import XCTest
@testable import NDMCore

final class TranscriptTimestampTests: XCTestCase {
    func testBasicFormatUsesCommaNotPeriod() {
        XCTAssertEqual(TranscriptDocument.timestamp(0), "00:00:00,000")
        XCTAssertEqual(TranscriptDocument.timestamp(1.5), "00:00:01,500")
        XCTAssertEqual(TranscriptDocument.timestamp(61.25), "00:01:01,250")
    }

    func testHoursAreSupported() {
        XCTAssertEqual(TranscriptDocument.timestamp(3600), "01:00:00,000")
        XCTAssertEqual(TranscriptDocument.timestamp(7325.5), "02:02:05,500")
        // A very long recording must widen rather than wrap around.
        XCTAssertEqual(TranscriptDocument.timestamp(360_000), "100:00:00,000")
    }

    /// Rounding the seconds and the fraction separately is how 59.9995 becomes the
    /// impossible "00:00:59,1000".
    func testMillisecondRoundingCarriesIntoSeconds() {
        XCTAssertEqual(TranscriptDocument.timestamp(0.9995), "00:00:01,000")
        XCTAssertEqual(TranscriptDocument.timestamp(59.9995), "00:01:00,000")
        XCTAssertEqual(TranscriptDocument.timestamp(3599.9999), "01:00:00,000")
    }

    func testMillisecondsAreNotTruncatedDownwards() {
        XCTAssertEqual(TranscriptDocument.timestamp(1.0004), "00:00:01,000")
        XCTAssertEqual(TranscriptDocument.timestamp(1.0006), "00:00:01,001")
    }

    func testNegativeTimesClampToZero() {
        XCTAssertEqual(TranscriptDocument.timestamp(-5), "00:00:00,000")
    }
}

final class TranscriptSRTTests: XCTestCase {
    private func segment(_ start: Double, _ end: Double, _ text: String) -> TranscriptSegment {
        TranscriptSegment(start: start, end: end, text: text)
    }

    func testEmptyInputProducesEmptyFile() {
        XCTAssertEqual(TranscriptDocument.srt(from: []), "")
        XCTAssertEqual(TranscriptDocument.srt(from: [segment(0, 1, "   ")]), "")
    }

    func testNumberingStartsAtOneAndIsContiguous() {
        let srt = TranscriptDocument.srt(from: [
            segment(0, 2, "One"),
            segment(5, 7, "Two"),
            segment(10, 12, "Three"),
        ])
        let indices = srt.split(separator: "\n\n").compactMap {
            Int($0.split(separator: "\n").first ?? "")
        }
        XCTAssertEqual(indices, [1, 2, 3])
    }

    /// Parsers that read until a blank line drop the final cue when the file does
    /// not end with one.
    func testFileEndsWithABlankLine() {
        let srt = TranscriptDocument.srt(from: [segment(0, 2, "Only")])
        XCTAssertTrue(srt.hasSuffix("\n\n"))
    }

    func testUsesLFNotCRLF() {
        let srt = TranscriptDocument.srt(from: [segment(0, 2, "Only")])
        XCTAssertFalse(srt.contains("\r"), "line endings are LF by decision")
    }

    func testCueShapeIsIndexTimingThenText() {
        XCTAssertEqual(
            TranscriptDocument.srt(from: [segment(1, 3, "Hello")]),
            """
            1
            00:00:01,000 --> 00:00:03,000
            Hello


            """
        )
    }

    func testOutOfOrderSegmentsAreSorted() {
        let srt = TranscriptDocument.srt(from: [
            segment(10, 12, "Later"),
            segment(0, 2, "Earlier"),
        ])
        let firstText = srt.split(separator: "\n")[2]
        XCTAssertEqual(String(firstText), "Earlier")
    }

    func testZeroLengthCueStillGetsReadableDuration() {
        let cues = TranscriptDocument.subtitleCues(from: [segment(5, 5, "Blink")])
        XCTAssertEqual(cues.count, 1)
        XCTAssertGreaterThan(cues[0].duration, 0, "a zero-length cue would never be seen")
    }

    func testEndBeforeStartIsRepairedRatherThanEmittingBackwardsTiming() {
        let cues = TranscriptDocument.subtitleCues(from: [segment(10, 4, "Backwards")])
        XCTAssertGreaterThanOrEqual(cues[0].end, cues[0].start)
    }

    /// Two cues on screen at once is a defect players show as flicker.
    func testOverlappingCuesAreClampedSoNoTwoAreOnScreenTogether() {
        let cues = TranscriptDocument.subtitleCues(from: [
            segment(0, 8, "Long one"),
            segment(3, 9, "Starts during the first"),
        ])
        for index in 1..<cues.count {
            XCTAssertLessThanOrEqual(
                cues[index - 1].end,
                cues[index].start,
                "cue \(index - 1) overlaps cue \(index)"
            )
        }
    }

