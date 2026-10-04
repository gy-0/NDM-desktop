import XCTest
import Foundation
import NDMCore
@testable import NDMEngine

final class PreparedRangeResponseTests: XCTestCase {
    private actor StorageCapture {
        var storage: OffsetDownloadStorage?
        func save(_ value: OffsetDownloadStorage) { storage = value }
    }
    private actor Gate {
        var entered = false
        private var continuation: CheckedContinuation<Void, Never>?
        func wait() async {
            entered = true
            await withCheckedContinuation { continuation = $0 }
        }
        func release() { continuation?.resume(); continuation = nil }
    }

    private func waitForGate(_ gate: Gate) async throws {
        for _ in 0..<500 {
            if await gate.entered { return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw EngineError.invalidResponse
    }

    private func request(_ server: LocalRangeServer) -> URLRequest {
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=0-", forHTTPHeaderField: "Range")
        return request
    }

    private func lease(_ length: Int) -> RangeTransferLease {
        RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1,
            start: 0, end: Int64(length - 1)), completed: 0)
    }

    func testOpenResponseWaitsForOwnershipAndWritesOnlyAssignedPrefix() async throws {
        let payload = Data((0..<524288).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537, bodyChunkDelay: { _ in 0.005 })
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let unused = root.appendingPathComponent("unused"), file = root.appendingPathComponent("owned")
        let gate = Gate(), ownership = lease(payload.count), request = request(server)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: unused, lease: ownership,
                expectedValidator: .etag(server.entityTag), expectedTotal: Int64(payload.count), append: false,
                prepareRangeBody: { response in
                    XCTAssertEqual(response.statusCode, 206)
                    await gate.wait()
                    ownership.withLock { ownership.segment.end = 98303 }
                    return .init(fileURL: file, offsetStorage: nil)
                }, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        }
        try await waitForGate(gate)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: unused.path))
        await gate.release()
        let result = try await transfer.value
        XCTAssertEqual(result.bytesWritten, 98304)
        XCTAssertEqual(try Data(contentsOf: file), payload.prefix(98304))
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-"], "The metadata response itself carries the assigned payload")
    }

    func testCancellationDuringPreparationReturnsWithoutWaitingForPlanner() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 7, count: 65536))
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let gate = Gate(), token = CancelToken(), ownership = lease(65536), request = request(server)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: file, lease: ownership, append: false,
                prepareRangeBody: { _ in
                    await gate.wait() // Deliberately does not honor Task cancellation.
                    return .init(fileURL: file, offsetStorage: nil)
                }, isCancelled: { token.isCancelled }, cancellationTokens: [token], limiter: nil, onBytes: { _ in })
        }
        try await waitForGate(gate)
        let watchdog = Task { try? await Task.sleep(nanoseconds: 2_000_000_000); await gate.release() }
        let start = Date()
        token.cancel()
        do { _ = try await transfer.value; XCTFail("Cancelled preparation must fail") }
        catch EngineError.cancelled {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertLessThan(Date().timeIntervalSince(start), 1)
        await gate.release(); watchdog.cancel()
        try await Task.sleep(nanoseconds: 20_000_000)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path), "Late planner completion cannot open a writer")
    }

    func testInvalidIdentityCannotReachPreparationOrTouchDestination() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 7, count: 65536))
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let sentinel = Data("existing contents".utf8)
        try sentinel.write(to: file); defer { try? FileManager.default.removeItem(at: file) }
        do {
            _ = try await RangeStreamDownloader.download(request: request(server), to: file, lease: lease(65536),
                expectedValidator: .etag("\"another-version\""), append: false,
                prepareRangeBody: { _ in
                    XCTFail("Invalid identity must be rejected before planning")
                    return .init(fileURL: file, offsetStorage: nil)
                }, isCancelled: { false }, limiter: nil, onBytes: { _ in })
            XCTFail("Expected identity failure")
        } catch HTTPRepresentationIdentity.Failure.changed {} catch { XCTFail("Unexpected error: \(error)") }
        XCTAssertEqual(try Data(contentsOf: file), sentinel)
    }

    func testSwiftCancellationHookDoesNotWaitForOwnershipLock() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 7, count: 65536))
        try server.start(); defer { server.stop() }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let gate = Gate(), ownership = lease(65536), request = request(server)
        let transfer = Task {
            try await RangeStreamDownloader.download(request: request, to: file, lease: ownership, append: false,
                prepareRangeBody: { _ in
                    await gate.wait()
                    return .init(fileURL: file, offsetStorage: nil)
                }, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        }
        try await waitForGate(gate)
        let acquired = expectation(description: "writer owns lease lock")
        let released = expectation(description: "writer released lease lock")
        let release = DispatchSemaphore(value: 0)
        DispatchQueue(label: "prepared-response-test-writer").async {
            ownership.withLock {
                acquired.fulfill()
                _ = release.wait(timeout: .now() + 2)
            }
            released.fulfill()
        }
        await fulfillment(of: [acquired], timeout: 1)
        let start = Date()
        transfer.cancel()
        XCTAssertLessThan(Date().timeIntervalSince(start), 1,
                          "Swift cancellation hooks cannot synchronously acquire the writer lock")
        release.signal()
        await fulfillment(of: [released], timeout: 1)
        do { _ = try await transfer.value; XCTFail("Cancelled preparation must fail") }
        catch EngineError.cancelled {} catch { XCTFail("Unexpected error: \(error)") }
        await gate.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testPreparedFirstResponseAndNextRangePublishThroughExistingOffsetStorage() async throws {
        let payload = Data((0..<131072).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let work = root.appendingPathComponent("work"), file = root.appendingPathComponent("final.bin")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let capture = StorageCapture(), ownership = lease(payload.count)
        let first = try await RangeStreamDownloader.download(request: request(server), to: file, lease: ownership,
            expectedValidator: .etag(server.entityTag), append: false,
            prepareRangeBody: { response in
                let range = try XCTUnwrap(HTTPFileResponsePolicy.contentRange(response.value(forHTTPHeaderField: "Content-Range")))
                let total = try XCTUnwrap(range.total)
                let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: work, destinationURL: file,
                    totalBytes: total, resourceContextHash: "synthetic-first-response", ranges: [
                        .init(id: 0, start: 0, end: 65535, durablePrefix: 0),
                        .init(id: 1, start: 65536, end: total - 1, durablePrefix: 0)
                    ])
                ownership.withLock { ownership.segment.end = 65535 }
                await capture.save(storage)
                return .init(fileURL: file, offsetStorage: storage)
            }, isCancelled: { false }, limiter: nil, onBytes: { _ in })
        XCTAssertEqual(first.bytesWritten, 65536)
        let captured = await capture.storage
        let storage = try XCTUnwrap(captured)
        XCTAssertEqual(storage.writtenPrefix(segmentID: 0), 65536)
        XCTAssertEqual(storage.writtenPrefix(segmentID: 1), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        var next = request(server)
        next.setValue("bytes=65536-131071", forHTTPHeaderField: "Range")
        let secondLease = RangeTransferLease(segment: SegmentRecord(order: 1, segmentId: 1, nextId: -1,
            start: 65536, end: 131071), completed: 0)
        _ = try await RangeStreamDownloader.download(request: next, to: file, lease: secondLease, offsetStorage: storage,
            expectedValidator: .etag(server.entityTag), expectedTotal: Int64(payload.count), append: false,
            isCancelled: { false }, limiter: nil, onBytes: { _ in })
        try storage.publish()
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-", "Range: bytes=65536-131071"])
    }
}
