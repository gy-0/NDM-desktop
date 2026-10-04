import XCTest
import Foundation
import NDMCore
@testable import NDMEngine

final class HTTPResponseIntegrityTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-http-integrity-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    func testContentRangeRequiresCompleteGrammarAndRepresentableLength() {
        let valid = HTTPFileResponsePolicy.contentRange(" bytes 2-9/10 \r\n")
        XCTAssertEqual(valid?.start, 2)
        XCTAssertEqual(valid?.end, 9)
        XCTAssertEqual(valid?.length, 8)
        XCTAssertEqual(valid?.total, 10)
        XCTAssertNil(HTTPFileResponsePolicy.contentRange("bytes 2-9/*")?.total)
        for invalid in ["bytes 0-9", "bytes 0-9/", "bytes 0-9/10/20", "bytes 0-9/9",
                        "bytes 0-9/0", "bytes +0-9/10", "bytes -1-9/10", "bytes 9-0/10",
                        "bytes 0-9223372036854775807/*", "bytes 0-1/9223372036854775808"] {
            XCTAssertNil(HTTPFileResponsePolicy.contentRange(invalid), invalid)
        }
    }

    func testOnlySyntacticallyStrongEntityTagsAuthorizeJoining() throws {
        let url = URL(string: "https://example.invalid/file")!
        for tag in ["W/\"weak\"", "\"one\", \"two\"", "\"has space\"", "\"has\tcontrol\""] {
            let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["ETag": tag]))
            XCTAssertNil(HTTPRepresentationIdentity.Validator.from(response), tag)
        }
        let response = try XCTUnwrap(HTTPURLResponse(url: url, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: ["ETag": " \"same\" "]))
        let validator = try XCTUnwrap(HTTPRepresentationIdentity.Validator.from(response))
        XCTAssertEqual(validator, .etag("\"same\""))
        XCTAssertTrue(validator.matches(response), "Normalize field whitespace consistently on probe and Range")
    }

    func testMalformedOrUnboundRangeLeavesSavedPrefixUntouched() async throws {
        for contentRange in [nil, "bytes 11-63", "bytes 11-63/*", "bytes 11-63/64/64", "bytes 11-63/63"] as [String?] {
            let server = LocalRangeServer(payload: Data(0..<64), rangeContentRange: { _, _, _ in contentRange })
            try server.start()
            defer { server.stop() }
            let root = try directory(), part = root.appendingPathComponent("seg.x0")
            let original = Data(0..<11)
            try original.write(to: part)
            var request = URLRequest(url: server.baseURL)
            request.setValue("bytes=11-63", forHTTPHeaderField: "Range")
            do {
                _ = try await RangeStreamDownloader.download(request: request, to: part,
                    expectedValidator: .etag(server.entityTag), expectedTotal: 64,
                    append: true, isCancelled: { false }, limiter: nil, onBytes: { _ in })
                XCTFail("Invalid Content-Range must fail before append: \(String(describing: contentRange))")
            } catch let error as EngineError {
                guard case .invalidResponse = error else { return XCTFail("Unexpected error: \(error)") }
            }
            XCTAssertEqual(try Data(contentsOf: part), original)
        }
    }

    func testUnsolicitedPartialResponseCannotTruncateExistingFile() async throws {
        let server = LocalRangeServer(payload: Data(0..<64), fullResponseStatus: 206)
        try server.start()
        defer { server.stop() }
        let part = try directory().appendingPathComponent("seg.x0")
        let original = Data("saved user prefix".utf8)
        try original.write(to: part)
        do {
            _ = try await RangeStreamDownloader.download(request: URLRequest(url: server.baseURL), to: part,
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
            XCTFail("A clean request must not accept a partial representation")
        } catch let error as EngineError {
            guard case .invalidResponse = error else { return XCTFail("Unexpected error: \(error)") }
        }
        XCTAssertEqual(try Data(contentsOf: part), original)
    }

    func testEncodedRangeCannotModifySavedPrefix() async throws {
        let server = LocalRangeServer(payload: Data(0..<64), responseHeaders: { _, _ in ["Content-Encoding": "gzip"] })
        try server.start()
        defer { server.stop() }
        let part = try directory().appendingPathComponent("seg.x0")
        let original = Data(0..<11)
        try original.write(to: part)
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=11-63", forHTTPHeaderField: "Range")
        do {
            _ = try await RangeStreamDownloader.download(request: request, to: part,
                expectedValidator: .etag(server.entityTag), expectedTotal: 64,
                append: true, isCancelled: { false }, limiter: nil, onBytes: { _ in })
            XCTFail("Decoded content cannot be joined at encoded offsets")
        } catch { }
        XCTAssertEqual(try Data(contentsOf: part), original)
    }

    func testInvalidByteZeroProbeNeverStartsPayloadRanges() async throws {
        for contentRange in ["bytes 1-1/64", "bytes 0-0", "bytes 0-1/64"] {
            let server = LocalRangeServer(payload: Data(0..<64), rangeContentRange: { _, _, _ in contentRange }, headStatus: 405)
            try server.start()
            defer { server.stop() }
            let root = try directory(), destination = root.appendingPathComponent("downloads")
            let engine = DownloadEngine(taskID: 1,
                request: DownloadRequest(url: server.baseURL, destinationDirectory: destination, suggestedFilename: "result.bin"),
                workDirectory: root.appendingPathComponent("work"))
            do {
                _ = try await engine.start()
                XCTFail("Malformed capability probe must fail")
            } catch let error as EngineError {
                guard case .invalidResponse = error else { return XCTFail("Unexpected error: \(error)") }
            }
            XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-0"])
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("result.bin").path))
        }
    }

    func testUnknownTotalByteZeroProbeFallsBackToCleanIdentityStream() async throws {
        let payload = Data((0..<(64 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload,
            rangeContentRange: { _, _, _ in "bytes 0-0/*" }, headStatus: 405)
        try server.start()
        defer { server.stop() }
        let root = try directory(), destination = root.appendingPathComponent("downloads")
        let engine = DownloadEngine(taskID: 1,
            request: DownloadRequest(url: server.baseURL, connections: 4,
                destinationDirectory: destination, suggestedFilename: "result.bin"),
            workDirectory: root.appendingPathComponent("work"))
        let file = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedMethods, ["HEAD", "GET", "GET"])
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-0"],
            "A legal unknown total must not authorize payload Range requests")
        XCTAssertEqual(server.recordedHeaders.map { $0["range"] }, [nil, "bytes=0-0", nil])
        XCTAssertTrue(server.recordedHeaders.allSatisfy { $0["accept-encoding"] == "identity" })
        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.totalBytes, Int64(payload.count))
        XCTAssertEqual(progress.completedBytes, Int64(payload.count))
        XCTAssertEqual(progress.status, .complete)
    }

    func testEOFDelimitedRangeStillChecksBodyLength() async throws {
        let server = LocalRangeServer(payload: Data(0..<64), truncateRangeBody: { _, _ in 13 }, omitRangeContentLength: true)
        try server.start()
        defer { server.stop() }
        let part = try directory().appendingPathComponent("seg.x0")
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=0-63", forHTTPHeaderField: "Range")
        do {
            _ = try await RangeStreamDownloader.download(request: request, to: part,
                expectedValidator: .etag(server.entityTag), expectedTotal: 64,
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
            XCTFail("EOF without transport error must still detect a short Range body")
        } catch let error as EngineError {
            guard case .incompleteResponse(expected: 64, received: 13) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
        }
        XCTAssertEqual(try Data(contentsOf: part), Data(0..<13))
    }

    func testEOFDelimitedDisconnectResumesExactValidatedSuffix() async throws {
        let payload = Data((0..<(64 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload,
            truncateRangeBody: { _, ordinal in ordinal == 1 ? 13 : nil }, omitRangeContentLength: true)
        try server.start()
        defer { server.stop() }
        let root = try directory(), destination = root.appendingPathComponent("downloads")
        let engine = DownloadEngine(taskID: 1,
            request: DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: destination, suggestedFilename: "result.bin"),
            workDirectory: root.appendingPathComponent("work"))
        let file = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.truncatedResponses, 1)
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-65535", "Range: bytes=13-65535"])
    }

    func testCapturedCompressionPreferenceCannotOverrideIdentityRequests() async throws {
        for sendsValidator in [true, false] {
            let payload = Data((0..<(64 * 1024)).map { UInt8($0 % 251) })
            let server = LocalRangeServer(payload: payload, sendsValidator: sendsValidator)
            try server.start()
            defer { server.stop() }
            let root = try directory(), destination = root.appendingPathComponent("downloads")
            var request = DownloadRequest(url: server.baseURL, connections: 1,
                destinationDirectory: destination, suggestedFilename: "result.bin")
            request.headers["aCcEpT-EnCoDiNg"] = "gzip, br"
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: root.appendingPathComponent("work"))
            let file = try await engine.start()
            XCTAssertEqual(try Data(contentsOf: file), payload)
            XCTAssertEqual(server.recordedMethods, ["HEAD", "GET"])
            XCTAssertTrue(server.recordedHeaders.allSatisfy { $0["accept-encoding"] == "identity" })
            XCTAssertEqual(server.recordedRanges.count, sendsValidator ? 1 : 0,
                "Exercise both a validated Range and a clean stream")
        }
    }

    func testSwiftTaskCancellationClosesRequestWithoutWaitingForResponse() async throws {
        let server = LocalRangeServer(payload: Data(0..<64), responseDelay: 2)
        try server.start()
        defer { server.stop() }
        let part = try directory().appendingPathComponent("seg.x0")
        let request = URLRequest(url: server.baseURL)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: part,
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        }
        for _ in 0..<100 {
            if !server.recordedMethods.isEmpty { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertFalse(server.recordedMethods.isEmpty)
        let cancelledAt = ProcessInfo.processInfo.systemUptime
        transfer.cancel()
        do {
            _ = try await transfer.value
            XCTFail("Cancelling the Swift task must cancel its URLSession request")
        } catch { }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - cancelledAt, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
    }
    private final class TransferOutcome: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Result<URL, Error>?
        func record(_ value: Result<URL, Error>) {
            lock.lock(); defer { lock.unlock() }
            stored = value
        }
        var result: Result<URL, Error>? {
            lock.lock(); defer { lock.unlock() }
            return stored
        }
    }

    func testZeroProgressEOFBackoffPauseAndCancelPreserveCommittedPrefix() async throws {
        for shouldPause in [true, false] {
            let payload = Data((0..<(64 * 1024)).map { UInt8($0 % 251) })
            let server = LocalRangeServer(payload: payload,
                truncateRangeBody: { _, ordinal in ordinal == 1 ? 13 : 0 },
                omitRangeContentLength: true)
            try server.start()
            defer { server.stop() }
            let root = try directory(), work = root.appendingPathComponent("work")
            let destination = root.appendingPathComponent("downloads")
            let engine = DownloadEngine(taskID: 1,
                request: DownloadRequest(url: server.baseURL, connections: 1,
                    destinationDirectory: destination, suggestedFilename: "result.bin"),
                workDirectory: work)
            let outcome = TransferOutcome()
            let running = Task {
                do { outcome.record(.success(try await engine.start())) }
                catch { outcome.record(.failure(error)) }
            }
            defer { running.cancel() }
            // Observe a zero-byte EOF after saving the first prefix; all polling
            // has deadlines so a broken control cannot hang this regression.
            let retryDeadline = ProcessInfo.processInfo.systemUptime + 15
            while server.truncatedResponses < 2 && outcome.result == nil
                && ProcessInfo.processInfo.systemUptime < retryDeadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTAssertGreaterThanOrEqual(server.truncatedResponses, 2)
            XCTAssertNil(outcome.result, "Validated zero-progress EOF remains recoverable")
            XCTAssertEqual(Array(server.recordedRanges.prefix(2)),
                ["Range: bytes=0-65535", "Range: bytes=13-65535"])
            try await Task.sleep(nanoseconds: 100_000_000)
            let stoppedAt = ProcessInfo.processInfo.systemUptime
            if shouldPause { await engine.pause() } else { await engine.cancel() }
            while outcome.result == nil && ProcessInfo.processInfo.systemUptime < stoppedAt + 1 {
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            guard let result = outcome.result else {
                XCTFail("Pause/cancel must drain a zero-progress EOF retry within one second")
                continue
            }
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - stoppedAt, 1)
            switch result {
            case .success: XCTFail("Interrupted transfer must not publish a result")
            case .failure(let error):
                guard let error = error as? EngineError else {
                    XCTFail("Unexpected terminal error: \(error)")
                    continue
                }
                switch error {
                case .paused: XCTAssertTrue(shouldPause)
                case .cancelled: XCTAssertFalse(shouldPause)
                default: XCTFail("Unexpected terminal engine error: \(error)")
                }
            }
            let rangesAfterStop = server.recordedRanges
            try await Task.sleep(nanoseconds: 250_000_000)
            XCTAssertEqual(server.recordedRanges, rangesAfterStop, "No retry after control settles")
            let progress = await engine.currentProgress()
            XCTAssertEqual(progress.status, shouldPause ? .paused : .incomplete)
            XCTAssertEqual(progress.completedBytes, 13)
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("result.bin").path))
            let persisted = try XCTUnwrap(OffsetDownloadStorage.persistedProgress(taskID: 1, workDirectory: work))
            XCTAssertEqual(persisted.totalBytes, Int64(payload.count))
            XCTAssertEqual(persisted.completedBytes, 13)
            let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: work))
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work,
                resourceContextHash: identity.storageContextHash)
            XCTAssertEqual(recovered.writtenPrefix(segmentID: 0), 13)
            XCTAssertEqual(recovered.snapshot().reduce(Int64(0)) { $0 + $1.durablePrefix }, 13)
            XCTAssertEqual(try Data(contentsOf: recovered.partialURL).prefix(13), payload.prefix(13))
        }
    }

}
