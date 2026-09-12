import XCTest
@testable import NDMEngine
@testable import NDMCore

/// Failure-injection regressions from the 2026-09-08 engine audit.
/// These assert required integrity behavior, not acceptance of the old defect.
final class DownloadEngineIntegrityRegressionTests: XCTestCase {
    func testPageContextParticipatesInPersistedRepresentationIdentity() {
        let url = URL(string: "https://example.invalid/file")!
        let destination = FileManager.default.temporaryDirectory
        let first = DownloadRequest(url: url, destinationDirectory: destination, pageURL: URL(string: "https://example.invalid/account-a"))
        let second = DownloadRequest(url: url, destinationDirectory: destination, pageURL: URL(string: "https://example.invalid/account-b"))
        let a = HTTPRepresentationIdentity(request: first, totalBytes: 10, validator: .etag("\"same\""))
        let b = HTTPRepresentationIdentity(request: second, totalBytes: 10, validator: .etag("\"same\""))
        XCTAssertNotEqual(a.requestFingerprint, b.requestFingerprint)
        XCTAssertEqual(a, HTTPRepresentationIdentity(request: first, totalBytes: 10, validator: .etag("\"same\"")))
    }

    func testExistingDestinationFailsBeforeDownloadingAnyMissingBytes() async throws {
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let (engine, work, destination) = try seededEngine(server: server, payload: payload, savedValidator: .etag(server.entityTag), savedBytes: 32 * 1024)
        let target = destination.appendingPathComponent("result.bin")
        let previous = Data("unrelated user output".utf8)
        try previous.write(to: target)
        do { try await engine.start(); XCTFail("Existing output must fail before network body work") } catch {}
        XCTAssertTrue(server.recordedRanges.isEmpty)
        XCTAssertEqual(try Data(contentsOf: target), previous)
        XCTAssertEqual(try Data(contentsOf: SegmentFileFormat.segmentFileURL(id: 0, in: work)), payload.prefix(32 * 1024))
    }

