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
    /// A local destination already exists; never overwrite it silently.
    case fileAlreadyExists
    /// Remote representation or local ownership no longer matches the saved record.
    case downloadRecordChanged
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
        case .downloadRecordChanged: return "download record changed"
        case .fileAlreadyExists: return "EEXIST"
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
        case .downloadRecordChanged:
            return L10n.t("Download record changed", "下载记录已变化")
        case .fileAlreadyExists:
            return L10n.t("A file with this name already exists", "保存位置已有同名文件")
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

    /// Concise recovery guidance. Raw details remain in the stored diagnostic.
    public func message(hasSavedData: Bool) -> String {
        switch self {
        case .linkExpired:
            return L10n.t("Open the source page and click download again.", "请打开来源页面，重新点击下载。")
        case .signInRequired:
            return L10n.t("Sign in on the source website, then download again.", "请在来源网站登录后重新下载。")
        case .rangeNotSupported:
            return L10n.t("This server does not support resuming. Please download the file again.", "服务器不支持断点续传，请重新下载。")
        case .serverThrottled:
            return L10n.t("Please try again later, or reduce the number of connections.", "请稍后重试，或减少下载连接数。")
        case .serverError:
            return L10n.t("Please try again later.", "请稍后重试。")
        case .httpError:
            return L10n.t("Open the source page to check whether the file is available.", "请打开来源页面，确认文件是否可下载。")
        case .offline:
            return L10n.t("Check your network connection, then try again.", "请连接网络后重试。")
        case .timeout:
            return L10n.t("Check your network connection, then try again.", "请检查网络连接后重试。")
        case .connectionLost:
            return L10n.t("Check your network connection, then try again.", "请检查网络连接后重试。")
        case .sslFailure:
            return L10n.t("Check your system time and network settings, then try again.", "请检查系统时间和网络设置后重试。")
        case .downloadRecordChanged:
            return L10n.t("The source file or local download record has changed. It is not safe to resume. Please download again.", "源文件或本地下载记录已变化，请重新下载。")
        case .fileAlreadyExists:
            return L10n.t("Retry to replace the existing file after the download completes.", "重试将在下载完成后替换现有文件。")
        case .diskFull:
            return L10n.t("Free some disk space, then try again.", "请清理磁盘空间后重试。")
        case .mergeFailed:
            return L10n.t("Please try again to finish processing the video.", "请重试以完成视频处理。")
        case .mediaFetchFailed:
            return L10n.t("Please try again. If it still fails, open the source page.", "请重试。若仍失败，请打开来源页面。")
        case .generic:
            return L10n.t("Please try again. If it still fails, check your network and save location.", "请重试。若仍失败，请检查网络和保存位置。")
        }
    }

    /// Short inline summary for the task list row: headline + the next step.
    public var rowSummary: String {
        rowSummary(hasSavedData: true)
    }

    /// A compact reason and next step, without assumptions about saved data.
    public func rowSummary(hasSavedData: Bool) -> String {
        switch self {
        case .linkExpired:
            return L10n.t("Address expired · open source page", "地址已失效 · 请打开来源页面")
        case .signInRequired:
            return L10n.t("Sign-in required · open source page", "需要登录 · 请打开来源页面")
        case .rangeNotSupported:
            return L10n.t("Resume unsupported · download again", "不支持断点续传 · 请重新下载")
        case .serverThrottled:
            return L10n.t("Too many requests · try again later", "请求过于频繁 · 请稍后重试")
        case .serverError:
            return L10n.t("Server unavailable · try again later", "服务器暂不可用 · 请稍后重试")
        case .httpError:
            return L10n.t("Request failed · check source page", "请求失败 · 请查看来源页面")
        case .offline:
            return L10n.t("No network · check connection", "网络未连接 · 请检查网络")
        case .timeout:
            return L10n.t("Connection timed out · try again", "连接超时 · 请重试")
        case .connectionLost:
            return L10n.t("Connection interrupted · try again", "连接中断 · 请重试")
        case .sslFailure:
            return L10n.t("Secure connection failed · check settings", "安全连接失败 · 请检查网络设置")
        case .downloadRecordChanged:
            return L10n.t("Download record changed · download again", "下载记录已变化 · 请重新下载")
        case .fileAlreadyExists:
            return L10n.t("File already exists · download again", "同名文件已存在 · 可重新下载")
        case .diskFull:
            return L10n.t("Disk full · free space and retry", "磁盘空间不足 · 请清理后重试")
        case .mergeFailed:
            return L10n.t("Video processing incomplete · try again", "视频处理未完成 · 请重试")
        case .mediaFetchFailed:
            return L10n.t("Could not retrieve video · try again", "未能获取视频 · 请重试")
        case .generic:
            return L10n.t("Download incomplete · try again", "下载未完成 · 请重试")
        }
    }

    /// The follow-up this diagnostic recommends.
    public var primaryAction: DiagnosticAction {
        switch self {
        case .linkExpired: return .renew
        case .signInRequired: return .openPage
        case .serverThrottled, .serverError, .timeout, .connectionLost,
             .diskFull, .fileAlreadyExists, .downloadRecordChanged, .mergeFailed, .mediaFetchFailed, .generic:
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
        if (error.domain == NSPOSIXErrorDomain && error.code == Int(EEXIST))
            || (error.domain == NSCocoaErrorDomain && error.code == NSFileWriteFileExistsError) {
            return .fileAlreadyExists
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
        case .downloadRecordChanged: body = "downloadRecordChanged"
        case .fileAlreadyExists: body = "fileAlreadyExists"
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
        case "downloadRecordChanged": self = .downloadRecordChanged
        case "fileAlreadyExists": self = .fileAlreadyExists
        case "diskFull": self = .diskFull
        case "mergeFailed": self = .mergeFailed(detail: detail)
        case "mediaFetchFailed": self = .mediaFetchFailed(status: code ?? 403)
        case "generic": self = detail.hasSuffix("File exists") ? .fileAlreadyExists : .generic(detail: detail)
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
