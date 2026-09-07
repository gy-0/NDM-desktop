import XCTest
@testable import NDMCore
@testable import NDMEngine

/// The one step of C2 that changes existing wiring, so the guarantees are pinned
/// rather than assumed: content becomes findable, a removed download stops being
/// findable, and index trouble never costs a download.
private enum WiringRecycleFailure: Error {
    case denied
}

final class SearchIndexWiringTests: XCTestCase {
    private var root: URL!
    private var support: URL!
    private var downloads: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-wiring-\(UUID().uuidString)", isDirectory: true)
        support = root.appendingPathComponent("support", isDirectory: true)
        downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeManager(
        index: SearchIndexStore?,
        recycler: DownloadManager.FileRecycler? = { url in
            try FileManager.default.removeItem(at: url)
        }
    ) throws -> (DownloadManager, DownloadStore) {
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: downloads,
            maxConnections: 2,
            useCategoryFolders: false
        )
        let manager = DownloadManager(
            store: store,
            settings: settings,
            supportRoot: support,
            fileRecycler: recycler,
            searchIndex: index
        )
        return (manager, store)
    }

    private func insertTask(_ store: DownloadStore, filename: String = "讲座.mp4") throws -> DownloadTask {
        try store.insert(DownloadTask(
            url: "https://www.bilibili.com/video/BV1",
            filename: filename,
            status: .complete,
            pageURL: "https://www.bilibili.com/video/BV1",
            pageTitle: "深度学习公开课",
            folderPath: downloads.path
        ))
    }

    // MARK: - Becoming findable

    func testATranscriptBecomesSearchable() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let task = try insertTask(store)

        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 3, text: "开场先讲背景"),
            TranscriptSegment(start: 12.5, end: 16, text: "这里讲到本地转写"),
        ])

        let groups = try InboxSearch(index: index).search("转写")
        XCTAssertEqual(groups.count, 1)
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.taskID, task.id)
        XCTAssertTrue(group.hasSpokenMatch)
        XCTAssertEqual(group.snippets.first?.startSeconds, 12.5)
    }

    /// Indexing the transcript must not cost the download its name and title: both go
    /// in together because a task's entries are replaced wholesale.
    func testTranscriptIndexingKeepsMetadataSearchable() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let task = try insertTask(store)

        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 3, text: "内容里讲转写"),
        ])

        let search = InboxSearch(index: index)
        XCTAssertEqual(try search.search("公开课").count, 1, "the title must still match")
        XCTAssertEqual(try search.search("讲座").count, 1, "the filename must still match")
        XCTAssertEqual(try search.search("bilibili").count, 1, "the site must still match")
    }

    /// A download with no transcript can only be found by what it is called, and that
    /// baseline is what makes a search box worth opening.
    func testMetadataOnlyMatchesAreLabelledHonestly() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let task = try insertTask(store)
        await manager.indexTranscript(taskID: task.id, segments: [])

        let groups = try InboxSearch(index: index).search("公开课")
        let group = try XCTUnwrap(groups.first)
        XCTAssertTrue(group.isMetadataOnly)
        XCTAssertFalse(group.hasSpokenMatch)
    }

    /// Re-running a transcript must not double every line in the results.
    func testReindexingTheSameTaskDoesNotDuplicate() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let task = try insertTask(store)
        let segments = [TranscriptSegment(start: 0, end: 3, text: "讲到本地转写")]

        await manager.indexTranscript(taskID: task.id, segments: segments)
        await manager.indexTranscript(taskID: task.id, segments: segments)
        await manager.indexTranscript(taskID: task.id, segments: segments)

        let groups = try InboxSearch(index: index).search("转写")
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.totalSnippetCount, 1)
    }

    func testIndexingAnUnknownTaskIsRecordedRatherThanCrashing() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, _) = try makeManager(index: index)
        await manager.indexTranscript(taskID: 9999, segments: [
            TranscriptSegment(start: 0, end: 1, text: "孤儿内容"),
        ])
        let failures = await manager.searchIndexFailures()
        XCTAssertEqual(failures.count, 1)
        XCTAssertTrue(try InboxSearch(index: index).search("孤儿").isEmpty)
    }

    // MARK: - Ceasing to be findable

    /// A privacy requirement, not housekeeping: search must not keep serving content
    /// the user believes they erased.
    func testRemovingADownloadMakesItUnsearchable() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let task = try insertTask(store)
        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 3, text: "机密内容不该留下"),
        ])
        XCTAssertEqual(try InboxSearch(index: index).search("机密").count, 1)

        try await manager.remove(taskID: task.id, deleteFile: false)

        XCTAssertTrue(
            try InboxSearch(index: index).search("机密").isEmpty,
            "a deleted download must not remain findable"
        )
        XCTAssertTrue(try index.indexedTaskIDs().isEmpty)
    }

    func testRemovingOneDownloadLeavesOthersSearchable() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index: index)
        let keep = try insertTask(store, filename: "保留.mp4")
        let drop = try insertTask(store, filename: "删除.mp4")
        await manager.indexTranscript(taskID: keep.id, segments: [
            TranscriptSegment(start: 0, end: 2, text: "保留这条转写"),
        ])
        await manager.indexTranscript(taskID: drop.id, segments: [
            TranscriptSegment(start: 0, end: 2, text: "删掉那条转写"),
        ])

        try await manager.remove(taskID: drop.id, deleteFile: false)

        let groups = try InboxSearch(index: index).search("转写")
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.taskID, keep.id)
    }

    /// A07's lesson applied to the index: the irreversible step happens only after the
    /// row is really gone. A removal that fails must leave the index intact, or a
    /// retry would search a hole.
    func testAFailedRemovalLeavesTheIndexIntact() async throws {
        let index = try SearchIndexStore(directory: support)
        let file = downloads.appendingPathComponent("讲座.mp4")
        try Data("payload".utf8).write(to: file)
        let (manager, store) = try makeManager(
            index: index,
            recycler: { _ in throw WiringRecycleFailure.denied }
        )
        let task = try insertTask(store)
        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 2, text: "仍然应该搜得到的转写"),
        ])

        do {
            try await manager.remove(taskID: task.id, deleteFile: true)
            XCTFail("expected the recycler to fail")
        } catch WiringRecycleFailure.denied {
            // Expected.
        }

        XCTAssertEqual(
            try InboxSearch(index: index).search("转写").count,
            1,
            "the task still exists, so its index entries must too"
        )
    }

    // MARK: - Never costing a download

    /// Search is derived data. Its absence must be invisible to downloading.
    func testEverythingWorksWithNoIndexAtAll() async throws {
        let (manager, store) = try makeManager(index: nil)
        let task = try insertTask(store)
        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 2, text: "没有索引也不该崩"),
        ])
        let failures = await manager.searchIndexFailures()
        XCTAssertTrue(failures.isEmpty, "no index is not a failure")
        try await manager.remove(taskID: task.id, deleteFile: false)
        let remaining = try await manager.task(id: task.id)
        XCTAssertNil(remaining, "removal must succeed without an index")
    }

    /// Failures are recorded rather than thrown or swallowed — thrown would cost the
    /// user a download, swallowed would hide a silently degraded search.
    func testIndexFailuresAreVisibleWithoutBeingFatal() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, _) = try makeManager(index: index)
        await manager.indexTranscript(taskID: 4242, segments: [
            TranscriptSegment(start: 0, end: 1, text: "内容"),
        ])
        let failures = await manager.searchIndexFailures()
        XCTAssertFalse(failures.isEmpty, "a real problem must leave a trace")
        XCTAssertTrue(
            failures.contains { $0.contains("4242") },
            "the trace must say which task, got \(failures)"
        )
    }
}

