import XCTest
@testable import NDMCore

final class SearchTermsTests: XCTestCase {
    /// Highlighting must mark the phrase the user typed, not the bigrams the index
    /// searched on. Nobody types 本地转写 expecting three overlapping fragments to
    /// light up.
    func testAChineseRunStaysOnePhrase() {
        XCTAssertEqual(SearchSnippet.terms(in: "本地转写"), ["本地转写"])
    }

    func testLatinWordsAreSeparateTerms() {
        XCTAssertEqual(
            SearchSnippet.terms(in: "on-device speech"),
            ["on", "device", "speech"]
        )
    }

    func testScriptChangesSplitTerms() {
        // Terms keep their original case; matching folds case separately.
        XCTAssertEqual(SearchSnippet.terms(in: "用GPT推理"), ["用", "GPT", "推理"])
    }

    func testPunctuationIsIgnored() {
        XCTAssertEqual(SearchSnippet.terms(in: "「转写」，可用！"), ["转写", "可用"])
        XCTAssertTrue(SearchSnippet.terms(in: "，。！？").isEmpty)
        XCTAssertTrue(SearchSnippet.terms(in: "").isEmpty)
    }
}

final class SearchMatchRangeTests: XCTestCase {
    func testASingleChineseMatchIsFoundByCharacterOffset() {
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "用来验证本地转写是否可用", terms: ["本地转写"]),
            [4..<8]
        )
    }

    /// Offsets count characters. An emoji is one character, so a highlight after it
    /// must not slide by the extra UTF-16 unit it occupies.
    func testEmojiDoesNotShiftOffsets() {
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "🎬本地转写", terms: ["本地转写"]),
            [1..<5]
        )
    }

    func testEveryOccurrenceIsReported() {
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "转写完成，转写成功", terms: ["转写"]),
            [0..<2, 5..<7]
        )
    }

    func testEnglishMatchingIgnoresCase() {
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "On-Device Speech", terms: ["speech"]),
            [10..<16]
        )
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "on-device speech", terms: ["SPEECH"]),
            [10..<16]
        )
    }

    func testOverlappingAndTouchingRangesAreFused() {
        // 本地 and 地转 touch and overlap; one continuous highlight is correct.
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "本地转写", terms: ["本地", "地转"]),
            [0..<3]
        )
    }

    func testAdjacentRangesBecomeOne() {
        XCTAssertEqual(
            SearchSnippet.matchRanges(in: "语音识别", terms: ["语音", "识别"]),
            [0..<4]
        )
    }

    /// A document can match on bigrams without containing the phrase contiguously.
    /// Highlighting nothing in that case would make a correct result look wrong.
    func testAnAbsentPhraseFallsBackToItsBigrams() {
        let ranges = SearchSnippet.matchRanges(in: "本地做了转写", terms: ["本地转写"])
        XCTAssertFalse(ranges.isEmpty, "本地 and 转写 are both present")
        XCTAssertEqual(ranges, [0..<2, 4..<6])
    }

    func testATermThatIsGenuinelyAbsentHighlightsNothing() {
        XCTAssertTrue(
            SearchSnippet.matchRanges(in: "完全无关的内容", terms: ["量子力学"]).isEmpty
        )
    }

    func testMatchesAreNotFoundAcrossPunctuationTheyDoNotContain() {
        // The phrase is not there; only its halves are, so only those are marked.
        let ranges = SearchSnippet.matchRanges(in: "语音，识别", terms: ["语音识别"])
        XCTAssertEqual(ranges, [0..<2, 3..<5])
    }
}

final class SearchMatchedTermCountTests: XCTestCase {
    func testCountsDistinctTermsNotOccurrences() {
        XCTAssertEqual(
            SearchSnippet.matchedTermCount(in: "转写 转写 转写", terms: ["转写"]),
            1
        )
    }

    func testCountsEachTermThatAppears() {
        XCTAssertEqual(
            SearchSnippet.matchedTermCount(in: "本地转写与语音识别", terms: ["转写", "识别", "量子"]),
            2
        )
    }

    func testZeroWhenNothingMatches() {
        XCTAssertEqual(
            SearchSnippet.matchedTermCount(in: "无关内容", terms: ["转写"]),
            0
        )
    }
}