    func testExtendingAShortCueNeverEatsIntoTheNext() {
        let cues = TranscriptDocument.subtitleCues(
            from: [segment(0, 0.2, "Tiny"), segment(3.0, 6.0, "Next")],
            options: .init(minimumDuration: 5.0, maximumMergeGap: 0.1)
        )
        XCTAssertEqual(cues.count, 2)
        XCTAssertLessThanOrEqual(cues[0].end, cues[1].start)
    }

    func testShortAdjacentCuesAreMerged() {
        let cues = TranscriptDocument.subtitleCues(from: [
            segment(0, 0.3, "Hello"),
            segment(0.4, 0.7, "there"),
        ])
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].text, "Hello there")
    }

    /// Adjacency is the normal case for subtitles — nearly every cue starts where
    /// the last one ended. Treating a zero gap as a reason to merge fused every
    /// well-sized pair into one long cue, which only a look at real output caught.
    func testAdjacentWellSizedCuesStaySeparate() {
        let cues = TranscriptDocument.subtitleCues(from: [
            segment(0.0, 2.4, "这是一段中文测试语音，"),
            segment(2.4, 5.36, "用来验证本地转写是否可用。"),
        ])
        XCTAssertEqual(cues.count, 2, "adjacency alone is not a reason to merge")
        XCTAssertEqual(cues[0].end, 2.4)
        XCTAssertEqual(cues[1].start, 2.4)
    }

    /// Genuine overlap still merges, since two cues cannot share the screen.
    func testOverlappingCuesDoMerge() {
        let cues = TranscriptDocument.subtitleCues(from: [
            segment(0.0, 3.0, "First"),
            segment(2.0, 5.0, "overlapping"),
        ])
        XCTAssertEqual(cues.count, 1)
        XCTAssertEqual(cues[0].text, "First overlapping")
    }

    /// Real silence is structure, not noise; bridging it would put a subtitle over
    /// the wrong moment.
    func testLongSilenceIsNeverBridged() {
        let cues = TranscriptDocument.subtitleCues(from: [
            segment(0, 0.3, "Before"),
            segment(30, 30.4, "After"),
        ])
        XCTAssertEqual(cues.count, 2)
    }

    func testMergingStopsAtTheMaximumDuration() {
        let many = (0..<40).map { i in
            segment(Double(i) * 0.4, Double(i) * 0.4 + 0.3, "w\(i)")
        }
        let cues = TranscriptDocument.subtitleCues(from: many)
        XCTAssertGreaterThan(cues.count, 1, "everything must not collapse into one cue")
        for cue in cues {
            XCTAssertLessThanOrEqual(cue.duration, 7.0 + 0.001)
        }
    }

    func testWhitespaceAroundTextIsTrimmed() {
        let srt = TranscriptDocument.srt(from: [segment(0, 2, "  spaced out \n")])
        XCTAssertTrue(srt.contains("spaced out"))
        XCTAssertFalse(srt.contains(" spaced"))
    }
}

final class TranscriptWrappingTests: XCTestCase {
    /// Chinese has no spaces, so word wrapping leaves one runaway line. This is the
    /// single easiest thing to get wrong in a Chinese subtitle file.
    func testChineseWrapsByCharacterCount() {
        let text = String(repeating: "中", count: 40)
        let lines = TranscriptDocument.wrap(
            text,
            options: .init(maxCJKCharactersPerLine: 16, maxLinesPerCue: 4)
        )
        XCTAssertGreaterThan(lines.count, 1, "a 40-character line would run off screen")
        for line in lines.dropLast() {
            XCTAssertLessThanOrEqual(line.count, 17)
        }
    }

    func testEnglishWrapsOnWordBoundariesAndNeverMidWord() {
        let text = "the quick brown fox jumps over the lazy dog again and again and again"
        let lines = TranscriptDocument.wrap(
            text,
            options: .init(maxLatinCharactersPerLine: 20, maxLinesPerCue: 6)
        )
        XCTAssertGreaterThan(lines.count, 1)
        for line in lines {
            XCTAssertFalse(line.hasPrefix(" "))
            XCTAssertFalse(line.hasSuffix(" "))
        }
        XCTAssertEqual(
            lines.joined(separator: " ").split(separator: " ").count,
            text.split(separator: " ").count,
            "no word may be lost or split"
        )
    }

    func testPunctuationDoesNotOpenALine() {
        let text = String(repeating: "中", count: 16) + "，" + String(repeating: "文", count: 5)
        let lines = TranscriptDocument.wrap(
            text,
            options: .init(maxCJKCharactersPerLine: 16, maxLinesPerCue: 4)
        )
        for line in lines {
            XCTAssertFalse(
                TranscriptDocument.isLeadingForbidden(line.first ?? "x"),
                "line \(line.debugDescription) opens with punctuation"
            )
        }
    }