/// Rebuilding from what is already on disk. The subtitle files are the source, not
/// the .txt transcript: only they carry timings, and an index rebuilt without them
/// could find a download but never jump to the moment.
final class SearchIndexRebuildTests: XCTestCase {
    private var root: URL!
    private var support: URL!
    private var downloads: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-rebuild-\(UUID().uuidString)", isDirectory: true)
        support = root.appendingPathComponent("support", isDirectory: true)
        downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeManager(
        _ index: SearchIndexStore
    ) throws -> (DownloadManager, DownloadStore) {
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(downloadDirectory: downloads, useCategoryFolders: false),
            supportRoot: support,
            searchIndex: index
        )
        return (manager, store)
    }

    @discardableResult
    private func insert(
        _ store: DownloadStore,
        filename: String,
        title: String? = "公开课"
    ) throws -> DownloadTask {
        try store.insert(DownloadTask(
            url: "https://www.bilibili.com/video/BV1",
            filename: filename,
            status: .complete,
            pageURL: "https://www.bilibili.com/video/BV1",
            pageTitle: title,
            folderPath: downloads.path
        ))
    }

    private func writeSubtitles(_ name: String, _ segments: [TranscriptSegment]) throws {
        try Data(TranscriptDocument.srt(from: segments).utf8)
            .write(to: downloads.appendingPathComponent(name))
    }

    // MARK: - Trigger

    func testAFreshIndexNeedsRebuilding() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, _) = try makeManager(index)
        let needs = await manager.searchIndexNeedsRebuild()
        XCTAssertTrue(needs, "an empty index has nothing to serve")
    }

    /// Rescanning every launch would spend the user's first seconds re-deriving
    /// something already correct.
    func testAPopulatedIndexDoesNotNeedRebuilding() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        let task = try insert(store, filename: "讲座.mp4")
        await manager.indexTranscript(taskID: task.id, segments: [
            TranscriptSegment(start: 0, end: 2, text: "已有内容"),
        ])
        let needs = await manager.searchIndexNeedsRebuild()
        XCTAssertFalse(needs)
    }

    // MARK: - Recovering timings

    /// The point of parsing subtitles rather than the .txt: a rebuilt index must still
    /// be able to jump to the moment.
    func testRebuildRecoversTimingsFromSubtitles() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        try insert(store, filename: "讲座.mp4")
        try writeSubtitles("讲座.srt", [
            TranscriptSegment(start: 0, end: 3, text: "开场先讲背景介绍"),
            TranscriptSegment(start: 30, end: 34, text: "这里讲到本地转写的细节"),
        ])

        let progress = await manager.rebuildSearchIndex()
        XCTAssertEqual(progress.total, 1)
        XCTAssertEqual(progress.processed, 1)
        XCTAssertEqual(progress.indexedTranscripts, 1)

        let groups = try InboxSearch(index: index).search("转写")
        let group = try XCTUnwrap(groups.first)
        XCTAssertTrue(group.hasSpokenMatch)
        let start = try XCTUnwrap(group.snippets.first?.startSeconds)
        XCTAssertEqual(
            start,
            30,
            accuracy: 0.01,
            "a rebuilt index must still know where the words are"
        )
    }

    /// C1-5 steps a transcript aside to Movie.transcribed.srt when the site already
    /// supplied a subtitle, so a rebuild has to look there too.
    func testRebuildFindsTheSteppedAsideSubtitleName() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        try insert(store, filename: "讲座.mp4")
        try writeSubtitles("讲座.transcribed.srt", [
            TranscriptSegment(start: 12, end: 15, text: "退让命名里的转写内容"),
        ])

        await manager.rebuildSearchIndex()
        let groups = try InboxSearch(index: index).search("转写")
        let start = try XCTUnwrap(groups.first?.snippets.first?.startSeconds)
        XCTAssertEqual(start, 12, accuracy: 0.01)
    }

    func testATaskWithoutSubtitlesGetsMetadataOnly() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        try insert(store, filename: "无字幕.mp4", title: "深度学习公开课")

        let progress = await manager.rebuildSearchIndex()
        XCTAssertEqual(progress.indexedTranscripts, 0)

        let groups = try InboxSearch(index: index).search("公开课")
        XCTAssertEqual(groups.count, 1)
        XCTAssertTrue(
            groups.first?.isMetadataOnly == true,
            "without a transcript only the name can match, and it must say so"
        )
    }

    // MARK: - Behaviour under repetition and cancellation

    func testRebuildingTwiceGivesTheSameResult() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        try insert(store, filename: "讲座.mp4")
        try writeSubtitles("讲座.srt", [TranscriptSegment(start: 5, end: 8, text: "重复重建的转写")])

        await manager.rebuildSearchIndex()
        let first = try index.entryCount()
        await manager.rebuildSearchIndex()
        let second = try index.entryCount()

        XCTAssertEqual(first, second, "a rebuild must not accumulate rows")
        XCTAssertEqual(try InboxSearch(index: index).search("转写").count, 1)
    }

    func testAnAlreadyCancelledRebuildDoesNothing() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        try insert(store, filename: "讲座.mp4")
        try writeSubtitles("讲座.srt", [TranscriptSegment(start: 0, end: 2, text: "不该被索引的转写")])

        let token = CancelToken()
        token.cancel()
        let progress = await manager.rebuildSearchIndex(cancelToken: token)

        XCTAssertEqual(progress.processed, 0)
        XCTAssertEqual(try index.entryCount(), 0)
        XCTAssertTrue(try InboxSearch(index: index).search("转写").isEmpty)
    }

    func testProgressIsReportedForEveryTask() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, store) = try makeManager(index)
        for i in 1...4 {
            try insert(store, filename: "第\(i)个.mp4")
        }

        let collected = LockedProgressRecorder()
        await manager.rebuildSearchIndex(onProgress: { collected.record($0) })

        XCTAssertEqual(collected.snapshots.map(\.processed), [1, 2, 3, 4])
        XCTAssertTrue(collected.snapshots.allSatisfy { $0.total == 4 })
        XCTAssertEqual(collected.snapshots.last?.fractionCompleted, 1.0)
    }

    func testRebuildWithNoTasksIsComplete() async throws {
        let index = try SearchIndexStore(directory: support)
        let (manager, _) = try makeManager(index)
        let progress = await manager.rebuildSearchIndex()
        XCTAssertEqual(progress.total, 0)
        XCTAssertEqual(progress.fractionCompleted, 1.0, "nothing to do is done, not stuck at zero")
    }
}

private final class LockedProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [DownloadManager.RebuildProgress] = []

    func record(_ progress: DownloadManager.RebuildProgress) {
        lock.lock()
        storage.append(progress)
        lock.unlock()
    }

    var snapshots: [DownloadManager.RebuildProgress] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
