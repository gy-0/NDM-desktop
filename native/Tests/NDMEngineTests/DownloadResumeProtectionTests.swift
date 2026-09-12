import XCTest
@testable import NDMCore
@testable import NDMEngine

/// Actual HTTP engine runs against saved legacy and V2 payloads. These fixtures
/// intentionally bind bytes before restart; filenames/length/ETag across URIs
/// never authorize request-context migration.
final class DownloadResumeProtectionTests: XCTestCase {
    private let payload = Data((0..<65536).map { UInt8($0 % 251) })

    func testChangedURIWithSameValidatorRetainsBothStorageFormatsBeforeNetwork() async throws {
        for offset in [false, true] {
            let server = LocalRangeServer(payload: payload)
            try server.start(); defer { server.stop() }
            let fixture = try seed(server: server, offset: offset)
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let before = try contents(fixture)
            var request = fixture.request
            request.url = server.baseURL.appendingPathComponent("different-object")
            await expectProtected(request, fixture)
            XCTAssertEqual(try contents(fixture), before)
            XCTAssertTrue(server.recordedMethods.isEmpty)
        }
    }

    func testUnboundLegacyPayloadIsNotRetroactivelyAdoptedOrDiscarded() async throws {
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let fixture = try seed(server: server, offset: false)
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        try FileManager.default.removeItem(at: HTTPRepresentationIdentity.file(in: fixture.work))
        let before = try contents(fixture)
        await expectProtected(fixture.request, fixture)
        XCTAssertEqual(try contents(fixture), before)
        XCTAssertTrue(server.recordedMethods.isEmpty)
    }

    func testSameURIChangedOrMissingValidatorRetainsLegacyPayload() async throws {
        for sendsValidator in [true, false] {
            let server = LocalRangeServer(payload: payload, sendsValidator: sendsValidator)
            try server.start(); defer { server.stop() }
            let fixture = try seed(server: server, offset: false, validator: "\"previous-version\"")
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let before = try contents(fixture)
            await expectProtected(fixture.request, fixture)
            XCTAssertEqual(try contents(fixture), before)
            XCTAssertEqual(server.recordedMethods, ["HEAD"])
            XCTAssertTrue(server.recordedRanges.isEmpty)
        }
    }

    func testRangeIgnoredOnResumeKeepsBothFormatsWithoutFullStreamFallback() async throws {
        for offset in [false, true] {
            let server = LocalRangeServer(payload: payload, ignoresRangeRequests: true)
            try server.start(); defer { server.stop() }
            let fixture = try seed(server: server, offset: offset)
            defer { try? FileManager.default.removeItem(at: fixture.root) }
            let before = try contents(fixture)
            await expectProtected(fixture.request, fixture)
            XCTAssertEqual(try contents(fixture), before)
            XCTAssertEqual(server.recordedRanges, ["Range: bytes=32768-65535"])
            XCTAssertEqual(server.recordedMethods.filter { $0 == "GET" }.count, 1,
                           "No clean full-stream restart after the rejected Range")
        }
    }

    func testCompleteBootstrapCannotReplaceSavedLegacyPayload() async throws {
        let server = LocalRangeServer(payload: payload, ignoresRangeRequests: true, headStatus: 405)
        try server.start(); defer { server.stop() }
        let fixture = try seed(server: server, offset: false)
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let before = try contents(fixture)
        await expectProtected(fixture.request, fixture)
        XCTAssertEqual(try contents(fixture), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.output.appendingPathComponent("result.bin").path))
    }

    private struct Fixture {
        let root: URL, work: URL, output: URL, partial: URL
        let request: DownloadRequest
    }

    private func seed(server: LocalRangeServer, offset: Bool, validator: String? = nil) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-protect-\(UUID().uuidString)")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let request = DownloadRequest(url: server.baseURL, connections: 1,
                                      destinationDirectory: output, suggestedFilename: "result.bin")
        let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count),
                                                   validator: .etag(validator ?? server.entityTag))
        let partial: URL
        if offset {
            let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: work,
                destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count),
                resourceContextHash: identity.storageContextHash,
                ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
            try storage.write(segmentID: 0, data: payload.prefix(32768))
            try storage.checkpoint()
            partial = storage.partialURL
        } else {
            let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
            try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            partial = SegmentFileFormat.segmentFileURL(id: 0, in: work)
            try payload.prefix(32768).write(to: partial)
        }
        try identity.save(in: work)
        return Fixture(root: root, work: work, output: output, partial: partial, request: request)
    }

    private func contents(_ fixture: Fixture) throws -> [String: Data] {
        var result = ["payload": try Data(contentsOf: fixture.partial)]
        for name in ["representation.json", "segments.bin", "offset-storage-v2.json"] {
            let file = fixture.work.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: file.path) {
                let data = try Data(contentsOf: file)
                // Checkpoint may rewrite equivalent JSON with a different key order.
                result[name] = name.hasSuffix(".json")
                    ? try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: data), options: .sortedKeys)
                    : data
            }
        }
        return result
    }

    private func expectProtected(_ request: DownloadRequest, _ fixture: Fixture,
                                 file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: fixture.work).start()
            XCTFail("Resume should require an explicit new download", file: file, line: line)
        } catch HTTPRepresentationIdentity.Failure.changed {
        } catch {
            XCTFail("Unexpected error: \(error)", file: file, line: line)
        }
    }
}
