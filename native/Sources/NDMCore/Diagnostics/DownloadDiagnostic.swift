import Foundation

/// The follow-up a diagnostic recommends; UI uses it to pick button emphasis.
public enum DiagnosticAction: String, Sendable, Equatable {
    /// Re-fetch a fresh URL from the source page (expired signed links).
    case renew
    /// Plain retry is likely to succeed (transient network problems).
    case retry
    /// User must act in the browser first (sign in again), then retry.
    case openPage
    /// Informational only — nothing to do.
    case none
}

/// The truthful recovery gesture for one failed task. This deliberately
/// separates opening a page from manually replacing a URL: both may eventually
/// refresh authorization, but they ask very different things of the user.
public enum TaskRecoveryAction: String, Sendable, Equatable {
    case none
    case retry
    case renewURL
    case openSourcePage

    public static func make(from task: DownloadTask) -> TaskRecoveryAction {
        guard task.status == .error else { return .none }
        if task.browserRescueURL != nil { return .openSourcePage }
        guard let diagnostic = DownloadDiagnostic.fromStoredErrorText(task.errorText) else {
            return .retry
        }
        return diagnostic.primaryAction == .renew ? .renewURL : .retry
    }
}

/// A download failure translated into language a person can act on.
///
/// The engine layer classifies raw errors (`DownloadDiagnostic.classify` in
/// NDMEngine) and the manager persists `storageString` into `task.errorText`.
/// Presentation parses it back so the copy always renders in the *current*
/// UI language, and the raw protocol code stays available for power users.
public enum DownloadDiagnostic: Equatable, Sendable {
    /// 403 / 404 / 410 — signed or temporary URLs that stopped working.
    case linkExpired(status: Int)
    /// 401 / 407 — the site (or proxy) wants credentials again.
    case signInRequired(status: Int)
    /// 416 or a server that ignores Range — resume/multi-connection unavailable.
    case rangeNotSupported
    /// 429 — server-side rate limiting.
    case serverThrottled
    /// 5xx — the server is having a bad day; retrying later usually works.
    case serverError(status: Int)
    /// Any other unexpected HTTP status.
    case httpError(status: Int)
    /// No network route at all.
    case offline
    /// Connection timed out.
    case timeout
    /// Transfer started, then the connection dropped.
    case connectionLost
    /// TLS handshake / certificate trouble.
    case sslFailure
    /// Local disk is out of space.
    case diskFull
    /// Packaging failed after the pieces were already on disk.
    case mergeFailed(detail: String)
    /// The site refused the media bytes (yt-dlp “unable to download video data”).
    /// The page URL is typically still valid — retry re-extracts a fresh address.
    case mediaFetchFailed(status: Int)
    /// Unclassified failure; carries the original message.
    case generic(detail: String)

    // MARK: - Raw code (corner label for power users)

    /// Short technical label, e.g. `HTTP 403`, `timeout`. Never localized.
    public var rawLabel: String {
        switch self {
        case .linkExpired(let s), .signInRequired(let s),
             .serverError(let s), .httpError(let s):
            return "HTTP \(s)"
        case .rangeNotSupported: return "HTTP 416 / no Range"
        case .serverThrottled: return "HTTP 429"
        case .offline: return "offline"
        case .timeout: return "timeout"
        case .connectionLost: return "connection lost"
        case .sslFailure: return "TLS"
        case .diskFull: return "disk full"
        case .mergeFailed: return "package"
        case .mediaFetchFailed(let s): return "HTTP \(s)"
        case .generic: return "error"
        }
    }

    // MARK: - Human copy (design/NDM-Design-Suite.html §04 is the source of truth)

