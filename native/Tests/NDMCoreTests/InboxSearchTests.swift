import XCTest
@testable import NDMCore

final class SearchResultGroupingTests: XCTestCase {
    private func hit(
        _ taskID: Int64,
        _ text: String,
        at start: Double? = nil,
        source: SearchIndexStore.Source = .transcript
    ) -> SearchIndexStore.Hit {
        SearchIndexStore.Hit(
            taskID: taskID,
            source: source,
            text: text,
            startSeconds: start,
            endSeconds: start.map { $0 + 2 }
        )
    }

    /// A forty-minute podcast can match twenty times. Listing twenty rows for one file
    /// buries every other download — one item, one row.
    func testManyHitsInOneDownloadBecomeOneResult() {
        let hits = (0..<8).map { hit(1, "第\($0)段讲到转写", at: Double($0) * 60) }
        let groups = SearchResultBuilder.group(hits: hits, query: "转写")
        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.taskID, 1)
    }

    func testDifferentDownloadsStaySeparate() {
        let groups = SearchResultBuilder.group(
            hits: [hit(1, "第一个讲转写", at: 0), hit(2, "第二个也讲转写", at: 0)],
            query: "转写"
        )
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(Set(groups.map(\.taskID)), [1, 2])
    }

    func testSnippetsAreCappedAndTheRemainderIsCounted() {
        let hits = (0..<10).map { hit(1, "第\($0)段讲到转写", at: Double($0)) }
        let group = SearchResultBuilder.group(hits: hits, query: "转写", snippetsPerTask: 3).first
        XCTAssertEqual(group?.snippets.count, 3)
        XCTAssertEqual(group?.additionalSnippetCount, 7, "hidden matches must be counted, not lost")
        XCTAssertEqual(group?.totalSnippetCount, 10)
    }

    /// Truncating a time-ordered list would keep the introduction and drop the part
    /// the user searched for. Selection happens on relevance, display on time.
    func testTheMostRelevantMomentsSurviveTruncationNotTheEarliest() {
        let hits = [
            hit(1, "开场只提到转写", at: 0),
            hit(1, "中间也只提到转写", at: 100),
            hit(1, "这里同时讲转写和识别", at: 200),
        ]
        let group = SearchResultBuilder.group(
            hits: hits,
            query: "转写 识别",
            snippetsPerTask: 1
        ).first
        XCTAssertEqual(group?.snippets.count, 1)
        XCTAssertEqual(
            group?.snippets.first?.startSeconds,
            200,
            "the line containing both terms must be the one kept"
        )
    }

    func testKeptSnippetsAreShownInTimeOrder() {
        let hits = [
            hit(1, "后面讲转写和识别", at: 300),
            hit(1, "前面讲转写和识别", at: 10),
            hit(1, "中间讲转写和识别", at: 100),
        ]
        let group = SearchResultBuilder.group(
            hits: hits,
            query: "转写 识别",
            snippetsPerTask: 3
        ).first
        XCTAssertEqual(group?.snippets.map(\.startSeconds), [10, 100, 300])
    }

    /// Metadata describes the item rather than a place inside it, so it follows the
    /// timed moments.
    func testTimedMomentsComeBeforeMetadata() {
        let hits = [
            hit(1, "标题里也有转写", source: .title),
            hit(1, "内容里讲转写", at: 42),
        ]
        let group = SearchResultBuilder.group(hits: hits, query: "转写").first
        XCTAssertEqual(group?.snippets.first?.startSeconds, 42)
        XCTAssertEqual(group?.snippets.last?.source, .title)
    }

    // MARK: - Ranking

    func testDownloadsContainingMoreOfTheQueryRankHigher() {
        let hits = [
            hit(1, "只讲转写", at: 0),
            hit(2, "同时讲转写与识别", at: 0),
        ]
        let groups = SearchResultBuilder.group(hits: hits, query: "转写 识别")
        XCTAssertEqual(groups.first?.taskID, 2)
        XCTAssertEqual(groups.first?.bestMatchedTermCount, 2)
        XCTAssertEqual(groups.last?.bestMatchedTermCount, 1)
    }

    /// The index already ordered by relevance; ties must follow it so that running the
    /// same query twice does not reshuffle what someone is reading.
    func testTiesFollowTheIndexOrderAndAreStable() {
        let hits = [hit(7, "讲转写", at: 0), hit(3, "讲转写", at: 0), hit(5, "讲转写", at: 0)]
        let first = SearchResultBuilder.group(hits: hits, query: "转写").map(\.taskID)
        let second = SearchResultBuilder.group(hits: hits, query: "转写").map(\.taskID)
        XCTAssertEqual(first, [7, 3, 5], "arrival order decides")
        XCTAssertEqual(first, second, "identical input must give identical output")
    }

    // MARK: - Honesty about what matched

    /// A download with no transcript can only match on its name. Saying nothing about
    /// that would imply the words were found inside it.
    func testAMetadataOnlyMatchIsLabelledAsSuch() {
        let groups = SearchResultBuilder.group(
            hits: [hit(1, "深度学习公开课", source: .title)],
            query: "公开课"
        )
        let group = groups.first
        XCTAssertEqual(group?.isMetadataOnly, true)
        XCTAssertEqual(group?.hasSpokenMatch, false)
        XCTAssertEqual(group?.matchedSources, [.title])
    }

    func testASpokenMatchIsDistinguishedFromANameMatch() {
        let groups = SearchResultBuilder.group(
            hits: [
                hit(1, "转写公开课", source: .title),
                hit(1, "里面讲到转写", at: 30),
            ],
            query: "转写"
        )
        let group = groups.first
        XCTAssertEqual(group?.hasSpokenMatch, true)
        XCTAssertEqual(group?.isMetadataOnly, false)
        XCTAssertEqual(group?.matchedSources, [.title, .transcript])
    }

    func testOnlyTimedSnippetsClaimTheyCanJump() throws {
        let groups = SearchResultBuilder.group(
            hits: [hit(1, "标题转写", source: .title), hit(1, "内容转写", at: 5)],
            query: "转写"
        )
        let snippets = try XCTUnwrap(groups.first?.snippets)
        XCTAssertEqual(snippets.filter(\.canJumpToTime).count, 1)
        XCTAssertEqual(snippets.filter { !$0.canJumpToTime }.count, 1)
    }

    // MARK: - Edges

    func testAnUnsearchableQueryProducesNothing() {
        XCTAssertTrue(SearchResultBuilder.group(hits: [hit(1, "内容", at: 0)], query: "").isEmpty)
        XCTAssertTrue(SearchResultBuilder.group(hits: [hit(1, "内容", at: 0)], query: "，。").isEmpty)
    }

    func testNoHitsProduceNoGroups() {
        XCTAssertTrue(SearchResultBuilder.group(hits: [], query: "转写").isEmpty)
    }

    func testASnippetCapOfZeroStillCountsWhatExists() {
        let group = SearchResultBuilder.group(
            hits: [hit(1, "讲转写", at: 0)],
            query: "转写",
            snippetsPerTask: 0
        ).first
        XCTAssertEqual(group?.snippets.count, 0)
        XCTAssertEqual(group?.additionalSnippetCount, 1)
    }

    func testHighlightRangesSurviveIntoTheResult() throws {
        let group = try XCTUnwrap(
            SearchResultBuilder.group(hits: [hit(1, "这里讲到本地转写", at: 0)], query: "转写").first
        )
        let snippet = try XCTUnwrap(group.snippets.first)
        let characters = Array(snippet.highlight.snippet)
        let range = try XCTUnwrap(snippet.highlight.ranges.first)
        XCTAssertEqual(String(characters[range]), "转写")
    }
}

