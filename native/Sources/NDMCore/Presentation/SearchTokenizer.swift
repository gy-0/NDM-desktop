import Foundation

/// Splits text into the tokens the search index stores, and builds the matching
/// query expression.
///
/// Why this exists rather than letting SQLite tokenize: measured on SQLite 3.54.0,
/// FTS5's default `unicode61` tokenizer returns **zero** results for every Chinese
/// query, because Chinese has no spaces to split on. The `trigram` tokenizer works
/// only for queries of three characters or more — and most Chinese search terms are
/// two characters (中文, 语音, 转写, 视频), so it is equally broken for the primary
/// market.
///
/// So CJK is cut into overlapping bigrams before it ever reaches SQLite, which
/// makes any query of two or more characters findable, including one that straddles
/// a word boundary. Real word segmentation (`NLTokenizer`) was rejected for the
/// same reason: splitting 本地转写 into 本地 + 转写 loses the query 地转, and search
/// wants recall, not linguistic correctness.
public enum SearchTokenizer: Sendable {
    /// Tokens to store for a document: bigrams plus each CJK run's final character.
    public static func indexTokens(_ text: String) -> [String] {
        tokens(text, includeRunFinalUnigram: true)
    }

    /// Tokens to search for.
    ///
    /// Deliberately *not* the same as `indexTokens`. The run-final unigram is an
    /// indexing device that makes a single-character prefix query findable; demanding
    /// it in a query would add a redundant term to every Chinese search and describe
    /// a constraint the user never asked for.
    public static func queryTokens(_ text: String) -> [String] {
        tokens(text, includeRunFinalUnigram: false)
    }

    private static func tokens(_ text: String, includeRunFinalUnigram: Bool) -> [String] {
        var tokens: [String] = []
        var cjkRun: [Character] = []
        var latinRun = ""

        func flushCJK() {
            defer { cjkRun = [] }
            guard !cjkRun.isEmpty else { return }
            guard cjkRun.count >= 2 else {
                tokens.append(String(cjkRun[0]))
                return
            }
            for index in 0..<(cjkRun.count - 1) {
                tokens.append(String(cjkRun[index...(index + 1)]))
            }
            // The run's last character begins no bigram, so a single-character
            // prefix query would find every character except that one. Being
            // inconsistent about it is worse than not supporting it at all, and one
            // extra token per run is nothing. Index side only.
            if includeRunFinalUnigram {
                tokens.append(String(cjkRun[cjkRun.count - 1]))
            }
        }

        func flushLatin() {
            defer { latinRun = "" }
            let word = latinRun.lowercased()
            if !word.isEmpty { tokens.append(word) }
        }

        for character in text {
            if isCJK(character) {
                flushLatin()
                cjkRun.append(character)
            } else if character.isLetter || character.isNumber {
                flushCJK()
                latinRun.append(character)
            } else {
                flushCJK()
                flushLatin()
            }
        }
        flushCJK()
        flushLatin()
        return tokens
    }

    /// The stored form: tokens joined by spaces so `unicode61` splits them back out.
    public static func indexedText(_ text: String) -> String {
        indexTokens(text).joined(separator: " ")
    }

    /// An FTS5 MATCH expression, or nil when the query has nothing searchable in it.
    ///
    /// Terms are combined with AND: someone typing two words almost always wants
    /// both, and OR would bury the result they meant.
    public static func matchExpression(for query: String) -> String? {
        let tokens = queryTokens(query)
        guard !tokens.isEmpty else { return nil }
        let terms = tokens.map { token -> String in
            let quoted = token.replacingOccurrences(of: "\"", with: "\"\"")
            // A lone CJK character is no bigram, so ask for any bigram starting with
            // it instead of demanding an exact token.
            if token.count == 1, let only = token.first, isCJK(only) {
                return "\"\(quoted)\"*"
            }
            return "\"\(quoted)\""
        }
        return terms.joined(separator: " AND ")
    }

    /// Whether a query contains anything that could match. Punctuation-only input is
    /// not an empty result, it is not a search at all.
    public static func isSearchable(_ query: String) -> Bool {
        matchExpression(for: query) != nil
    }

    static func isCJK(_ character: Character) -> Bool {
        character.unicodeScalars.contains { scalar in
            switch scalar.value {
            case 0x3040...0x309F,        // hiragana
                 0x30A0...0x30FF,        // katakana
                 0x3400...0x4DBF,        // CJK ext A
                 0x4E00...0x9FFF,        // CJK unified
                 0xAC00...0xD7AF,        // hangul syllables
                 0xF900...0xFAFF:        // compatibility ideographs
                return true
            default:
                return false
            }
        }
    }
}