    func testLineBudgetIsNeverExceeded() {
        let text = String(repeating: "中", count: 200)
        let lines = TranscriptDocument.wrap(
            text,
            options: .init(maxCJKCharactersPerLine: 16, maxLinesPerCue: 2)
        )
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(
            lines.joined().contains(String(repeating: "中", count: 100)),
            "overflow must fold into the last line, not vanish"
        )
    }

    /// An English sentence quoting one Chinese word should still wrap by word.
    func testMostlyLatinTextWithOneCJKWordWrapsByWord() {
        XCTAssertFalse(
            TranscriptDocument.isPredominantlyCJK(
                "the model is called 通义 and it runs locally on your machine today"
            )
        )
    }

    func testMostlyCJKTextWithSomeLatinIsTreatedAsCJK() {
        XCTAssertTrue(TranscriptDocument.isPredominantlyCJK("这个 model 是本地跑的，完全不上传"))
    }

    func testJoiningDoesNotInventSpacesBetweenCJK() {
        XCTAssertEqual(TranscriptDocument.joined("你好", "世界"), "你好世界")
        XCTAssertEqual(TranscriptDocument.joined("hello", "world"), "hello world")
        XCTAssertEqual(TranscriptDocument.joined("hello", "世界"), "hello世界")
    }
}

final class TranscriptPlainTextTests: XCTestCase {
    private func segment(_ start: Double, _ end: Double, _ text: String) -> TranscriptSegment {
        TranscriptSegment(start: start, end: end, text: text)
    }

    func testEmptyInputProducesEmptyTranscript() {
        XCTAssertEqual(TranscriptDocument.plainText(from: []), "")
    }

    /// A transcript is read, not watched: no timestamps, no cue numbers.
    func testTranscriptCarriesNoTimingArtifacts() {
        let text = TranscriptDocument.plainText(from: [
            segment(0, 2, "First part"),
            segment(2.1, 4, "second part"),
        ])
        XCTAssertFalse(text.contains("-->"))
        XCTAssertFalse(text.contains("00:00"))
        XCTAssertEqual(text, "First part second part\n")
    }

    func testPausesBecomeParagraphs() {
        let text = TranscriptDocument.plainText(from: [
            segment(0, 2, "Opening thought"),
            segment(2.1, 4, "continued"),
            segment(20, 22, "A new topic"),
        ])
        XCTAssertEqual(text, "Opening thought continued\n\nA new topic\n")
    }

    func testChineseParagraphsAreNotSpaceSeparated() {
        let text = TranscriptDocument.plainText(from: [
            segment(0, 2, "这是第一句"),
            segment(2.1, 4, "这是第二句"),
        ])
        XCTAssertEqual(text, "这是第一句这是第二句\n")
    }

    func testOutOfOrderSegmentsAreOrderedBeforeJoining() {
        let text = TranscriptDocument.plainText(from: [
            segment(10, 12, "Second"),
            segment(0, 2, "First"),
        ])
        XCTAssertTrue(text.hasPrefix("First"))
    }

    func testEmptySegmentsAreDropped() {
        let text = TranscriptDocument.plainText(from: [
            segment(0, 2, "Kept"),
            segment(2.1, 3, "   "),
            segment(3.1, 4, "also kept"),
        ])
        XCTAssertEqual(text, "Kept also kept\n")
    }
}

final class TranscriptVisualShapeTests: XCTestCase {
    /// A realistic Chinese example, asserted in full. Passing unit tests do not
    /// prove a file is valid SubRip, and looking at this output is what exposed the
    /// adjacency-merge bug that every other test had missed.
    func testChineseSubtitleVisualShape() {
        let srt = TranscriptDocument.srt(from: [
            TranscriptSegment(start: 0.0, end: 2.4, text: "这是一段中文测试语音，"),
            TranscriptSegment(start: 2.4, end: 5.36, text: "用来验证本地转写是否可用。"),
            TranscriptSegment(
                start: 9.0,
                end: 13.5,
                text: "接下来这一句故意写得很长很长，用来看看断行规则在实际输出里是不是真的生效了。"
            ),
        ])
        XCTAssertEqual(srt, """
        1
        00:00:00,000 --> 00:00:02,400
        这是一段中文测试语音，

        2
        00:00:02,400 --> 00:00:05,360
        用来验证本地转写是否可用。

        3
        00:00:09,000 --> 00:00:13,500
        接下来这一句故意写得很长很长，用
        来看看断行规则在实际输出里是不是真的生效了。


        """)
    }
}