final class InboxSearchIntegrationTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-inboxsearch-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    /// Index, group and highlight together, over a real database.
    func testSearchingAcrossTwoDownloadsGroupsAndRanksThem() throws {
        let index = try SearchIndexStore(directory: root)
        try index.replaceEntries(taskID: 1, entries: [
            .init(taskID: 1, source: .title, text: "语音识别公开课"),
            .init(taskID: 1, source: .transcript, text: "开场先讲背景", startSeconds: 0, endSeconds: 5),
            .init(
                taskID: 1,
                source: .transcript,
                text: "这里同时讲本地转写和语音识别",
                startSeconds: 120,
                endSeconds: 126
            ),
        ])
        try index.replaceEntries(taskID: 2, entries: [
            .init(taskID: 2, source: .transcript, text: "只顺口提了转写", startSeconds: 8, endSeconds: 11),
        ])

        let groups = try InboxSearch(index: index).search("转写 识别")
        XCTAssertEqual(groups.count, 1, "task 2 lacks 识别, so it must not match an AND query")
        let group = try XCTUnwrap(groups.first)
        XCTAssertEqual(group.taskID, 1)
        XCTAssertTrue(group.hasSpokenMatch)
        XCTAssertEqual(group.snippets.first?.startSeconds, 120)
        XCTAssertEqual(group.bestMatchedTermCount, 2)
    }

    func testDeletingADownloadRemovesItFromResults() throws {
        let index = try SearchIndexStore(directory: root)
        try index.replaceEntries(taskID: 1, entries: [
            .init(taskID: 1, source: .transcript, text: "机密内容讲转写", startSeconds: 0, endSeconds: 3),
        ])
        let search = InboxSearch(index: index)
        XCTAssertEqual(try search.search("转写").count, 1)

        try index.deleteAll(taskID: 1)
        XCTAssertTrue(
            try search.search("转写").isEmpty,
            "a deleted download must not remain findable"
        )
    }

    func testTaskLimitBoundsTheRows() throws {
        let index = try SearchIndexStore(directory: root)
        for taskID in Int64(1)...Int64(10) {
            try index.replaceEntries(taskID: taskID, entries: [
                .init(
                    taskID: taskID,
                    source: .transcript,
                    text: "第\(taskID)个下载讲转写",
                    startSeconds: 0,
                    endSeconds: 2
                ),
            ])
        }
        XCTAssertEqual(try InboxSearch(index: index).search("转写", taskLimit: 4).count, 4)
    }

    func testAnUnsearchableQueryDoesNotTouchTheIndex() throws {
        let index = try SearchIndexStore(directory: root)
        try index.replaceEntries(taskID: 1, entries: [
            .init(taskID: 1, source: .transcript, text: "任何内容", startSeconds: 0, endSeconds: 1),
        ])
        XCTAssertTrue(try InboxSearch(index: index).search("，。！").isEmpty)
    }
}