    /// One-line headline: what happened.
    public var title: String {
        switch self {
        case .linkExpired:
            return L10n.t("The download address is no longer valid", "下载地址已失效")
        case .signInRequired:
            return L10n.t("Sign-in required", "需要重新登录")
        case .rangeNotSupported:
            return L10n.t("This server does not support resumable downloads", "此服务器不支持分段下载")
        case .serverThrottled:
            return L10n.t("The server is limiting download rate", "服务器限制了下载频率")
        case .serverError:
            return L10n.t("The server is temporarily unavailable", "服务器暂时不可用")
        case .httpError(let s):
            return L10n.t("The request was refused (HTTP \(s))", "请求被拒绝（HTTP \(s)）")
        case .offline:
            return L10n.t("No network connection", "网络未连接")
        case .timeout:
            return L10n.t("The server timed out", "服务器响应超时")
        case .connectionLost:
            return L10n.t("The connection was interrupted", "连接已中断")
        case .sslFailure:
            return L10n.t("Could not establish a secure connection", "无法建立安全连接")
        case .diskFull:
            return L10n.t("Not enough disk space", "磁盘空间不足")
        case .mergeFailed:
            return L10n.t("Could not finish packaging", "视频封装未完成")
        case .mediaFetchFailed:
            return L10n.t("Could not retrieve the video", "未能获取视频数据")
        case .generic:
            return L10n.t("Download did not complete", "下载未完成")
        }
    }

    /// Why it happened + what to do next, in plain language.
    public var message: String {
        message(hasSavedData: true)
    }

    /// Context-aware long explanation. Recovery promises are strongest when
    /// they name what is actually on disk, not what a typical failed task might
    /// have downloaded.
    public func message(hasSavedData: Bool) -> String {
        switch self {
        case .linkExpired:
            if !hasSavedData {
                return L10n.t(
                    "The original address is no longer valid. Continue once from the source page; a fresh authorization attaches to this task instead of creating a duplicate.",
                    "原始地址已失效。请从来源页面继续一次，新的授权会接回此任务，不会创建重复记录。"
                )
            }
            return L10n.t(
                "The original address is no longer valid. Continue once from the source page; a fresh authorization attaches to this task and downloaded data is kept.",
                "原始地址已失效。请从来源页面继续一次，新的授权会接回此任务，已下载内容会保留。"
            )
        case .signInRequired:
            return L10n.t(
                "Sign in again in the browser, then continue once from the source page. The new session resumes this task instead of creating a duplicate.",
                "请在浏览器中重新登录，然后从来源页面继续一次。新的会话会接回此任务，不会创建重复记录。"
            )
        case .rangeNotSupported:
            return L10n.t(
                "This server does not accept resume requests, so multiple connections cannot be used. The transfer continues on a single connection at the rate the server allows.",
                "该服务器不接受断点续传，因此无法使用多连接。已改为单连接下载，速度取决于服务器。"
            )
        case .serverThrottled:
            return L10n.t(
                "The server reported too many requests. Waiting briefly before retrying usually clears it; lowering connections for this host can also help.",
                "服务器返回请求过于频繁。稍候重试通常即可恢复；也可降低该站点的连接数。"
            )
        case .serverError:
            return L10n.t(
                "This is a server-side fault and is usually temporary. Retry shortly.",
                "这是服务器端故障，通常是暂时性的。稍后重试即可。"
            )
        case .httpError:
            return L10n.t(
                "The link may be incorrect, region-restricted, or require additional permission. Opening the source page in a browser shows what the site expects.",
                "链接可能有误、受地区限制，或需要额外权限。可在浏览器中打开来源页面确认。"
            )
        case .offline:
            return L10n.t(
                "Check the network connection. The download resumes from the last saved byte once connectivity returns.",
                "请检查网络连接。恢复联网后，下载将从断点继续。"
            )
        case .timeout:
            return L10n.t(
                "The server did not respond in time. Retry; a proxy is often more stable for distant hosts.",
                "服务器未在时限内响应。可重试；访问远端站点时使用代理通常更稳定。"
            )
        case .connectionLost:
            return L10n.t(
                "The transfer was interrupted. Downloaded data is kept; retry resumes from the last byte written to disk.",
                "传输过程中连接中断。已下载内容会保留，重试将从断点继续。"
            )
        case .sslFailure:
            return L10n.t(
                "The server certificate could not be verified. Public Wi-Fi and proxy networks commonly cause this.",
                "无法验证服务器证书。公共 Wi-Fi 或代理网络常会导致此问题。"
            )
        case .diskFull:
            return L10n.t(
                "Free some disk space, or change the download folder in Settings, then retry. Completed data is kept.",
                "请清理磁盘空间，或在设置中更换下载目录后重试。已完成部分会保留。"
            )
        case .mergeFailed(let detail):
            let lead = L10n.t(
                "The tracks are on disk, but packaging did not produce the final file. They are kept; retry packages them again without re-downloading.",
                "音视频分轨已下载。封装未能生成最终文件，分轨已保留。重试将仅重新封装。"
            )
            return detail.isEmpty ? lead : "\(lead)\n\(detail)"
        case .mediaFetchFailed(let status):
            return L10n.t(
                "The site refused this media request (HTTP \(status)). Partial files are kept. Retry fetches a fresh address and continues.",
                "站点拒绝了本次媒体请求（HTTP \(status)）。已下载部分会保留。重试将重新获取地址并继续。"
            )
        case .generic(let detail):
            let lead = L10n.t(
                "The download did not complete. Retry is available; partial files are kept.",
                "下载未能完成。可重试，已下载部分会保留。"
            )
            return detail.isEmpty ? lead : "\(lead)\n\(detail)"
        }
    }

