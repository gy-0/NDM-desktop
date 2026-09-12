import Foundation
import NDMCore

/// The extension knows the active browser profile; a browser name alone does
/// not. Keep that explicit handoff in memory and lease a scoped cookie file
/// only for the lifetime of each media-tool invocation.
public final class RelayMediaSessionStore: @unchecked Sendable {
    public static let shared = RelayMediaSessionStore()
    private struct Record {
        let id: String
        let url: String
        let browser: String
        let cookies: Data
        let expiresAt: Date
    }
    public struct Lease: Sendable {
        public let source: YtDlpCookieSource?
        private let directory: URL?
        init(source: YtDlpCookieSource?, directory: URL? = nil) {
            self.source = source
            self.directory = directory
        }
        public func close() {
            if let directory { try? FileManager.default.removeItem(at: directory) }
        }
    }
    private let lock = NSLock()
    private var records: [String: Record] = [:]
    public typealias RefreshHandler = @Sendable (String, String) async -> String?
    private var refreshHandler: RefreshHandler?
    public enum Failure: Error, LocalizedError {
        case unavailable
        public var errorDescription: String? {
            L10n.t("Browser connection unavailable. Send this download again from the source page.",
                "浏览器连接已断开，请从来源网页重新发送下载。")
        }
    }
    private let lifetime: TimeInterval
    private let capacity: Int

    public init(lifetime: TimeInterval = 30 * 60, capacity: Int = 64) {
        self.lifetime = lifetime
        self.capacity = max(1, capacity)
    }

    @discardableResult
    public func remember(url: String, browser: String, encodedCookies: String, sessionID: String = UUID().uuidString, now: Date = Date()) -> YtDlpCookieSource? {
        guard BridgeDurableProtocol.validRequestID(sessionID),
              let browser = try? MediaSessionSelection.browser(from: browser),
              let key = Self.normalizedURL(url),
              let cookies = Self.scopedCookies(encodedCookies, url: key, now: now) else { return nil }
        let record = Record(id: sessionID, url: key, browser: browser,
            cookies: cookies, expiresAt: now.addingTimeInterval(lifetime))
        lock.lock()
        defer { lock.unlock() }
        records = records.filter { $0.value.expiresAt > now }
        // Replace only this exact page/browser selection; unrelated pending
        // downloads retain their own session until its bounded expiry.
        if records.count >= capacity, let oldest = records.values.min(by: { $0.expiresAt < $1.expiresAt }) {
            records[oldest.id] = nil
        }
        records[record.id] = record
        return .relay(browser: browser, sessionID: record.id, pageURL: key)
    }

    public func source(for url: String, sessionID: String, browser: String? = nil) throws -> YtDlpCookieSource {
        guard BridgeDurableProtocol.validRequestID(sessionID), let key = Self.normalizedURL(url) else { throw Failure.unavailable }
        lock.lock()
        let record = records[sessionID]
        lock.unlock()
        if let record {
            guard record.url == key && (browser == nil || record.browser == browser) else { throw Failure.unavailable }
            return .relay(browser: record.browser, sessionID: sessionID, pageURL: key)
        }
        guard let browser, (try? MediaSessionSelection.browser(from: browser)) != nil else { throw Failure.unavailable }
        return .relay(browser: browser, sessionID: sessionID, pageURL: key)
    }

    public func setRefreshHandler(_ handler: @escaping RefreshHandler) {
        lock.lock(); defer { lock.unlock() }
        refreshHandler = handler
    }

    private func currentRefreshHandler() -> RefreshHandler? {
        lock.lock(); defer { lock.unlock() }
        return refreshHandler
    }

