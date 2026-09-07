import Foundation

/// A readable excerpt of a matching line, with the parts to highlight.
public struct SearchHighlight: Equatable, Sendable {
    /// The excerpt to display, ellipses included when it was cut.
    public let snippet: String
    /// Character offsets into `snippet` — not UTF-16, not bytes. A CJK character or
    /// an emoji counts as one, so a highlight cannot land mid-character.
    public let ranges: [Range<Int>]
    /// How many distinct query terms this line contained. Lets the caller break a
    /// relevance tie without re-scanning the text.
    public let matchedTermCount: Int
    public let truncatedAtStart: Bool
    public let truncatedAtEnd: Bool

    public init(
        snippet: String,
        ranges: [Range<Int>],
        matchedTermCount: Int,
        truncatedAtStart: Bool,
        truncatedAtEnd: Bool
    ) {
        self.snippet = snippet
        self.ranges = ranges
        self.matchedTermCount = matchedTermCount
        self.truncatedAtStart = truncatedAtStart
        self.truncatedAtEnd = truncatedAtEnd
    }
}

/// Builds display excerpts from the *original* text.
///
/// FTS5's `snippet()` is unusable here on purpose: the index stores bigram tokens,
/// so `snippet()` would hand back `本地 地转 转写` — a correct answer to the wrong
/// question, and unreadable. Highlighting has to be computed from the text the user
/// will actually see.
public enum SearchSnippet: Sendable {
    /// The phrases to highlight, which are deliberately *not* the search tokens.
    ///
    /// A user who typed 本地转写 expects that phrase marked, not three overlapping
    /// two-character fragments. So the query is split into contiguous runs — one CJK
    /// run, one Latin word — and those are what get highlighted.
    public static func terms(in query: String) -> [String] {
        var terms: [String] = []
        var current = ""
        var currentIsCJK = false

        func flush() {
            defer { current = "" }
            guard !current.isEmpty else { return }
            terms.append(current)
        }

        for character in query {
            let cjk = SearchTokenizer.isCJK(character)
            if cjk {
                if !currentIsCJK { flush() }
                currentIsCJK = true
                current.append(character)
            } else if character.isLetter || character.isNumber {
                if currentIsCJK { flush() }
                currentIsCJK = false
                current.append(character)
            } else {
                flush()
                currentIsCJK = false
            }
        }
        flush()
        return terms
    }

    /// Character ranges in `text` covering every occurrence of any term.
    ///
    /// When a whole term is absent, its bigrams are tried instead. The index matched
    /// on bigrams, so a document can qualify without containing the phrase
    /// contiguously; highlighting nothing in that case would look like a wrong result.
    public static func matchRanges(in text: String, terms: [String]) -> [Range<Int>] {
        let haystack = folded(text)
        var found: [Range<Int>] = []
        for term in terms where !term.isEmpty {
            let direct = occurrences(of: folded(term), in: haystack)
            if !direct.isEmpty {
                found.append(contentsOf: direct)
                continue
            }
            for fragment in bigrams(of: term) {
                found.append(contentsOf: occurrences(of: folded(fragment), in: haystack))
            }
        }
        return merged(found)
    }

    /// How many of `terms` appear in `text`, counting each term once.
    public static func matchedTermCount(in text: String, terms: [String]) -> Int {
        let haystack = folded(text)
        return terms.filter { term in
            guard !term.isEmpty else { return false }
            if !occurrences(of: folded(term), in: haystack).isEmpty { return true }
            return bigrams(of: term).contains {
                !occurrences(of: folded($0), in: haystack).isEmpty
            }
        }.count
    }

