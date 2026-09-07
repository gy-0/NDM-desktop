import Foundation

/// A product-facing result for links pasted as either a URL or a social share message.
public struct SharedLinkResolution: Equatable, Sendable {
    public enum Source: String, Equatable, Sendable {
        case youtube
        case bilibili
        case douyin
        case xiaohongshu
        case tiktok
        case kuaishou
        case weibo
        case instagram
        case x
        case facebook
        case vimeo
        case twitch
        case dailymotion
        case web
    }

    public let urlString: String
    public let source: Source
    public let wasExtractedFromText: Bool
    /// Kept only for the short-lived clipboard/new-task handoff. This lets the
    /// next surface say “share recognized” without reparsing or persisting the
    /// surrounding message.
    public let inputText: String

    public init(
        urlString: String,
        source: Source,
        wasExtractedFromText: Bool,
        inputText: String? = nil
    ) {
        self.urlString = urlString
        self.source = source
        self.wasExtractedFromText = wasExtractedFromText
        self.inputText = inputText ?? urlString
    }
}

/// Turns copied share messages into a clean URL without making the user hunt
/// through Chinese copy, hashtags, timestamps, or app-specific command text.
public enum SharedLinkResolver {
    private struct Candidate {
        let urlString: String
        let location: Int
        let source: SharedLinkResolution.Source
        let score: Int
    }

    private static let maximumInputLength = 32_768
    private static let urlExpression = try! NSRegularExpression(
        pattern: #"(?i)(?:https?|ftp)://[^\s<>\"'，。；：！？）》】」』、]+"#
    )
    /// Scheme-less links are accepted only for recognized media/social hosts.
    /// This catches the text produced by several mobile share sheets while
    /// avoiding turning every dotted phrase into a download candidate.
    private static let knownHostExpression = try! NSRegularExpression(
        pattern: #"(?i)(?<![\w.])(?:(?:www\.|m\.|music\.)?youtube\.com|youtu\.be|(?:www\.|m\.)?bilibili\.com|b23\.tv|(?:www\.|v\.)?douyin\.com|[\w.-]+\.iesdouyin\.com|(?:www\.)?xiaohongshu\.com|(?:[\w-]+\.)?xhslink\.com|(?:www\.|vm\.|vt\.)?tiktok\.com|(?:www\.|v\.|m\.)?kuaishou\.com|(?:www\.|m\.)?weibo\.(?:com|cn)|(?:www\.)?instagram\.com|(?:www\.)?(?:x|twitter)\.com|fb\.watch|(?:www\.|m\.)?facebook\.com|(?:www\.)?vimeo\.com|(?:www\.)?twitch\.tv|dai\.ly|(?:www\.)?dailymotion\.com)/[^\s<>\"'，。；：！？）》】」』、]+"#
    )
    private static let trailingPunctuation = CharacterSet(
        charactersIn: ".,;:!?)]}>，。；：！？）》】」』、…"
    )
    /// Internal for the cross-module test that keeps this list in lockstep
    /// with `ShortLinkExpander.exactHosts`.
    static let shortLinkHosts: Set<String> = [
        "b23.tv", "youtu.be", "v.douyin.com", "xhslink.com",
        "vm.tiktok.com", "vt.tiktok.com", "v.kuaishou.com",
        "fb.watch", "dai.ly",
    ]
    private static let likelyMediaPathTokens = [
        "/video/", "/watch/", "/shorts/", "/reel/", "/reels/",
        "/tv/", "/play/", "/live/", "/photo/", "/explore/",
    ]
    private static let directExtensions: Set<String> = [
        "mp4", "mkv", "mov", "m4v", "webm", "mp3", "m4a", "flac",
        "wav", "m3u8", "m3u", "ts", "zip", "dmg", "pkg", "pdf",
    ]
    private static let fullWidthURLPunctuation: [UInt32: UInt32] = [
        0xFF03: 0x23, // #
        0xFF05: 0x25, // %
        0xFF06: 0x26, // &
        0xFF0B: 0x2B, // +
        0xFF0D: 0x2D, // -
        0xFF0E: 0x2E, // .
        0xFF0F: 0x2F, // /
        0xFF1A: 0x3A, // :
        0xFF1D: 0x3D, // =
        0xFF1F: 0x3F, // ?
        0xFF20: 0x40, // @
        0xFF3F: 0x5F, // _
        0xFF5E: 0x7E, // ~
    ]

    public static func resolve(_ raw: String) -> SharedLinkResolution? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf16.count <= maximumInputLength else { return nil }

        let prepared = prepareInput(trimmed)
        var candidates = matches(in: prepared, expression: urlExpression, prependHTTPS: false)
        candidates.append(contentsOf: matches(
            in: prepared,
            expression: knownHostExpression,
            prependHTTPS: true
        ))

        var seen: Set<String> = []
        let ranked = candidates.compactMap { candidate, location -> Candidate? in
            // matches() already ran cleanCandidate on every hit.
            guard seen.insert(candidate).inserted,
                  let url = URL(string: candidate),
                  let scheme = url.scheme?.lowercased(),
                  ["http", "https", "ftp"].contains(scheme),
                  let host = url.host?.lowercased(), !host.isEmpty else { return nil }
            let source = source(forHost: host)
            return Candidate(
                urlString: candidate,
                location: location,
                source: source,
                score: score(url: url, source: source)
            )
        }.sorted { lhs, rhs in
            lhs.score == rhs.score ? lhs.location < rhs.location : lhs.score > rhs.score
        }