    public func refresh(_ source: YtDlpCookieSource?, allowCachedAnonymous: Bool = false) async throws {
        guard case .relay(let browser, let id, let pageURL) = source else { return }
        guard let refresh = currentRefreshHandler(),
              let encoded = await refresh(id, pageURL),
              remember(url: pageURL, browser: browser, encodedCookies: encoded, sessionID: id) != nil else {
            // An explicit empty handoff can still resolve public media when
            // a browser cookie API is unavailable. Never reuse cached login
            // credentials, or guess an account for an unknown token.
            if allowCachedAnonymous && isCachedAnonymous(source) { return }
            throw Failure.unavailable
        }
    }

    private func isCachedAnonymous(_ source: YtDlpCookieSource?) -> Bool {
        guard case .relay(let browser, let id, let pageURL) = source else { return false }
        lock.lock(); defer { lock.unlock() }
        guard let record = records[id], record.browser == browser, record.url == Self.normalizedURL(pageURL),
              record.expiresAt > Date() else { return false }
        return record.cookies == Data("# Netscape HTTP Cookie File\n".utf8)
    }

    public func refreshedLease(_ source: YtDlpCookieSource?) async throws -> Lease {
        do { return try lease(source) }
        catch Failure.unavailable {
            try await refresh(source)
            return try lease(source)
        }
    }

    public func lease(_ source: YtDlpCookieSource?, now: Date = Date()) throws -> Lease {
        guard case .relay(let browser, let id, let pageURL) = source else { return Lease(source: source) }
        lock.lock()
        let record = records[id].flatMap { $0.expiresAt > now && $0.browser == browser && $0.url == Self.normalizedURL(pageURL) ? $0 : nil }
        lock.unlock()
        // Never silently change accounts by falling back to a default profile.
        // The async caller refreshes through the extension that issued this ID.
        guard let record else { throw Failure.unavailable }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-media-session-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
            let file = directory.appendingPathComponent("cookies.txt")
            try record.cookies.write(to: file, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            return Lease(source: .file(file.path), directory: directory)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    static func normalizedURL(_ raw: String) -> String? {
        guard var url = URLComponents(string: raw),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return nil }
        url.scheme = url.scheme?.lowercased()
        url.host = url.host?.lowercased()
        url.fragment = nil
        return url.string
    }

    static func scopedCookies(_ encoded: String, url: String, now: Date) -> Data? {
        guard encoded.utf8.count <= 90_000,
              let data = Data(base64Encoded: encoded), data.count <= 64 * 1024,
              let text = String(data: data, encoding: .utf8),
              text.hasPrefix("# Netscape HTTP Cookie File"),
              let target = URLComponents(string: url), let host = target.host?.lowercased() else { return nil }
        var output = ["# Netscape HTTP Cookie File"]
        for raw in text.components(separatedBy: .newlines) {
            let httpOnly = raw.hasPrefix("#HttpOnly_")
            if raw.isEmpty || (raw.hasPrefix("#") && !httpOnly) { continue }
            guard output.count <= 256, raw.utf8.count <= 8192 else { return nil }
            let line = httpOnly ? String(raw.dropFirst("#HttpOnly_".count)) : raw
            let fields = line.components(separatedBy: "\t")
            guard fields.count == 7,
                  ["TRUE", "FALSE"].contains(fields[1]), ["TRUE", "FALSE"].contains(fields[3]),
                  fields[2].hasPrefix("/"), let expiry = Int64(fields[4]), expiry >= 0,
                  expiry == 0 || Double(expiry) > now.timeIntervalSince1970,
                  !fields[5].isEmpty, !fields[5].contains(";"), !fields[5].contains("="),
                  !fields[5].contains(" "), !fields[6].contains("\0") else { continue }
            let domain = fields[0].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            guard !domain.isEmpty,
                  domain == host || (fields[1] == "TRUE" && domain.contains(".") && host.hasSuffix("." + domain)),
                  fields[3] != "TRUE" || target.scheme?.lowercased() == "https" else { continue }
            output.append(raw)
        }
        return (output.joined(separator: "\n") + "\n").data(using: .utf8)
    }
}