    /// Short inline summary for the task list row: headline + the next step.
    public var rowSummary: String {
        rowSummary(hasSavedData: true)
    }

    /// The list must not promise that partial data was preserved when the task
    /// has not actually written a byte yet. The full inspector message remains
    /// generally true; this compact line is the glanceable factual summary.
    public func rowSummary(hasSavedData: Bool) -> String {
        switch self {
        case .linkExpired:
            if hasSavedData {
                return L10n.t(
                    "Address expired · continue from the source page, saved data is kept",
                    "地址已失效 · 从来源页继续，已下载内容会保留"
                )
            }
            return L10n.t(
                "Address expired · continue this task from the source page",
                "地址已失效 · 从来源页继续此任务"
            )
        case .signInRequired:
            return L10n.t(
                "Sign-in expired · continue from the browser",
                "登录已失效 · 请在浏览器登录后继续"
            )
        case .rangeNotSupported:
            return L10n.t(
                "Resume unsupported · single connection only on this server",
                "不支持断点续传 · 该服务器仅能单连接下载"
            )
        case .serverThrottled:
            return L10n.t("Rate-limited by server · retry shortly", "服务器限流 · 稍候可重试")
        case .serverError:
            return L10n.t("Server unavailable · retry shortly", "服务器暂不可用 · 稍后可重试")
        case .httpError(let s):
            return L10n.t("Request refused (HTTP \(s)) · check the source page", "请求被拒绝 HTTP \(s) · 请来源页确认")
        case .offline:
            return L10n.t("No network · resumes automatically when back online", "网络未连接 · 恢复联网后自动续传")
        case .timeout:
            return L10n.t("Server timed out · retry", "服务器超时 · 可重试")
        case .connectionLost:
            return L10n.t("Connection interrupted · retry resumes from last byte", "连接已中断 · 重试将从断点继续")
        case .sslFailure:
            return L10n.t("Secure connection failed · check network or proxy", "安全连接失败 · 请检查网络或代理")
        case .diskFull:
            return L10n.t("Disk full · free space and retry", "磁盘空间不足 · 清理后可重试")
        case .mergeFailed:
            return L10n.t("Packaging incomplete · tracks kept, retry packages only", "封装未完成 · 分轨已保留，可重试封装")
        case .mediaFetchFailed:
            return L10n.t("Could not retrieve video · retry keeps partial files", "未能获取视频 · 可重试，已下载部分会保留")
        case .generic:
            return L10n.t("Download incomplete · retry available", "下载未完成 · 可重试")
        }
    }

