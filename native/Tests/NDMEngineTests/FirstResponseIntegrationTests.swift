import XCTest
import Foundation
import NDMCore
@testable import NDMEngine

final class FirstResponseIntegrationTests: XCTestCase {
    private func directories() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("first-response-\(UUID())")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        return (root, work, output)
    }

    func testFreshSingleConnectionUsesMetadataResponseAsOnlyPayloadRequest() async throws {
        let payload = Data((0..<524288).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 8192, bodyChunkDelay: { _ in 0.002 }, responseDelay: 0.15)
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories()
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: .init(url: server.baseURL, connections: 1,
            destinationDirectory: output, suggestedFilename: "result.bin"), workDirectory: work)
        let file = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedMethods, ["GET"])
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-"])
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .published(file))
    }

    func testFirstResponseAndOtherWorkersCannotJoinChangedSameSizeRepresentation() async throws {
        let payload = Data(repeating: 11, count: 4 * 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 8192, bodyChunkDelay: { _ in 0.002 },
            responseHeaders: { _, ordinal in
                ordinal.map { $0 > 1 } == true ? ["ETag": "\"replacement\""] : [:]
            })
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories()
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: .init(url: server.baseURL, connections: 4,
            destinationDirectory: output, suggestedFilename: "result.bin"), workDirectory: work)
        do { _ = try await engine.start(); XCTFail("Different response identities must not join") }
        catch HTTPRepresentationIdentity.Failure.changed {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(server.recordedRanges.first, "Range: bytes=0-")
        XCTAssertGreaterThan(server.recordedRanges.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
        let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: work))
        let storage = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work, resourceContextHash: identity.storageContextHash)
        XCTAssertTrue(storage.snapshot().filter { $0.id != 0 }.allSatisfy { $0.durablePrefix == 0 })
    }

    func testPinnedV2ResumeAdoptsValidatedSuffixAndRejectsChangedOrFullResponses() async throws {
        for mode in ["same", "changed", "missing", "wrong-total", "ignored", "paused"] {
            let payload = Data((0..<65536).map { UInt8($0 % 251) })
            let server = LocalRangeServer(payload: payload, responseDelay: mode == "paused" ? 0.3 : 0, ignoresRangeRequests: mode == "ignored",
                contentRangeTotalOffset: mode == "wrong-total" ? 1 : 0, sendsValidator: mode != "missing")
            try server.start(); defer { server.stop() }
            let (root, work, output) = try directories()
            defer { try? FileManager.default.removeItem(at: root) }
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let request = DownloadRequest(url: server.baseURL, connections: 1,
                destinationDirectory: output, suggestedFilename: "result.bin")
            let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count),
                validator: .etag(mode == "changed" ? "\"old-generation\"" : server.entityTag))
            try identity.save(in: work)
            var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
                destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count),
                resourceContextHash: identity.storageContextHash,
                ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
            try storage!.write(segmentID: 0, data: payload.prefix(32768))
            try storage!.checkpoint(); storage = nil
            guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work) else {
                return XCTFail("Expected owned partial")
            }
            let before = try Data(contentsOf: partial)
            let receipt = work.appendingPathComponent("offset-storage-v2.json")
            let receiptBefore = try Data(contentsOf: receipt)
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
            if mode == "same" {
                let final = try await engine.start()
                XCTAssertEqual(try Data(contentsOf: final), payload)
                let progress = await engine.currentProgress()
                XCTAssertEqual(progress.completedBytes, Int64(payload.count))
            } else {
                if mode == "paused" {
                    let running = Task { try await engine.start() }
                    let deadline = Date().addingTimeInterval(2)
                    while server.recordedRanges.isEmpty && Date() < deadline { try await Task.sleep(nanoseconds: 1_000_000) }
                    XCTAssertFalse(server.recordedRanges.isEmpty)
                    await engine.pause()
                    do { _ = try await running.value; XCTFail("Expected paused handshake") }
                    catch EngineError.paused {} catch { XCTFail("Unexpected pause failure: \(error)") }
                } else {
                    do { _ = try await engine.start(); XCTFail("Unverified resume must fail") }
                    catch HTTPRepresentationIdentity.Failure.changed {} catch { XCTFail("Unexpected failure: \(error)") }
                }
                XCTAssertEqual(try Data(contentsOf: partial), before)
                XCTAssertEqual(try Data(contentsOf: receipt), receiptBefore)
                XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
            }
            XCTAssertEqual(server.recordedMethods, ["GET"])
            XCTAssertEqual(server.recordedRanges, ["Range: bytes=32768-65535"])
            XCTAssertEqual(server.recordedHeaders.first?["if-range"], identity.validator.ifRange)
        }
    }

}
