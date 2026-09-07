import XCTest
import Foundation
import Darwin
import NDMCore
@testable import NDMEngine

final class RangeStreamOffsetStorageTests: XCTestCase {
    private func root() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func lease(_ id: Int16, _ start: Int64, _ end: Int64) -> RangeTransferLease {
        RangeTransferLease(segment: SegmentRecord(order: id, segmentId: id, nextId: -1, start: start, end: end), completed: 0)
    }

    private func request(_ server: LocalRangeServer, start: Int64, end: Int64) -> URLRequest {
        var request = URLRequest(url: server.baseURL)
        request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
        return request
    }

    private func transfer(_ server: LocalRangeServer, storage: OffsetDownloadStorage, lease: RangeTransferLease,
                          start: Int64, end: Int64, legacy: URL, total: Int64) async throws -> RangeStreamDownloader.Result {
        try await RangeStreamDownloader.download(request: request(server, start: start, end: end), to: legacy,
            lease: lease, offsetStorage: storage, expectedValidator: .etag(server.entityTag), expectedTotal: total,
            append: false, isCancelled: { false }, limiter: nil, onBytes: { _ in })
    }

    func testOutOfOrderRangesWriteAtAbsoluteOffsetsWithoutPublishingOrLegacyFiles() async throws {
        let directory = try root(), payload = Data(0..<64)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let target = directory.appendingPathComponent("result.bin"), legacy = directory.appendingPathComponent("seg.x0")
        let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: directory, destinationURL: target,
            totalBytes: 64, resourceContextHash: "fixture", ranges: [
                .init(id: 0, start: 0, end: 31, durablePrefix: 0), .init(id: 1, start: 32, end: 63, durablePrefix: 0)])
        let tail = lease(1, 32, 63)
        let first = try await transfer(server, storage: storage, lease: tail, start: 32, end: 63, legacy: legacy, total: 64)
        XCTAssertEqual(first.bytesWritten, 32)
        XCTAssertEqual(tail.withLock { tail.completed }, 32)
        XCTAssertEqual(storage.snapshot().map(\.durablePrefix), [0, 0], "Streams must not checkpoint the shared backend")
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        let head = lease(0, 0, 31)
        _ = try await transfer(server, storage: storage, lease: head, start: 0, end: 31, legacy: legacy, total: 64)
        XCTAssertEqual(try Data(contentsOf: storage.partialURL), payload)
        XCTAssertFalse(storage.isPublished)
        try storage.publish() // Only the owner may publish after all writers finish.
        XCTAssertEqual(try Data(contentsOf: target), payload)
    }

    func testResumeUsesBackendWrittenPrefixInsteadOfStaleLeaseOrLegacyFile() async throws {
        let directory = try root(), payload = Data(0..<64)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let target = directory.appendingPathComponent("result.bin"), legacy = directory.appendingPathComponent("seg.x0")
        try Data(repeating: 99, count: 20).write(to: legacy)
        let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: directory, destinationURL: target,
            totalBytes: 64, resourceContextHash: "fixture", ranges: [.init(id: 0, start: 0, end: 63, durablePrefix: 0)])
        try storage.write(segmentID: 0, data: payload.prefix(11))
        let owned = lease(0, 0, 63)
        let result = try await transfer(server, storage: storage, lease: owned, start: 11, end: 63, legacy: legacy, total: 64)
        XCTAssertEqual(result.bytesWritten, 53)
        XCTAssertEqual(owned.withLock { owned.completed }, 64)
        XCTAssertEqual(try Data(contentsOf: storage.partialURL), payload)
        XCTAssertEqual(try Data(contentsOf: legacy), Data(repeating: 99, count: 20))
        XCTAssertEqual(storage.snapshot()[0].durablePrefix, 0)
    }

    func testIgnoredRangeAndWrongResumeOffsetLeaveBothSinksUntouched() async throws {
        for ignoresRange in [true, false] {
            let directory = try root(), payload = Data(0..<64)
            let server = LocalRangeServer(payload: payload, ignoresRangeRequests: ignoresRange)
            try server.start(); defer { server.stop() }
            let target = directory.appendingPathComponent("result.bin"), legacy = directory.appendingPathComponent("seg.x0")
            let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: directory, destinationURL: target,
                totalBytes: 64, resourceContextHash: "fixture", ranges: [.init(id: 0, start: 0, end: 63, durablePrefix: 0)])
            try storage.write(segmentID: 0, data: payload.prefix(11))
            let before = try Data(contentsOf: storage.partialURL)
            do {
                _ = try await transfer(server, storage: storage, lease: lease(0, 0, 63),
                    start: ignoresRange ? 11 : 10, end: 63, legacy: legacy, total: 64)
                XCTFail("An ignored Range or mismatched resume offset must fail")
            } catch let error as EngineError {
                if ignoresRange { guard case .notResumable = error else { return XCTFail("Wrong error: \(error)") } }
                else { guard case .invalidResponse = error else { return XCTFail("Wrong error: \(error)") } }
            }
            XCTAssertEqual(storage.writtenPrefix(segmentID: 0), 11)
            XCTAssertEqual(try Data(contentsOf: storage.partialURL), before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        }
    }

    func testShortWriteThenDiskFullKeepsExactLeasePrefixAndBackendUsable() async throws {
        let directory = try root(), payload = Data(0..<64)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let target = directory.appendingPathComponent("result.bin"), legacy = directory.appendingPathComponent("seg.x0")
        var io = OffsetDownloadStorage.IO()
        io.write = { fd, bytes, count, offset in
            if offset >= 7 { errno = ENOSPC; return -1 }
            return pwrite(fd, bytes, min(count, 7 - Int(offset)), offset)
        }
        let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: directory, destinationURL: target,
            totalBytes: 64, resourceContextHash: "fixture", ranges: [.init(id: 0, start: 0, end: 63, durablePrefix: 0)], io: io)
        let owned = lease(0, 0, 63)
        do {
            _ = try await transfer(server, storage: storage, lease: owned, start: 0, end: 63, legacy: legacy, total: 64)
            XCTFail("Injected disk-full must fail")
        } catch let error as POSIXError { XCTAssertEqual(error.code, .ENOSPC) }
        XCTAssertEqual(owned.withLock { owned.completed }, 7)
        XCTAssertEqual(storage.writtenPrefix(segmentID: 0), 7)
        XCTAssertEqual(storage.snapshot()[0].durablePrefix, 0)
        try storage.checkpoint() // Stream failure did not close the shared descriptor.
        let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: directory, resourceContextHash: "fixture")
        _ = try await transfer(server, storage: recovered, lease: owned, start: 7, end: 63, legacy: legacy, total: 64)
        try recovered.publish()
        XCTAssertEqual(try Data(contentsOf: target), payload)
    }
    func testLiveOwnershipShrinkClipsResponseWithoutClosingSiblingSink() async throws {
        let directory = try root()
        let payload = Data((0..<(1024 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537, bodyChunkDelay: { _ in 0.02 })
        try server.start(); defer { server.stop() }
        let target = directory.appendingPathComponent("result.bin"), legacy = directory.appendingPathComponent("seg.x0")
        let total = Int64(payload.count), cut: Int64 = 524291
        let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: directory, destinationURL: target,
            totalBytes: total, resourceContextHash: "fixture", ranges: [.init(id: 0, start: 0, end: total - 1, durablePrefix: 0)])
        let owned = lease(0, 0, total - 1)
        let transferTask = Task {
            try await self.transfer(server, storage: storage, lease: owned, start: 0, end: total - 1, legacy: legacy, total: total)
        }
        for _ in 0..<300 {
            if owned.withLock({ owned.completed >= 65536 }) { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try owned.withLock {
            XCTAssertGreaterThanOrEqual(owned.completed, 65536)
            guard owned.completed < cut else { throw EngineError.invalidResponse }
            try storage.replacePlan([
                .init(id: 0, start: 0, end: cut - 1, durablePrefix: owned.completed),
                .init(id: 1, start: cut, end: total - 1, durablePrefix: 0)])
            owned.segment.end = cut - 1
        }
        let result = try await transferTask.value
        XCTAssertEqual(result.bytesWritten, cut)
        XCTAssertEqual(owned.withLock { owned.completed }, cut)
        XCTAssertEqual(storage.writtenPrefix(segmentID: 1), 0)
        _ = try await transfer(server, storage: storage, lease: lease(1, cut, total - 1),
            start: cut, end: total - 1, legacy: legacy, total: total)
        XCTAssertEqual(try Data(contentsOf: storage.partialURL), payload)
        XCTAssertFalse(storage.isPublished)
    }

}
