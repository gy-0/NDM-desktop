import XCTest
import Foundation
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

final class WorkerNetworkRecoveryTests: XCTestCase {
    private let prefix = 64 * 1024
    private func payload() -> Data { Data((0..<(8 * 1024 * 1024)).map { UInt8(truncatingIfNeeded: $0 &* 17 &+ ($0 >> 16)) }) }
    private func fixture(_ data: Data, legacy: Bool, connections: Int = 2, truncate: @escaping @Sendable (Int, Int) -> Int?) throws -> (LocalRangeServer, DownloadEngine, URL, URL) {
        let server = LocalRangeServer(payload: data, bodyChunkSize: 16 * 1024, truncateRangeBody: truncate, bodyChunkDelay: { _ in 0.003 })
        try server.start()
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("worker-network-\(UUID().uuidString)")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        if legacy {
            let plan = SegmentFileFormat.planDynamicConnections(totalBytes: Int64(data.count), connections: connections, completedPrefixBytes: 0)
            try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        }
        let request = DownloadRequest(url: server.baseURL, connections: connections, destinationDirectory: output, suggestedFilename: "fixture.bin")
        return (server, DownloadEngine(taskID: 1, request: request, workDirectory: work), root, work)
    }
    private func start(_ range: String) -> Int { Int(range.split(separator: "=").last?.split(separator: "-").first ?? "") ?? -1 }

    func testPartialTCPClosureRetriesOnlyFailedWorkerAndPreservesFileSHA() async throws {
        for legacy in [false, true] {
            let data = payload(), prefix = prefix
            let (server, engine, root, _) = try fixture(data, legacy: legacy, truncate: { start, _ in start == 0 ? prefix : nil })
            defer { server.stop(); try? FileManager.default.removeItem(at: root) }
            let final = try await engine.start()
            XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: data))
            let starts = server.recordedRanges.map(start)
            XCTAssertEqual(starts.filter { $0 == data.count / 2 }.count, 1, "Healthy original worker must retain its request")
            XCTAssertTrue(starts.contains { $0 > 0 && $0 <= prefix }, "Failed worker must resume its actual written prefix")
            XCTAssertEqual(server.truncatedResponses, 1)
        }
    }

    func testPauseInterruptsNetworkRetryBackoffWithoutLateRequests() async throws {
        let data = payload(), prefix = prefix
        let (server, engine, root, _) = try fixture(data, legacy: false, truncate: { start, _ in start == 0 ? prefix : nil })
        defer { server.stop(); try? FileManager.default.removeItem(at: root) }
        let running = Task { try await engine.start() }
        let deadline = Date().addingTimeInterval(5)
        while server.truncatedResponses == 0 && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(server.truncatedResponses, 1)
        // Let the deliberately short response reach URLSession and retry backoff.
        try await Task.sleep(nanoseconds: 100_000_000)
        let before = Date()
        await engine.pause()
        do { _ = try await running.value; XCTFail("Paused task must not finish") }
        catch EngineError.paused {} catch EngineError.cancelled {} catch is CancellationError {}
        catch { XCTFail("Unexpected terminal error: \(error)") }
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.6)
        let count = server.recordedRanges.count
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(server.recordedRanges.count, count)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("output/fixture.bin").path))
    }

    func testRepeatedTCPFailureRemainsRecoverableUntilUserPauses() async throws {
        let data = payload(), prefix = prefix
        let (server, engine, root, work) = try fixture(data, legacy: false, connections: 1, truncate: { _, _ in prefix })
        defer { server.stop(); try? FileManager.default.removeItem(at: root) }
        let running = Task { try await engine.start() }
        let deadline = Date().addingTimeInterval(13)
        while server.truncatedResponses < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 25_000_000) }
        XCTAssertGreaterThanOrEqual(server.truncatedResponses, 3, "Transient disconnect must keep retrying instead of becoming terminal")
        await engine.pause()
        do { _ = try await running.value; XCTFail("Expected user pause") }
        catch EngineError.paused {} catch EngineError.cancelled {} catch is CancellationError {}
        catch { XCTFail("Transient disconnect became terminal: \(error)") }
        let count = server.recordedRanges.count
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(server.recordedRanges.count, count)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("output/fixture.bin").path))
        let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: work))
        let stored = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work, resourceContextHash: identity.storageContextHash)
        XCTAssertGreaterThan(stored.snapshot().reduce(Int64(0)) { $0 + $1.durablePrefix }, 0)
    }

    func testThirtyTwoInitialWorkersRecoverPartialTCPClosureWithCorrectSHA() async throws {
        let data = payload(), prefix = prefix
        let (server, engine, root, _) = try fixture(data, legacy: false, connections: 32, truncate: { start, _ in start == 0 ? prefix : nil })
        defer { server.stop(); try? FileManager.default.removeItem(at: root) }
        let plan = SegmentFileFormat.planDynamicConnections(totalBytes: Int64(data.count), connections: 32, completedPrefixBytes: 0)
        XCTAssertEqual(plan.count, 32, "Fixture must establish 32 initial ranges")
        let final = try await engine.start()
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: data))
        let starts = server.recordedRanges.map(start)
        for segment in plan.dropFirst() {
            XCTAssertEqual(starts.filter { $0 == Int(segment.start) }.count, 1, "Healthy worker \(segment.segmentId) was restarted")
        }
        XCTAssertTrue(starts.contains { $0 > 0 && $0 <= prefix })
        XCTAssertEqual(server.truncatedResponses, 1)
    }
}
