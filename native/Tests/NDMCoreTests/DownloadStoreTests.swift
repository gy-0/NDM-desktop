import XCTest
@testable import NDMCore

final class DownloadStoreTests: XCTestCase {
    func testAllDownloadsRetainsTaskOrderAndHeaderOrder() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-download-store-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try DownloadStore(directory: directory)
        let first = try store.insert(DownloadTask(
            url: "https://example.com/first",
            thumbnailURL: "https://img.example.com/first.webp",
            headers: ["Accept: application/json", "X-Request-ID: one"]
        ))
        let second = try store.insert(DownloadTask(url: "https://example.com/second"))
        let third = try store.insert(DownloadTask(
            url: "https://example.com/third",
            headers: ["Authorization: Bearer token", "X-Request-ID: three"]
        ))

        let downloads = try store.allDownloads()

        XCTAssertEqual(downloads.map(\.id), [third.id, second.id, first.id])
        XCTAssertEqual(downloads.map(\.headers), [
            ["Authorization: Bearer token", "X-Request-ID: three"],
            [],
            ["Accept: application/json", "X-Request-ID: one"],
        ])
        XCTAssertEqual(downloads.last?.thumbnailURL, "https://img.example.com/first.webp")
    }

    func testAllDownloadsOrdersByLatestRetryOrCompletionActivity() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-download-recency-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try DownloadStore(directory: directory)
        let base = Date(timeIntervalSince1970: 1_750_000_000)
        var older = try store.insert(DownloadTask(
            url: "https://example.com/older",
            lastTry: base
        ))
        var newer = try store.insert(DownloadTask(
            url: "https://example.com/newer",
            lastTry: base.addingTimeInterval(10)
        ))

        XCTAssertEqual(try store.allDownloads().map(\.id), [newer.id, older.id])

        older.lastTry = base.addingTimeInterval(20)
        try store.update(older)
        XCTAssertEqual(try store.allDownloads().map(\.id), [older.id, newer.id])

        newer.status = .complete
        newer.completedAt = base.addingTimeInterval(30)
        try store.update(newer)
        XCTAssertEqual(try store.allDownloads().map(\.id), [newer.id, older.id])
    }

    func testRecoverInterruptedTasksPreservesOnlyDurableCollectionQueue() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-download-recovery-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try DownloadStore(directory: directory)
        let interrupted = try store.insert(DownloadTask(
            url: "https://example.com/interrupted.bin",
            status: .downloading
        ))
        let ordinaryWaiting = try store.insert(DownloadTask(
            url: "https://example.com/waiting.bin",
            status: .waiting
        ))
        let singleVideoWaiting = try store.insert(DownloadTask(
            url: "https://example.com/watch/1",
            linkType: "ytdlp",
            status: .waiting
        ))
        let collectionWaiting = try store.insert(DownloadTask(
            url: "https://example.com/watch/2",
            linkType: "YTDLP",
            status: .waiting,
            pageURL: "https://example.com/playlist/1"
        ))
        let completed = try store.insert(DownloadTask(
            url: "https://example.com/complete.bin",
            status: .complete
        ))
        let paused = try store.insert(DownloadTask(
            url: "https://example.com/paused.bin",
            status: .paused
        ))
        let failed = try store.insert(DownloadTask(
            url: "https://example.com/failed.bin",
            status: .error
        ))

        XCTAssertEqual(try store.recoverInterruptedTasks(), 3)

        let tasks = try store.allDownloads()
        let statusByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0.status) })
        XCTAssertEqual(statusByID[interrupted.id], .incomplete)
        XCTAssertEqual(statusByID[ordinaryWaiting.id], .incomplete)
        XCTAssertEqual(statusByID[singleVideoWaiting.id], .incomplete)
        XCTAssertEqual(statusByID[collectionWaiting.id], .waiting)
        XCTAssertEqual(statusByID[completed.id], .complete)
        XCTAssertEqual(statusByID[paused.id], .paused)
        XCTAssertEqual(statusByID[failed.id], .error)
        XCTAssertEqual(try store.recoverInterruptedTasks(), 0)
    }

    /// `startAt` is what makes a scheduled download survive a relaunch. A column
    /// that silently fails to round-trip would mean the app forgets every
    /// appointment on quit, which is the one thing scheduling must not do.
    func testScheduledStartSurvivesARoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-sched-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let when = Date(timeIntervalSince1970: 1_800_003_600)
        let store = try DownloadStore(directory: dir)
        var task = DownloadTask(url: "https://example.test/a.bin", filename: "a.bin")
        task.status = .waiting
        task.startAt = when
        let saved = try store.insert(task)

        let reopened = try DownloadStore(directory: dir)
        let loaded = try XCTUnwrap(reopened.allDownloads().first { $0.id == saved.id })
        XCTAssertEqual(loaded.startAt?.timeIntervalSince1970, when.timeIntervalSince1970)
        XCTAssertEqual(loaded.status, .waiting)

        // And clearing it must clear it, not leave yesterday's appointment behind.
        var cleared = loaded
        cleared.startAt = nil
        try reopened.update(cleared)
        let after = try XCTUnwrap(try reopened.allDownloads().first { $0.id == saved.id })
        XCTAssertNil(after.startAt)
    }

    /// Scheduling for 3am assumes the app may be restarted before then. The
    /// interrupted-task sweep turns every `.waiting` row into `.incomplete`, which
    /// without an exemption silently cancels every appointment on launch — the one
    /// failure that would make the whole feature useless.
    func testRelaunchDoesNotCancelScheduledDownloads() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-sched-recover-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try DownloadStore(directory: dir)
        var scheduled = DownloadTask(url: "https://example.test/s.bin", filename: "s.bin")
        scheduled.status = .waiting
        scheduled.startAt = Date().addingTimeInterval(3600)
        let savedScheduled = try store.insert(scheduled)

        var queued = DownloadTask(url: "https://example.test/q.bin", filename: "q.bin")
        queued.status = .waiting
        let savedQueued = try store.insert(queued)

        _ = try store.recoverInterruptedTasks()
        let rows = try store.allDownloads()

        let after = try XCTUnwrap(rows.first { $0.id == savedScheduled.id })
        XCTAssertEqual(after.status, .waiting, "a clock appointment must survive relaunch")
        XCTAssertNotNil(after.startAt)

        let queuedAfter = try XCTUnwrap(rows.first { $0.id == savedQueued.id })
        XCTAssertEqual(
            queuedAfter.status, .incomplete,
            "a task merely waiting for a slot is still an interrupted download"
        )
    }
}
