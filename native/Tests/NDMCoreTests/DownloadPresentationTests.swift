import XCTest
@testable import NDMCore

final class DownloadPresentationTests: XCTestCase {
    override func setUp() {
        super.setUp()
        L10n.apply(.english)
    }

    override func tearDown() {
        L10n.apply(.system)
        super.tearDown()
    }

    func testMostRecentActivityOrderingPromotesOldTaskAfterRetry() {
        let base = Date(timeIntervalSince1970: 1_750_000_000)
        let newlyInserted = DownloadTask(
            id: 20,
            url: "https://example.com/new",
            lastTry: base.addingTimeInterval(10)
        )
        let retriedOlderRow = DownloadTask(
            id: 2,
            url: "https://example.com/retried",
            lastTry: base.addingTimeInterval(20)
        )

        XCTAssertTrue(
            TaskPresentationFormatting.isMoreRecentlyActive(
                retriedOlderRow,
                than: newlyInserted
            )
        )
        XCTAssertFalse(
            TaskPresentationFormatting.isMoreRecentlyActive(
                newlyInserted,
                than: retriedOlderRow
            )
        )
    }

    func testMostRecentActivityUsesCompletionAndFallsBackToID() {
        let base = Date(timeIntervalSince1970: 1_750_000_000)
        let completed = DownloadTask(
            id: 1,
            url: "https://example.com/completed",
            lastTry: base,
            completedAt: base.addingTimeInterval(30)
        )
        let retrying = DownloadTask(
            id: 99,
            url: "https://example.com/retrying",
            lastTry: base.addingTimeInterval(20)
        )
        XCTAssertEqual(completed.mostRecentActivity, base.addingTimeInterval(30))
        XCTAssertTrue(TaskPresentationFormatting.isMoreRecentlyActive(completed, than: retrying))

        let lowerID = DownloadTask(id: 3, url: "https://example.com/a")
        let higherID = DownloadTask(id: 4, url: "https://example.com/b")
        XCTAssertTrue(TaskPresentationFormatting.isMoreRecentlyActive(higherID, than: lowerID))
    }

    func testSegmentFractionRepresentsIndividualConnectionProgress() {
        let quarter = SegmentState(id: 2, start: 1_000, end: 1_399, completed: 100)
        XCTAssertEqual(quarter.length, 400)
        XCTAssertEqual(quarter.fractionCompleted, 0.25, accuracy: 0.000_001)
        XCTAssertEqual(quarter.remainingBytes, 300)
    }

    func testSegmentFractionClampsInvalidOrExcessCounts() {
        let negative = SegmentState(id: 0, start: 0, end: 99, completed: -20)
        XCTAssertEqual(negative.fractionCompleted, 0)
        XCTAssertEqual(negative.remainingBytes, 100)

        let excess = SegmentState(id: 1, start: 100, end: 199, completed: 500)
        XCTAssertEqual(excess.fractionCompleted, 1)
        XCTAssertEqual(excess.remainingBytes, 0)
    }

    func testTaskBuildsCompletedDestinationURL() {
        let task = DownloadTask(
            url: "https://example.com/archive.zip",
            filename: "archive.zip",
            folderPath: "/Users/example/Downloads"
        )
        XCTAssertEqual(task.destinationFileURL?.path, "/Users/example/Downloads/archive.zip")

        var missingFolder = task
        missingFolder.folderPath = nil
        XCTAssertNil(missingFolder.destinationFileURL)
    }

    func testSidebarFilterMatchesStatusGroups() {
        let downloading = DownloadTask(url: "https://a/x", status: .downloading)
        let waiting = DownloadTask(url: "https://a/x", status: .waiting)
        let paused = DownloadTask(url: "https://a/x", status: .paused)
        let incomplete = DownloadTask(url: "https://a/x", status: .incomplete)
        let complete = DownloadTask(url: "https://a/x", status: .complete)
        let failed = DownloadTask(url: "https://a/x", status: .error)

        XCTAssertTrue(SidebarFilter.active.matches(downloading))
        // Queued (waiting) folds into "active" — no standalone 排队中 filter.
        XCTAssertTrue(SidebarFilter.active.matches(waiting))
        XCTAssertTrue(SidebarFilter.paused.matches(paused))
        XCTAssertTrue(SidebarFilter.paused.matches(incomplete))
        XCTAssertTrue(SidebarFilter.completed.matches(complete))
        XCTAssertTrue(SidebarFilter.failed.matches(failed))
        XCTAssertEqual(SidebarFilter.paused.title, "To Resume")
    }

