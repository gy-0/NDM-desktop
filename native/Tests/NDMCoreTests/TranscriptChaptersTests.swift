import XCTest
@testable import NDMCore

final class TranscriptChaptersTests: XCTestCase {
    /// Continuous speech with explicit silences at the given indices.
    ///
    /// `length` is deliberately close to `spacing`: real engine output comes back
    /// essentially back to back, so the natural gap must stay well under
    /// `pauseThreshold` or every sentence boundary would look like a topic change.
    /// The first version of this helper left a 2.0s gap everywhere, exactly the
    /// default threshold, which made "no pauses" mean the opposite.
    private func lecture(
        segmentCount: Int,
        spacing: TimeInterval = 10,
        length: TimeInterval = 9.7,
        pausesBefore: [Int: TimeInterval] = [:]
    ) -> [TranscriptSegment] {
        var segments: [TranscriptSegment] = []
        var clock = 0.0
        for index in 0..<segmentCount {
            if let pause = pausesBefore[index] { clock += pause }
            segments.append(TranscriptSegment(
                start: clock,
                end: clock + length,
                text: "第\(index)段内容"
            ))
            clock += spacing
        }
        return segments
    }

    // MARK: - When not to split

    func testEmptyInputYieldsNoChapters() {
        XCTAssertTrue(TranscriptChapters.detect(segments: []).isEmpty)
    }

    /// Splitting a two-minute clip helps nobody.
    func testAShortRecordingStaysOneChapter() {
        let chapters = TranscriptChapters.detect(
            segments: lecture(segmentCount: 6, pausesBefore: [3: 30])
        )
        XCTAssertEqual(chapters.count, 1)
    }

    func testASingleSegmentIsOneChapter() {
        let chapters = TranscriptChapters.detect(segments: [
            TranscriptSegment(start: 0, end: 5, text: "只有一句"),
        ])
        XCTAssertEqual(chapters.count, 1)
        XCTAssertEqual(chapters.first?.segmentCount, 1)
    }

    /// Continuous speech has no boundaries to find, however long it runs.
    func testALongRecordingWithNoPausesStaysOneChapter() {
        let chapters = TranscriptChapters.detect(segments: lecture(segmentCount: 60))
        XCTAssertEqual(chapters.count, 1)
    }

    // MARK: - Splitting

    func testALongSilenceBecomesABoundary() {
        let chapters = TranscriptChapters.detect(
            segments: lecture(segmentCount: 30, pausesBefore: [15: 20])
        )
        XCTAssertEqual(chapters.count, 2)
        XCTAssertEqual(chapters.first?.segmentCount, 15)
        XCTAssertEqual(chapters.last?.segmentCount, 15)
    }

    /// An outline of twenty entries for a twenty-minute talk is not an outline. A run
    /// of pauses must not shred it.
    func testCloselySpacedPausesDoNotShredTheOutline() {
        let pauses = Dictionary(uniqueKeysWithValues: (10...20).map { ($0, 5.0) })
        let chapters = TranscriptChapters.detect(
            segments: lecture(segmentCount: 40, pausesBefore: pauses)
        )
        for chapter in chapters {
            XCTAssertGreaterThanOrEqual(
                chapter.duration,
                45 - 0.001,
                "a chapter shorter than the minimum slipped through"
            )
        }
    }

    /// The strongest signals survive the cap, not whichever happened to come first.
    func testTheLongestSilencesWinWhenCapped() {
        let chapters = TranscriptChapters.detect(
            segments: lecture(
                segmentCount: 60,
                pausesBefore: [15: 3.0, 30: 60.0, 45: 3.0]
            ),
            options: .init(maximumChapters: 2)
        )
        XCTAssertEqual(chapters.count, 2)
        XCTAssertEqual(
            chapters.first?.segmentCount,
            30,
            "the sixty-second silence is the boundary, not one of the three-second ones"
        )
    }

    func testChapterCountIsCapped() {
        let pauses = Dictionary(uniqueKeysWithValues: stride(from: 6, to: 300, by: 6).map { ($0, 10.0) })
        let chapters = TranscriptChapters.detect(
            segments: lecture(segmentCount: 300, pausesBefore: pauses),
            options: .init(maximumChapters: 5)
        )
        XCTAssertLessThanOrEqual(chapters.count, 5)
    }

