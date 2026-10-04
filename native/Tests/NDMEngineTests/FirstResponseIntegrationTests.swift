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
}
