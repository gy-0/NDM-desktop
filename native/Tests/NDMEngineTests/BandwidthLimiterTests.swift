import XCTest
import NDMCore
@testable import NDMEngine

final class BandwidthLimiterTests: XCTestCase {
    private final class Results: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Bool] = []
        func append(_ value: Bool) { lock.lock(); values.append(value); lock.unlock() }
        var snapshot: [Bool] { lock.lock(); defer { lock.unlock() }; return values }
    }

    func testCallbackLargerThanOneSecondQuotaEventuallyCompletes() {
        let limiter = BandwidthLimiter(bytesPerSecond: 128)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            limiter.consume(256)
            finished.signal()
        }
        let outcome = finished.wait(timeout: .now() + 2)
        // Release a broken old implementation too; never leave a test thread stuck.
        limiter.updateLimit(0)
        if outcome == .timedOut { XCTAssertEqual(finished.wait(timeout: .now() + 1), .success) }
        XCTAssertEqual(outcome, .success, "A callback larger than the quota must advance across windows")
    }

    func testConcurrentWorkersShareOneQuota() {
        let limiter = BandwidthLimiter(bytesPerSecond: 128)
        let group = DispatchGroup()
        let results = Results()
        let began = ProcessInfo.processInfo.systemUptime
        for _ in 0..<3 {
            group.enter()
            DispatchQueue.global().async { results.append(limiter.consume(128)); group.leave() }
        }
        let outcome = group.wait(timeout: .now() + 4)
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        limiter.updateLimit(0)
        XCTAssertEqual(group.wait(timeout: .now() + 1), .success)
        XCTAssertEqual(outcome, .success)
        XCTAssertGreaterThanOrEqual(elapsed, 1.9, "Three workers cannot each get a private initial quota")
        XCTAssertEqual(results.snapshot, [true, true, true])
    }

    func testCancellationInterruptsAnOversizedWaitingCallback() {
        let limiter = BandwidthLimiter(bytesPerSecond: 1)
        let token = CancelToken()
        let entered = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        let results = Results()
        DispatchQueue.global().async {
            results.append(limiter.consume(65536, isCancelled: { entered.signal(); return token.isCancelled }))
            finished.signal()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
        token.pause()
        let outcome = finished.wait(timeout: .now() + 0.5)
        limiter.updateLimit(0)
        if outcome == .timedOut { _ = finished.wait(timeout: .now() + 1) }
        XCTAssertEqual(outcome, .success)
        XCTAssertEqual(results.snapshot, [false])
    }

    func testChangingLimitUnblocksPendingCallbacksAndLowerLimitIsApplied() {
        for newLimit: Int64 in [0, 1024] {
            let limiter = BandwidthLimiter(bytesPerSecond: 1)
            let entered = DispatchSemaphore(value: 0)
            let finished = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                limiter.consume(128, isCancelled: { entered.signal(); return false })
                finished.signal()
            }
            XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
            limiter.updateLimit(newLimit)
            let outcome = finished.wait(timeout: .now() + 0.5)
            limiter.updateLimit(0)
            if outcome == .timedOut { _ = finished.wait(timeout: .now() + 1) }
            XCTAssertEqual(outcome, .success)
        }
        let limiter = BandwidthLimiter(bytesPerSecond: 128)
        XCTAssertTrue(limiter.consume(128)) // Exhaust the original window first.
        let entered = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            limiter.consume(128, isCancelled: { entered.signal(); return false })
            finished.signal()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
        let began = ProcessInfo.processInfo.systemUptime
        limiter.updateLimit(64)
        let outcome = finished.wait(timeout: .now() + 2.5)
        let elapsed = ProcessInfo.processInfo.systemUptime - began
        limiter.updateLimit(0)
        if outcome == .timedOut { _ = finished.wait(timeout: .now() + 1) }
        XCTAssertEqual(outcome, .success)
        XCTAssertGreaterThanOrEqual(elapsed, 0.95)
    }

    func testPausedRangeDoesNotStayBlockedInsideLimiterOrAppendLater() async throws {
        let payload = Data(repeating: 0x33, count: 65536)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let limiter = BandwidthLimiter(bytesPerSecond: 1)
        let token = CancelToken()
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=0-65535", forHTTPHeaderField: "Range")
        let finished = expectation(description: "Paused range finishes promptly")
        let run = Task {
            defer { finished.fulfill() }
            do {
                _ = try await RangeStreamDownloader.download(request: request, to: file, append: false,
                    isCancelled: { token.isCancelled }, cancellationTokens: [token], limiter: limiter, onBytes: { _ in })
                return false
            } catch let error as EngineError {
                if case .cancelled = error { return true }
                return false
            } catch { return false }
        }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: file.path) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        token.pause()
        await fulfillment(of: [finished], timeout: 0.5)
        limiter.updateLimit(0) // Also drains a regression if the assertion times out.
        let cancelled = await run.value
        XCTAssertTrue(cancelled)
        let stopped = try Data(contentsOf: file)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(try Data(contentsOf: file), stopped)
        XCTAssertLessThan(stopped.count, payload.count)
    }

    func testLeaseShrinkingWhileQuotaIsExhaustedClipsTheLaterWrite() async throws {
        let payload = Data((0..<131072).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let limiter = BandwidthLimiter(bytesPerSecond: 65536)
        XCTAssertTrue(limiter.consume(65536)) // No response body can write in this window.
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1,
                                                             start: 0, end: 131071), completed: 0)
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=0-131071", forHTTPHeaderField: "Range")
        let finished = expectation(description: "Shrunk range finishes across quota windows")
        let run = Task {
            defer { finished.fulfill() }
            return try await RangeStreamDownloader.download(request: request, to: file, lease: lease,
                append: false, isCancelled: { false }, limiter: limiter, onBytes: { _ in })
        }
        for _ in 0..<50 {
            if FileManager.default.fileExists(atPath: file.path) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        lease.withLock {
            XCTAssertEqual(lease.completed, 0, "The response is still waiting for shared quota")
            lease.segment.end = 1023
        }
        await fulfillment(of: [finished], timeout: 3.5)
        limiter.updateLimit(0)
        let result = try await run.value
        XCTAssertEqual(result.bytesWritten, 1024)
        XCTAssertEqual(try Data(contentsOf: file), payload.prefix(1024))
        XCTAssertEqual(server.recordedRanges.count, 1)
    }
}
