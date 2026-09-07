import XCTest
import Foundation
import Darwin
@testable import NDMEngine

/// Invoked only by qa-offset-storage-crash.mjs in a separate test process.
final class OffsetStorageProcessTests: XCTestCase {
    func testProcessFixture() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["NDM_OFFSET_QA_ROOT"], let mode = environment["NDM_OFFSET_QA_MODE"] else {
            throw XCTSkip("Requires isolated process-crash harness")
        }
        let root = URL(fileURLWithPath: path), work = root.appendingPathComponent("work")
        let final = root.appendingPathComponent("result.bin")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let count = 32, partSize: Int64 = 131072, total = Int64(count) * partSize
        let ranges = (0..<count).map { id in OffsetDownloadStorage.Range(id: Int16(id), start: Int64(id) * partSize,
            end: Int64(id + 1) * partSize - 1, durablePrefix: 0) }
        let storage: OffsetDownloadStorage
        if mode == "crash" {
            storage = try .create(taskID: 42, workDirectory: work, destinationURL: final,
                totalBytes: total, resourceContextHash: "fixture-context-sha256", ranges: ranges)
        } else {
            storage = try .recover(taskID: 42, workDirectory: work, resourceContextHash: "fixture-context-sha256")
            XCTAssertEqual(storage.snapshot().map(\.durablePrefix), Array(repeating: partSize / 2, count: count))
        }
        for range in storage.snapshot() {
            let limit = mode == "crash" ? partSize / 2 : partSize
            let amount = Int(limit - range.durablePrefix)
            let start = range.start + range.durablePrefix
            let data = Data((0..<amount).map { UInt8((start + Int64($0)) % 251) })
            _ = try storage.write(segmentID: range.id, data: data)
        }
        try storage.checkpoint()
        if mode == "crash" {
            // A tail that is written but not checkpointed must not become trusted.
            _ = try storage.write(segmentID: 0, data: Data(repeating: 255, count: 1024))
            try Data("ready".utf8).write(to: root.appendingPathComponent("ready"))
            while true { usleep(100000) }
        }
        let published = try storage.publish()
        XCTAssertEqual(published, final)
        XCTAssertTrue(storage.isPublished)
        let recovered = try OffsetDownloadStorage.recover(taskID: 42, workDirectory: work,
            resourceContextHash: "fixture-context-sha256")
        XCTAssertTrue(recovered.isPublished)
    }
}
