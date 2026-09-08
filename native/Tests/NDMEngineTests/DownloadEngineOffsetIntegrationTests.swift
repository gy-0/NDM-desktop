import XCTest
@testable import NDMEngine
@testable import NDMCore

final class DownloadEngineOffsetIntegrationTests: XCTestCase {
    private func directories() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        return (root, work, output)
    }
    func testFreshResumableUsesOneFileAndSinglePayloadBudget() async throws {
        let payload = Data((0..<(2 * 1024 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 4,
            destinationDirectory: output, suggestedFilename: "result.bin"), workDirectory: work,
            capacityProvider: { _ in Int64(payload.count) + 4096 })
        let final = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: final), payload)
        let names = try FileManager.default.contentsOfDirectory(atPath: work.path)
        XCTAssertFalse(names.contains("segments.bin"))
        XCTAssertFalse(names.contains { $0.hasPrefix("seg.x") })
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .published(final))
        XCTAssertGreaterThan(server.recordedRanges.count, 1)
    }
    func testV2ResumesCommittedPrefixWithoutFetchingItAgain() async throws {
        let payload = Data((0..<65536).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: output, suggestedFilename: "result.bin")
        let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag))
        var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
            destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count), resourceContextHash: identity.storageContextHash,
            ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
        try storage!.write(segmentID: 0, data: payload.prefix(32768)); try storage!.checkpoint()
        storage = nil
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(try Data(contentsOf: final), payload)
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=32768-65535"])
    }
    func testPublishedReceiptCompletesBeforeNetworkProbe() async throws {
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let target = output.appendingPathComponent("result.bin")
        var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
            destinationURL: target, totalBytes: 4, resourceContextHash: "expired-source",
            ranges: [.init(id: 0, start: 0, end: 3, durablePrefix: 0)])
        try storage!.write(segmentID: 0, data: Data([1, 2, 3, 4])); try storage!.publish(); storage = nil
        let request = DownloadRequest(url: URL(string: "http://127.0.0.1:1/expired")!, connections: 1, destinationDirectory: output, suggestedFilename: "result.bin")
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(final, target)
    }

    func testSameSizeReplacementCannotJoinCommittedOffsetBytes() async throws {
        let replacement = Data(repeating: 92, count: 65536)
        let server = LocalRangeServer(payload: replacement)
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 1,
            destinationDirectory: output, suggestedFilename: "result.bin")
        let oldIdentity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(replacement.count),
            validator: .etag("\"previous-generation\""))
        var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
            destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(replacement.count),
            resourceContextHash: oldIdentity.storageContextHash,
            ranges: [.init(id: 0, start: 0, end: Int64(replacement.count - 1), durablePrefix: 0)])
        try storage!.write(segmentID: 0, data: Data(repeating: 17, count: 32768))
        try storage!.checkpoint()
        storage = nil
        guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work) else {
            return XCTFail("Missing committed partial")
        }
        let before = try Data(contentsOf: partial)
        let manifest = work.appendingPathComponent("offset-storage-v2.json")
        let receiptBefore = try Data(contentsOf: manifest)
        do {
            _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
            XCTFail("Same Content-Length must not authorize mixing representations")
        } catch OffsetDownloadStorage.Failure.identityMismatch {
            // The receipt belongs to the old representation; retain it for explicit recovery.
        } catch {
            XCTFail("Unexpected failure: \(error)")
        }
        XCTAssertTrue(server.recordedMethods.contains("HEAD"))
        XCTAssertTrue(server.recordedRanges.isEmpty)
        XCTAssertEqual(try Data(contentsOf: partial), before)
        XCTAssertEqual(try Data(contentsOf: manifest), receiptBefore)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
        let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work,
            resourceContextHash: oldIdentity.storageContextHash)
        XCTAssertEqual(recovered.writtenPrefix(segmentID: 0), 32768)
    }
    func testLegacyPlanStillUsesLegacyFiles() async throws {
        let payload = Data(repeating: 7, count: 65536)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
        try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: output, suggestedFilename: "result.bin")
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(try Data(contentsOf: final), payload)
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .absent)
        XCTAssertTrue(FileManager.default.fileExists(atPath: work.appendingPathComponent("segments.bin").path))
    }

    func testLiveReplanKeepsOneBackingFileAndCorrectBytes() async throws {
        let payload = Data(repeating: 91, count: 4 * 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65536, bodyChunkDelay: { _ in 0.02 })
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 2,
            destinationDirectory: output, suggestedFilename: "result.bin"), workDirectory: work)
        let run = Task { try await engine.start() }
        for _ in 0..<100 where server.recordedRanges.count < 2 { try await Task.sleep(nanoseconds: 20_000_000) }
        try await engine.applyConnectionsCount(4)
        let final = try await run.value
        XCTAssertEqual(try Data(contentsOf: final), payload)
        XCTAssertGreaterThan(server.recordedRanges.count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent("segments.bin").path))
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .published(final))
    }
    func testCheckpointFailureDrainsWritersBeforeReturning() async throws {
        let payload = Data(repeating: 41, count: 8 * 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65536, bodyChunkDelay: { _ in 0.04 })
        try server.start(); defer { server.stop() }
        let (root, work, output) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 2, destinationDirectory: output, suggestedFilename: "result.bin")
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let run = Task { try await engine.start() }
        for _ in 0..<100 where server.recordedRanges.count < 2 { try await Task.sleep(nanoseconds: 20_000_000) }
        guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work) else { return XCTFail("Missing V2 partial") }
        let metadata = work.appendingPathComponent("offset-storage-v2.json")
        let saved = work.appendingPathComponent("saved-manifest")
        try FileManager.default.moveItem(at: metadata, to: saved)
        try FileManager.default.createDirectory(at: metadata, withIntermediateDirectories: false)
        do { _ = try await run.value; XCTFail("Checkpoint failure must stop transfer") } catch {}
        let stopped = try Data(contentsOf: partial)
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(try Data(contentsOf: partial), stopped)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
        try FileManager.default.removeItem(at: metadata)
        try FileManager.default.moveItem(at: saved, to: metadata)
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(try Data(contentsOf: final), payload)
    }
}
