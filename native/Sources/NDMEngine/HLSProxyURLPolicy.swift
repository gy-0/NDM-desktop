import Foundation
import Darwin
import NDMCore

/// URLSession's proxy configuration bypasses loopback destinations, including
/// when the selected proxy is unreachable. Stop before dispatch rather than
/// report those requests as proxied. Ordinary/direct HLS remains supported.
enum HLSProxyURLPolicy {
    enum Failure: Error, LocalizedError, Equatable {
        case loopbackDestination
        var errorDescription: String? {
            "系统会绕过代理连接本机回环地址，已停止 HLS 请求。请使用可经代理访问的服务器地址；当前代理模式暂不支持本机 HLS。"
        }
    }
    static func validate(_ url: URL, requiresProxy: Bool) throws {
        guard requiresProxy, var host = url.host?.lowercased() else { return }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        while host.hasSuffix(".") { host.removeLast() }
        if host == "localhost" || host.hasSuffix(".localhost") { throw Failure.loopbackDestination }
        // inet_aton also recognizes legacy decimal/octal/hex IPv4 literals that
        // Foundation can send to the local host despite their noncanonical text.
        var address = in_addr()
        if inet_aton(host, &address) == 1 {
            let octets = withUnsafeBytes(of: address.s_addr) { Array($0) }
            if octets[0] == 127 { throw Failure.loopbackDestination }
        }
        if let zone = host.firstIndex(of: "%") { host = String(host[..<zone]) }
        var ipv6 = in6_addr()
        if inet_pton(AF_INET6, host, &ipv6) == 1 {
            let bytes = withUnsafeBytes(of: ipv6) { Array($0) }
            if bytes.prefix(15).allSatisfy({ $0 == 0 }) && bytes[15] == 1 {
                throw Failure.loopbackDestination
            }
            if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255, bytes[12] == 127 {
                throw Failure.loopbackDestination
            }
        }
    }
}

/// HEAD probes need the same pre-redirect restriction as streamed HLS bodies.
final class HLSProbeDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let requiresProxy: Bool
    private let authentication: ProbeAuthenticationDelegate
    init(origin: URL, requiresProxy: Bool, proxy: ProxySettings?) {
        self.requiresProxy = requiresProxy
        self.authentication = ProbeAuthenticationDelegate(origin: origin, proxy: proxy)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        do { if let url = request.url { try HLSProxyURLPolicy.validate(url, requiresProxy: requiresProxy) } }
        catch { completionHandler(nil); return }
        authentication.urlSession(session, task: task, willPerformHTTPRedirection: response,
                                  newRequest: request, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        authentication.urlSession(session, task: task, didReceive: challenge, completionHandler: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        authentication.urlSession(session, task: task, didCompleteWithError: error)
    }
}
