import XCTest
@testable import NDMCore
@testable import NDMEngine

/// The model names chapters and writes summaries; it never decides boundaries. These
/// tests pin the guarantees that matter when it misbehaves, since its output is not
/// deterministic and asserting exact words would be a test that fails on a good day.
final class TranscriptNarratorTests: XCTestCase {
    private func chapters(_ count: Int) -> [TranscriptChapter] {
        (0..<count).map { index in
            TranscriptChapter(
                startSeconds: Double(index) * 60,
                endSeconds: Double(index) * 60 + 55,
                text: "第\(index + 1)部分讲的是一个独立的话题，内容有一定长度",
                segmentCount: 6
            )
        }
    }

    // MARK: - Applying titles

    /// The failure that would quietly ruin the feature: a mismatched list shifting
    /// every title onto the wrong chapter.
    func testAMismatchedTitleCountIsRefusedRatherThanMisaligned() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let input = chapters(3)
        let narration = TranscriptNarrator.Narration(
            summary: "摘要",
            chapterTitles: ["只有一个标题"]
        )
        let result = TranscriptNarrator.applying(narration, to: input)
        XCTAssertEqual(result, input, "titles must be dropped, not shifted")
        XCTAssertTrue(result.allSatisfy { $0.title == nil })
    }

    func testMatchingTitlesAreApplyedInOrder() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let result = TranscriptNarrator.applying(
            .init(summary: nil, chapterTitles: ["一", "二", "三"]),
            to: chapters(3)
        )
        XCTAssertEqual(result.map(\.title), ["一", "二", "三"])
    }

    func testAnEmptyTitleBecomesNoTitleRatherThanABlankOne() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let result = TranscriptNarrator.applying(
            .init(chapterTitles: ["一", "", "三"]),
            to: chapters(3)
        )
        XCTAssertNil(result[1].title)
    }

    func testEmptyNarrationLeavesChaptersUntouched() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let input = chapters(2)
        XCTAssertEqual(TranscriptNarrator.applying(.none, to: input), input)
        XCTAssertTrue(TranscriptNarrator.Narration.none.isEmpty)
    }

    // MARK: - Degrading instead of failing

    func testNoChaptersMeansNoNarrationRatherThanAModelCall() async throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let narration = await TranscriptNarrator().narrate(chapters: [], languageName: "Chinese")
        XCTAssertTrue(narration.isEmpty)
    }

    /// A summary must never hold a transcript hostage.
    func testAnAlreadyCancelledRunReturnsNothingImmediately() async throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let token = CancelToken()
        token.cancel()
        let started = Date()
        let narration = await TranscriptNarrator().narrate(
            chapters: chapters(3),
            languageName: "Chinese",
            cancelToken: token
        )
        XCTAssertTrue(narration.isEmpty)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.0)
    }

    /// An impossible deadline must yield an empty narration, not a hang and not a throw.
    func testAnImpossibleTimeoutDegradesQuietly() async throws {
        try LiveModelGate.skipUnlessEnabled("Testing the model timeout")
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        guard TranscriptNarrator.isAvailable else { throw XCTSkip("no language model here") }
        let narration = await TranscriptNarrator().narrate(
            chapters: chapters(4),
            languageName: "Chinese",
            timeout: 0.001
        )
        XCTAssertTrue(narration.isEmpty, "a missed deadline is a degradation, not a result")
    }

    func testLongChapterTextIsTrimmedBeforeBeingSent() throws {
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        let long = String(repeating: "内", count: 5000)
        XCTAssertEqual(TranscriptNarrator.excerpt(long, limit: 600).count, 600)
        XCTAssertEqual(TranscriptNarrator.excerpt("短", limit: 600), "短")
    }

    // MARK: - Real call

    /// Asserts shape, not wording: the model's exact words are not stable, and a test
    /// that demanded them would fail on a perfectly good output.
    func testARealNarrationIsShortAndComplete() async throws {
        try LiveModelGate.skipUnlessEnabled("Narrating with the on-device model")
        guard #available(macOS 26, *) else { throw XCTSkip("needs macOS 26") }
        guard TranscriptNarrator.isAvailable else { throw XCTSkip("no language model here") }

        let input = chapters(3)
        let narration = await TranscriptNarrator().narrate(
            chapters: input,
            languageName: "Chinese"
        )
        let summary = try XCTUnwrap(narration.summary, "expected a summary")
        XCTAssertFalse(summary.isEmpty)
        XCTAssertLessThan(
            summary.count,
            120,
            "a summary that long is not a summary; got \(summary)"
        )
        if !narration.chapterTitles.isEmpty {
            XCTAssertEqual(narration.chapterTitles.count, input.count)
            for title in narration.chapterTitles {
                XCTAssertFalse(title.isEmpty)
                XCTAssertLessThan(title.count, 40, "title too long for an outline: \(title)")
            }
        }
    }
}
