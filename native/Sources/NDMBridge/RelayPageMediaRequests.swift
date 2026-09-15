import Foundation
import NDMCore

/// Two-stage, connection-bound browser access. Discovery exposes metadata only;
/// signed resource URLs and request headers exist only during selected admission.
public actor RelayPageMediaRequests {
    public static let requestPrefix = "NDMRelayPageMediaRequest:"
    public static let responsePrefix = "NDMRelayPageMediaResponse:"
    public enum Failure: String, Error, LocalizedError {
        case unsupported, unavailable, navigation, busy, timeout, invalid
        public var errorDescription: String? {
            switch self {
            case .unsupported: return "请更新 NDM Relay 扩展，并刷新已打开的视频页面后重试。"
            case .unavailable: return "未找到当前页面的视频版本。请在原浏览器打开此视频并播放，再读取页面。"
            case .navigation: return "浏览器页面或视频版本已变化，请重新读取页面后选择版本。"
            case .busy: return "浏览器正在处理上一次请求，请稍后重试。"
            case .timeout: return "浏览器未及时响应，请确认扩展已连接后重试。"
            case .invalid: return "浏览器返回的视频信息无效，请刷新来源页面后重试。"
            }
        }
    }
    public struct Item: Codable, Sendable, Equatable {
        public let mediaKey: String
        public let title: String
        public let meta: String
        public let badge: String
        public let kind: String
        public let quality: String
    }
    public struct Source: Decodable, Sendable {
        let sourceID: String
        let pageURL: String
        let title: String
        let browser: String
        let incognito: Bool
        let tabId: Int
        let documentID: String
        let items: [Item]
    }
    public struct Summary: Encodable, Sendable {
        public let sourceToken: String
        public let pageURL: String
        public let title: String
        public let browser: String
        public let incognito: Bool
        public let items: [Item]
    }
    public struct Response: Decodable, Sendable {
        let requestId: String
        let op: String
        let sources: [Source]?
        let sourceID: String?
        let mediaKey: String?
        let pageURL: String?
        let payload: String?
        let error: String?
    }
    private struct Binding {
        let clientID: String
        let source: Source
        let expires: Date
    }
    private struct Discovery {
        let pageURL: String
        var clients: Set<String>
        var summaries: [Summary]
        let continuation: CheckedContinuation<[Summary], Error>
    }
    private struct Preparation {
        let binding: Binding
        let mediaKey: String
        let continuation: CheckedContinuation<ParsedBridgeMessage, Error>
    }
    private var bindings: [String: Binding] = [:]
    private var discoveries: [String: Discovery] = [:]
    private var preparations: [String: Preparation] = [:]
    private let clients: @Sendable () -> [String]
    private let send: @Sendable (String, String) -> Bool
    private let now: @Sendable () -> Date
    private let timeout: UInt64
    public init(timeoutMilliseconds: UInt64 = 7000, now: @escaping @Sendable () -> Date = { Date() },
                clients: @escaping @Sendable () -> [String], send: @escaping @Sendable (String, String) -> Bool) {
        self.clients = clients; self.send = send; self.now = now; self.timeout = timeoutMilliseconds
    }
    /// Require an explicit video ID, including Douyin's modal share URLs.
    /// An ordinary feed without that ID is never inferred from the current tab.
    public static func pageIdentity(_ value: String) -> String? {
        guard value.utf8.count <= 4096, let url = URLComponents(string: value), url.scheme == "https",
              url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              let host = url.host?.lowercased(), host == "douyin.com" || host.hasSuffix(".douyin.com") else { return nil }
        let ids = (url.queryItems ?? []).filter { $0.name == "modal_id" }
        guard ids.count <= 1, ids.isEmpty || ids.first?.value?.range(of: "^[0-9]{1,32}$", options: .regularExpression) != nil else { return nil }
        if let match = url.path.range(of: "^/video/[0-9]{1,32}/?$", options: .regularExpression) {
            if let id = ids.first?.value, id != url.path.split(separator: "/").last.map(String.init) { return nil }
            return "https://www.douyin.com/" + String(url.path[match]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        guard !url.path.hasPrefix("/video/"), ids.count == 1, let id = ids.first?.value,
              id.range(of: "^[0-9]{1,32}$", options: .regularExpression) != nil else { return nil }
        return "https://www.douyin.com/video/" + id
    }
    private static func bounded(_ value: String, _ length: Int) -> Bool {
        value.utf8.count <= length && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
    private static func valid(_ source: Source) -> Bool {
        UUID(uuidString: source.sourceID) != nil && pageIdentity(source.pageURL) != nil
        && bounded(source.title, 1024) && bounded(source.browser, 32) && source.tabId >= 0
        && !source.documentID.isEmpty && bounded(source.documentID, 128)
        && (1...6).contains(source.items.count)
        && Set(source.items.map(\.mediaKey)).count == source.items.count
        && source.items.allSatisfy { item in
            (16...128).contains(item.mediaKey.utf8.count)
            && item.mediaKey.range(of: "^[a-zA-Z0-9:_-]+$", options: .regularExpression) != nil
            && bounded(item.title, 512) && bounded(item.meta, 256) && bounded(item.badge, 64)
            && item.kind == "video" && bounded(item.quality, 128)
        }
    }
    public static func parseResponse(_ raw: String) -> Response? {
        guard raw.hasPrefix(responsePrefix), raw.utf8.count <= BridgeConstants.maxMessageBytes,
              let data = raw.dropFirst(responsePrefix.count).data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = try? JSONDecoder().decode(Response.self, from: data), UUID(uuidString: value.requestId) != nil,
              ["discover", "prepare"].contains(value.op) else { return nil }
        if let error = value.error {
            guard Set(object.keys).isSubset(of: ["requestId", "op", "error"]), Failure(rawValue: error) != nil else { return nil }
        } else if value.op == "discover" {
            guard Set(object.keys) == ["requestId", "op", "sources"], let sources = value.sources,
                  sources.count <= 16, sources.allSatisfy(valid) else { return nil }
            // Metadata envelopes cannot smuggle URLs/credentials through extra
            // properties that Decodable would otherwise silently ignore.
            guard let rows = object["sources"] as? [[String: Any]], rows.allSatisfy({ row in
                Set(row.keys) == ["sourceID", "pageURL", "title", "browser", "incognito", "tabId", "documentID", "items"]
                && (row["items"] as? [[String: Any]])?.allSatisfy { Set($0.keys) == ["mediaKey", "title", "meta", "badge", "kind", "quality"] } == true
            }) else { return nil }
        } else {
            guard Set(object.keys) == ["requestId", "op", "sourceID", "mediaKey", "pageURL", "payload"],
                  let sourceID = value.sourceID, UUID(uuidString: sourceID) != nil,
                  value.mediaKey != nil, value.pageURL != nil, value.payload != nil else { return nil }
        }
        return value
    }
    public func discover(pageURL: String) async throws -> [Summary] {
        guard let page = Self.pageIdentity(pageURL) else { throw Failure.invalid }
        prune()
        guard discoveries.count + preparations.count < 16 else { throw Failure.busy }
        let connected = Set(clients())
        guard !connected.isEmpty else { throw Failure.unsupported }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            discoveries[id] = Discovery(pageURL: page, clients: connected, summaries: [], continuation: continuation)
            for client in connected {
                if !send(client, encode(["requestId": id, "op": "discover", "pageURL": page])) {
                    discoveries[id]?.clients.remove(client)
                }
            }
            if discoveries[id]?.clients.isEmpty == true { finishDiscovery(id, timedOut: false) }
            scheduleExpiry(id)
        }
    }
    public func prepare(sourceToken: String, mediaKey: String, pageURL: String) async throws -> ParsedBridgeMessage {
        prune()
        guard let binding = bindings[sourceToken], clients().contains(binding.clientID),
              Self.pageIdentity(pageURL) == Self.pageIdentity(binding.source.pageURL),
              binding.source.items.contains(where: { $0.mediaKey == mediaKey }) else { throw Failure.navigation }
        guard discoveries.count + preparations.count < 16 else { throw Failure.busy }
        let id = UUID().uuidString
        return try await withCheckedThrowingContinuation { continuation in
            preparations[id] = Preparation(binding: binding, mediaKey: mediaKey, continuation: continuation)
            if !send(binding.clientID, encode(["requestId": id, "op": "prepare", "pageURL": binding.source.pageURL,
                                               "sourceID": binding.source.sourceID, "mediaKey": mediaKey])) {
                preparations.removeValue(forKey: id)?.continuation.resume(throwing: Failure.navigation)
            }
            scheduleExpiry(id)
        }
    }
    public func receive(clientID: String, response: Response) {
        if response.op == "discover", var pending = discoveries[response.requestId], pending.clients.remove(clientID) != nil {
            if response.error == nil {
                for source in response.sources ?? [] where Self.pageIdentity(source.pageURL) == pending.pageURL {
                    guard bindings.count < 64 else { break }
                    let token = UUID().uuidString
                    bindings[token] = Binding(clientID: clientID, source: source, expires: now().addingTimeInterval(120))
                    pending.summaries.append(Summary(sourceToken: token, pageURL: source.pageURL, title: source.title,
                                                     browser: source.browser, incognito: source.incognito, items: source.items))
                }
            }
            discoveries[response.requestId] = pending
            if pending.clients.isEmpty { finishDiscovery(response.requestId, timedOut: false) }
        } else if response.op == "prepare", let pending = preparations[response.requestId], pending.binding.clientID == clientID {
            if let error = response.error {
                preparations.removeValue(forKey: response.requestId)?.continuation.resume(throwing: Failure(rawValue: error) ?? .invalid)
                return
            }
            guard response.sourceID == pending.binding.source.sourceID, response.mediaKey == pending.mediaKey,
                  response.pageURL == pending.binding.source.pageURL else { return }
            preparations[response.requestId] = nil
            do {
                let message = try Self.preparedMessage(response.payload ?? "", pageURL: pending.binding.source.pageURL)
                pending.continuation.resume(returning: message)
            } catch { pending.continuation.resume(throwing: Failure.invalid) }
        }
    }
    public static func preparedMessage(_ payload: String, pageURL: String) throws -> ParsedBridgeMessage {
        var message = try BridgeMessageParser.parse(payload)
        guard pageIdentity(pageURL) != nil, pageIdentity(message.pageURL) == pageIdentity(pageURL),
              let resource = URLComponents(string: message.url), ["https", "http"].contains(resource.scheme ?? ""),
              resource.host != nil, resource.user == nil, resource.password == nil,
              pageIdentity(message.url) == nil, message.method == "GET", message.postData == nil,
              message.alternateURL.isEmpty, ["normal", "media", "video", "hls", "m3u8"].contains(message.ltype.lowercased()),
              !message.filename.contains("://"), !message.filename.hasPrefix("//"),
              !message.url.contains("\n"), !message.url.contains("\r") else { throw Failure.invalid }
        // This path needs resource-scoped headers only. A full browser session
        // jar is unnecessary for an already captured resource and is discarded.
        message.sessionCookies = ""; message.sessionID = ""; message.sessionBrowser = ""
        return message
    }
    public func disconnected(_ clientID: String) {
        bindings = bindings.filter { $0.value.clientID != clientID }
        for id in Array(preparations.keys) where preparations[id]?.binding.clientID == clientID {
            preparations.removeValue(forKey: id)?.continuation.resume(throwing: Failure.navigation)
        }
        for id in Array(discoveries.keys) {
            discoveries[id]?.clients.remove(clientID)
            if discoveries[id]?.clients.isEmpty == true { finishDiscovery(id, timedOut: false) }
        }
    }
    private func prune() { bindings = bindings.filter { $0.value.expires > now() } }
    private func encode(_ value: [String: String]) -> String {
        Self.requestPrefix + String(decoding: try! JSONEncoder().encode(value), as: UTF8.self)
    }
    private func scheduleExpiry(_ id: String) {
        Task { try? await Task.sleep(nanoseconds: timeout * 1_000_000); expire(id) }
    }
    private func expire(_ id: String) {
        finishDiscovery(id, timedOut: true)
        preparations.removeValue(forKey: id)?.continuation.resume(throwing: Failure.timeout)
    }
    private func finishDiscovery(_ id: String, timedOut: Bool) {
        guard let value = discoveries.removeValue(forKey: id) else { return }
        if value.summaries.isEmpty { value.continuation.resume(throwing: timedOut ? Failure.timeout : Failure.unavailable) }
        else { value.continuation.resume(returning: value.summaries) }
    }
}
