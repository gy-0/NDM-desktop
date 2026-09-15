import Foundation
import Darwin
import NDMCore

public enum DouyinCookieError: Error, LocalizedError, Equatable {
    case exportFailed(String)

    public var errorDescription: String? {
        switch self {
        case .exportFailed(let detail):
            return L10n.t("Could not read the browser session: \(detail)",
                          "无法读取浏览器会话：\(detail)")
        }
    }
}

/// Browser rows retain their request scope until the API URL is known.
struct DouyinCookieJar: Sendable {
    struct Entry: Sendable {
        let domain: String
        let subdomains: Bool
        let path: String
        let secure: Bool
        let name: String
        let value: String
    }
    let entries: [Entry]
    var isEmpty: Bool { entries.isEmpty }

    init(_ content: String, now: Date = Date()) {
        entries = content.components(separatedBy: .newlines).compactMap { raw in
            let line = raw.hasPrefix("#HttpOnly_") ? String(raw.dropFirst(10)) : raw
            guard !line.hasPrefix("#") else { return nil }
            let fields = line.components(separatedBy: "\t")
            guard fields.count == 7,
                  ["TRUE", "FALSE"].contains(fields[1]), ["TRUE", "FALSE"].contains(fields[3]),
                  fields[2].hasPrefix("/"), let expiry = Int64(fields[4]), expiry >= 0,
                  expiry == 0 || Double(expiry) > now.timeIntervalSince1970,
                  !fields[5].isEmpty, !fields[5].contains(";"), !fields[5].contains("="),
                  !fields[5].contains(" "), !fields[6].contains("\0") else { return nil }
            let domain = fields[0].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            // No cookies from sister sites, login subdomains, or host-only
            // douyin.com rows can be sent to www.douyin.com.
            guard domain == "www.douyin.com" || (domain == "douyin.com" && fields[1] == "TRUE") else { return nil }
            return Entry(domain: domain, subdomains: fields[1] == "TRUE", path: fields[2],
                         secure: fields[3] == "TRUE", name: fields[5], value: fields[6])
        }
    }

    func matching(_ target: URL) -> [Entry] {
        let host = target.host?.lowercased() ?? ""
        let path = target.path.isEmpty ? "/" : target.path
        return entries.filter { row in
            let domainMatches = host == row.domain || (row.subdomains && host.hasSuffix("." + row.domain))
            let pathMatches = path == row.path || (path.hasPrefix(row.path)
                && (row.path.hasSuffix("/") || path.dropFirst(row.path.count).hasPrefix("/")))
            return domainMatches && pathMatches && (!row.secure || target.scheme?.lowercased() == "https")
        }.sorted { $0.path.count > $1.path.count }
    }

    func values(for target: URL) -> [String: String] {
        var values: [String: String] = [:]
        for row in matching(target) where values[row.name] == nil { values[row.name] = row.value }
        return values
    }

    func header(for target: URL) -> String {
        matching(target).map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }
}

/// Turns the engine's session sources into the cookie values a Douyin API
/// request needs. Douyin risk control rejects anonymous requests outright, so
/// an empty jar is treated as "no session" by the caller.
public enum DouyinCookieStore {
    static func jar(for source: YtDlpCookieSource?, now: Date = Date()) async throws -> DouyinCookieJar {
        // QA seam mirroring NDM_TOOL_DIR / NDM_SUPPORT_DIR: an isolated run can
        // point at a pre-exported jar instead of racing a live browser profile.
        if let override = ProcessInfo.processInfo.environment["NDM_DOUYIN_COOKIE_FILE"],
           !override.isEmpty {
            let content = try String(contentsOfFile: override, encoding: .utf8)
            return DouyinCookieJar(content, now: now)
        }
        guard let source else { return DouyinCookieJar("") }
        switch source {
        case .file(let path):
            let content = try String(contentsOfFile: path, encoding: .utf8)
            return DouyinCookieJar(content, now: now)
        case .browser(let browser):
            return try await exportBrowser(browser)
        case .relay:
            let lease = try await RelayMediaSessionStore.shared.refreshedLease(source)
            defer { lease.close() }
            guard case .file(let path)? = lease.source else { return DouyinCookieJar("") }
            let content = try String(contentsOfFile: path, encoding: .utf8)
            return DouyinCookieJar(content, now: now)
        }
    }

    static func parse(_ content: String, now: Date = Date(),
                      target: URL = URL(string: "https://www.douyin.com/aweme/v1/web/aweme/detail/")!) -> [String: String] {
        DouyinCookieJar(content, now: now).values(for: target)
    }

    /// Read only the requested profile. A retry must never select another
    /// profile: its login may belong to a different person.
    static func exportBrowser(_ browser: String, timeoutSeconds: TimeInterval = 25) async throws -> DouyinCookieJar {
        do {
            return try await exportOnce(browser, timeoutSeconds: timeoutSeconds)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try await Task.sleep(nanoseconds: 400_000_000)
            return try await exportOnce(browser, timeoutSeconds: timeoutSeconds)
        }
    }

    static func exportOnce(_ browser: String, timeoutSeconds: TimeInterval) async throws -> DouyinCookieJar {
        guard let binary = YtDlpTool.find() else {
            throw DouyinCookieError.exportFailed("yt-dlp not found")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        // yt-dlp exports the jar to a pipe, never a file containing other
        // websites' sessions. Only Douyin-scoped values survive parsing.
        process.arguments = YtDlpTool.executionArguments([
            "--ignore-config", "--no-cache-dir",
            "--cookies-from-browser", browser,
            "--cookies", "/dev/stdout", "--quiet", "--no-warnings",
            "--skip-download", "--", "ndm-cookie-export:",
        ])
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        try process.run()
        let output = Task.detached { outputPipe.fileHandleForReading.readDataToEndOfFile() }
        let errors = Task.detached { errorPipe.fileHandleForReading.readDataToEndOfFile() }
        defer {
            if process.isRunning {
                process.terminate()
                // A blocked helper must not survive a cancelled probe.
                DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                    if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
                }
            }
        }
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while process.isRunning && Date() < deadline {
            try await Task.sleep(nanoseconds: 120_000_000)
        }
        if process.isRunning {
            process.terminate()
            throw DouyinCookieError.exportFailed("读取浏览器会话超时")
        }
        let errorText = String(data: await errors.value, encoding: .utf8) ?? ""
        let content = String(data: await output.value, encoding: .utf8) ?? ""
        let values = DouyinCookieJar(content)
        if values.isEmpty, let failure = browserDataFailure(in: errorText) {
            throw DouyinCookieError.exportFailed(failure)
        }
        guard content.contains("# Netscape HTTP Cookie File") else {
            throw DouyinCookieError.exportFailed("未能读取所选浏览器资料的 Cookie")
        }
        return values
    }

    /// Detects yt-dlp messages that describe a browser-data access failure.
    static func browserDataFailure(in text: String) -> String? {
        let markers = [
            "could not copy", "cookie database", "cookies could not be loaded",
            "failed to decrypt", "permission denied", "database is locked",
            "keyring", "keychain", "dpapi", "secretstorage",
        ]
        let lowered = text.lowercased()
        guard markers.contains(where: { lowered.contains($0) }) else { return nil }
        return "浏览器资料暂不可读取，请确认所选资料及系统访问权限"
    }

}
