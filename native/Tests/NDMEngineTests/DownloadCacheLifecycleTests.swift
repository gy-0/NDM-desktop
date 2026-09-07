import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

private actor RecyclingGate {
    private var entered = false
    private var released = false
    private var enteredWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func blockRecycler() async {
        entered = true
        enteredWaiters.forEach { $0.resume() }
        enteredWaiters.removeAll()
        guard !released else { return }
        await withCheckedContinuation { releaseWaiters.append($0) }
    }

    func waitUntilEntered() async {
        guard !entered else { return }
        await withCheckedContinuation { enteredWaiters.append($0) }
    }

    func release() {
        released = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

final class DownloadCacheLifecycleTests: XCTestCase {
    func testCleanCompletedWorkDirectoryDiscardsOnlySlices() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-clean-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let seg0 = root.appendingPathComponent("seg.x0")
        let seg1 = root.appendingPathComponent("seg.x1")
        let segBin = root.appendingPathComponent("segments.bin")
        let ftpPart = root.appendingPathComponent("ftp.partial")
        let log = root.appendingPathComponent("LogFile.txt")
        let meta = root.appendingPathComponent("metadata.json")
        let tsDir = root.appendingPathComponent("ts", isDirectory: true)
        try FileManager.default.createDirectory(at: tsDir, withIntermediateDirectories: true)
        let tsChunk = tsDir.appendingPathComponent("segment_001.ts")

        try Data("seg0".utf8).write(to: seg0)
        try Data("seg1".utf8).write(to: seg1)
        try Data("bin".utf8).write(to: segBin)
        try Data("partial".utf8).write(to: ftpPart)
        try Data("important log".utf8).write(to: log)
        try Data("meta".utf8).write(to: meta)
        try Data("chunk".utf8).write(to: tsChunk)

        DownloadManager.cleanCompletedWorkDirectory(at: root)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: seg0.path), "seg.x0 should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: seg1.path), "seg.x1 should be deleted")
        XCTAssertTrue(fm.fileExists(atPath: segBin.path), "segments.bin remains as lightweight diagnostic plan metadata")
        XCTAssertFalse(fm.fileExists(atPath: ftpPart.path), "ftp.partial should be deleted")
        XCTAssertFalse(fm.fileExists(atPath: tsDir.path), "ts/ directory should be deleted")

        XCTAssertTrue(fm.fileExists(atPath: log.path), "LogFile.txt must be preserved")
        XCTAssertTrue(fm.fileExists(atPath: meta.path), "Custom metadata must be preserved")
    }

    func testReclaimCompletedArtifactsFreesSlicesAndKeepsLogs() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-reclaim-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: downloads,
            maxConnections: 2,
            useCategoryFolders: false
        )

        // Task 1: Complete — slices should be reclaimed
        let task1 = try store.insert(DownloadTask(
            url: "https://example.com/file1.pkg",
            filename: "file1.pkg",
            fileSize: 1024,
            status: .complete,
            folderPath: downloads.path
        ))

        // Task 2: Incomplete/Paused — slices must NOT be reclaimed so resume works
        let task2 = try store.insert(DownloadTask(
            url: "https://example.com/file2.pkg",
            filename: "file2.pkg",
            fileSize: 2048,
            status: .paused,
            folderPath: downloads.path
        ))

        let workDir1 = support.appendingPathComponent("\(task1.id)", isDirectory: true)
        let workDir2 = support.appendingPathComponent("\(task2.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: workDir1, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: workDir2, withIntermediateDirectories: true)

        let task1Seg = workDir1.appendingPathComponent("seg.x0")
        let task1Bin = workDir1.appendingPathComponent("segments.bin")
        let task1Log = workDir1.appendingPathComponent("LogFile.txt")
        try Data("12345678".utf8).write(to: task1Seg)
        try Data("1234".utf8).write(to: task1Bin)
        try Data("log content".utf8).write(to: task1Log)

        let task2Seg = workDir2.appendingPathComponent("seg.x0")
        let task2Bin = workDir2.appendingPathComponent("segments.bin")
        try Data("resume data".utf8).write(to: task2Seg)
        try Data("resume bin".utf8).write(to: task2Bin)

        let manager = DownloadManager(
            store: store,
            settings: settings,
            supportRoot: support
        )

        let reclaimedBytes = await manager.reclaimCompletedArtifacts()
        XCTAssertGreaterThan(reclaimedBytes, 0, "Should report reclaimed bytes")

        let fm = FileManager.default
        // Task 1 checks
        XCTAssertFalse(fm.fileExists(atPath: task1Seg.path), "Completed task seg file should be reclaimed")
        XCTAssertTrue(fm.fileExists(atPath: task1Bin.path), "Completed task keeps lightweight plan metadata")
        XCTAssertTrue(fm.fileExists(atPath: task1Log.path), "Completed task LogFile.txt must be preserved")

        // Task 2 checks
        XCTAssertTrue(fm.fileExists(atPath: task2Seg.path), "Paused task seg file must be kept for resume")
        XCTAssertTrue(fm.fileExists(atPath: task2Bin.path), "Paused task segments.bin must be kept for resume")
    }

    func testRestartResetsTaskStateAndCleansWorkDirectory() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-restart-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: downloads,
            maxConnections: 2,
            useCategoryFolders: false
        )

        let completedTask = try store.insert(DownloadTask(
            url: "https://example.com/deadlink.bin",
            filename: "deadlink.bin",
            fileSize: 4096,
            status: .complete,
            folderPath: downloads.path
        ))

        let workDir = support.appendingPathComponent("\(completedTask.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        let oldSeg = workDir.appendingPathComponent("seg.x0")
        try Data("stale bytes".utf8).write(to: oldSeg)

        let manager = DownloadManager(
            store: store,
            settings: settings,
            supportRoot: support
        )

        // Calling restart will attempt start, which will fail or set state for the dead URL.
        // Even if start throws or fails to connect, restart guarantees the stale workDir is wiped.
        try? await manager.restart(taskID: completedTask.id)

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: oldSeg.path), "Restart should wipe stale segments from previous complete run")

        let updatedTask = try await manager.task(id: completedTask.id)
        XCTAssertNotNil(updatedTask)
        XCTAssertNil(updatedTask?.completedAt, "Restart must clear completedAt timestamp")
    }

    func testRestartWhileQueueBusyPreservesWorkDirectoryAndThrows() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-queuebusy-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        var settings = AppSettings(
            downloadDirectory: downloads,
            maxConnections: 2,
            useCategoryFolders: false
        )
        // Enforce one-by-one queue mode
        settings.downloadAllAtOnce = false

        // Task 1: Currently active task
        let activeTask = try store.insert(DownloadTask(
            url: "https://example.com/active.bin",
            filename: "active.bin",
            fileSize: 4096,
            status: .downloading,
            folderPath: downloads.path
        ))

        // Task 2: Paused/Failed task with valuable partial slices
        let partialTask = try store.insert(DownloadTask(
            url: "https://example.com/partial.bin",
            filename: "partial.bin",
            fileSize: 4096,
            status: .paused,
            folderPath: downloads.path
        ))

        let partialWorkDir = support.appendingPathComponent("\(partialTask.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: partialWorkDir, withIntermediateDirectories: true)
        let sliceFile = partialWorkDir.appendingPathComponent("seg.x0")
        try Data("precious slices".utf8).write(to: sliceFile)

        let manager = DownloadManager(
            store: store,
            settings: settings,
            supportRoot: support
        )

        // Artificially start activeTask or hold the queue
        // In one-by-one mode, since start checks !runningTasks.isEmpty, we can test that
        // restart checks queue admission BEFORE wiping partialWorkDir!
        // To simulate active task running: start activeTask (which throws on dead link or runs engine)
        // Or directly test restart when queue is busy:
        do {
            // When start(activeTask.id) is initiated, it adds to runningTasks
            // Let's call start on activeTask
            try await manager.start(taskID: activeTask.id)
        } catch {
            // Even if start threw or failed, let's verify behaviour
        }

        // Now if we attempt restart on partialTask while activeTask is in queue/running:
        // If queueBusy is thrown, sliceFile must NOT be deleted
        do {
            try await manager.restart(taskID: partialTask.id)
            XCTFail("Restart must be rejected while the one-at-a-time queue is busy")
        } catch ManagerError.queueBusy {
            // Expected.
        } catch {
            XCTFail("Expected queueBusy, got \(error)")
        }

        let fm = FileManager.default
        XCTAssertTrue(
            fm.fileExists(atPath: sliceFile.path),
            "Partial slices must NOT be wiped if restart is rejected by queueBusy"
        )
        let stored = try await manager.task(id: partialTask.id)
        XCTAssertEqual(stored?.status, .paused, "Status must not be corrupted if queue admission fails")
        await manager.pause(taskID: activeTask.id)
    }

    func testReclaimAccuratelyMeasuresDirectorySizes() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-reclaim-dirs-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: downloads,
            maxConnections: 2,
            useCategoryFolders: false
        )

        let completedTask = try store.insert(DownloadTask(
            url: "https://example.com/video.m3u8",
            filename: "video.mp4",
            fileSize: 4096,
            status: .complete,
            folderPath: downloads.path
        ))

        let workDir = support.appendingPathComponent("\(completedTask.id)", isDirectory: true)
        let tsDir = workDir.appendingPathComponent("ts", isDirectory: true)
        try FileManager.default.createDirectory(at: tsDir, withIntermediateDirectories: true)

        let chunk1 = tsDir.appendingPathComponent("001.ts")
        let chunk2 = tsDir.appendingPathComponent("002.ts")
        let data1000 = Data(repeating: 0x42, count: 1000)
        let data2000 = Data(repeating: 0x43, count: 2000)
        try data1000.write(to: chunk1)
        try data2000.write(to: chunk2)

        let manager = DownloadManager(
            store: store,
            settings: settings,
            supportRoot: support
        )

        let reclaimed = await manager.reclaimCompletedArtifacts()
        XCTAssertEqual(reclaimed, 3000, "Reclaim must recursively sum file sizes within ts/ directory (3000 bytes)")

        let fm = FileManager.default
        XCTAssertFalse(fm.fileExists(atPath: tsDir.path), "ts directory must be deleted after reclaim")
    }

    func testStartWaitsForConcurrentRemovalAndCannotReviveDeletedTask() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-lifecycle-lock-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let task = try store.insert(DownloadTask(
            url: "https://example.com/file.bin",
            filename: "file.bin",
            fileSize: 4,
            status: .complete,
            folderPath: downloads.path
        ))
        try Data("done".utf8).write(to: downloads.appendingPathComponent(task.filename))

        let gate = RecyclingGate()
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(
                downloadDirectory: downloads,
                maxConnections: 2,
                useCategoryFolders: false
            ),
            supportRoot: support,
            fileRecycler: { _ in await gate.blockRecycler() }
        )

        let removal = Task { try await manager.remove(taskID: task.id, deleteFile: true) }
        await gate.waitUntilEntered()
        let concurrentStart = Task { try await manager.start(taskID: task.id) }
        await gate.release()
        try await removal.value

        do {
            try await concurrentStart.value
            XCTFail("A start queued behind removal must not revive the deleted task")
        } catch ManagerError.taskNotFound {
            // Expected: start acquired the task lock only after removal committed.
        } catch {
            XCTFail("Expected taskNotFound, got \(error)")
        }
        let removedTask = try await manager.task(id: task.id)
        XCTAssertNil(removedTask)
    }

    func testCompletedCleanupRemovesAppOwnedYtDlpStagingOnly() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-test-ytdlp-stage-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let staging = root.appendingPathComponent("yt-dlp", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try Data("partial".utf8).write(to: staging.appendingPathComponent("movie.f137.mp4.part"))
        let log = root.appendingPathComponent("LogFile.txt")
        try Data("keep".utf8).write(to: log)

        DownloadManager.cleanCompletedWorkDirectory(at: root)

        XCTAssertFalse(FileManager.default.fileExists(atPath: staging.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: log.path))
    }
}
