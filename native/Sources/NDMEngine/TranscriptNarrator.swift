import Foundation
import FoundationModels
import NDMCore

/// Names chapters and writes a summary, on this Mac.
///
/// Only naming and summarising. Chapter *boundaries* stay with
/// `TranscriptChapters`, because the failure modes are not comparable: a wrong
/// boundary sends the user to the wrong moment, while a mediocre title merely reads
/// badly. Structure belongs to deterministic rules; prose belongs to the model.
@available(macOS 26, *)
public struct TranscriptNarrator: Sendable {
    /// What the model produced. Every field is optional or empty-able: a narration
    /// that did not happen must degrade the result, never fail it.
    public struct Narration: Equatable, Sendable {
        public var summary: String?
        /// Empty unless exactly one title came back per chapter — see `narrate`.
        public var chapterTitles: [String]

        public init(summary: String? = nil, chapterTitles: [String] = []) {
            self.summary = summary
            self.chapterTitles = chapterTitles
        }

        public static let none = Narration()
        public var isEmpty: Bool { summary == nil && chapterTitles.isEmpty }
    }

    /// Guided output rather than parsed prose. Asking for free text and pulling it
    /// apart is fragile everywhere and worse in Chinese, where there are no spaces to
    /// anchor on and the model may or may not use the punctuation a parser expects.
    // Not private: the @Generable macro generates code that must see this type.
    @Generable
    struct Outline {
        @Guide(description: "A one-sentence summary of the whole recording, at most 40 characters")
        var summary: String
        @Guide(description: "One short title per chapter, at most 10 characters each, in the same order as the input")
        var titles: [String]
    }

    public init() {}

    /// Whether the model is usable right now. False on a machine where Apple
    /// Intelligence is off or unavailable, which is a degradation rather than an error.
    public static var isAvailable: Bool {
        SystemLanguageModel.default.isAvailable
    }

    /// Ask for a summary and titles.
    ///
    /// Never throws. A model that is unavailable, slow, or wrong leaves the chapters
    /// exactly as they were — the outline is still jumpable without prose, and losing a
    /// transcript because a summary failed would be an absurd trade.
    ///
    /// Length limits are stated to the model because a long title is useless in an
    /// outline: the whole value of an outline is being scannable at a glance.
    public func narrate(
        chapters: [TranscriptChapter],
        languageName: String,
        timeout: TimeInterval = 30,
        cancelToken: CancelToken? = nil
    ) async -> Narration {
        guard !chapters.isEmpty, Self.isAvailable else { return .none }
        if cancelToken?.isCancelled == true { return .none }

        let body = chapters.enumerated()
            .map { "Chapter \($0.offset + 1): \(Self.excerpt($0.element.text))" }
            .joined(separator: "\n")
        let prompt = """
        Below are the chapters of a recording. Reply in \(languageName).
        Give one summary of the whole recording and one short title per chapter.

        \(body)
        """

        // Raced against a timeout: a model call has no guaranteed upper bound, and a
        // transcript must never be held hostage to one.
        let outline: Outline? = await withTaskGroup(of: Outline?.self) { group in
            group.addTask {
                do {
                    let session = LanguageModelSession()
                    return try await session.respond(
                        to: prompt,
                        generating: Outline.self
                    ).content
                } catch {
                    return nil
                }
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(max(1, timeout) * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        guard let outline, cancelToken?.isCancelled != true else { return .none }

        let summary = outline.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        // Titles are used only when there is exactly one per chapter. A short or long
        // list would silently shift every title onto the wrong chapter, which is worse
        // than having none at all.
        let titles = outline.titles.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let usableTitles = titles.count == chapters.count && titles.allSatisfy { !$0.isEmpty }
            ? titles
            : []

        return Narration(
            summary: summary.isEmpty ? nil : summary,
            chapterTitles: usableTitles
        )
    }

    /// Long chapters are trimmed before being sent: the model has a context budget, and
    /// the opening of a chapter carries its topic far more reliably than its middle.
    static func excerpt(_ text: String, limit: Int = 600) -> String {
        text.count <= limit ? text : String(text.prefix(limit))
    }

    /// Attach titles to chapters. Pure, and a no-op when the counts disagree so a
    /// mismatch can never be applied by a different code path than the one that
    /// checked it.
    public static func applying(
        _ narration: Narration,
        to chapters: [TranscriptChapter]
    ) -> [TranscriptChapter] {
        guard narration.chapterTitles.count == chapters.count else { return chapters }
        return zip(chapters, narration.chapterTitles).map { chapter, title in
            var named = chapter
            named.title = title.isEmpty ? nil : title
            return named
        }
    }
}
