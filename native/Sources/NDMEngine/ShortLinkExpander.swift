import Foundation

/// Product-facing outcome of resolving a social short link. Expansion is a
/// best-effort preparation step: failure always falls back to the original URL.
public struct ExpandedShortLink: Equatable, Sendable {
    public let originalURL: String
    public let resolvedURL: String
    public let didExpand: Bool

    public init(originalURL: String, resolvedURL: String, didExpand: Bool) {
        self.originalURL = originalURL
        self.resolvedURL = resolvedURL
        self.didExpand = didExpand
    }
}

/// Expands known social redirectors before the media resolver sees them.
/// The network session is ephemeral, cookie-free and cache-free so this step
/// never borrows browser identity or persists site data.
public enum ShortLinkExpander {
    typealias RequestResolver = @Sendable (URLRequest) async throws -> URL?

    /// Internal for the cross-module test that keeps this list in lockstep
    /// with `SharedLinkResolver.shortLinkHosts`.
    static let exactHosts: Set<String> = [
        "b23.tv",
        "youtu.be",
        "v.douyin.com",
        "xhslink.com",
        "vm.tiktok.com",
        "vt.tiktok.com",
        "v.kuaishou.com",
        "fb.watch",
        "dai.ly",
    ]

    public static func shouldExpand(_ raw: String) -> Bool {
        guard let url = validWebURL(raw), let host = url.host?.lowercased() else { return false }
        if exactHosts.contains(host) { return true }
        return host.hasSuffix(".xhslink.com")
    }

    public static func expand(
        _ raw: String,
        timeout: TimeInterval = 12
    ) async -> ExpandedShortLink {
        await expand(raw) { request in
            try await resolveFinalURL(for: request, timeout: timeout)
        }
    }

    /// Injectable request boundary keeps redirect behavior deterministic in
    /// unit tests without reaching real social sites.
    static func expand(
        _ raw: String,
        resolvingWith resolver: @escaping RequestResolver
    ) async -> ExpandedShortLink {
        let original = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard shouldExpand(original), let originalURL = validWebURL(original) else {
            return ExpandedShortLink(originalURL: original, resolvedURL: original, didExpand: false)
        }

        var head = URLRequest(url: originalURL)
        head.httpMethod = "HEAD"
        prepare(&head)
        if let final = try? await resolver(head),
           let sanitized = sanitizedResolvedURL(original: originalURL, responseURL: final),
           sanitized != originalURL.absoluteString {
            return ExpandedShortLink(originalURL: original, resolvedURL: sanitized, didExpand: true)
        }

        // A few redirectors reject HEAD. Ask only for the first byte so the
        // fallback cannot accidentally turn into a media download.
        var get = URLRequest(url: originalURL)
        get.httpMethod = "GET"
        get.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        prepare(&get)
        if let final = try? await resolver(get),
           let sanitized = sanitizedResolvedURL(original: originalURL, responseURL: final),
           sanitized != originalURL.absoluteString {
            return ExpandedShortLink(originalURL: original, resolvedURL: sanitized, didExpand: true)
        }

        return ExpandedShortLink(originalURL: original, resolvedURL: original, didExpand: false)
    }

    static func sanitizedResolvedURL(original: URL, responseURL: URL?) -> String? {
        guard let responseURL,
              let scheme = responseURL.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = responseURL.host, !host.isEmpty else { return nil }
        var components = URLComponents(url: responseURL, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        return components?.url?.absoluteString
    }

    private static func validWebURL(_ raw: String) -> URL? {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    private static func prepare(_ request: inout URLRequest) {
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
            forHTTPHeaderField: "User-Agent"
        )
        request.setValue("text/html,application/xhtml+xml,*/*;q=0.8", forHTTPHeaderField: "Accept")
    }

    private static func resolveFinalURL(
        for request: URLRequest,
        timeout: TimeInterval
    ) async throws -> URL? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(for: request)
        return response.url
    }
}