    func testSidebarFilterMatchesCategoriesAndRetryFlags() {
        let video = DownloadTask(url: "https://a/v.mp4", filename: "v.mp4", category: .video, status: .complete)
        let uncategorized = DownloadTask(url: "https://a/file", filename: "file", category: .misc, status: .complete)
        let failed = DownloadTask(url: "https://a/x", status: .error, errorText: "410 Gone")
        XCTAssertTrue(SidebarFilter.video.matches(video))
        XCTAssertFalse(SidebarFilter.document.matches(video))
        XCTAssertTrue(SidebarFilter.other.matches(uncategorized))
        XCTAssertFalse(SidebarFilter.other.matches(video))
        XCTAssertEqual(SidebarFilter.video.section, "Type")
        XCTAssertEqual(SidebarFilter.all.section, "Status")

        let row = TaskRowPresentation.make(task: failed, progress: nil)
        XCTAssertTrue(row.canRetry)
        XCTAssertTrue(row.canRenew)
        XCTAssertEqual(row.statusTitle, "Failed")

        let done = TaskRowPresentation.make(task: video, progress: nil)
        XCTAssertTrue(done.canRetry)
        XCTAssertFalse(done.canOpen) // no folderPath → Open stays off; Retry still on
        let doneWithPath = DownloadTask(
            url: "https://a/v.mp4",
            filename: "v.mp4",
            category: .video,
            status: .complete,
            folderPath: "/tmp"
        )
        XCTAssertTrue(TaskRowPresentation.make(task: doneWithPath, progress: nil).canOpen)
    }

    func testTaskRowPresentationFormatsLiveProgress() {
        let task = DownloadTask(
            url: "https://cdn.example.com/film.mkv",
            filename: "film.mkv",
            fileSize: 1_000,
            status: .downloading,
            connections: 8
        )
        let progress = DownloadProgress(
            taskID: 1,
            totalBytes: 1_000,
            completedBytes: 250,
            bytesPerSecond: 50,
            status: .downloading
        )
        let row = TaskRowPresentation.make(task: task, progress: progress)
        XCTAssertEqual(row.host, "cdn.example.com")
        XCTAssertEqual(row.statusTitle, "Downloading")
        XCTAssertEqual(row.progressText, "25%")
        XCTAssertEqual(row.progressFraction, 0.25, accuracy: 0.000_001)
        XCTAssertEqual(row.primaryAction, .showProgress)
        XCTAssertTrue(row.canPause)
        XCTAssertFalse(row.canStart)
        XCTAssertNotEqual(row.speedText, "—")
        XCTAssertNotEqual(row.etaText, "—")
        XCTAssertEqual(row.connectionsText, "8 / 8")
        XCTAssertTrue(row.statusDetail.contains(L10n.connectionsCount(8)))
    }

    func testPausedAndInterruptedRowsDescribeContinuityWithoutRepeatingState() {
        XCTAssertEqual(TaskPresentationFormatting.byteCount(0), "0 KB")

        let pausedTask = DownloadTask(
            url: "https://cdn.example.com/archive.zip",
            filename: "archive.zip",
            fileSize: 1_000,
            status: .paused
        )
        let pausedProgress = DownloadProgress(
            taskID: 1,
            totalBytes: 1_000,
            completedBytes: 250,
            status: .paused
        )
        let paused = TaskRowPresentation.make(task: pausedTask, progress: pausedProgress)
        XCTAssertEqual(paused.statusTitle, "Paused")
        XCTAssertNotEqual(paused.statusDetail, paused.statusTitle)
        // ByteCountFormatter follows the process locale independently from the
        // app's explicit language override ("bytes" / "字节"). Pin the useful
        // counters without making the test depend on the runner's locale.
        XCTAssertTrue(paused.statusDetail.contains("250"))
        XCTAssertTrue(paused.statusDetail.contains("1 KB"))

        let interruptedTask = DownloadTask(
            url: "https://cdn.example.com/archive.zip",
            filename: "archive.zip",
            status: .incomplete
        )
        let interrupted = TaskRowPresentation.make(task: interruptedTask, progress: nil)
        XCTAssertEqual(interrupted.statusTitle, "To Resume")
        XCTAssertEqual(interrupted.statusDetail, "Ready to resume")
        XCTAssertTrue(interrupted.canStart)
    }