final class SearchSnippetWindowTests: XCTestCase {
    private let long = "第一段内容讲的是背景介绍，第二段开始说本地转写这件事，第三段讲索引，第四段讲搜索排序，第五段收尾"

    func testShortTextIsReturnedWholeWithNoEllipsis() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: "本地转写可用", query: "转写", windowLength: 90)
        )
        XCTAssertEqual(result.snippet, "本地转写可用")
        XCTAssertFalse(result.truncatedAtStart)
        XCTAssertFalse(result.truncatedAtEnd)
        XCTAssertFalse(result.snippet.contains("…"))
    }

    /// Ellipses appear only where text was really removed, or they become decoration
    /// that lies about the content.
    func testEllipsisOnlyWhereTextWasActuallyCut() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: long, query: "索引", windowLength: 20, leadingContext: 6)
        )
        XCTAssertTrue(result.truncatedAtStart)
        XCTAssertTrue(result.snippet.hasPrefix("…"))
        XCTAssertTrue(result.truncatedAtEnd)
        XCTAssertTrue(result.snippet.hasSuffix("…"))
    }

    func testAMatchAtTheStartIsNotPrefixedWithAnEllipsis() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: long, query: "第一段", windowLength: 20)
        )
        XCTAssertFalse(result.truncatedAtStart)
        XCTAssertFalse(result.snippet.hasPrefix("…"))
        XCTAssertTrue(result.truncatedAtEnd)
    }

    func testAMatchAtTheEndIsNotSuffixedWithAnEllipsis() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: long, query: "收尾", windowLength: 20)
        )
        XCTAssertTrue(result.truncatedAtStart)
        XCTAssertFalse(
            result.truncatedAtEnd,
            "the window reaches the end, so nothing was cut there"
        )
        XCTAssertFalse(result.snippet.hasSuffix("…"))
    }

    /// The offsets must address the returned string, ellipsis and all — otherwise
    /// every highlight in a truncated snippet is off by one.
    func testRangesAddressTheReturnedSnippetIncludingItsEllipsis() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: long, query: "本地转写", windowLength: 24, leadingContext: 8)
        )
        let characters = Array(result.snippet)
        let range = try XCTUnwrap(result.ranges.first)
        XCTAssertEqual(String(characters[range]), "本地转写")
    }

    func testHighlightsOutsideTheWindowAreDropped() throws {
        let text = "转写在开头，中间很长很长很长很长很长很长很长很长很长，结尾也有转写"
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: text, query: "转写", windowLength: 12, leadingContext: 0)
        )
        let characters = Array(result.snippet)
        for range in result.ranges {
            XCTAssertLessThanOrEqual(range.upperBound, characters.count)
            XCTAssertEqual(String(characters[range]), "转写")
        }
    }

    /// A whole character is never split, because everything is measured in characters.
    func testWindowNeverSplitsACharacter() throws {
        let text = String(repeating: "漢", count: 200)
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: text, query: "漢漢", windowLength: 30)
        )
        XCTAssertTrue(result.snippet.allSatisfy { $0 == "漢" || $0 == "…" })
    }

    func testAnUnsearchableQueryReturnsNil() {
        XCTAssertNil(SearchSnippet.highlight(text: "任何内容", query: "，。！"))
        XCTAssertNil(SearchSnippet.highlight(text: "任何内容", query: ""))
    }

    /// A line that matched the document but not this segment still needs something to
    /// show, so a leading excerpt comes back with no highlights rather than nil.
    func testASearchableQueryWithNoLocalMatchStillReturnsAnExcerpt() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: long, query: "量子力学", windowLength: 20)
        )
        XCTAssertTrue(result.ranges.isEmpty)
        XCTAssertEqual(result.matchedTermCount, 0)
        XCTAssertFalse(result.snippet.isEmpty)
        XCTAssertFalse(result.truncatedAtStart, "with no match, start from the beginning")
    }

    func testMatchedTermCountIsCarriedThrough() throws {
        let result = try XCTUnwrap(
            SearchSnippet.highlight(text: "本地转写与语音识别", query: "转写 识别")
        )
        XCTAssertEqual(result.matchedTermCount, 2)
    }

    func testEmptyTextIsHandled() throws {
        let result = try XCTUnwrap(SearchSnippet.highlight(text: "", query: "转写"))
        XCTAssertEqual(result.snippet, "")
        XCTAssertTrue(result.ranges.isEmpty)
    }
}
