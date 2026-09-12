import XCTest
import Foundation
import Darwin
import NDMCore
@testable import NDMEngine

/// Deliver one oversized URLSession callback, independent of TCP packet coalescing.
private final class QuotaBurstProtocol: URLProtocol, @unchecked Sendable {
    static let payload = Data((0..<(4 * 1024 * 1024)).map { UInt8($0 % 251) })
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "ndm-quota-test.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let response = HTTPURLResponse(url: request.url!, statusCode: 206, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Range": "bytes 0-\(Self.payload.count - 1)/\(Self.payload.count)",
            "Content-Length": "\(Self.payload.count)"
        ])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.payload)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class RangeStreamQuotaProgressTests: XCTestCase {
    private final class Progress: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Int64] = []
        func append(_ value: Int64) { lock.lock(); values.append(value); lock.unlock() }
        var snapshot: [Int64] { lock.lock(); defer { lock.unlock() }; return values }
    }

    private func checkPauseDuringLargeCallback(offset: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("seg.x0")
        let total = Int64(QuotaBurstProtocol.payload.count)
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1,
            start: 0, end: total - 1), completed: 0)
        let storage = try offset ? OffsetDownloadStorage.create(taskID: 1, workDirectory: root,
            destinationURL: root.appendingPathComponent("result.bin"), totalBytes: total,
            resourceContextHash: "quota-fixture", ranges: [.init(id: 0, start: 0, end: total - 1, durablePrefix: 0)]) : nil
        let token = CancelToken()
        let limiter = BandwidthLimiter(bytesPerSecond: 1024 * 1024)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QuotaBurstProtocol.self]
        var request = URLRequest(url: URL(string: "https://ndm-quota-test.invalid/file")!)
        request.setValue("bytes=0-\(total - 1)", forHTTPHeaderField: "Range")
        let progress = Progress()
        let firstProgress = expectation(description: "Quota-sized prefix is written before the whole callback is admitted")
        firstProgress.assertForOverFulfill = false
        let finished = expectation(description: "Pause drains the active writer")
        let transfer = Task {
            defer { finished.fulfill() }
            do {
                _ = try await RangeStreamDownloader.download(request: request, to: file, lease: lease,
                    offsetStorage: storage, append: false, isCancelled: { token.isCancelled },
                    cancellationTokens: [token], limiter: limiter, sessionConfiguration: configuration, onBytes: { count in
                        progress.append(count)
                        if count >= 1024 * 1024 { firstProgress.fulfill() }
                    })
                return false
            } catch let error as EngineError {
                if case .cancelled = error { return true }
                return false
            } catch { return false }
        }
        await fulfillment(of: [firstProgress], timeout: 0.8)
        try await Task.sleep(nanoseconds: 100_000_000) // The next prefix is now waiting for the exhausted quota.
        token.pause() // Also drains the old all-or-nothing implementation after a red assertion.
        await fulfillment(of: [finished], timeout: 0.5)
        limiter.updateLimit(0)
        let cancelled = await transfer.value
        XCTAssertTrue(cancelled)
        let prefix = lease.withLock { lease.completed }
        XCTAssertGreaterThan(prefix, 0, "Already admitted quota must become a resumable disk prefix")
        XCTAssertLessThanOrEqual(prefix, 1024 * 1024)
        XCTAssertEqual(progress.snapshot.last, prefix, "Final progress must agree with the exact saved prefix")
        let sink = storage?.partialURL ?? file
        let content = try Data(contentsOf: sink)
        XCTAssertEqual(content.prefix(Int(prefix)), QuotaBurstProtocol.payload.prefix(Int(prefix)))
        if let storage {
            XCTAssertEqual(storage.writtenPrefix(segmentID: 0), prefix)
            XCTAssertEqual(storage.snapshot().first?.durablePrefix, 0, "The stream must not checkpoint its owner's storage")
            XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        } else {
            XCTAssertEqual(content.count, Int(prefix))
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(try Data(contentsOf: sink), content, "Paused writers must never append later")
    }

    func testLargeCallbackReportsAndPreservesLegacyPrefixBeforePause() async throws {
        try await checkPauseDuringLargeCallback(offset: false)
    }

    func testLargeCallbackReportsAndPreservesOffsetPrefixBeforePause() async throws {
        try await checkPauseDuringLargeCallback(offset: true)
    }

    func testPartialWriteFailureReportsExactSavedPrefixBeforeReturning() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let total = Int64(QuotaBurstProtocol.payload.count)
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1,
            start: 0, end: total - 1), completed: 0)
        var io = OffsetDownloadStorage.IO()
        io.write = { fd, bytes, count, offset in
            if offset >= 7 { errno = ENOSPC; return -1 }
            return pwrite(fd, bytes, min(count, 7 - Int(offset)), offset)
        }
        let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: root,
            destinationURL: root.appendingPathComponent("result.bin"), totalBytes: total,
            resourceContextHash: "quota-fixture", ranges: [.init(id: 0, start: 0, end: total - 1, durablePrefix: 0)], io: io)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [QuotaBurstProtocol.self]
        var request = URLRequest(url: URL(string: "https://ndm-quota-test.invalid/file")!)
        request.setValue("bytes=0-\(total - 1)", forHTTPHeaderField: "Range")
        let progress = Progress()
        do {
            _ = try await RangeStreamDownloader.download(request: request, to: root.appendingPathComponent("seg.x0"),
                lease: lease, offsetStorage: storage, append: false, isCancelled: { false }, limiter: nil,
                sessionConfiguration: configuration, onBytes: { progress.append($0) })
            XCTFail("Injected disk-full must fail")
        } catch let error as POSIXError { XCTAssertEqual(error.code, .ENOSPC) }
        XCTAssertEqual(storage.writtenPrefix(segmentID: 0), 7)
        XCTAssertEqual(lease.withLock { lease.completed }, 7)
        XCTAssertEqual(progress.snapshot, [7], "Even a prefix below the reporting threshold must reach the engine before failure returns")
        XCTAssertEqual(try Data(contentsOf: storage.partialURL).prefix(7), QuotaBurstProtocol.payload.prefix(7))
        try storage.checkpoint() // The range writer does not close the shared storage.
    }
}