    /// Build an excerpt of at most `windowLength` characters around the first match.
    ///
    /// Returns nil when the query contains nothing searchable; returns a leading
    /// excerpt with no highlights when the query is searchable but this particular
    /// line holds none of it.
    public static func highlight(
        text: String,
        query: String,
        windowLength: Int = 90,
        leadingContext: Int = 16
    ) -> SearchHighlight? {
        let terms = terms(in: query)
        guard !terms.isEmpty else { return nil }

        let characters = Array(text)
        let ranges = matchRanges(in: text, terms: terms)
        let count = matchedTermCount(in: text, terms: terms)

        guard windowLength > 0 else {
            return SearchHighlight(
                snippet: "",
                ranges: [],
                matchedTermCount: count,
                truncatedAtStart: !characters.isEmpty,
                truncatedAtEnd: false
            )
        }

        // Short enough to show whole: no window, no ellipsis, no arithmetic to get
        // wrong.
        guard characters.count > windowLength else {
            return SearchHighlight(
                snippet: text,
                ranges: ranges,
                matchedTermCount: count,
                truncatedAtStart: false,
                truncatedAtEnd: false
            )
        }

        let anchor = ranges.first?.lowerBound ?? 0
        var start = max(0, anchor - leadingContext)
        var end = min(characters.count, start + windowLength)
        // Pull the window back when it ran past the end, so it stays full length.
        if end - start < windowLength {
            start = max(0, end - windowLength)
        }
        end = min(characters.count, max(end, start + windowLength))

        let truncatedAtStart = start > 0
        let truncatedAtEnd = end < characters.count
        let body = String(characters[start..<end])

        let prefix = truncatedAtStart ? "…" : ""
        let suffix = truncatedAtEnd ? "…" : ""
        let shift = prefix.count

        // Keep only what is visible, clipped to the window, then shifted past the
        // leading ellipsis so offsets address the returned string.
        let visible: [Range<Int>] = ranges.compactMap { range in
            let lower = max(range.lowerBound, start)
            let upper = min(range.upperBound, end)
            guard lower < upper else { return nil }
            return (lower - start + shift)..<(upper - start + shift)
        }

        return SearchHighlight(
            snippet: prefix + body + suffix,
            ranges: visible,
            matchedTermCount: count,
            truncatedAtStart: truncatedAtStart,
            truncatedAtEnd: truncatedAtEnd
        )
    }

    // MARK: - Internals

    /// Per-character case folding that preserves a one-to-one mapping, so character
    /// offsets stay valid. Lowercasing a whole string can change its length.
    static func folded(_ text: String) -> [String] {
        text.map { String($0).lowercased() }
    }

    static func bigrams(of term: String) -> [String] {
        let characters = Array(term)
        guard characters.count >= 2 else { return [] }
        return (0..<(characters.count - 1)).map { String(characters[$0...($0 + 1)]) }
    }

    static func occurrences(of needle: [String], in haystack: [String]) -> [Range<Int>] {
        guard !needle.isEmpty, needle.count <= haystack.count else { return [] }
        var result: [Range<Int>] = []
        var index = 0
        while index <= haystack.count - needle.count {
            if Array(haystack[index..<(index + needle.count)]) == needle {
                result.append(index..<(index + needle.count))
                // Advance past this hit; overlapping hits of the same term would only
                // produce ranges that merge back together anyway.
                index += needle.count
            } else {
                index += 1
            }
        }
        return result
    }

    /// Sort, then fuse overlapping or touching ranges so highlighting never paints
    /// the same character twice or leaves a one-character gap between two marks.
    static func merged(_ ranges: [Range<Int>]) -> [Range<Int>] {
        guard !ranges.isEmpty else { return [] }
        let sorted = ranges.sorted {
            $0.lowerBound == $1.lowerBound ? $0.upperBound < $1.upperBound : $0.lowerBound < $1.lowerBound
        }
        var result: [Range<Int>] = [sorted[0]]
        for range in sorted.dropFirst() {
            let last = result[result.count - 1]
            if range.lowerBound <= last.upperBound {
                result[result.count - 1] = last.lowerBound..<max(last.upperBound, range.upperBound)
            } else {
                result.append(range)
            }
        }
        return result
    }
}