    /// The follow-up this diagnostic recommends.
    public var primaryAction: DiagnosticAction {
        switch self {
        case .linkExpired: return .renew
        case .signInRequired: return .openPage
        case .serverThrottled, .serverError, .timeout, .connectionLost,
             .diskFull, .mergeFailed, .mediaFetchFailed, .generic:
            return .retry
        case .httpError: return .openPage
        case .rangeNotSupported, .offline, .sslFailure: return .none
        }
    }

    // MARK: - Classification helpers (protocol-level; error-object mapping lives in NDMEngine)

    public static func fromHTTPStatus(_ status: Int) -> DownloadDiagnostic {
        switch status {
        case 401, 407: return .signInRequired(status: status)
        case 403, 404, 410: return .linkExpired(status: status)
        case 416: return .rangeNotSupported
        case 429: return .serverThrottled
        case 500...599: return .serverError(status: status)
        default: return .httpError(status: status)
        }
    }

    public static func fromURLError(_ error: URLError) -> DownloadDiagnostic {
        switch error.code {
        case .notConnectedToInternet, .internationalRoamingOff, .dataNotAllowed:
            return .offline
        case .timedOut:
            return .timeout
        case .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed:
            return .connectionLost
        case .secureConnectionFailed, .serverCertificateUntrusted,
             .serverCertificateHasBadDate, .serverCertificateNotYetValid,
             .serverCertificateHasUnknownRoot, .clientCertificateRejected:
            return .sslFailure
        default:
            return .generic(detail: error.localizedDescription)
        }
    }

    public static func fromCocoaError(_ error: NSError) -> DownloadDiagnostic? {
        if error.domain == NSCocoaErrorDomain,
           error.code == NSFileWriteOutOfSpaceError || error.code == NSFileWriteVolumeReadOnlyError {
            return .diskFull
        }
        if error.domain == NSPOSIXErrorDomain, error.code == Int(ENOSPC) {
            return .diskFull
        }
        return nil
    }

    // MARK: - Persistence (stored in task.errorText; copy re-localizes at render time)

    private static let storagePrefix = "#diag:"

    public var storageString: String {
        let body: String
        switch self {
        case .linkExpired(let s): body = "linkExpired:\(s)"
        case .signInRequired(let s): body = "signInRequired:\(s)"
        case .rangeNotSupported: body = "rangeNotSupported"
        case .serverThrottled: body = "serverThrottled"
        case .serverError(let s): body = "serverError:\(s)"
        case .httpError(let s): body = "httpError:\(s)"
        case .offline: body = "offline"
        case .timeout: body = "timeout"
        case .connectionLost: body = "connectionLost"
        case .sslFailure: body = "sslFailure"
        case .diskFull: body = "diskFull"
        case .mergeFailed(let d): body = "mergeFailed|\(d)"
        case .mediaFetchFailed(let s): body = "mediaFetchFailed:\(s)"
        case .generic(let d): body = "generic|\(d)"
        }
        return Self.storagePrefix + body
    }

    public init?(storageString: String) {
        guard storageString.hasPrefix(Self.storagePrefix) else { return nil }
        let body = String(storageString.dropFirst(Self.storagePrefix.count))
        let detailSplit = body.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false)
        let head = String(detailSplit[0])
        let detail = detailSplit.count > 1 ? String(detailSplit[1]) : ""
        let parts = head.split(separator: ":", maxSplits: 1)
        let kind = parts.first.map(String.init) ?? ""
        let code = parts.count > 1 ? Int(parts[1]) : nil

