import Foundation
import NDMCore

/// Owned by DownloadEngine's actor; origin and proxy use separate instances.
struct RequestAuthentication {
    var fixedHeader: String?
    private var digest: DigestAuth.Challenge?
    private var count: UInt32 = 0
    private var cnonce = DigestAuth.randomCnonce()

    mutating func adopt(_ challenge: DigestAuth.Challenge) throws {
        try DigestAuth.validate(challenge)
        if digest?.nonce != challenge.nonce || digest?.realm != challenge.realm {
            count = 0
            cnonce = DigestAuth.randomCnonce()
        }
        digest = challenge
        fixedHeader = nil
    }

    mutating func setFixedHeader(_ value: String) {
        digest = nil
        fixedHeader = value
    }

    mutating func header(for request: URLRequest, username: String?, password: String, proxy: Bool, forwardProxy: Bool = false) throws -> String? {
        guard let digest else { return fixedHeader }
        guard let username else { throw EngineError.authRequired(status: proxy ? 407 : 401, challenge: nil) }
        guard count < UInt32.max else { throw DigestAuth.Failure.nonceCountExhausted }
        count += 1
        guard let url = request.url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { throw EngineError.invalidResponse }
        components.fragment = nil
        let target: String
        if proxy && url.scheme?.lowercased() == "https" { throw HTTPAuthenticationBoundary.Failure.unsupportedProxyTunnel }
        if proxy || forwardProxy {
            target = components.string ?? url.absoluteString
        } else {
            let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
            target = path + (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        }
        return try DigestAuth.authorizationHeader(challenge: digest, username: username, password: password,
            method: request.httpMethod ?? "GET", uri: target, nc: String(format: "%08x", count), cnonce: cnonce)
    }
}
