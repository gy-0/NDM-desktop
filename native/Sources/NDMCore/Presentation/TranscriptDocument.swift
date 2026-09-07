import Foundation

/// One timed piece of recognised speech.
///
/// Neutral on purpose: the transcription engine's own result type never reaches
/// this file, so serialization stays unit-testable without the speech framework
/// and without a system new enough to run it. C1-3 only has to map into this.
public struct TranscriptSegment: Equatable, Sendable {
    public var start: TimeInterval
    public var end: TimeInterval
    public var text: String

    public init(start: TimeInterval, end: TimeInterval, text: String) {
        self.start = start
        self.end = end
        self.text = text
    }

    public var duration: TimeInterval { max(0, end - start) }
}

/// Turns timed speech into the two artifacts a user actually wants: subtitles to
/// play alongside the video, and a transcript to read.
///
/// They are different documents, not two renderings of one. Subtitles are
/// constrained by how much a person can read in the time a line is on screen;
/// a transcript has no clock and wants paragraphs.
public enum TranscriptDocument: Sendable {
    // MARK: - Options

    public struct SubtitleOptions: Sendable, Equatable {
        /// Full-width characters per line. 16 follows the widely used Chinese
        /// subtitle guideline; more than this cannot be read in the time a cue is
        /// usually on screen.
        public var maxCJKCharactersPerLine: Int
        /// Latin characters per line; 42 is the common broadcast limit.
        public var maxLatinCharactersPerLine: Int
        public var maxLinesPerCue: Int
        /// Cues shorter than this are merged forward — a flash of text is harder
        /// to read than a slightly longer one.
        public var minimumDuration: TimeInterval
        /// Merging stops here so a merged cue never outstays its welcome.
        public var maximumMergedDuration: TimeInterval
        /// Silence longer than this is treated as a real break, never bridged.
        public var maximumMergeGap: TimeInterval

        public init(
            maxCJKCharactersPerLine: Int = 16,
            maxLatinCharactersPerLine: Int = 42,
            maxLinesPerCue: Int = 2,
            minimumDuration: TimeInterval = 1.0,
            maximumMergedDuration: TimeInterval = 7.0,
            maximumMergeGap: TimeInterval = 0.6
        ) {
            self.maxCJKCharactersPerLine = maxCJKCharactersPerLine
            self.maxLatinCharactersPerLine = maxLatinCharactersPerLine
            self.maxLinesPerCue = maxLinesPerCue
            self.minimumDuration = minimumDuration
            self.maximumMergedDuration = maximumMergedDuration
            self.maximumMergeGap = maximumMergeGap
        }

        public static let `default` = SubtitleOptions()
    }

    // MARK: - SRT

    /// SubRip text.
    ///
    /// Lines are separated with LF, not the historical CRLF. Every player on this
    /// platform accepts LF, the repository's existing subtitle fixtures use it, and
    /// a file that stays LF cannot pick up mixed endings the first time someone
    /// edits it on a Mac.
    public static func srt(
        from segments: [TranscriptSegment],
        options: SubtitleOptions = .default
    ) -> String {
        let cues = subtitleCues(from: segments, options: options)
        guard !cues.isEmpty else { return "" }
        var out = ""
        for (index, cue) in cues.enumerated() {
            out += "\(index + 1)\n"
            out += "\(timestamp(cue.start)) --> \(timestamp(cue.end))\n"
            out += wrap(cue.text, options: options).joined(separator: "\n")
            // A blank line closes every cue, including the last: parsers that read
            // until a blank line otherwise drop the final subtitle.
            out += "\n\n"
        }
        return out
    }

    /// `HH:MM:SS,mmm`. Comma, not period — a period is WebVTT and SubRip parsers
    /// reject it.
    public static func timestamp(_ seconds: TimeInterval) -> String {
        // Decompose from whole milliseconds so rounding carries properly. Rounding
        // the seconds and the fraction separately is how 59.9995 becomes the
        // impossible "00:00:59,1000".
        let totalMilliseconds = max(0, Int((seconds * 1000).rounded()))
        let milliseconds = totalMilliseconds % 1000
        let totalSeconds = totalMilliseconds / 1000
        return String(
            format: "%02d:%02d:%02d,%03d",
            totalSeconds / 3600,
            (totalSeconds / 60) % 60,
            totalSeconds % 60,
            milliseconds
        )
    }

    // MARK: - Reading SRT back

