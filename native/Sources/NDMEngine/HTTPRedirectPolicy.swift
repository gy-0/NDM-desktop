import Foundation
import NDMCore

/// Captured browser headers belong to the original request origin. Each newly
/// constructed request and every redirect hop must enforce that same boundary.
enum HTTPRedirectPolicy {
    enum Failure: Error, LocalizedError {
        case unsafeTarget
        case insecureDowngrade
        case crossOriginBody
        case authenticatedProxyRedirect

        var errorDescription: String? {
            switch self {
            case .unsafeTarget:
                return L10n.t("The download redirect has an unsupported or credential-bearing URL.",
                              "下载重定向地址使用了不支持的协议或包含登录凭据。")
            case .insecureDowngrade:
                return L10n.t("The download redirect would send a secure request over an insecure connection.",
                              "下载重定向将 HTTPS 降级为不安全的 HTTP，已停止请求。")
            case .crossOriginBody:
                return L10n.t("A download request body cannot be forwarded to another origin.",
                              "下载请求正文不能转发给另一个来源，已停止重定向。")
            case .authenticatedProxyRedirect:
                return L10n.t("Cross-origin download redirects through an authenticated HTTP proxy are not supported.",
                              "暂不支持通过需要认证的 HTTP 代理进行跨来源下载重定向。")
            }
        }
    }

    static func sameOrigin(_ lhs: URL?, _ rhs: URL?) -> Bool {
        guard let lhs, let rhs, let scheme = lhs.scheme?.lowercased(),
              let host = lhs.host?.lowercased(), !host.isEmpty,
              scheme == rhs.scheme?.lowercased(), host == rhs.host?.lowercased() else { return false }
        let defaultPort = scheme == "https" ? 443 : 80
        return (lhs.port ?? defaultPort) == (rhs.port ?? defaultPort)
    }

    // Deliberately allow only transport/representation headers. Site credentials
    // can have arbitrary names; a blacklist cannot bound captured header leakage.
    private static let portableHeaders: Set<String> = [
        "accept", "accept-encoding", "accept-language", "accept-charset",
        "user-agent", "range", "if-range"
    ]

    static func configure(_ configuration: URLSessionConfiguration) {
        // Cookies are explicitly captured and scoped, never supplied by a session
        // jar (whose cookie host rules do not distinguish origin ports).
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
    }

    static func scope(_ request: URLRequest, to origin: URL, crossedOrigin: Bool = false) throws -> URLRequest {
        guard let target = request.url,
              ["http", "https"].contains(target.scheme?.lowercased() ?? ""),
              let host = target.host, !host.isEmpty,
              target.user == nil, target.password == nil else { throw Failure.unsafeTarget }
        if origin.scheme?.lowercased() == "https", target.scheme?.lowercased() == "http" {
            throw Failure.insecureDowngrade
        }
        var result = request
        result.httpShouldHandleCookies = false
        if crossedOrigin || !sameOrigin(origin, target) {
            guard ["GET", "HEAD"].contains((result.httpMethod ?? "GET").uppercased()),
                  result.httpBody == nil, result.httpBodyStream == nil else { throw Failure.crossOriginBody }
            for header in (result.allHTTPHeaderFields ?? [:]).keys where !portableHeaders.contains(header.lowercased()) {
                result.setValue(nil, forHTTPHeaderField: header)
            }
        }
        return result
    }

    static func redirect(_ proposed: URLRequest, from source: URL?, origin: URL,
                         crossedOrigin: inout Bool, authenticatedHTTPProxy: Bool = false,
                         originalRequest: URLRequest? = nil) throws -> URLRequest {
        if source?.scheme?.lowercased() == "https", proposed.url?.scheme?.lowercased() == "http" {
            throw Failure.insecureDowngrade
        }
        // Once a chain leaves the origin, even a later return must not revive
        // captured credentials from URLSession's original request.
        crossedOrigin = crossedOrigin || !sameOrigin(source, proposed.url) || !sameOrigin(origin, proposed.url)
        // A proxy's Digest challenge is bound to the new absolute request target.
        // Replaying the original request cannot authenticate that redirect safely.
        if crossedOrigin, authenticatedHTTPProxy { throw Failure.authenticatedProxyRedirect }
        var result = proposed
        if !crossedOrigin, sameOrigin(origin, originalRequest?.url) {
            // Foundation removes these even for same-origin redirects. Restore
            // only inside the still-unbroken origin boundary, never after a hop
            // away and back. Other captured headers remain in its proposed request.
            for header in ["Authorization", "Proxy-Authorization"] {
                if result.value(forHTTPHeaderField: header) == nil,
                   let value = originalRequest?.value(forHTTPHeaderField: header) {
                    result.setValue(value, forHTTPHeaderField: header)
                }
            }
        }
        return try scope(result, to: origin, crossedOrigin: crossedOrigin)
    }

    static func checkAuthenticationResponse(_ response: URLResponse, origin: URL) throws {
        if let http = response as? HTTPURLResponse, http.statusCode == 401,
           !sameOrigin(origin, http.url) { throw HTTPAuthenticationBoundary.Failure.crossOrigin }
    }
}
