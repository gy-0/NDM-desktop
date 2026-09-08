import XCTest
import Foundation
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

final class FirstBodyStartupTests: XCTestCase {
    private func directories() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("first-body-startup-\(UUID().uuidString)")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        return (root, work, output)
    }

    func testSuccessfulHEADDoesNotBypassRealBodyInitialPlusThreeBudget() async throws {
        for (connections, legacy) in [(1, false), (1, true), (32, false), (32, true)] {
            let data = Data(repeating: 0x43, count: connections == 1 ? 65536 : 8 * 1024 * 1024)
            let server = LocalRangeServer(payload: data, truncateRangeBody: { _, _ in 0 })
            try server.start(); defer { server.stop() }
            let (root, work, output) = try directories()
            defer { try? FileManager.default.removeItem(at: root) }
            if legacy {
                let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(data.count), connections: connections)
                try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            }
            let request = DownloadRequest(url: server.baseURL, connections: connections, destinationDirectory: output, suggestedFilename: "fixture.bin")
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
            // Bound the pre-fix infinite retry behavior so a red test never hangs.
            let watchdog = Task {
                do { try await Task.sleep(nanoseconds: 3_000_000_000) }
                catch { return }
                await engine.pause()
            }
            defer { watchdog.cancel() }
            do { _ = try await engine.start(); XCTFail("Zero-body startup must terminate") }
            catch {
                XCTAssertEqual((error as NSError).domain, NSURLErrorDomain)
                XCTAssertEqual((error as NSError).code, NSURLErrorNetworkConnectionLost,
                               "Must exhaust startup budget, not reach watchdog pause")
            }
            XCTAssertEqual(server.recordedMethods.filter { $0 == "HEAD" }.count, 1)
            XCTAssertEqual(server.recordedRanges.count, 4, "Initial real GET plus three retries; HEAD is not file progress")
            XCTAssertTrue(server.recordedRanges.allSatisfy { $0.lowercased().hasPrefix("range: bytes=0-") })
            XCTAssertEqual(Set(server.recordedRanges).count, 1, "All four attempts retain the same unstarted first range")
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("fixture.bin").path),
                           "No final file may be published; an owned preallocated partial is expected")
            if !legacy {
                let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: work))
                let storage = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work,
                    resourceContextHash: identity.storageContextHash)
                XCTAssertEqual(storage.snapshot().reduce(Int64(0)) { $0 + $1.durablePrefix }, 0)
            } else {
                let parts = try FileManager.default.contentsOfDirectory(at: work, includingPropertiesForKeys: nil)
                    .filter { $0.lastPathComponent.hasPrefix("seg.x") }
                for part in parts { XCTAssertEqual(try Data(contentsOf: part).count, 0) }
            }
        }
    }

    func testRecoveredDurablePrefixAllowsMoreThanThreeZeroBodyInterruptions() async throws {
        let data = Data((0..<(512 * 1024)).map { UInt8(truncatingIfNeeded: $0 &* 19) })
        let server = LocalRangeServer(payload: data, bodyChunkSize: 8192, truncateRangeBody: { _, ordinal in
            ordinal == 1 ? 65536 : ordinal <= 5 ? 0 : nil
        }, bodyChunkDelay: { _ in 0.003 })
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories()
        defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: output, suggestedFilename: "fixture.bin")
        let first = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let running = Task { try await first.start() }
        let deadline = Date().addingTimeInterval(3)
        // File length is preallocated and server send completion does not prove
        // URLSession delivered data. Read the actual patterned bytes in our own
        // partial before requesting a checkpoint; never recover a live backend.
        let expectedPrefix = Data(data.prefix(65536))
        func writtenPrefixMatches() -> Bool {
            guard let partial = (try? FileManager.default.contentsOfDirectory(at: output,
                includingPropertiesForKeys: nil))?.first(where: { $0.lastPathComponent.hasPrefix(".ndm-offset-") }),
                  let handle = try? FileHandle(forReadingFrom: partial) else { return false }
            defer { try? handle.close() }
            return (try? handle.read(upToCount: 65536)) == expectedPrefix
        }
        while !writtenPrefixMatches() && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(writtenPrefixMatches(), "Actual 64KiB prefix must reach storage before pause")
        XCTAssertEqual(server.truncatedResponses, 1)
        await first.pause()
        do { _ = try await running.value; XCTFail("Expected pause after real prefix") }
        catch EngineError.paused {} catch EngineError.cancelled {} catch is CancellationError {}
        catch { XCTFail("Unexpected pause error: \(error)") }
        let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: work))
        let storage = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work, resourceContextHash: identity.storageContextHash)
        let durable = storage.snapshot().reduce(Int64(0)) { $0 + $1.durablePrefix }
        XCTAssertEqual(durable, 65536, "Only actual checkpointed prefix authorizes resumed transport policy")

        let resumed = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let watchdog = Task {
            do { try await Task.sleep(nanoseconds: 28_000_000_000) }
            catch { return }
            await resumed.pause()
        }
        defer { watchdog.cancel() }
        let final = try await resumed.start()
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: data))
        XCTAssertEqual(server.truncatedResponses, 5)
        XCTAssertEqual(server.recordedRanges.count, 6)
        XCTAssertTrue(server.recordedRanges.dropFirst().allSatisfy { $0.lowercased() == "range: bytes=65536-524287" },
                      "All retry requests must preserve the same durable prefix")
    }
}
