import Foundation

/// A stretch of a recording that can be jumped to and read on its own.
public struct TranscriptChapter: Equatable, Sendable {
    public var startSeconds: TimeInterval
    public var endSeconds: TimeInterval
    /// The chapter's spoken text, joined the way the language wants.
    public var text: String
    public var segmentCount: Int
    /// Set later by whatever can name it. Nil means "not named yet", which is
    /// different from "has no name" — the caller decides how to show that.
    public var title: String?

    public init(
        startSeconds: TimeInterval,
        endSeconds: TimeInterval,
        text: String,
        segmentCount: Int,
        title: String? = nil
    ) {
        self.startSeconds = startSeconds
        self.endSeconds = endSeconds
        self.text = text
        self.segmentCount = segmentCount
        self.title = title
    }

    public var duration: TimeInterval { max(0, endSeconds - startSeconds) }
}

/// Splits a transcript into chapters using only its timings.
///
/// Honest about what this is: pause-based, not semantic. A long silence often means
/// nothing at all. It is here because it has two properties nothing smarter has —
/// it is deterministic and testable offline, and it still gives a jumpable outline
/// on a machine with no language model available.
///
/// The division of labour that follows from that: boundaries stay here, and a model
/// is only ever asked to *name* chapters. A wrong boundary sends the user to the
/// wrong place; a mediocre title costs nothing.
public enum TranscriptChapters: Sendable {
    public struct Options: Sendable, Equatable {
        /// Silence at least this long is a candidate boundary. Below it, a pause is
        /// just breathing.
        public var pauseThreshold: TimeInterval
        /// No chapter shorter than this. An outline of twenty entries for a
        /// twenty-minute talk is not an outline.
        public var minimumChapterDuration: TimeInterval
        /// Recordings shorter than this stay a single chapter: splitting a two-minute
        /// clip helps nobody.
        public var minimumDurationToSplit: TimeInterval
        /// Upper bound on entries, so a rambling recording cannot produce a wall.
        public var maximumChapters: Int

        public init(
            pauseThreshold: TimeInterval = 2.0,
            minimumChapterDuration: TimeInterval = 45,
            minimumDurationToSplit: TimeInterval = 150,
            maximumChapters: Int = 24
        ) {
            self.pauseThreshold = pauseThreshold
            self.minimumChapterDuration = minimumChapterDuration
            self.minimumDurationToSplit = minimumDurationToSplit
            self.maximumChapters = maximumChapters
        }

        public static let `default` = Options()
    }

    public static func detect(
        segments: [TranscriptSegment],
        options: Options = .default
    ) -> [TranscriptChapter] {
        let cleaned = segments
            .compactMap { segment -> TranscriptSegment? in
                let text = segment.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return nil }
                let start = max(0, segment.start)
                return TranscriptSegment(start: start, end: max(start, segment.end), text: text)
            }
            .sorted { $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start }
        guard !cleaned.isEmpty else { return [] }

        let total = (cleaned.last?.end ?? 0) - (cleaned.first?.start ?? 0)
        guard total >= options.minimumDurationToSplit else {
            return [chapter(from: cleaned)]
        }

        // Candidate boundaries, longest silence first: the biggest pause is the best
        // guess at a topic change, and ranking means the cap keeps the strongest ones
        // rather than whichever came earliest.
        var candidates: [(index: Int, gap: TimeInterval)] = []
        for index in 1..<cleaned.count {
            let gap = cleaned[index].start - cleaned[index - 1].end
            if gap >= options.pauseThreshold {
                candidates.append((index, gap))
            }
        }
        candidates.sort { $0.gap == $1.gap ? $0.index < $1.index : $0.gap > $1.gap }

        var accepted: Set<Int> = []
        for candidate in candidates {
            guard accepted.count + 1 < options.maximumChapters else { break }
            var trial = accepted
            trial.insert(candidate.index)
            // Accept only if every resulting chapter still reads as one: this is what
            // stops a run of pauses from shredding the outline.
            if respectsMinimumDuration(trial, in: cleaned, minimum: options.minimumChapterDuration) {
                accepted = trial
            }
        }

        let boundaries = accepted.sorted()
        var chapters: [TranscriptChapter] = []
        var start = 0
        for boundary in boundaries {
            chapters.append(chapter(from: Array(cleaned[start..<boundary])))
            start = boundary
        }
        chapters.append(chapter(from: Array(cleaned[start...])))
        return chapters
    }

    private static func respectsMinimumDuration(
        _ boundaries: Set<Int>,
        in segments: [TranscriptSegment],
        minimum: TimeInterval
    ) -> Bool {
        let sorted = boundaries.sorted()
        var start = 0
        for boundary in sorted + [segments.count] {
            let slice = segments[start..<boundary]
            guard let first = slice.first, let last = slice.last else { return false }
            if last.end - first.start < minimum { return false }
            start = boundary
        }
        return true
    }

    private static func chapter(from segments: [TranscriptSegment]) -> TranscriptChapter {
        let text = segments.dropFirst().reduce(segments.first?.text ?? "") {
            TranscriptDocument.joined($0, $1.text)
        }
        return TranscriptChapter(
            startSeconds: segments.first?.start ?? 0,
            endSeconds: segments.last?.end ?? 0,
            text: text,
            segmentCount: segments.count
        )
    }

    /// A Markdown outline, which is both readable and pasteable — the cheapest way to
    /// make an outline something a user can actually take somewhere.
    public static func markdownOutline(
        _ chapters: [TranscriptChapter],
        clock: (TimeInterval) -> String
    ) -> String {
        guard !chapters.isEmpty else { return "" }
        return chapters.map { chapter in
            let name = chapter.title ?? String(chapter.text.prefix(24))
            return "- \(clock(chapter.startSeconds))  \(name)"
        }.joined(separator: "\n") + "\n"
    }
}
