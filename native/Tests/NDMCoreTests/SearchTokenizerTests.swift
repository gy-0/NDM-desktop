import XCTest
@testable import NDMCore

final class SearchTokenizerIndexTests: XCTestCase {
    func testChineseBecomesOverlappingBigramsPlusTheRunsLastCharacter() {
        XCTAssertEqual(
            SearchTokenizer.indexTokens("本地转写"),
            ["本地", "地转", "转写", "写"]
        )
    }

    /// A query that straddles a word boundary is exactly what word segmentation
    /// would lose, and the reason bigrams were chosen over it.
    func testABigramSpanningAWordBoundaryIsIndexed() {
        XCTAssertTrue(SearchTokenizer.indexTokens("本地转写").contains("地转"))
    }

    func testASingleChineseCharacterIsItsOwnToken() {
        XCTAssertEqual(SearchTokenizer.indexTokens("中"), ["中"])
    }

    func testEnglishIsSplitIntoLowercasedWordsNotBigrams() {
        XCTAssertEqual(
            SearchTokenizer.indexTokens("On-Device Speech"),
            ["on", "device", "speech"]
        )
    }

    /// Bigramming English would multiply the index and break prefix search for no
    /// benefit — English already has spaces.
    func testEnglishTokensAreWholeWords() {
        for token in SearchTokenizer.indexTokens("recognition") {
            XCTAssertEqual(token, "recognition")
        }
    }

    func testDigitsSurviveAsTokens() {
        XCTAssertEqual(SearchTokenizer.indexTokens("GPT 4o 2026"), ["gpt", "4o", "2026"])
    }

    func testMixedScriptsSplitAtTheBoundary() {
        XCTAssertEqual(
            SearchTokenizer.indexTokens("用 GPT 推理"),
            ["用", "gpt", "推理", "理"]
        )
    }

    /// Punctuation ends a run, which is why the run-final character needs its own
    /// token — otherwise 音 in "语音，" would be unfindable while 语 was fine.
    func testPunctuationEndsARunAndTheFinalCharacterStaysFindable() {
        let tokens = SearchTokenizer.indexTokens("测试语音，可用")
        XCTAssertTrue(tokens.contains("语音"))
        XCTAssertTrue(tokens.contains("音"), "the run-final character must be indexed")
        XCTAssertFalse(
            tokens.contains("音可"),
            "a bigram must never straddle punctuation"
        )
    }

    func testEmptyAndPunctuationOnlyTextYieldNoTokens() {
        XCTAssertTrue(SearchTokenizer.indexTokens("").isEmpty)
        XCTAssertTrue(SearchTokenizer.indexTokens("   ").isEmpty)
        XCTAssertTrue(SearchTokenizer.indexTokens("，。！？ -- ").isEmpty)
    }

    func testJapaneseAndKoreanAreTreatedAsCJK() {
        XCTAssertTrue(SearchTokenizer.indexTokens("日本語").contains("日本"))
        XCTAssertTrue(SearchTokenizer.indexTokens("한국어").contains("한국"))
    }

    func testIndexedTextIsSpaceJoinedSoSQLiteCanSplitItBack() {
        XCTAssertEqual(SearchTokenizer.indexedText("本地转写"), "本地 地转 转写 写")
    }
}

final class SearchTokenizerQueryTests: XCTestCase {
    func testATwoCharacterChineseQueryBecomesOneExactTerm() {
        XCTAssertEqual(SearchTokenizer.matchExpression(for: "中文"), "\"中文\"")
    }

    func testALongerChineseQueryRequiresEveryBigram() {
        XCTAssertEqual(
            SearchTokenizer.matchExpression(for: "本地转写"),
            "\"本地\" AND \"地转\" AND \"转写\""
        )
    }

    /// A lone CJK character is no bigram, so it asks for any bigram starting with it.
    func testASingleChineseCharacterBecomesAPrefixQuery() {
        XCTAssertEqual(SearchTokenizer.matchExpression(for: "中"), "\"中\"*")
    }

    /// Two words typed together almost always mean "both", and OR would bury the
    /// result the user meant.
    func testMultipleTermsAreCombinedWithAnd() {
        XCTAssertEqual(
            SearchTokenizer.matchExpression(for: "speech recognition"),
            "\"speech\" AND \"recognition\""
        )
    }

    func testMixedScriptQueriesCombineBothKinds() {
        XCTAssertEqual(
            SearchTokenizer.matchExpression(for: "GPT 推理"),
            "\"gpt\" AND \"推理\""
        )
    }

    func testNothingSearchableReturnsNil() {
        XCTAssertNil(SearchTokenizer.matchExpression(for: ""))
        XCTAssertNil(SearchTokenizer.matchExpression(for: "   "))
        XCTAssertNil(SearchTokenizer.matchExpression(for: "，。？"))
        XCTAssertFalse(SearchTokenizer.isSearchable("!!!"))
        XCTAssertTrue(SearchTokenizer.isSearchable("中文"))
    }

    /// Punctuation, quotes included, is a separator — so a quote can never survive
    /// into a term and alter the expression.
    func testQuotesCannotEscapeIntoTheExpression() {
        let expression = SearchTokenizer.matchExpression(for: "say \"hello\" now")
        XCTAssertEqual(expression, "\"say\" AND \"hello\" AND \"now\"")
    }

    func testFTS5OperatorsInTheQueryAreNeutralised() {
        // `*`, `:` and `-` are FTS5 syntax; none may reach the expression as syntax.
        XCTAssertEqual(SearchTokenizer.matchExpression(for: "a* OR b"), "\"a\" AND \"or\" AND \"b\"")
        XCTAssertEqual(SearchTokenizer.matchExpression(for: "col:value"), "\"col\" AND \"value\"")
    }

    /// Every query token must be something the index actually stores, or a document
    /// becomes unfindable by its own words.
    func testEveryQueryTokenExistsInTheIndexTokens() {
        for text in ["本地转写", "语音识别", "on-device speech", "用 GPT 推理", "中"] {
            let indexed = Set(SearchTokenizer.indexTokens(text))
            for token in SearchTokenizer.queryTokens(text) {
                XCTAssertTrue(
                    indexed.contains(token),
                    "\(text): query token \(token.debugDescription) is not indexed"
                )
            }
        }
    }

    /// The run-final unigram belongs to indexing only; demanding it in a query would
    /// add a redundant term to every Chinese search.
    func testQueryTokensOmitTheRunFinalUnigram() {
        XCTAssertEqual(SearchTokenizer.queryTokens("本地转写"), ["本地", "地转", "转写"])
        XCTAssertEqual(SearchTokenizer.indexTokens("本地转写"), ["本地", "地转", "转写", "写"])
    }
}
