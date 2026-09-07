import SQLite3
import XCTest
@testable import NDMCore

final class SearchIndexStoreTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-index-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeStore() throws -> SearchIndexStore {
        try SearchIndexStore(directory: root)
    }

    private func transcript(
        _ taskID: Int64,
        _ lines: [(Double, Double, String)]
    ) -> [SearchIndexStore.Entry] {
        lines.map {
            SearchIndexStore.Entry(
                taskID: taskID,
                source: .transcript,
                text: $0.2,
                startSeconds: $0.0,
                endSeconds: $0.1
            )
        }
    }

    // MARK: - Recall

    /// The whole reason for the custom tokenizer: two-character Chinese must be
    /// findable, which neither of SQLite's own tokenizers manages.
    func testTwoCharacterChineseIsFound() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [
            (0, 2.4, "这是一段中文测试语音"),
            (2.4, 5, "用来验证本地转写是否可用"),
        ]))
        XCTAssertEqual(try store.search("中文").count, 1)
        XCTAssertEqual(try store.search("转写").count, 1)
    }

    /// A query straddling a word boundary is what word segmentation would lose.
    func testAQueryStraddlingAWordBoundaryIsFound() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [
            (0, 3, "用来验证本地转写是否可用"),
        ]))
        XCTAssertEqual(try store.search("地转").count, 1)
    }

    func testEnglishIsFoundCaseInsensitively() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [
            (0, 3, "This lecture covers On-Device Speech recognition"),
        ]))
        XCTAssertEqual(try store.search("speech").count, 1)
        XCTAssertEqual(try store.search("SPEECH").count, 1)
    }

    func testMultipleTermsMustAllAppear() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [
            (0, 3, "本地转写与语音识别"),
        ]))
        XCTAssertEqual(try store.search("转写 识别").count, 1)
        XCTAssertEqual(
            try store.search("转写 量子").count,
            0,
            "every term has to be present"
        )
    }

    func testAnAbsentQueryFindsNothing() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 3, "无关内容")]))
        XCTAssertTrue(try store.search("量子力学").isEmpty)
    }

    func testAnUnsearchableQueryReturnsNothingRatherThanEverything() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 3, "任何内容")]))
        XCTAssertTrue(try store.search("").isEmpty)
        XCTAssertTrue(try store.search("，。！").isEmpty)
    }

    // MARK: - What comes back

    func testHitsCarryEnoughToJumpToTheSecond() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 42, entries: transcript(42, [
            (0, 2.4, "开场介绍"),
            (12.5, 15.0, "这里讲到本地转写"),
        ]))
        let hits = try store.search("转写")
        XCTAssertEqual(hits.count, 1)
        let hit = try XCTUnwrap(hits.first)
        XCTAssertEqual(hit.taskID, 42)
        XCTAssertEqual(hit.source, .transcript)
        XCTAssertEqual(hit.startSeconds, 12.5)
        XCTAssertEqual(hit.endSeconds, 15.0)
        XCTAssertEqual(
            hit.text,
            "这里讲到本地转写",
            "the original text must come back verbatim for highlighting"
        )
    }

    /// Metadata sources have no timestamp, and must say so rather than claiming zero.
    func testMetadataSourcesHaveNoTimestamp() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 7, entries: [
            SearchIndexStore.Entry(taskID: 7, source: .title, text: "深度学习公开课"),
            SearchIndexStore.Entry(taskID: 7, source: .site, text: "bilibili.com"),
        ])
        let hits = try store.search("公开课")
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.source, .title)
        XCTAssertNil(hits.first?.startSeconds)
    }

    func testResultsCanBeLimited() throws {
        let store = try makeStore()
        let lines = (0..<20).map { (Double($0), Double($0) + 1, "第\($0)段讲转写") }
        try store.replaceEntries(taskID: 1, entries: transcript(1, lines))
        XCTAssertEqual(try store.search("转写", limit: 5).count, 5)
    }

    // MARK: - Idempotence and deletion

    /// Re-running a transcript must not double every line in the results.
    func testRewritingATaskReplacesRatherThanAppends() throws {
        let store = try makeStore()
        let entries = transcript(1, [(0, 2, "本地转写")])
        try store.replaceEntries(taskID: 1, entries: entries)
        try store.replaceEntries(taskID: 1, entries: entries)
        try store.replaceEntries(taskID: 1, entries: entries)
        XCTAssertEqual(try store.search("转写").count, 1)
        XCTAssertEqual(try store.entryCount(), 1)
    }

    func testRewritingOneTaskLeavesOthersAlone() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "第一个任务讲转写")]))
        try store.replaceEntries(taskID: 2, entries: transcript(2, [(0, 2, "第二个任务也讲转写")]))
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "第一个任务改了内容仍讲转写")]))
        XCTAssertEqual(try store.search("转写").count, 2)
        XCTAssertEqual(try store.indexedTaskIDs(), [1, 2])
    }

    /// A deleted download must stop being findable. This is a privacy requirement, not
    /// housekeeping: otherwise search hands back content the user believed was erased.
    func testDeletingATaskMakesItUnfindable() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "机密内容不该留下")]))
        XCTAssertEqual(try store.search("机密").count, 1)

        try store.deleteAll(taskID: 1)
        XCTAssertTrue(try store.search("机密").isEmpty)
        XCTAssertEqual(try store.entryCount(), 0)
        XCTAssertTrue(try store.indexedTaskIDs().isEmpty)
    }

    func testDeletingOneTaskKeepsTheOthers() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "保留这条转写")]))
        try store.replaceEntries(taskID: 2, entries: transcript(2, [(0, 2, "删掉那条转写")]))
        try store.deleteAll(taskID: 2)
        let hits = try store.search("转写")
        XCTAssertEqual(hits.count, 1)
        XCTAssertEqual(hits.first?.taskID, 1)
    }

    func testDeletingAnUnknownTaskIsNotAnError() throws {
        let store = try makeStore()
        XCTAssertNoThrow(try store.deleteAll(taskID: 999))
    }

    /// A line with nothing tokenizable would occupy a row that can never be found.
    func testUnsearchableEntriesAreNotStored() throws {
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [
            (0, 1, "，。！？"),
            (1, 2, "有内容的一行讲转写"),
        ]))
        XCTAssertEqual(try store.entryCount(), 1)
    }

    // MARK: - Durability

    func testTheIndexSurvivesReopening() throws {
        do {
            let store = try makeStore()
            try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "持久化的转写内容")]))
            XCTAssertFalse(store.wasRebuilt)
        }
        let reopened = try makeStore()
        XCTAssertFalse(reopened.wasRebuilt, "a healthy index must not be discarded")
        XCTAssertEqual(try reopened.search("转写").count, 1)
    }

    /// Derived data: a version it does not recognise is deleted, not migrated.
    func testAForeignSchemaVersionTriggersARebuild() throws {
        do {
            let store = try makeStore()
            try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "旧版本的转写")]))
        }
        // Pretend the file came from a build with a different schema.
        let db = root.appendingPathComponent("SearchIndex.db")
        XCTAssertTrue(FileManager.default.fileExists(atPath: db.path))
        try rewriteSchemaVersion(at: db, to: "999")

        let reopened = try makeStore()
        XCTAssertTrue(reopened.wasRebuilt, "an unknown schema must be discarded")
        XCTAssertEqual(try reopened.entryCount(), 0)
        XCTAssertTrue(try reopened.search("转写").isEmpty)
    }

    /// A corrupt file must cost a rebuild, not the feature.
    func testACorruptFileIsRebuiltRatherThanFatal() throws {
        do {
            let store = try makeStore()
            try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "会被损坏的转写")]))
        }
        let db = root.appendingPathComponent("SearchIndex.db")
        try Data(repeating: 0x7F, count: 4096).write(to: db)

        let reopened = try makeStore()
        XCTAssertTrue(reopened.wasRebuilt)
        XCTAssertEqual(try reopened.entryCount(), 0)
        // And it must be usable afterwards, not just openable.
        try reopened.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "重建之后的转写")]))
        XCTAssertEqual(try reopened.search("转写").count, 1)
    }

    func testAnEmptyFileIsRebuilt() throws {
        let db = root.appendingPathComponent("SearchIndex.db")
        try Data().write(to: db)
        let store = try makeStore()
        try store.replaceEntries(taskID: 1, entries: transcript(1, [(0, 2, "空文件之后的转写")]))
        XCTAssertEqual(try store.search("转写").count, 1)
    }

    /// The index lives in its own file so wiping it can never touch the task database.
    func testTheIndexIsItsOwnFile() throws {
        _ = try makeStore()
        let contents = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertTrue(contents.contains("SearchIndex.db"))
        XCTAssertFalse(
            contents.contains("NeatDB.db"),
            "the index must not share a file with the task store"
        )
    }

    // MARK: - Helpers

    private func rewriteSchemaVersion(at url: URL, to value: String) throws {
        var handle: OpaquePointer?
        guard sqlite3_open(url.path, &handle) == SQLITE_OK else {
            throw StoreTestFailure.cannotOpenFixture
        }
        defer { sqlite3_close(handle) }
        let sql = "INSERT OR REPLACE INTO meta(key, value) VALUES ('schemaVersion', '\(value)');"
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw StoreTestFailure.cannotWriteFixture
        }
    }

    private enum StoreTestFailure: Error {
        case cannotOpenFixture
        case cannotWriteFixture
    }
}
