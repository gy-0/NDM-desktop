import XCTest
@testable import NDMCore

final class TranscriptSRTParseTests: XCTestCase {
    func testParsesASingleCue() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:03,500
        Hello there

        """)
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.start, 1.0)
        XCTAssertEqual(segments.first?.end, 3.5)
        XCTAssertEqual(segments.first?.text, "Hello there")
    }

    func testParsesHoursBeyondOne() {
        let segments = TranscriptDocument.parseSRT("""
        1
        02:02:05,500 --> 02:02:07,000
        Late in the recording

        """)
        XCTAssertEqual(segments.first?.start, 7325.5)
    }

    /// A period for the milliseconds is not SubRip, but real files use it, and
    /// rejecting the file would cost a whole transcript over a punctuation mark.
    func testAcceptsAPeriodForMilliseconds() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01.250 --> 00:00:02.500
        Period style

        """)
        XCTAssertEqual(segments.first?.start, 1.25)
        XCTAssertEqual(segments.first?.end, 2.5)
    }

    func testHandlesCRLFAndMixedLineEndings() {
        let text = "1\r\n00:00:01,000 --> 00:00:02,000\r\nFirst\r\n\r\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n\n"
        let segments = TranscriptDocument.parseSRT(text)
        XCTAssertEqual(segments.map(\.text), ["First", "Second"])
    }

    /// A byte-order mark would otherwise become part of the first cue's index line.
    func testStripsAByteOrderMark() {
        let segments = TranscriptDocument.parseSRT("\u{FEFF}1\n00:00:01,000 --> 00:00:02,000\nWith BOM\n\n")
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.text, "With BOM")
    }

    func testAMissingIndexLineIsFine() {
        let segments = TranscriptDocument.parseSRT("""
        00:00:01,000 --> 00:00:02,000
        No index line

        """)
        XCTAssertEqual(segments.first?.text, "No index line")
    }

    func testNonContiguousIndicesAreIgnored() {
        let segments = TranscriptDocument.parseSRT("""
        7
        00:00:01,000 --> 00:00:02,000
        Seven

        99
        00:00:03,000 --> 00:00:04,000
        Ninety-nine

        """)
        XCTAssertEqual(segments.map(\.text), ["Seven", "Ninety-nine"])
    }

    func testExtraBlankLinesAreTolerated() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:02,000
        First



        2
        00:00:03,000 --> 00:00:04,000
        Second

        """)
        XCTAssertEqual(segments.map(\.text), ["First", "Second"])
    }

    func testAFileWithNoTrailingBlankLineStillYieldsItsLastCue() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:02,000
        Only cue
        """)
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.text, "Only cue")
    }

    func testMultiLineLatinCuesRejoinWithSpaces() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:04,000
        the quick brown fox
        jumps over the lazy dog

        """)
        XCTAssertEqual(
            segments.first?.text,
            "the quick brown fox jumps over the lazy dog"
        )
    }

    /// The writer breaks Chinese by character count with no space, so rejoining must
    /// not invent one — a stray space inside a Chinese sentence is a visible defect.
    func testMultiLineChineseCuesRejoinWithoutSpaces() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:04,000
        接下来这一句故意写得很长很长，用
        来看看断行规则

        """)
        XCTAssertEqual(
            segments.first?.text,
            "接下来这一句故意写得很长很长，用来看看断行规则"
        )
    }

    /// One broken cue must not cost four hundred good ones.
    func testABrokenCueIsSkippedRatherThanFailingTheFile() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:02,000
        Good one

        2
        this line is not a timing
        Broken

        3
        00:00:05,000 --> 00:00:06,000
        Good two

        """)
        XCTAssertEqual(segments.map(\.text), ["Good one", "Good two"])
    }

    func testCuesWithNoTextAreSkipped() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:01,000 --> 00:00:02,000

        2
        00:00:03,000 --> 00:00:04,000
        Real text

        """)
        XCTAssertEqual(segments.map(\.text), ["Real text"])
    }

    func testGarbageYieldsNothingRatherThanCrashing() {
        XCTAssertTrue(TranscriptDocument.parseSRT("").isEmpty)
        XCTAssertTrue(TranscriptDocument.parseSRT("not a subtitle file at all").isEmpty)
        XCTAssertTrue(TranscriptDocument.parseSRT("\n\n\n").isEmpty)
        XCTAssertTrue(TranscriptDocument.parseSRT("00:00:01,000 --> broken\ntext\n\n").isEmpty)
    }

    /// A backwards cue keeps its text: the words are real even when the timing is not.
    func testABackwardsCueIsRepairedNotDropped() {
        let segments = TranscriptDocument.parseSRT("""
        1
        00:00:10,000 --> 00:00:04,000
        Backwards

        """)
        XCTAssertEqual(segments.count, 1)
        XCTAssertEqual(segments.first?.start, 10)
        XCTAssertGreaterThanOrEqual(
            segments.first?.end ?? 0,
            segments.first?.start ?? 0
        )
    }

    // MARK: - Round trip

    /// The invariant is `parse(srt(from: s)) == subtitleCues(from: s)`, not `== s`:
    /// writing reshapes cues, so the shaped form is what a file can contain.
    func testRoundTripReproducesTheShapedCues() {
        let source = [
            TranscriptSegment(start: 0, end: 2.4, text: "这是一段中文测试语音，"),
            TranscriptSegment(start: 2.4, end: 5.36, text: "用来验证本地转写是否可用。"),
            TranscriptSegment(start: 9.0, end: 13.5, text: "第三句稍微长一点，用来触发断行规则的分支"),
        ]
        let shaped = TranscriptDocument.subtitleCues(from: source)
        let parsed = TranscriptDocument.parseSRT(TranscriptDocument.srt(from: source))

        XCTAssertEqual(parsed.count, shaped.count)
        for (actual, expected) in zip(parsed, shaped) {
            XCTAssertEqual(actual.text, expected.text)
            // Timestamps are written at millisecond precision, so compare at it.
            XCTAssertEqual(actual.start, expected.start, accuracy: 0.001)
            XCTAssertEqual(actual.end, expected.end, accuracy: 0.001)
        }
    }

    func testRoundTripSurvivesLatinText() {
        let source = [
            TranscriptSegment(start: 0, end: 3, text: "This lecture covers on-device speech recognition"),
            TranscriptSegment(start: 3, end: 6, text: "and how the index is built afterwards"),
        ]
        let shaped = TranscriptDocument.subtitleCues(from: source)
        let parsed = TranscriptDocument.parseSRT(TranscriptDocument.srt(from: source))
        XCTAssertEqual(parsed.map(\.text), shaped.map(\.text))
    }

    func testRoundTripOfAnEmptyDocument() {
        XCTAssertTrue(TranscriptDocument.parseSRT(TranscriptDocument.srt(from: [])).isEmpty)
    }
}