        guard let selected = ranked.first else { return nil }
        let direct = normalizedForComparison(prepared) == normalizedForComparison(selected.urlString)
        return SharedLinkResolution(
            urlString: selected.urlString,
            source: selected.source,
            wasExtractedFromText: !direct,
            inputText: trimmed
        )
    }

    /// Shared by Link Lens so platform identity cannot drift from extraction.
    public static func source(forURLString raw: String) -> SharedLinkResolution.Source {
        guard let host = URL(string: raw)?.host?.lowercased() else { return .web }
        return source(forHost: host)
    }

    private static func matches(
        in text: String,
        expression: NSRegularExpression,
        prependHTTPS: Bool
    ) -> [(String, Int)] {
        let nsText = text as NSString
        let range = NSRange(location: 0, length: nsText.length)
        return expression.matches(in: text, range: range).compactMap { match in
            guard match.range.location != NSNotFound else { return nil }
            let raw = nsText.substring(with: match.range)
            let candidate = cleanCandidate(raw, prependHTTPS: prependHTTPS)
            guard !candidate.isEmpty else { return nil }
            return (candidate, match.range.location)
        }
    }

    private static func cleanCandidate(_ raw: String, prependHTTPS: Bool) -> String {
        var candidate = raw.replacingOccurrences(of: "&amp;", with: "&")
        while let scalar = candidate.unicodeScalars.last,
              trailingPunctuation.contains(scalar) {
            candidate.removeLast()
        }
        guard !candidate.isEmpty else { return "" }
        return prependHTTPS && !candidate.contains("://")
            ? "https://\(candidate)"
            : candidate
    }

    private static func score(
        url: URL,
        source: SharedLinkResolution.Source
    ) -> Int {
        let host = url.host?.lowercased() ?? ""
        let path = url.path.lowercased()
        var value = source == .web ? 0 : 100
        if shortLinkHosts.contains(host) || host.hasSuffix(".xhslink.com") { value += 30 }
        if likelyMediaPathTokens.contains(where: path.contains) { value += 18 }
        if directExtensions.contains(url.pathExtension.lowercased()) { value += 24 }
        return value
    }

    private static func source(forHost host: String) -> SharedLinkResolution.Source {
        if host == "youtu.be" || host == "youtube.com" || host.hasSuffix(".youtube.com") {
            return .youtube
        }
        if host == "b23.tv" || host == "bilibili.com" || host.hasSuffix(".bilibili.com") {
            return .bilibili
        }
        if host == "douyin.com" || host.hasSuffix(".douyin.com")
            || host == "iesdouyin.com" || host.hasSuffix(".iesdouyin.com") {
            return .douyin
        }
        if host == "xhslink.com" || host.hasSuffix(".xhslink.com")
            || host == "xiaohongshu.com" || host.hasSuffix(".xiaohongshu.com") {
            return .xiaohongshu
        }
        if host == "tiktok.com" || host.hasSuffix(".tiktok.com") { return .tiktok }
        if host == "kuaishou.com" || host.hasSuffix(".kuaishou.com") { return .kuaishou }
        if host == "weibo.com" || host.hasSuffix(".weibo.com")
            || host == "weibo.cn" || host.hasSuffix(".weibo.cn") { return .weibo }
        if host == "instagram.com" || host.hasSuffix(".instagram.com") { return .instagram }
        if host == "x.com" || host.hasSuffix(".x.com")
            || host == "twitter.com" || host.hasSuffix(".twitter.com") { return .x }
        if host == "fb.watch" || host == "facebook.com" || host.hasSuffix(".facebook.com") {
            return .facebook
        }
        if host == "vimeo.com" || host.hasSuffix(".vimeo.com") { return .vimeo }
        if host == "twitch.tv" || host.hasSuffix(".twitch.tv") { return .twitch }
        if host == "dai.ly" || host == "dailymotion.com" || host.hasSuffix(".dailymotion.com") {
            return .dailymotion
        }
        return .web
    }

    /// Mobile share sheets occasionally insert zero-width characters or
    /// full-width ASCII punctuation. Normalize only those transport artifacts;
    /// never rewrite query parameters or strip tokens from the chosen URL.
    private static func prepareInput(_ value: String) -> String {
        let decoded = value.replacingOccurrences(of: "&amp;", with: "&")
        let withoutInvisible = decoded.unicodeScalars.filter {
            ![0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF].contains($0.value)
        }
        let normalizedScalars = withoutInvisible.map { scalar -> UnicodeScalar in
            let value = scalar.value
            if (0xFF10...0xFF19).contains(value)
                || (0xFF21...0xFF3A).contains(value)
                || (0xFF41...0xFF5A).contains(value),
               let normalized = UnicodeScalar(value - 0xFEE0) {
                return normalized
            }
            if let mapped = fullWidthURLPunctuation[value], let normalized = UnicodeScalar(mapped) {
                return normalized
            }
            return scalar
        }
        return String(String.UnicodeScalarView(normalizedScalars))
    }

    private static func normalizedForComparison(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: trailingPunctuation)
    }
}