    func testLiveConnectionCountPrefersEngineReportOverConfiguredCeiling() {
        defer { L10n.apply(.system) }
        L10n.apply(.english)
        let task = DownloadTask(
            url: "https://cdn.example.com/big.bin",
            filename: "big.bin",
            fileSize: 10_000_000,
            status: .downloading,
            connections: 32
        )
        let progress = DownloadProgress(
            taskID: 9,
            totalBytes: 10_000_000,
            completedBytes: 1_000_000,
            bytesPerSecond: 800_000,
            status: .downloading,
            tuning: ConnectionTuning(
                steps: [
                    .init(connections: 2, bytesPerSecond: 200_000),
                    .init(connections: 8, bytesPerSecond: 800_000),
                ],
                currentConnections: 8,
                outcome: .settled
            ),
            currentConnections: 8
        )

        XCTAssertEqual(
            TaskPresentationFormatting.liveConnectionCount(task: task, progress: progress),
            8
        )
        let row = TaskRowPresentation.make(task: task, progress: progress)
        XCTAssertEqual(row.connectionsText, "8 / 32")
        XCTAssertTrue(row.statusDetail.contains(L10n.connectionsCount(8)))
        XCTAssertFalse(row.statusDetail.contains(L10n.connectionsCount(32)))
    }

    func testLiveConnectionCountFallsBackToUnfinishedSegments() {
        let task = DownloadTask(
            url: "https://cdn.example.com/file.bin",
            filename: "file.bin",
            status: .downloading,
            connections: 32
        )
        let progress = DownloadProgress(
            taskID: 3,
            totalBytes: 4_000,
            completedBytes: 1_500,
            segmentStates: [
                SegmentState(id: 0, start: 0, end: 999, completed: 1_000, isFinished: true),
                SegmentState(id: 1, start: 1_000, end: 1_999, completed: 500, isFinished: false),
                SegmentState(id: 2, start: 2_000, end: 2_999, completed: 0, isFinished: false),
                SegmentState(id: 3, start: 3_000, end: 3_999, completed: 0, isFinished: false),
            ],
            status: .downloading
        )
        XCTAssertEqual(
            TaskPresentationFormatting.liveConnectionCount(task: task, progress: progress),
            3
        )
        let row = TaskRowPresentation.make(task: task, progress: progress)
        XCTAssertEqual(row.connectionsText, "3 / 32")
        XCTAssertTrue(row.statusDetail.contains(L10n.connectionsCount(3)))
    }

    func testMediaJourneyKeepsTruthfulBytesAndOneSemanticProgress() {
        defer { L10n.apply(.system) }
        L10n.apply(.english)
        let task = DownloadTask(
            url: "https://www.youtube.com/watch?v=example",
            filename: "film.mp4",
            linkType: "ytdlp",
            fileSize: 1_000,
            status: .downloading
        )
        let progress = DownloadProgress(
            taskID: 2,
            totalBytes: 1_000,
            completedBytes: 1_000,
            bytesPerSecond: 0,
            status: .downloading,
            phase: .merging,
            journeyFraction: 0.972
        )

        XCTAssertNil(progress.remainingTime)
        let row = TaskRowPresentation.make(task: task, progress: progress)
        XCTAssertEqual(row.progressFraction, 0.972, accuracy: 0.000_001)
        XCTAssertEqual(row.progressText, "97%")
        XCTAssertTrue(row.statusDetail.contains(L10n.ytdlpMergingShort))
        XCTAssertEqual(progress.completedBytes, progress.totalBytes)
    }

