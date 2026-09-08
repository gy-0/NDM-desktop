import XCTest
import Foundation
import NDMCore
@testable import NDMEngine

final class RangeTransferLeaseTests: XCTestCase {
    func testProxyChallengeUsesProxyCredentialsWithoutOriginAuthorization() async throws {
        let payload = Data(repeating: 0x33, count: 65536)
        let server = LocalRangeServer(payload: payload, injectedRangeFailureStatus: 407,
            injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: 1)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let destination = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 1,
            destinationDirectory: destination, suggestedFilename: "result.bin"), workDirectory: root.appendingPathComponent("work"),
            httpProxy: ProxySettings(host: "127.0.0.1", port: server.port, username: "proxy", password: "secret", enabled: true))
        let result = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: result), payload)
        XCTAssertEqual(server.recordedRanges.count, 2)
        let headers = try XCTUnwrap(server.recordedHeaders.last)
        XCTAssertEqual(headers["proxy-authorization"], "Basic " + Data("proxy:secret".utf8).base64EncodedString())
        XCTAssertNil(headers["authorization"])
    }

    func testBasicAuthenticationRetryUsesDonorsLatestBoundary() async throws {
        for challenge in ["Basic realm=\"fixture\""] {
            let firstLength = 256 * 1024
            let payload = Data((0..<(4 * 1024 * 1024)).map { UInt8($0 % 251) })
            // Admit the donor after a real first-body prefix, before the fast
            // segment finishes and splits its tail during the delayed challenge.
            let server = LocalRangeServer(payload: payload, authenticationChallenge: challenge,
                bodyChunkSize: 8192, bodyChunkDelay: { $0 == 0 ? 0.005 : 0 },
                rangeResponseDelay: { $0 == 0 ? 0.03 : 0.3 },
                injectedRangeFailureStatus: 401, injectRangeFailureAfterCount: 0,
                injectedRangeFailureLimit: 1, injectedRangeFailureStartAtOrAbove: firstLength)
            try server.start(); defer { server.stop() }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let work = root.appendingPathComponent("work")
            let destination = root.appendingPathComponent("output")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let plan = [
                SegmentRecord(order: 0, segmentId: 0, nextId: 1, start: 0, end: Int64(firstLength - 1)),
                SegmentRecord(order: 1, segmentId: 1, nextId: -1, start: Int64(firstLength), end: Int64(payload.count - 1))
            ]
            try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            let request = DownloadRequest(url: server.baseURL, connections: 2, destinationDirectory: destination,
                                          suggestedFilename: "result.bin", username: "fixture", password: "fixture")
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
            let result = try await engine.start()
            XCTAssertEqual(try Data(contentsOf: result), payload)
            let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
            let donor = server.recordedRanges.filter { $0.contains("bytes=\(firstLength)-") }
            XCTAssertEqual(donor.count, 2, "Initial challenge plus one authentication retry")
            XCTAssertEqual(donor.filter { $0.contains("-\(payload.count - 1)") }.count, 1,
                           "The authentication retry must not request the old full donor tail: \(server.recordedRanges) \(log)")
        }
    }

    private func waitForPrefix(_ lease: RangeTransferLease, minimum: Int64 = 65536) async throws {
        for _ in 0..<500 {
            if lease.withLock({ lease.completed >= minimum }) { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("Stream never wrote the required prefix")
        throw EngineError.invalidResponse
    }

    func testBasicAuthenticationWithoutCredentialsFailsWithoutPublishing() async throws {
        for challenge in ["Basic realm=\"fixture\""] {
            let server = LocalRangeServer(payload: Data(repeating: 0x13, count: 65536), authenticationChallenge: challenge,
                injectedRangeFailureStatus: 401, injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: 10)
            try server.start(); defer { server.stop() }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let destination = root.appendingPathComponent("output")
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 1,
                destinationDirectory: destination, suggestedFilename: "result.bin"), workDirectory: root.appendingPathComponent("work"))
            do { _ = try await engine.start(); XCTFail("Authentication must not be silently accepted") }
            catch let error as EngineError {
                guard case .authRequired = error else { return XCTFail("Wrong error: \(error)") }
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("result.bin").path))
            XCTAssertEqual(server.recordedRanges.count, 1)
        }
    }

    private func request(_ server: LocalRangeServer, count: Int) -> URLRequest {
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=0-\(count - 1)", forHTTPHeaderField: "Range")
        return request
    }

    func testTwoLiveShrinksKeepOriginalResponseAndClipCrossingCallback() async throws {
        let payload = Data((0..<(2 * 1024 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537, bodyChunkDelay: { _ in 0.02 })
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: Int64(payload.count - 1)), completed: 0)
        let request = request(server, count: payload.count)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: file, lease: lease,
                expectedValidator: .etag(server.entityTag), expectedTotal: Int64(payload.count),
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        }
        try await waitForPrefix(lease)
        lease.withLock { lease.segment.end = 1_500_001 }
        try await waitForPrefix(lease, minimum: 262144)
        lease.withLock { lease.segment.end = 900_007 }
        let result = try await transfer.value
        XCTAssertEqual(result.bytesWritten, 900_008)
        XCTAssertEqual(try Data(contentsOf: file), payload.prefix(900_008))
        XCTAssertEqual(server.recordedRanges.count, 1)
        XCTAssertTrue(server.recordedRanges[0].contains("bytes=0-\(payload.count - 1)"))
        XCTAssertEqual(lease.withLock { lease.completed }, 900_008)
    }

    func testPauseDuringLiveShrinkStopsWriterWithoutLateAppend() async throws {
        let payload = Data(repeating: 0x57, count: 2 * 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537, bodyChunkDelay: { _ in 0.02 })
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: Int64(payload.count - 1)), completed: 0)
        let token = CancelToken()
        let request = request(server, count: payload.count)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: file, lease: lease,
                append: false, isCancelled: { token.isCancelled }, cancellationTokens: [token], limiter: nil, onBytes: { _ in })
        }
        try await waitForPrefix(lease)
        lease.withLock { lease.segment.end = 1_500_001 }
        token.pause()
        do { _ = try await transfer.value; XCTFail("Pause must fail the transfer") } catch {}
        let stopped = try Data(contentsOf: file)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(try Data(contentsOf: file), stopped)
        XCTAssertEqual(stopped, payload.prefix(stopped.count))
        XCTAssertLessThan(stopped.count, 1_500_002)
    }

    func testFailedPlanCommitLeavesLiveOwnershipUnchanged() async throws {
        let payload = Data(repeating: 0x37, count: 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537, bodyChunkDelay: { _ in 0.01 })
        try server.start(); defer { server.stop() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("part")
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: Int64(payload.count - 1)), completed: 0)
        let request = request(server, count: payload.count)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: file, lease: lease,
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        }
        try await waitForPrefix(lease)
        XCTAssertThrowsError(try lease.withLock {
            // A directory cannot be replaced by an atomic metadata file.
            try Data("new plan".utf8).write(to: directory, options: .atomic)
            lease.segment.end = 500_003
        })
        _ = try await transfer.value
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(lease.withLock { lease.segment.end }, Int64(payload.count - 1))
        XCTAssertEqual(server.recordedRanges.count, 1)
    }

    func testShortenedLeaseDoesNotRelaxOriginalResponseIdentity() async throws {
        let payload = Data(repeating: 0x42, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: 65535), completed: 0)
        do {
            _ = try await RangeStreamDownloader.download(request: request(server, count: payload.count), to: file, lease: lease,
                expectedValidator: .etag("\"different\""), expectedTotal: Int64(payload.count),
                append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
            XCTFail("A shorter lease cannot accept another representation")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(lease.withLock { lease.completed }, 0)
    }
}