    // MARK: - Chapter contents

    func testChaptersCoverEverySegmentExactlyOnce() {
        let segments = lecture(segmentCount: 40, pausesBefore: [12: 20, 26: 20])
        let chapters = TranscriptChapters.detect(segments: segments)
        XCTAssertEqual(chapters.reduce(0) { $0 + $1.segmentCount }, segments.count)
    }

    func testChaptersAreInOrderAndDoNotOverlap() {
        let chapters = TranscriptChapters.detect(
            segments: lecture(segmentCount: 40, pausesBefore: [12: 20, 26: 20])
        )
        for index in 1..<chapters.count {
            XCTAssertLessThanOrEqual(chapters[index - 1].endSeconds, chapters[index].startSeconds)
        }
    }

    func testChapterTextJoinsWithoutInventingSpacesBetweenCJK() {
        let chapters = TranscriptChapters.detect(segments: [
            TranscriptSegment(start: 0, end: 2, text: "这是第一句"),
            TranscriptSegment(start: 2, end: 4, text: "这是第二句"),
        ])
        XCTAssertEqual(chapters.first?.text, "这是第一句这是第二句")
    }

    func testChapterTextJoinsLatinWithSpaces() {
        let chapters = TranscriptChapters.detect(segments: [
            TranscriptSegment(start: 0, end: 2, text: "first part"),
            TranscriptSegment(start: 2, end: 4, text: "second part"),
        ])
        XCTAssertEqual(chapters.first?.text, "first part second part")
    }

    func testBlankSegmentsAreIgnored() {
        let chapters = TranscriptChapters.detect(segments: [
            TranscriptSegment(start: 0, end: 2, text: "有内容"),
            TranscriptSegment(start: 2, end: 3, text: "   "),
            TranscriptSegment(start: 3, end: 5, text: "也有内容"),
        ])
        XCTAssertEqual(chapters.first?.segmentCount, 2)
    }

    func testOutOfOrderSegmentsAreSortedFirst() {
        let chapters = TranscriptChapters.detect(segments: [
            TranscriptSegment(start: 10, end: 12, text: "后面"),
            TranscriptSegment(start: 0, end: 2, text: "前面"),
        ])
        XCTAssertEqual(chapters.first?.startSeconds, 0)
        XCTAssertTrue(chapters.first?.text.hasPrefix("前面") == true)
    }

    /// A title is set later by whatever can name a chapter; nil means "not named yet",
    /// which the caller must be able to tell apart from a chapter with no name.
    func testChaptersStartUnnamed() {
        let chapters = TranscriptChapters.detect(segments: lecture(segmentCount: 6))
        XCTAssertNil(chapters.first?.title)
    }

    func testDetectionIsDeterministic() {
        let segments = lecture(segmentCount: 60, pausesBefore: [20: 10, 40: 10])
        let first = TranscriptChapters.detect(segments: segments)
        let second = TranscriptChapters.detect(segments: segments)
        XCTAssertEqual(first, second)
    }

    // MARK: - Outline

    func testOutlineIsPasteableMarkdown() {
        let chapters = [
            TranscriptChapter(startSeconds: 0, endSeconds: 60, text: "开场介绍背景", segmentCount: 5),
            TranscriptChapter(
                startSeconds: 125,
                endSeconds: 200,
                text: "接着讲索引",
                segmentCount: 4,
                title: "索引怎么建"
            ),
        ]
        let outline = TranscriptChapters.markdownOutline(chapters) { seconds in
            let total = Int(seconds)
            return String(format: "%d:%02d", total / 60, total % 60)
        }
        XCTAssertEqual(outline, "- 0:00  开场介绍背景\n- 2:05  索引怎么建\n")
    }

    func testAnEmptyOutlineIsEmpty() {
        XCTAssertTrue(TranscriptChapters.markdownOutline([]) { _ in "0:00" }.isEmpty)
    }
}