    func testTaskRowPresentationCompletedPrimaryActionIsOpenWhenDestinationKnown() {
        // Presentation must not probe the filesystem; destination path is enough.
        let task = DownloadTask(
            url: "https://example.com/done.bin",
            filename: "done.bin",
            fileSize: 3,
            status: .complete,
            folderPath: "/Users/example/Downloads"
        )
        let row = TaskRowPresentation.make(task: task, progress: nil)
        XCTAssertEqual(row.primaryAction, .open)
        XCTAssertTrue(row.canOpen)
        XCTAssertTrue(row.canShowInFinder)
        XCTAssertTrue(row.canShowProgress, "completed result pages must remain reopenable")
        XCTAssertTrue(row.isComplete)
        XCTAssertFalse(row.showsProgressBar)
        XCTAssertEqual(row.progressText, "Completed")
        XCTAssertEqual(row.sizeText, TaskPresentationFormatting.byteCount(3))
    }

    func testSearchMatchesFilenameHostAndURL() {
        let task = DownloadTask(
            url: "https://files.example.org/path/report.pdf",
            filename: "Q3-report.pdf",
            status: .complete
        )
        XCTAssertTrue(TaskPresentationFormatting.matchesSearch(task, query: "report"))
        XCTAssertTrue(TaskPresentationFormatting.matchesSearch(task, query: "files.example"))
        XCTAssertTrue(TaskPresentationFormatting.matchesSearch(task, query: "path/report"))
        XCTAssertFalse(TaskPresentationFormatting.matchesSearch(task, query: "video"))
    }

    func testSelectionActionsFollowRowCapabilities() {
        let paused = TaskRowPresentation.make(
            task: DownloadTask(url: "https://a/x", status: .paused),
            progress: nil
        )
        let actions = TaskSelectionActions.make(from: paused)
        XCTAssertTrue(actions.canStart)
        XCTAssertFalse(actions.canPause)
        XCTAssertTrue(actions.canDelete)
        XCTAssertEqual(TaskSelectionActions.make(from: nil), .none)
    }

    func testPromotedActionsPreferContinuationOverRetryForIncompleteTask() {
        let incomplete = TaskRowPresentation.make(
            task: DownloadTask(url: "https://a/x", status: .incomplete),
            progress: nil
        )

        XCTAssertEqual(TaskPromotedAction.make(from: incomplete), [.resume])
    }

    func testPromotedActionsKeepCompletedToolbarResultFirst() {
        let completed = TaskRowPresentation.make(
            task: DownloadTask(
                url: "https://a/x",
                filename: "x.bin",
                status: .complete,
                folderPath: "/tmp"
            ),
            progress: nil
        )

        XCTAssertTrue(completed.canRetry, "retry remains available in secondary menus")
        XCTAssertEqual(TaskPromotedAction.make(from: completed), [.open, .reveal])
    }

    func testPromotedActionsDeferToBatchBarForMultipleSelection() {
        let paused = TaskRowPresentation.make(
            task: DownloadTask(url: "https://a/x", status: .paused),
            progress: nil
        )

        XCTAssertEqual(
            TaskPromotedAction.make(from: paused, hasMultipleSelection: true),
            []
        )
    }

    func testPromotedActionsNameBrowserRecoveryInsteadOfPretendingToUpdateAutomatically() {
        let failed = TaskRowPresentation.make(
            task: DownloadTask(
                url: "https://cdn.example.com/expired/video.mp4",
                status: .error,
                pageURL: "https://example.com/watch/video",
                errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
            ),
            progress: nil
        )

        XCTAssertEqual(failed.primaryAction, .recover)
        XCTAssertEqual(failed.recoveryAction, .openSourcePage)
        XCTAssertTrue(failed.canRetry, "retry remains available in secondary menus")
        XCTAssertEqual(TaskPromotedAction.make(from: failed), [.openSourcePage])
    }

    func testPromotedActionsDoNotOfferDoomedRetryBesideManualLinkRenewal() {
        let failed = TaskRowPresentation.make(
            task: DownloadTask(
                url: "https://cdn.example.com/expired/video.mp4",
                status: .error,
                errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
            ),
            progress: nil
        )

        XCTAssertEqual(failed.recoveryAction, .renewURL)
        XCTAssertTrue(failed.canRetry, "retry remains available in secondary menus")
        XCTAssertEqual(TaskPromotedAction.make(from: failed), [.renew])
    }
}