    func testWeakOrUnprovenDatesCannotAuthorizeRangeJoining() throws {
        let url = URL(string: "https://example.invalid/file")!
        for headers in [
            ["ETag": "W/\"weak\"", "Last-Modified": "Mon, 07 Sep 2026 00:00:00 GMT", "Date": "Tue, 08 Sep 2026 00:00:00 GMT"],
            ["Last-Modified": "Tue, 08 Sep 2026 00:00:00 GMT"],
            ["Last-Modified": "Tue, 08 Sep 2026 00:00:00 GMT", "Date": "Tue, 08 Sep 2026 00:00:30 GMT"]
        ] {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers))
            XCTAssertNil(HTTPRepresentationIdentity.Validator.from(response))
        }
    }

    func testStableStrongValidatorResumesWithoutRequestingSavedPrefix() async throws {
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let (engine, work, _) = try seededEngine(server: server, payload: payload, savedValidator: .etag(server.entityTag), savedBytes: 32 * 1024)
        let file = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=32768-131071"])
        XCTAssertTrue(server.recordedHeaders.filter { $0["range"] != nil }.allSatisfy { $0["if-range"] == server.entityTag })
        XCTAssertNotNil(HTTPRepresentationIdentity.load(in: work))
    }

    func testChangedStrongValidatorPreservesOriginalBeforeAppending() async throws {
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let (engine, work, destination) = try seededEngine(server: server, payload: Data(repeating: 0x11, count: payload.count), savedValidator: .etag("\"old\""), savedBytes: 32 * 1024)
        let identity = try Data(contentsOf: HTTPRepresentationIdentity.file(in: work))
        do {
            _ = try await engine.start()
            XCTFail("A changed representation must not implicitly restart saved work")
        } catch HTTPRepresentationIdentity.Failure.changed { }
        XCTAssertEqual(try Data(contentsOf: SegmentFileFormat.segmentFileURL(id: 0, in: work)), Data(repeating: 0x11, count: 32 * 1024))
        XCTAssertEqual(try Data(contentsOf: HTTPRepresentationIdentity.file(in: work)), identity)
        XCTAssertTrue(server.recordedRanges.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("result.bin").path))
    }

    func testChangedValidatorBetweenProbeAndRangeRejectsBodyBeforeWrite() async throws {
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload, responseHeaders: { method, _ in
            ["ETag": method == "HEAD" ? "\"old\"" : "\"new\""]
        })
        try server.start()
        defer { server.stop() }
        let (engine, work, destination) = try seededEngine(server: server, payload: payload, savedValidator: nil, savedBytes: 0)
        do { try await engine.start(); XCTFail("A changed Range validator must not be accepted") } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("result.bin").path))
        XCTAssertEqual(SegmentFileFormat.rawExistingByteCount(for: SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)[0], in: work), 0)
    }

    func testMissingOrWeakValidatorUsesOneCleanResponseForFreshTaskIncludingHeadFallback() async throws {
        for weak in [false, true] {
            let payload = Data(repeating: 0x61, count: 128 * 1024)
            let server = LocalRangeServer(payload: payload, sendsValidator: false, headStatus: 405, responseHeaders: { _, _ in weak ? ["ETag": "W/\"weak\""] : [:] })
            try server.start()
            defer { server.stop() }
            let (engine, _, _) = try seededEngine(server: server, payload: payload, savedValidator: nil, savedBytes: 0)
            let file = try await engine.start()
            XCTAssertEqual(try Data(contentsOf: file), payload)
            XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-0"], "Only the capability probe may use Range; the body must be a fresh full response")
            XCTAssertEqual(server.recordedMethods.filter { $0 == "GET" }.count, 2)
        }
    }

    func testStrongLastModifiedResumesUsingItsOriginalDate() async throws {
        let modified = "Mon, 07 Sep 2026 00:00:00 GMT"
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload, sendsValidator: false, responseHeaders: { _, _ in
            ["Last-Modified": modified, "Date": "Tue, 08 Sep 2026 00:00:00 GMT"]
        })
        try server.start()
        defer { server.stop() }
        let (engine, _, _) = try seededEngine(server: server, payload: payload, savedValidator: .lastModified(modified), savedBytes: 32 * 1024)
        let file = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=32768-131071"])
        XCTAssertTrue(server.recordedHeaders.filter { $0["range"] != nil }.allSatisfy { $0["if-range"] == modified })
    }

    func testExistingDestinationSurvivesPublicationFailureAndRetryNeedsNoNetwork() async throws {
        let payload = Data(repeating: 0x52, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let (engine, work, destination) = try seededEngine(server: server, payload: payload, savedValidator: .etag(server.entityTag), savedBytes: payload.count)
        let target = destination.appendingPathComponent("result.bin")
        let previous = Data("existing user file".utf8)
        try previous.write(to: target)
        do { try await engine.start(); XCTFail("Exclusive publication must preserve a collision") } catch {}
        XCTAssertEqual(try Data(contentsOf: target), previous)
        XCTAssertEqual(try Data(contentsOf: SegmentFileFormat.segmentFileURL(id: 0, in: work)), payload)
        // Move our fixture aside, then retry only assembly using the saved parts.
        try FileManager.default.moveItem(at: target, to: destination.appendingPathComponent("preserved.bin"))
        let finished = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: finished), payload)
        XCTAssertTrue(server.recordedRanges.isEmpty, "A destination failure must not cause a second download")
    }

    private func seededEngine(server: LocalRangeServer, payload: Data, savedValidator: HTTPRepresentationIdentity.Validator?, savedBytes: Int) throws -> (DownloadEngine, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-validator-audit-\(UUID())")
        let work = root.appendingPathComponent("work")
        let destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: destination, suggestedFilename: "result.bin")
        let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
        try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        if savedBytes > 0 { try payload.prefix(savedBytes).write(to: SegmentFileFormat.segmentFileURL(id: 0, in: work)) }
        if let savedValidator { try HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: savedValidator).save(in: work) }
        return (DownloadEngine(taskID: 1, request: request, workDirectory: work), work, destination)
    }

    func testSameLengthReplacementMustNotPublishMixedGeneration() async throws {
        let replacement = Data(repeating: 0xBB, count: 128 * 1024)
        let server = LocalRangeServer(payload: replacement)
        try server.start()
        defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-generation-audit-\(UUID())")
        let support = root.appendingPathComponent("support")
        let destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: destination, maxConnections: 2, useCategoryFolders: false), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 2)
        let work = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(replacement.count), connections: 2)
        try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        // A valid old-generation prefix has exactly the expected length. The
        // legacy resume format has no validator; absence must not imply sameness.
        let oldPrefix = Data(repeating: 0xAA, count: 32 * 1024)
        try oldPrefix.write(to: SegmentFileFormat.segmentFileURL(id: 0, in: work))
        do {
            try await manager.startAndWait(taskID: task.id)
        } catch {
            // Explicit refusal to resume unverifiable bytes is also safe.
            let states = try await manager.listTasks()
            XCTAssertNotEqual(states.first { $0.id == task.id }?.status, .complete)
            return
        }
        let states = try await manager.listTasks()
        let finished = try XCTUnwrap(states.first { $0.id == task.id })
        XCTAssertEqual(finished.status, .complete)
        let actual = try Data(contentsOf: destination.appendingPathComponent(finished.filename))
        XCTAssertTrue(actual == replacement, "Completed output mixes an old 32 KiB prefix with replacement bytes despite an unchanged Content-Length")
    }

    func testMergeOutputFailurePreservesCompleteSegmentsForRetry() async throws {
        let payload = Data(repeating: 0x6C, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-merge-audit-\(UUID())")
        let support = root.appendingPathComponent("support")
        let destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: destination, maxConnections: 2, useCategoryFolders: false), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 2)
        let work = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 2)
        try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        for segment in plan {
            try payload.subdata(in: Int(segment.start)..<Int(segment.end + 1)).write(to: SegmentFileFormat.segmentFileURL(id: segment.segmentId, in: work))
        }
        let request = DownloadRequest(url: server.baseURL, connections: 2, destinationDirectory: destination)
        try HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag)).save(in: work)
        // Only our temporary destination becomes unwritable; the support store
        // stays writable so the task can record the recoverable failure.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: destination.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path) }
        do {
            try await manager.startAndWait(taskID: task.id)
            XCTFail("The unwritable output directory must reject merge")
        } catch {}
        XCTAssertTrue(FileManager.default.fileExists(atPath: work.appendingPathComponent("segments.bin").path), "An output failure must preserve the valid resume plan")
        for segment in plan {
            XCTAssertEqual(SegmentFileFormat.rawExistingByteCount(for: segment, in: work), segment.length, "An output failure must not discard successfully downloaded bytes")
        }
    }
}