    /// Parse SubRip into segments — the inverse of `srt(from:)`, needed to rebuild a
    /// search index from the subtitle files already on disk.
    ///
    /// Note the round trip is `parse(srt(from: s)) == subtitleCues(from: s)`, not
    /// `== s`: writing reshapes cues (merging short ones, clamping overlaps, enforcing
    /// a readable minimum), so the shaped form is what a file can possibly contain.
    ///
    /// A malformed cue is skipped rather than failing the file. Subtitles come from
    /// everywhere; refusing to read four hundred good cues because one is broken
    /// would trade a whole transcript for a technicality.
    public static func parseSRT(_ text: String) -> [TranscriptSegment] {
        var normalized = text
        // A BOM would otherwise become part of the first cue's index or timing line.
        if normalized.hasPrefix("\u{FEFF}") { normalized.removeFirst() }
        normalized = normalized
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")

        var segments: [TranscriptSegment] = []
        // Blank lines separate cues; runs of them are just as valid a separator as one.
        for block in normalized.components(separatedBy: "\n\n") {
            let lines = block
                .components(separatedBy: "\n")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            guard !lines.isEmpty else { continue }

            // The index line is optional: plenty of files in the wild omit it, and
            // when present it is redundant with position.
            guard let timingIndex = lines.firstIndex(where: { $0.contains("-->") }),
                  let timing = parseTiming(lines[timingIndex])
            else { continue }

            let body = lines[(timingIndex + 1)...]
            guard !body.isEmpty else { continue }
            // Rejoin the way the writer split: no invented space between CJK.
            let joinedText = body.dropFirst().reduce(body[body.startIndex]) { joined($0, $1) }
            let trimmed = joinedText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            segments.append(TranscriptSegment(
                start: timing.start,
                end: timing.end,
                text: trimmed
            ))
        }
        return segments
    }

    /// `HH:MM:SS,mmm --> HH:MM:SS,mmm`. A period is accepted for the milliseconds
    /// because real files use both, and rejecting one costs a whole transcript.
    static func parseTiming(_ line: String) -> (start: TimeInterval, end: TimeInterval)? {
        let halves = line.components(separatedBy: "-->")
        guard halves.count == 2,
              let start = parseTimestamp(halves[0]),
              let end = parseTimestamp(halves[1])
        else { return nil }
        // A backwards cue is repaired rather than dropped: the text is still real.
        return (start, max(start, end))
    }

