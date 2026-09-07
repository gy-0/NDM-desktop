import XCTest
import Darwin
@testable import NDMEngine
@testable import NDMCore

final class MergeStagingReceiptTests: XCTestCase {
    func testOfflineDestinationKeepsReceiptUntilDirectoryReturns() throws {
        let (work, staging, handle) = try fixture()
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        try handle.write(contentsOf: Data("retain until remounted".utf8))
        try handle.close()
        let destination = staging.deletingLastPathComponent()
        let offline = destination.appendingPathExtension("offline")
        try FileManager.default.moveItem(at: destination, to: offline)
        XCTAssertThrowsError(try MergeStagingReceipt.recover(taskID: 42, in: work))
        XCTAssertTrue(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: offline.appendingPathComponent(staging.lastPathComponent).path))
        try FileManager.default.moveItem(at: offline, to: destination)
        try MergeStagingReceipt.recover(taskID: 42, in: work)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
    }

    func testRemovingTaskWithOfflineDestinationPreservesRowAndReceipt() async throws {
        let (manager, task, work, staging) = try managerFixture()
        let destination = staging.deletingLastPathComponent()
        let offline = destination.appendingPathExtension("offline")
        try FileManager.default.moveItem(at: destination, to: offline)
        defer { try? FileManager.default.moveItem(at: offline, to: destination) }
        do { try await manager.remove(taskID: task.id, deleteFile: false); XCTFail("Offline ownership must be retained") } catch {}
        let tasks = try await manager.listTasks()
        XCTAssertTrue(tasks.contains { $0.id == task.id })
        XCTAssertTrue(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
    }

    func testCancelledAndPausedMergeNeverPublishesAndKeepsCompleteParts() async throws {
        for pause in [false, true] {
            let payload = Data(repeating: 0x65, count: 4 * 1024 * 1024)
            let server = LocalRangeServer(payload: payload)
            try server.start()
            defer { server.stop() }
            let (work, unusedStaging, unusedHandle) = try fixture()
            try unusedHandle.close()
            // This unused empty fixture has no receipt and must never be swept.
            let destination = unusedStaging.deletingLastPathComponent()
            let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: destination, suggestedFilename: "cancelled.bin")
            let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
            try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            let part = SegmentFileFormat.segmentFileURL(id: 0, in: work)
            try payload.write(to: part)
            try HTTPRepresentationIdentity(request: request, totalBytes: Int64(payload.count), validator: .etag(server.entityTag)).save(in: work)
            let entered = expectation(description: "first merge chunk written")
            let release = DispatchSemaphore(value: 0)
            let engine = DownloadEngine(taskID: 42, request: request, workDirectory: work, mergeWriteObserver: { bytes in
                if bytes == 1_048_576 { entered.fulfill(); release.wait() }
            })
            let run = Task { try await engine.start() }
            await fulfillment(of: [entered], timeout: 5)
            if pause { engine.requestPause() } else { run.cancel() }
            release.signal()
            do { _ = try await run.value; XCTFail("Interrupted merge must not publish") }
            catch let error as EngineError {
                switch error {
                case .paused: XCTAssertTrue(pause)
                case .cancelled: XCTAssertFalse(pause)
                default: XCTFail("Unexpected stop error: \(error)")
                }
            }
            XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("cancelled.bin").path))
            XCTAssertEqual(try Data(contentsOf: part), payload)
            XCTAssertFalse(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: unusedStaging.path))
            XCTAssertTrue(server.recordedRanges.isEmpty)
        }
    }

    func testTaskRemovalReclaimsCrashCandidateBeforeDeletingReceiptDirectory() async throws {
        let (manager, task, work, staging) = try managerFixture()
        try await manager.remove(taskID: task.id, deleteFile: false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path))
        let tasks = try await manager.listTasks()
        XCTAssertFalse(tasks.contains { $0.id == task.id })
    }

    func testTaskRemovalPreservesAReplacementAtTheRecordedPath() async throws {
        let (manager, task, work, staging) = try managerFixture()
        try FileManager.default.moveItem(at: staging, to: staging.appendingPathExtension("moved"))
        let replacement = Data("user replacement".utf8)
        try replacement.write(to: staging)
        try await manager.remove(taskID: task.id, deleteFile: false)
        XCTAssertEqual(try Data(contentsOf: staging), replacement)
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path))
    }

    func testRestartReclaimsCrashCandidateBeforeReplacingWorkDirectory() async throws {
        let payload = Data(repeating: 0x72, count: 128 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }
        let (manager, task, _, staging) = try managerFixture(url: server.baseURL.absoluteString)
        try await manager.restart(taskID: task.id)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        await manager.pause(taskID: task.id)
    }

    private func managerFixture(url: String = "https://example.invalid/file.bin") throws -> (DownloadManager, DownloadTask, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-receipt-lifecycle-\(UUID())")
        let support = root.appendingPathComponent("support")
        let destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let task = try store.insert(DownloadTask(url: url, filename: "result.bin", status: .incomplete, folderPath: destination.path))
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: destination, useCategoryFolders: false), supportRoot: support)
        let work = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let staging = destination.appendingPathComponent(".ndm-merge-\(task.id)-\(UUID()).partial")
        let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        _ = try MergeStagingReceipt.register(taskID: task.id, staging: staging, descriptor: descriptor, in: work)
        try handle.write(contentsOf: Data(repeating: 0x53, count: 128 * 1024))
        return (manager, task, work, staging)
    }

    func testRecoveryUsesPersistedInodeAndDoesNotScanOtherPartialFiles() throws {
        let (work, staging, handle) = try fixture()
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        try handle.write(contentsOf: Data(repeating: 0x66, count: 256 * 1024))
        try handle.close()
        let unrelated = staging.deletingLastPathComponent().appendingPathComponent(".ndm-merge-42-unrelated.partial")
        try Data("unowned".utf8).write(to: unrelated)
        // No original receipt object is retained: this is the restart entry.
        try MergeStagingReceipt.recover(taskID: 42, in: work)
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
        XCTAssertEqual(try Data(contentsOf: unrelated), Data("unowned".utf8))
    }

    func testReplacedPathDoesNotAuthorizeDeletingTheReplacement() throws {
        let (work, staging, handle) = try fixture()
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        try handle.close()
        let moved = staging.appendingPathExtension("moved-by-user")
        try FileManager.default.moveItem(at: staging, to: moved)
        let replacement = Data("not the recorded inode".utf8)
        try replacement.write(to: staging)
        try MergeStagingReceipt.recover(taskID: 42, in: work)
        XCTAssertEqual(try Data(contentsOf: staging), replacement)
        XCTAssertTrue(FileManager.default.fileExists(atPath: moved.path))
    }

    func testSymlinkReplacementIsNotFollowedOrDeleted() throws {
        let (work, staging, handle) = try fixture()
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        try handle.close()
        let moved = staging.appendingPathExtension("old")
        try FileManager.default.moveItem(at: staging, to: moved)
        let victim = staging.deletingLastPathComponent().appendingPathComponent("user-file")
        let data = Data("preserve user contents".utf8)
        try data.write(to: victim)
        try FileManager.default.createSymbolicLink(at: staging, withDestinationURL: victim)
        try MergeStagingReceipt.recover(taskID: 42, in: work)
        XCTAssertEqual(try Data(contentsOf: victim), data)
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: staging.path), victim.path)
    }

    func testReceiptWriteFailureCannotLeaveADataBearingFile() throws {
        let (work, staging, handle) = try fixture()
        defer { try? handle.close() }
        try FileManager.default.createDirectory(at: MergeStagingReceipt.location(in: work), withIntermediateDirectories: false)
        XCTAssertThrowsError(try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work))
        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path), "Only the empty file created for this failed registration should be removed")
    }

    func testPublishedFileIsNotARecoveryTarget() throws {
        let (work, staging, handle) = try fixture()
        let receipt = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        let data = Data("published".utf8)
        try handle.write(contentsOf: data)
        try handle.close()
        let final = staging.deletingLastPathComponent().appendingPathComponent("final.bin")
        try FileManager.default.moveItem(at: staging, to: final)
        try receipt.finish(in: work)
        XCTAssertEqual(try Data(contentsOf: final), data)
        XCTAssertFalse(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
    }

    func testWrongTaskReceiptCannotAuthorizeCleanup() throws {
        let (work, staging, handle) = try fixture()
        defer { try? handle.close() }
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        XCTAssertThrowsError(try MergeStagingReceipt.recover(taskID: 43, in: work))
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
    }

    func testReceiptSymlinkCannotAuthorizeCleanup() throws {
        let (work, staging, handle) = try fixture()
        defer { try? handle.close() }
        _ = try MergeStagingReceipt.register(taskID: 42, staging: staging, descriptor: handle.fileDescriptor, in: work)
        let receipt = MergeStagingReceipt.location(in: work)
        let moved = receipt.appendingPathExtension("elsewhere")
        try FileManager.default.moveItem(at: receipt, to: moved)
        try FileManager.default.createSymbolicLink(at: receipt, withDestinationURL: moved)
        XCTAssertThrowsError(try MergeStagingReceipt.recover(taskID: 42, in: work))
        XCTAssertTrue(FileManager.default.fileExists(atPath: staging.path))
    }

    private func fixture() throws -> (URL, URL, FileHandle) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-merge-receipt-test-\(UUID())")
        let work = root.appendingPathComponent("work")
        let destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let staging = destination.appendingPathComponent(".ndm-merge-42-\(UUID()).partial")
        let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        return (work, staging, FileHandle(fileDescriptor: descriptor, closeOnDealloc: true))
    }
}
