import Foundation

/// One matching moment inside a download.
public struct SearchResultSnippet: Equatable, Sendable {
    public let source: SearchIndexStore.Source
    /// Where in the media this line is spoken. Nil for metadata matches, which have
    /// no position — and must say nil rather than pretend to be at zero.
    public let startSeconds: Double?
    public let highlight: SearchHighlight

    public init(
        source: SearchIndexStore.Source,
        startSeconds: Double?,
        highlight: SearchHighlight
    ) {
        self.source = source
        self.startSeconds = startSeconds
        self.highlight = highlight
    }

    public var canJumpToTime: Bool { startSeconds != nil }
}

/// Everything one download matched, as a single result.
///
/// Grouping is the point. A forty-minute podcast can match twenty times, and listing
/// twenty rows for one file buries every other download in the results. One item
/// occupies one row and opens to show its moments — the same shape
/// `CompletionStack` already uses for a download and its sidecars.
public struct SearchResultGroup: Equatable, Sendable {
    public let taskID: Int64
    /// Moments to show, ordered for reading.
    public let snippets: [SearchResultSnippet]
    /// Matches that exist but were not included, so the UI can say "3 more" instead
    /// of quietly hiding them.
    public let additionalSnippetCount: Int
    /// The most query terms any single line of this download contained.
    public let bestMatchedTermCount: Int
    public let matchedSources: Set<SearchIndexStore.Source>

    public init(
        taskID: Int64,
        snippets: [SearchResultSnippet],
        additionalSnippetCount: Int,
        bestMatchedTermCount: Int,
        matchedSources: Set<SearchIndexStore.Source>
    ) {
        self.taskID = taskID
        self.snippets = snippets
        self.additionalSnippetCount = additionalSnippetCount
        self.bestMatchedTermCount = bestMatchedTermCount
        self.matchedSources = matchedSources
    }

    /// True when the spoken content matched, not merely the name.
    public var hasSpokenMatch: Bool { matchedSources.contains(.transcript) }

    /// Only the title, filename or site matched — which is all a download without a
    /// transcript can offer. The UI has to say so rather than implying the words were
    /// found inside.
    public var isMetadataOnly: Bool { !hasSpokenMatch }

    public var totalSnippetCount: Int { snippets.count + additionalSnippetCount }
}

/// Turns index hits into what a list can render.
public enum SearchResultBuilder: Sendable {
    /// Group hits by download.
    ///
    /// `hits` must arrive in the index's relevance order; a hit's position is used as
    /// its relevance, which avoids threading a bm25 score through every layer.
    ///
    /// Ranking within a download happens before truncation, then the survivors are
    /// re-sorted by time for display. Truncating a time-ordered list instead would
    /// keep the *earliest* moments rather than the best ones — for a long podcast that
    /// means showing the introduction and dropping the part the user searched for.
    public static func group(
        hits: [SearchIndexStore.Hit],
        query: String,
        snippetsPerTask: Int = 3
    ) -> [SearchResultGroup] {
        guard SearchTokenizer.matchExpression(for: query) != nil else { return [] }

        struct Candidate {
            let snippet: SearchResultSnippet
            let arrival: Int
        }
        var candidatesByTask: [Int64: [Candidate]] = [:]
        var firstArrival: [Int64: Int] = [:]

        for (arrival, hit) in hits.enumerated() {
            guard let highlight = SearchSnippet.highlight(text: hit.text, query: query) else {
                continue
            }
            let snippet = SearchResultSnippet(
                source: hit.source,
                startSeconds: hit.startSeconds,
                highlight: highlight
            )
            candidatesByTask[hit.taskID, default: []].append(
                Candidate(snippet: snippet, arrival: arrival)
            )
            if firstArrival[hit.taskID] == nil { firstArrival[hit.taskID] = arrival }
        }

        var groups: [SearchResultGroup] = []
        for (taskID, candidates) in candidatesByTask {
            let ranked = candidates.sorted { lhs, rhs in
                let left = lhs.snippet.highlight.matchedTermCount
                let right = rhs.snippet.highlight.matchedTermCount
                return left == right ? lhs.arrival < rhs.arrival : left > right
            }
            let kept = Array(ranked.prefix(max(0, snippetsPerTask)))
            let display = kept.map(\.snippet).sorted(by: readingOrder)
            groups.append(SearchResultGroup(
                taskID: taskID,
                snippets: display,
                additionalSnippetCount: max(0, candidates.count - kept.count),
                bestMatchedTermCount: ranked.first?.snippet.highlight.matchedTermCount ?? 0,
                matchedSources: Set(candidates.map(\.snippet.source))
            ))
        }

        // Downloads that contained more of what was asked for come first; the index's
        // own order breaks ties, which keeps repeated identical queries stable.
        return groups.sorted { lhs, rhs in
            if lhs.bestMatchedTermCount != rhs.bestMatchedTermCount {
                return lhs.bestMatchedTermCount > rhs.bestMatchedTermCount
            }
            return (firstArrival[lhs.taskID] ?? .max) < (firstArrival[rhs.taskID] ?? .max)
        }
    }

    /// Timed moments first, in the order they are spoken; metadata matches after,
    /// since they describe the item rather than a place inside it.
    static func readingOrder(_ lhs: SearchResultSnippet, _ rhs: SearchResultSnippet) -> Bool {
        switch (lhs.startSeconds, rhs.startSeconds) {
        case let (left?, right?):
            return left < right
        case (nil, _?):
            return false
        case (_?, nil):
            return true
        case (nil, nil):
            return lhs.source.rawValue < rhs.source.rawValue
        }
    }
}

/// Searching the download inbox by what it says.
public struct InboxSearch: Sendable {
    private let index: SearchIndexStore

    public init(index: SearchIndexStore) {
        self.index = index
    }

    /// Grouped results, best first.
    ///
    /// `hitLimit` bounds the rows read from the index before grouping. It is
    /// deliberately larger than the number of downloads shown: several hits can belong
    /// to one download, so a limit as small as the display count would drop entire
    /// downloads that matched.
    public func search(
        _ query: String,
        taskLimit: Int = 30,
        snippetsPerTask: Int = 3,
        hitLimit: Int = 200
    ) throws -> [SearchResultGroup] {
        guard SearchTokenizer.isSearchable(query) else { return [] }
        let hits = try index.search(query, limit: hitLimit)
        let groups = SearchResultBuilder.group(
            hits: hits,
            query: query,
            snippetsPerTask: snippetsPerTask
        )
        return Array(groups.prefix(max(0, taskLimit)))
    }
}