        switch kind {
        case "linkExpired": self = .linkExpired(status: code ?? 403)
        case "signInRequired": self = .signInRequired(status: code ?? 401)
        case "rangeNotSupported": self = .rangeNotSupported
        case "serverThrottled": self = .serverThrottled
        case "serverError": self = .serverError(status: code ?? 500)
        case "httpError": self = .httpError(status: code ?? 0)
        case "offline": self = .offline
        case "timeout": self = .timeout
        case "connectionLost": self = .connectionLost
        case "sslFailure": self = .sslFailure
        case "diskFull": self = .diskFull
        case "mergeFailed": self = .mergeFailed(detail: detail)
        case "mediaFetchFailed": self = .mediaFetchFailed(status: code ?? 403)
        case "generic": self = .generic(detail: detail)
        default: return nil
        }
    }

    /// Parse persisted `task.errorText`. Returns nil for legacy plain-text errors.
    ///
    /// Earlier builds stored every yt-dlp failure as `mergeFailed`. Re-read the
    /// carried message so a 403 during fetch is not presented as a packaging
    /// failure after the app updates.
    public static func fromStoredErrorText(_ text: String?) -> DownloadDiagnostic? {
        guard let text else { return nil }
        guard let stored = DownloadDiagnostic(storageString: text) else { return nil }
        if case .mergeFailed(let detail) = stored {
            return classifyEngineMessage(detail)
        }
        return stored
    }

    /// Map a downloader / muxer stderr line (often carried on
    /// `EngineError.mergeFailed`) onto the diagnostic the UI should show.
    public static func classifyEngineMessage(_ message: String) -> DownloadDiagnostic {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()
        if looksLikeMuxFailure(lowered) {
            return .mergeFailed(detail: trimmed)
        }
        if let status = httpStatus(in: trimmed) {
            if looksLikeMediaFetchFailure(lowered) || (403...410).contains(status) {
                switch status {
                case 401, 407:
                    return .signInRequired(status: status)
                case 429:
                    return .serverThrottled
                case 500...599:
                    return .serverError(status: status)
                case 403, 404, 410:
                    return .mediaFetchFailed(status: status)
                default:
                    return fromHTTPStatus(status)
                }
            }
            return fromHTTPStatus(status)
        }
        if looksLikeResolverNoise(lowered) {
            return .generic(detail: trimmed)
        }
        return .generic(detail: trimmed)
    }

    private static func httpStatus(in message: String) -> Int? {
        let patterns = [
            #"HTTP Error (\d{3})"#,
            #"HTTP (\d{3})"#,
        ]
        for pattern in patterns {
            guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive),
                  let match = regex.firstMatch(in: message, range: NSRange(message.startIndex..., in: message)),
                  match.numberOfRanges >= 2,
                  let range = Range(match.range(at: 1), in: message),
                  let code = Int(message[range]),
                  (400...599).contains(code) else {
                continue
            }
            return code
        }
        return nil
    }

    private static func looksLikeMuxFailure(_ lowered: String) -> Bool {
        let markers = [
            "ffmpeg", "mkvmerge", "merger", "merging", "mux", "remux",
            "assemble", "concat", "封装", "合并",
            "failed on merging",
            "could not inspect downloaded media",
            "could not read media duration",
            "media component",
            "could not create the media process log",
            "error opening output",
            "error muxing",
            "could not write header",
            "invalid data found when processing input",
            "matches no streams",
        ]
        return markers.contains { lowered.contains($0) }
    }

    private static func looksLikeMediaFetchFailure(_ lowered: String) -> Bool {
        lowered.contains("unable to download")
            || lowered.contains("http error")
            || lowered.contains("got http")
    }

    private static func looksLikeResolverNoise(_ lowered: String) -> Bool {
        lowered.contains("yt-dlp")
            || lowered.contains("no usable video info")
            || lowered.contains("no usable collection info")
            || lowered.contains("aria2c exited")
            || lowered.contains("no file appeared")
            || lowered.contains("parsing timed out")
    }
}

public extension DownloadTask {
    /// Source page that can mint a fresh browser-authorized media URL for this
    /// failed direct task. Page-level yt-dlp tasks retry their own stable URL
    /// and therefore do not use browser handoff here.
    var browserRescueURL: URL? {
        guard status == .error,
              linkType.lowercased() != "ytdlp",
              let diagnostic = DownloadDiagnostic.fromStoredErrorText(errorText) else {
            return nil
        }
        switch diagnostic {
        case .linkExpired, .signInRequired, .httpError:
            break
        default:
            return nil
        }
        guard let pageURL,
              let url = URL(string: pageURL),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }
}
