import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class LegacyDownloadProgressTests: XCTestCase {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let records = [SegmentRecord(order: 0, segmentId: 0, nextId: 1, start: 0, end: 3),
                       SegmentRecord(order: 1, segmentId: 1, nextId: -1, start: 4, end: 7)]
        try SegmentFileFormat.serialize(records).write(to: root.appendingPathComponent("segments.bin"))
        try Data([1, 2, 3]).write(to: root.appendingPathComponent("seg.x0"))
        try Data([5, 6]).write(to: root.appendingPathComponent("seg.x1"))
        return root
    }

    func testReadsRetainedBytesWithoutChangingPlanOrPayload() throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let names = try FileManager.default.contentsOfDirectory(atPath: root.path).sorted()
        let before = try names.map { try Data(contentsOf: root.appendingPathComponent($0)) }
        XCTAssertEqual(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root)?.completedBytes, 5)
        XCTAssertEqual(try names.map { try Data(contentsOf: root.appendingPathComponent($0)) }, before)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path).sorted(), names)
        try FileManager.default.removeItem(at: root.appendingPathComponent("seg.x1"))
        XCTAssertEqual(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root)?.completedBytes, 3)
    }

    func testRejectsInvalidPlanBoundsAndOversizedParts() throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertNil(try LegacyDownloadProgress.read(totalBytes: 7, workDirectory: root))
        XCTAssertEqual(try LegacyDownloadProgress.read(totalBytes: 0, workDirectory: root)?.totalBytes, 8)
        try Data(repeating: 9, count: 5).write(to: root.appendingPathComponent("seg.x0"))
        XCTAssertNil(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root))
        try SegmentFileFormat.serialize([.init(order: 0, segmentId: 0, nextId: -1, start: 0, end: Int64.max)])
            .write(to: root.appendingPathComponent("segments.bin"))
        XCTAssertNil(try LegacyDownloadProgress.read(totalBytes: 0, workDirectory: root))
        try Data([1]).write(to: root.appendingPathComponent("segments.bin"))
        XCTAssertThrowsError(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root))
    }

    func testCannotUseLegacyFilesToHideInvalidOffsetReceiptOrSymlink() throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let receipt = root.appendingPathComponent("offset-storage-v2.json")
        try Data("invalid".utf8).write(to: receipt)
        XCTAssertNil(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root))
        try FileManager.default.removeItem(at: receipt)
        let segment = root.appendingPathComponent("seg.x0")
        try FileManager.default.removeItem(at: segment)
        try FileManager.default.createSymbolicLink(at: segment, withDestinationURL: root.appendingPathComponent("seg.x1"))
        XCTAssertNil(try LegacyDownloadProgress.read(totalBytes: 8, workDirectory: root))
    }

    func testManagerUsesCurrentGenerationAndKeepsPausedStatus() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let support = root.appendingPathComponent("support")
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root, useCategoryFolders: false), supportRoot: support)
        var task = try await manager.addURL("https://example.test/legacy.bin", connections: 1)
        task.fileSize = 0; task.status = .paused
        try store.update(task)
        let work = support.appendingPathComponent(String(task.id))
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        for name in ["segments.bin", "seg.x0", "seg.x1"] {
            try FileManager.default.copyItem(at: root.appendingPathComponent(name), to: work.appendingPathComponent(name))
        }
        let progress = await manager.progress(taskID: task.id)
        XCTAssertEqual(progress?.completedBytes, 5)
        XCTAssertEqual(progress?.totalBytes, 8)
        XCTAssertEqual(progress?.status, .paused)
        XCTAssertEqual(progress?.bytesPerSecond, 0)
        task.recoveryGeneration = 1; try store.update(task)
        let nextGeneration = await manager.progress(taskID: task.id)
        XCTAssertNil(nextGeneration, "Old generation bytes must not appear in a new download")
    }
}
