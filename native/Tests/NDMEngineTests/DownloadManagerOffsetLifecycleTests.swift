import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadManagerOffsetLifecycleTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let work: URL
        let output: URL
        let partial: URL
        let store: DownloadStore
        let manager: DownloadManager
        let id: Int64
    }
    private func fixture(published: Bool = false, completed: Bool = false) async throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-manager-offset-\(UUID())")
        let downloads = root.appendingPathComponent("downloads")
        let support = root.appendingPathComponent("support")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: downloads, useCategoryFolders: false), supportRoot: support)
        let task = try await manager.addURL("http://127.0.0.1:1/fixture.bin", connections: 1)
        let work = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let output = downloads.appendingPathComponent("fixture.bin")
        let storage = try OffsetDownloadStorage.create(taskID: task.id, workDirectory: work, destinationURL: output,
            totalBytes: 4, resourceContextHash: "fixture-context",
            ranges: [.init(id: 0, start: 0, end: 3, durablePrefix: 0)])
        let partial = storage.partialURL
        try storage.write(segmentID: 0, data: Data([1, 2, 3, 4]))
        try storage.checkpoint()
        if published { _ = try storage.publish() }
        if completed {
            var updated = task
            updated.status = .complete
            updated.filename = output.lastPathComponent
            updated.folderPath = downloads.path
            try store.update(updated)
        }
        return Fixture(root: root, work: work, output: output, partial: partial, store: store, manager: manager, id: task.id)
    }

    func testRemoveLegacyRowWithoutWorkDirectory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-legacy-no-work-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        let task = try await manager.addURL("https://example.test/legacy.bin", connections: 1)
        let work = root.appendingPathComponent("\(task.id)")
        if FileManager.default.fileExists(atPath: work.path) { try FileManager.default.removeItem(at: work) }
        try await manager.remove(taskID: task.id, deleteFile: false)
        XCTAssertFalse(try store.allDownloads().contains { $0.id == task.id })
    }

    func testRemoveWithoutDeletingFinalStillCleansOwnedPartial() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await f.manager.remove(taskID: f.id, deleteFile: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.partial.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.work.path))
        XCTAssertFalse(try f.store.allDownloads().contains { $0.id == f.id })
    }

    func testRemovePublishedKeepsFinalFile() async throws {
        let f = try await fixture(published: true, completed: true)
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await f.manager.remove(taskID: f.id, deleteFile: false)
        XCTAssertEqual(try Data(contentsOf: f.output), Data([1, 2, 3, 4]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.work.path))
    }

    func testRemoveAndRestartPreserveRowAndReceiptWhenDestinationIsUnavailable() async throws {
        for restart in [false, true] {
            let f = try await fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            let parent = f.output.deletingLastPathComponent()
            let offline = f.root.appendingPathComponent("offline")
            try FileManager.default.moveItem(at: parent, to: offline)
            do {
                if restart { try await f.manager.restart(taskID: f.id) }
                else { try await f.manager.remove(taskID: f.id, deleteFile: false) }
                XCTFail("Unavailable destination must preserve recovery state")
            } catch {}
            XCTAssertTrue(try f.store.allDownloads().contains { $0.id == f.id })
            XCTAssertTrue(FileManager.default.fileExists(atPath: f.work.appendingPathComponent("offset-storage-v2.json").path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: offline.appendingPathComponent(f.partial.lastPathComponent).path))
        }
    }

    func testRestartCleansOwnedPartialBeforeStartingNewGeneration() async throws {
        let f = try await fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        try await f.manager.restart(taskID: f.id)
        await f.manager.pause(taskID: f.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.partial.path))
        XCTAssertTrue(try f.store.allDownloads().contains { $0.id == f.id })
    }

    func testCompletedReclaimRetiresOnlyPublishedReceipt() async throws {
        for published in [false, true] {
            let f = try await fixture(published: published, completed: true)
            defer { try? FileManager.default.removeItem(at: f.root) }
            let legacySlice = f.work.appendingPathComponent("seg.x9")
            try Data([9]).write(to: legacySlice)
            _ = await f.manager.reclaimCompletedArtifacts()
            let receiptExists = FileManager.default.fileExists(atPath: f.work.appendingPathComponent("offset-storage-v2.json").path)
            XCTAssertEqual(receiptExists, !published)
            if published {
                XCTAssertEqual(try Data(contentsOf: f.output), Data([1, 2, 3, 4]))
                XCTAssertFalse(FileManager.default.fileExists(atPath: legacySlice.path))
            } else {
                XCTAssertTrue(FileManager.default.fileExists(atPath: f.partial.path))
                XCTAssertTrue(FileManager.default.fileExists(atPath: legacySlice.path))
            }
        }
    }

    func testCompletedReclaimPreservesReceiptForReplacedFinal() async throws {
        let f = try await fixture(published: true, completed: true)
        defer { try? FileManager.default.removeItem(at: f.root) }
        try FileManager.default.removeItem(at: f.output)
        let foreign = Data([7, 7, 7, 7])
        try foreign.write(to: f.output)
        _ = await f.manager.reclaimCompletedArtifacts()
        XCTAssertEqual(try Data(contentsOf: f.output), foreign)
        XCTAssertTrue(FileManager.default.fileExists(atPath: f.work.appendingPathComponent("offset-storage-v2.json").path))
    }
}
