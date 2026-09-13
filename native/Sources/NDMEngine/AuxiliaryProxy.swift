import Foundation
import Darwin
import NDMCore

public enum AuxiliaryProxyError: String, Error, LocalizedError, Sendable {
    case proxyUnsupported, proxyConfigurationUnsupported, proxyChanged, proxyUnavailable
    public var errorDescription: String? {
        switch self {
        case .proxyUnsupported: return "ED2K 暂不支持代理；请关闭代理后重新开始此任务。"
        case .proxyConfigurationUnsupported: return "当前代理类型无法用于此辅助协议，请改用支持的 HTTP 或 SOCKS5 代理。"
        case .proxyChanged: return "代理设置已更改，任务已安全暂停；重新开始将使用新设置。"
        case .proxyUnavailable: return "代理设置尚未确认，任务已暂停，未改为直连。"
        }
    }
}

/// Volatile transport intent only. Proxy credentials never enter the task
/// journal, creation receipt, metainfo override or helper configuration files.
public struct AuxiliaryProxyPlan: Sendable, Equatable {
    public enum Mode: Sendable, Equatable { case direct, http, socks4, socks5, unsupported, invalid }
    public let mode: Mode
    let uri: String
    let curlURI: String
    public var enabled: Bool { mode != .direct }
    public static let direct = Self(mode: .direct, uri: "", curlURI: "")
    public init(settings: AppSettings) {
        do { self = try Self.select(settings) } catch { self = .init(mode: .invalid, uri: "", curlURI: "") }
    }
    private static func select(_ settings: AppSettings) throws -> Self {
        if let proxy = settings.socksProxy, proxy.enabled {
            let mode: Mode = proxy.version == .v4 ? .socks4 : .socks5
            let uri = try uri(scheme: proxy.version == .v4 ? "socks4" : "socks5", host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password)
            let curl = try Self.uri(scheme: proxy.version == .v4 ? "socks4a" : "socks5h", host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password)
            return .init(mode: mode, uri: uri, curlURI: curl)
        }
        if let proxy = settings.httpProxy, proxy.enabled {
            let uri = try uri(scheme: "http", host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password)
            return .init(mode: .http, uri: uri, curlURI: uri)
        }
        if settings.httpsProxy?.enabled == true || settings.ftpProxy?.enabled == true { return .init(mode: .unsupported, uri: "", curlURI: "") }
        return .direct
    }
    private init(mode: Mode, uri: String, curlURI: String) { self.mode = mode; self.uri = uri; self.curlURI = curlURI }
    public func validate(kind: String) throws {
        if kind == "ed2k", enabled { throw AuxiliaryProxyError.proxyUnsupported }
        if mode == .unsupported { throw AuxiliaryProxyError.proxyConfigurationUnsupported }
        if mode == .invalid { throw AuxiliaryProxyError.proxyUnavailable }
        // SOCKS4 lacks the SFTP SOCKS5 hostname/authentication contract.
        if kind == "sftp", mode == .socks4 { throw AuxiliaryProxyError.proxyConfigurationUnsupported }
    }
    func validateBTEndpoints(_ config: AuxiliaryBTConfig) throws {
        guard mode == .socks4 else { return }
        // The pinned fork cannot delegate tracker/webseed DNS through SOCKS4.
        // Numeric destinations remain supported; never silently resolve names
        // locally when the user selected an auxiliary proxy.
        for value in config.trackers.map(\.url) + config.webSeeds {
            guard let host = URLComponents(string: value)?.host else { throw AuxiliaryProxyError.proxyConfigurationUnsupported }
            let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
            var v4 = in_addr(), v6 = in6_addr()
            guard inet_pton(AF_INET, bare, &v4) == 1 || inet_pton(AF_INET6, bare, &v6) == 1 else { throw AuxiliaryProxyError.proxyConfigurationUnsupported }
        }
    }
    func environment(from inherited: [String: String]) -> [String: String] {
        var output = inherited.filter { !$0.key.lowercased().hasSuffix("_proxy") }
        if mode == .socks5 { output["ALL_PROXY"] = curlURI }
        // No NO_PROXY bypass, including loopback. NDM's RPC client has its own
        // explicit proxy-free URLSession and does not use this child environment.
        return output
    }
    private static func uri(scheme: String, host: String, port: UInt16, username: String?, password: String?) throws -> String {
        guard port > 0, !host.isEmpty, host.utf8.count <= 253,
              !host.unicodeScalars.contains(where: { $0.value <= 32 || (127...159).contains($0.value) }),
              host.rangeOfCharacter(from: CharacterSet(charactersIn: "/@?#")) == nil else { throw AuxiliaryProxyError.proxyUnavailable }
        let address: String
        if host.contains(":") {
            let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
            var value = in6_addr(); guard inet_pton(AF_INET6, bare, &value) == 1 else { throw AuxiliaryProxyError.proxyUnavailable }
            address = "[\(bare)]"
        } else {
            guard host.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$", options: .regularExpression) != nil else { throw AuxiliaryProxyError.proxyUnavailable }
            address = host
        }
        let user = username ?? "", pass = password ?? ""
        guard user.utf8.count <= 1024, pass.utf8.count <= 4096, !user.contains("\0"), !pass.contains("\0"), !user.isEmpty || pass.isEmpty else { throw AuxiliaryProxyError.proxyUnavailable }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        let auth = user.isEmpty ? "" : "\(user.addingPercentEncoding(withAllowedCharacters: allowed)!):\(pass.addingPercentEncoding(withAllowedCharacters: allowed)!)@"
        return "\(scheme)://\(auth)\(address):\(port)/"
    }
}
