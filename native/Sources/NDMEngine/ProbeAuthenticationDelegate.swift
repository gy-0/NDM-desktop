import Foundation
import NDMCore

/// Authentication boundaries shared by probes and range transfers; TLS and
/// connection-bound NTLM remain URLSession's responsibility.
enum HTTPAuthenticationBoundary {
    enum Failure: Error, LocalizedError {
        case crossOrigin
        case unsupportedProxyTunnel
        var errorDescription: String? {
            switch self {
            case .crossOrigin: return "Authentication credentials cannot be reused for a redirected server."
            case .unsupportedProxyTunnel: return "Digest authentication for HTTPS proxy tunnels is not supported."
            }
        }
    }
    static func failure(for challenge: URLAuthenticationChallenge, origin: URL?, proxy: ProxySettings?) -> Failure? {
        let space = challenge.protectionSpace
        if space.isProxy() {
            guard let proxy, space.host.caseInsensitiveCompare(proxy.host) == .orderedSame, space.port == Int(proxy.port) else { return .crossOrigin }
            if origin?.scheme?.lowercased() == "https", space.authenticationMethod == NSURLAuthenticationMethodHTTPDigest { return .unsupportedProxyTunnel }
        } else {
            guard let origin, space.host.caseInsensitiveCompare(origin.host ?? "") == .orderedSame,
                  space.port == (origin.port ?? (origin.scheme?.lowercased() == "https" ? 443 : 80)),
                  space.protocol?.lowercased() == origin.scheme?.lowercased() else { return .crossOrigin }
        }
        return nil
    }
}

/// Probes are sequential. Capture HTTP challenges rather than letting URLSession
/// resend an existing proxy header with a nonce count it has already consumed.
final class ProbeAuthenticationDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let origin: URL
    private let proxy: ProxySettings?
    private let lock = NSLock()
    private var failure: Error?
    private var crossedTasks = Set<Int>()
    init(origin: URL, proxy: ProxySettings?) { self.origin = origin; self.proxy = proxy }
    func takeFailure() -> Error? { lock.lock(); defer { lock.unlock() }; defer { failure = nil }; return failure }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        lock.lock()
        var crossed = crossedTasks.contains(task.taskIdentifier)
        do {
            let scoped = try HTTPRedirectPolicy.redirect(request, from: response.url, origin: origin, crossedOrigin: &crossed,
                authenticatedHTTPProxy: proxy?.enabled == true && !(proxy?.username ?? "").isEmpty,
                originalRequest: task.originalRequest)
            if crossed { crossedTasks.insert(task.taskIdentifier) }
            lock.unlock()
            completionHandler(scoped)
        } catch {
            failure = error
            lock.unlock()
            completionHandler(nil)
        }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); crossedTasks.remove(task.taskIdentifier); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest:
            let response = challenge.failureResponse as? HTTPURLResponse
            let status = challenge.protectionSpace.isProxy() ? 407 : (response?.statusCode ?? 401)
            let error: Error = HTTPAuthenticationBoundary.failure(for: challenge, origin: origin, proxy: proxy)
                ?? EngineError.authRequired(status: status, challenge: response?.value(forHTTPHeaderField: status == 407 ? "Proxy-Authenticate" : "WWW-Authenticate"))
            lock.lock(); failure = error; lock.unlock()
            completionHandler(.cancelAuthenticationChallenge, nil)
        default: completionHandler(.performDefaultHandling, nil)
        }
    }
}
