import XCTest
@testable import NDMCore
@testable import NDMEngine

/// Some CDNs return 416 for every Range, but serve the same file to a plain GET.
final class RangeRejectionFallbackTests: XCTestCase {
    private let payload = Data((0..<524288).map { UInt8(truncatingIfNeeded: $0 &* 29 &+ ($0 >> 8)) })

    private func directories() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("range-rejection-\(UUID())")
        let output = root.appendingPathComponent("output"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        return (root, output, work)
    }

    func testFirstRange416FallsBackOnceWithAndWithoutHEAD() async throws {
        for headStatus in [200, 405] {
            for connections in [1, 32] {
                let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: 416,
                    injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max, headStatus: headStatus)
                try server.start(); defer { server.stop() }
                let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
                let request = DownloadRequest(url: server.baseURL,
                    headers: ["X-Fixture": "range-fallback", "Range": "bytes=400000-", "If-Range": "\"captured-browser-range\""],
                    connections: connections, destinationDirectory: output, suggestedFilename: "result.bin")
                let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
                XCTAssertEqual(try Data(contentsOf: final), payload)
                XCTAssertEqual(server.recordedRanges.count, 1, "Do not reschedule rejected ranges")
                XCTAssertTrue(server.recordedRanges[0].lowercased().hasPrefix("range: bytes=0-"))
                XCTAssertEqual(server.recordedMethods, ["HEAD", "GET", "GET"])
                let clean = try XCTUnwrap(server.recordedHeaders.last)
                XCTAssertNil(clean["range"])
                XCTAssertNil(clean["if-range"])
                XCTAssertEqual(clean["x-fixture"], "range-fallback")
                XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .absent)
                XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: output.path), ["result.bin"])
            }
        }
    }

    func testLaterRange416PreservesBytesDownloadedDuringCurrentAttempt() async throws {
        let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: 416,
            injectRangeFailureAfterCount: 1, injectedRangeFailureLimit: .max)
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 4,
            destinationDirectory: output, suggestedFilename: "result.bin")
        let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag))
        do {
            _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
            XCTFail("A later Range 416 must preserve the successful earlier response")
        } catch EngineError.httpStatus(416) { }
        XCTAssertGreaterThan(server.recordedRanges.count, 1)
        XCTAssertEqual(server.recordedMethods.filter { $0 == "GET" }.count, server.recordedRanges.count)
        let storage = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work, resourceContextHash: identity.storageContextHash)
        XCTAssertTrue(storage.snapshot().contains { $0.durablePrefix > 0 })
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
    }

    func testRetryOfEmptyOffsetReceiptCanUseCleanGET() async throws {
        for headStatus in [200, 405] {
            let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: 416,
                injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max, headStatus: headStatus)
            try server.start(); defer { server.stop() }
            let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
            let request = DownloadRequest(url: server.baseURL, connections: 32,
                destinationDirectory: output, suggestedFilename: "result.bin")
            let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag))
            try identity.save(in: work)
            var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
                destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count),
                resourceContextHash: identity.storageContextHash,
                ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
            let oldPartial = try XCTUnwrap(storage).partialURL
            storage = nil
            let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
            XCTAssertEqual(try Data(contentsOf: final), payload)
            XCTAssertFalse(FileManager.default.fileExists(atPath: oldPartial.path))
            XCTAssertEqual(server.recordedMethods, ["HEAD", "GET", "GET"])
            XCTAssertEqual(server.recordedRanges.count, 1)
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: work), .absent)
        }
    }

    func testSavedOffsetAndLegacyBytesSurviveRange416WithoutFullGET() async throws {
        for headStatus in [200, 405] {
            for useOffset in [false, true] {
                let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: 416,
                    injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max, headStatus: headStatus)
                try server.start(); defer { server.stop() }
                let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
                let request = DownloadRequest(url: server.baseURL, connections: 1,
                    destinationDirectory: output, suggestedFilename: "result.bin")
                let identity = HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag))
                try identity.save(in: work)
                let savedFile: URL
                if useOffset {
                    var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: work,
                        destinationURL: output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count),
                        resourceContextHash: identity.storageContextHash,
                        ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
                    try storage!.write(segmentID: 0, data: payload.prefix(32768))
                    try storage!.checkpoint()
                    savedFile = storage!.partialURL
                    storage = nil
                } else {
                    let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
                    try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
                    savedFile = SegmentFileFormat.segmentFileURL(id: 0, in: work)
                    try payload.prefix(32768).write(to: savedFile)
                }
                let savedBytes = try Data(contentsOf: savedFile)
                do {
                    _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
                    XCTFail("Saved progress requires explicit restart when Range is rejected")
                } catch EngineError.httpStatus(416) { }
                XCTAssertEqual(try Data(contentsOf: savedFile), savedBytes)
                XCTAssertEqual(server.recordedMethods, ["HEAD", "GET"])
                XCTAssertEqual(server.recordedRanges.count, 1)
                XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
            }
        }
    }

    func testOtherHTTPFailuresDoNotTriggerCleanGET() async throws {
        for headStatus in [200, 405] {
            for status in [403, 404, 410, 500] {
                let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: status,
                    injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max, headStatus: headStatus)
                try server.start(); defer { server.stop() }
                let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
                let request = DownloadRequest(url: server.baseURL, destinationDirectory: output)
                do {
                    _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
                    XCTFail("HTTP \(status) is not a range compatibility failure")
                } catch let EngineError.httpStatus(actual) { XCTAssertEqual(actual, status) }
                XCTAssertEqual(server.recordedMethods, ["HEAD", "GET"])
                XCTAssertEqual(server.recordedRanges.count, 1)
            }
        }
    }
}