    static func parseTimestamp(_ raw: String) -> TimeInterval? {
        // Trailing cue settings (`X1:...`) appear in WebVTT-flavoured files.
        let cleaned = raw
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: ",", with: ".")
            .components(separatedBy: " ")
            .first ?? ""
        let parts = cleaned.components(separatedBy: ":")
        guard (2...3).contains(parts.count) else { return nil }
        var seconds = 0.0
        for part in parts.dropLast() {
            guard let value = Double(part), value >= 0 else { return nil }
            seconds = seconds * 60 + value
        }
        guard let last = Double(parts[parts.count - 1]), last >= 0 else { return nil }
        return seconds * 60 + last
    }

    // MARK: - Cue shaping

    /// Clean, order and merge raw segments into displayable cues.
    public static func subtitleCues(
        from segments: [TranscriptSegment],
        options: SubtitleOptions = .default
    ) -> [TranscriptSegment] {
        // Drop anything with no words: an empty cue is a blank flash on screen.
        var cleaned = segments.compactMap { segment -> TranscriptSegment? in
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let start = max(0, segment.start)
            return TranscriptSegment(start: start, end: max(start, segment.end), text: text)
        }
        guard !cleaned.isEmpty else { return [] }

        // Recognisers can emit results out of order or with equal starts.
        cleaned.sort { lhs, rhs in
            lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
        }

        var merged: [TranscriptSegment] = []
        for segment in cleaned {
            guard var previous = merged.last else {
                merged.append(segment)
                continue
            }
            let gap = segment.start - previous.end
            let combinedDuration = segment.end - previous.start
            // `gap < 0` means a genuine overlap. Note it is not `<= 0`: adjacent
            // cues have a gap of exactly zero and that is the normal case for
            // subtitles, so treating adjacency as a reason to merge would fuse
            // every well-sized pair in the file into one long cue.
            let overlaps = gap < 0
            let previousTooShort = previous.duration < options.minimumDuration
            let shouldMerge = (previousTooShort || overlaps)
                && gap <= options.maximumMergeGap
                && combinedDuration <= options.maximumMergedDuration
            if shouldMerge {
                previous.end = max(previous.end, segment.end)
                previous.text = joined(previous.text, segment.text)
                merged[merged.count - 1] = previous
            } else {
                merged.append(segment)
            }
        }

        // Two cues must never be on screen at once, and a cue must last long
        // enough to read — but extending one can never eat into the next.
        for index in merged.indices {
            let nextStart = index + 1 < merged.count ? merged[index + 1].start : nil
            var cue = merged[index]
            if cue.duration < options.minimumDuration {
                let wanted = cue.start + options.minimumDuration
                cue.end = nextStart.map { min(wanted, $0) } ?? wanted
            }
            if let nextStart, cue.end > nextStart {
                cue.end = nextStart
            }
            cue.end = max(cue.end, cue.start)
            merged[index] = cue
        }
        return merged
    }

    /// Join two fragments without inventing a space between CJK characters, where
    /// a space is a visible defect rather than a separator.
    static func joined(_ left: String, _ right: String) -> String {
        guard let lastCharacter = left.last, let firstCharacter = right.first else {
            return left + right
        }
        if isCJK(lastCharacter) || isCJK(firstCharacter) {
            return left + right
        }
        return left + " " + right
    }

    // MARK: - Line wrapping

    /// Break a cue into readable lines.
    ///
    /// Chinese, Japanese and Korean text has no spaces to break on, so wrapping by
    /// word — the usual approach — leaves the whole subtitle on one runaway line.
    /// Those scripts break by character count instead.
    public static func wrap(_ text: String, options: SubtitleOptions = .default) -> [String] {
        let collapsed = text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        guard !collapsed.isEmpty else { return [""] }

        let lines = isPredominantlyCJK(collapsed)
            ? wrapByCharacter(collapsed, limit: options.maxCJKCharactersPerLine)
            : wrapByWord(collapsed, limit: options.maxLatinCharactersPerLine)

        guard lines.count > options.maxLinesPerCue else { return lines }
        // Never exceed the line budget: fold the overflow into the last allowed
        // line rather than pushing text off screen.
        var limited = Array(lines.prefix(options.maxLinesPerCue - 1))
        let rest = lines.dropFirst(options.maxLinesPerCue - 1)
        limited.append(rest.reduce("") { joined($0, $1) })
        return limited
    }

    static func wrapByCharacter(_ text: String, limit: Int) -> [String] {
        guard limit > 0 else { return [text] }
        var lines: [String] = []
        var current = ""
        for character in text {
            if current.count >= limit {
                // Punctuation must not open a line; keep it with the text it
                // belongs to even if that line runs one character long.
                if isLeadingForbidden(character) {
                    current.append(character)
                    continue
                }
                lines.append(current)
                current = ""
            }
            current.append(character)
        }
        if !current.isEmpty { lines.append(current) }
        return lines.isEmpty ? [text] : lines
    }

    static func wrapByWord(_ text: String, limit: Int) -> [String] {
        guard limit > 0 else { return [text] }
        var lines: [String] = []
        var current = ""
        for word in text.split(separator: " ") {
            let candidate = current.isEmpty ? String(word) : current + " " + word
            if candidate.count <= limit || current.isEmpty {
                current = candidate
            } else {
                lines.append(current)
                current = String(word)
            }
        }
        if !current.isEmpty { lines.append(current) }
        return lines.isEmpty ? [text] : lines
    }

    /// Punctuation that may not begin a line in CJK typesetting.
    private static let leadingForbidden: Set<Character> = [
        "，", "。", "、", "；", "：", "？", "！", "）", "】", "」", "』", "》",
        "”", "’", "…", "·", ",", ".", ";", ":", "?", "!", ")", "]", "}",
    ]

    static func isLeadingForbidden(_ character: Character) -> Bool {
        leadingForbidden.contains(character)
    }

    static func isCJK(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3040...0x30FF,        // kana
                 0x3400...0x4DBF,        // CJK ext A
                 0x4E00...0x9FFF,        // CJK unified
                 0xAC00...0xD7AF,        // hangul syllables
                 0xF900...0xFAFF,        // compatibility ideographs
                 0x3000...0x303F,        // CJK punctuation
                 0xFF00...0xFFEF:        // full-width forms
                return true
            default:
                return false
            }
        }
    }

    /// True when breaking on spaces would not work. Weighted on CJK share rather
    /// than mere presence, so an English sentence quoting one Chinese word still
    /// wraps by word.
    static func isPredominantlyCJK(_ text: String) -> Bool {
        var cjk = 0
        var total = 0
        for character in text where !character.isWhitespace {
            total += 1
            if isCJK(character) { cjk += 1 }
        }
        guard total > 0 else { return false }
        return Double(cjk) / Double(total) >= 0.3
    }

    // MARK: - Readable transcript

    /// A transcript is a different document from a subtitle file: no clock, no
    /// line-length budget, and paragraphs where the speaker paused. Wrapping is
    /// left to whatever the reader opens it in.
    public static func plainText(
        from segments: [TranscriptSegment],
        paragraphGap: TimeInterval = 2.0
    ) -> String {
        let cleaned = segments.compactMap { segment -> TranscriptSegment? in
            let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let start = max(0, segment.start)
            return TranscriptSegment(start: start, end: max(start, segment.end), text: text)
        }
        .sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        guard !cleaned.isEmpty else { return "" }

        var paragraphs: [String] = []
        var current = cleaned[0].text
        var previousEnd = cleaned[0].end
        for segment in cleaned.dropFirst() {
            if segment.start - previousEnd >= paragraphGap {
                paragraphs.append(current)
                current = segment.text
            } else {
                current = joined(current, segment.text)
            }
            previousEnd = max(previousEnd, segment.end)
        }
        paragraphs.append(current)
        return paragraphs.joined(separator: "\n\n") + "\n"
    }
}
