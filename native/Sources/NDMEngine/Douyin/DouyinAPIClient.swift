// Adapted and modified from MIT-licensed douyin-downloader.
// Pinned upstream references and full license: licenses/douyin/NOTICE.md.
import Foundation
import NDMCore

public enum DouyinClientError: Error, LocalizedError, Equatable {
    /// No cookies were available, or the site explicitly demanded a login.
    case sessionRequired
    case requestRejected(statusCode: Int)
    case api(statusCode: Int, message: String?)
    case invalidResponse
    case notFound
    case unsupportedLink

    public var errorDescription: String? {
        switch self {
        case .sessionRequired:
            return L10n.t("Douyin requires a signed-in browser session for this link.",
                          "抖音要求浏览器登录会话才能访问这个链接。")
        case .requestRejected(let statusCode):
            return L10n.t("Douyin rejected the request (HTTP \(statusCode)). Open the video in the selected browser and use NDM Relay to download it.",
                          "已读取浏览器会话，但抖音拒绝了此请求（HTTP \(statusCode)）。请在所选浏览器中打开视频，使用 NDM Relay 下载。")
        case .api(let statusCode, let message):
            if let message, !message.isEmpty {
                return L10n.t("Douyin returned an error (\(statusCode)): \(message)",
                              "抖音接口返回错误（\(statusCode)）：\(message)")
            }
            return L10n.t("Douyin returned an error (\(statusCode))", "抖音接口返回错误（\(statusCode)）")
        case .invalidResponse:
            return L10n.t("Douyin returned an unreadable response.", "抖音返回了无法解析的数据。")
        case .notFound:
            return L10n.t("This Douyin item is not available.", "这个抖音内容不可用。")
        case .unsupportedLink:
            return L10n.t("This Douyin link type is not supported yet.", "暂不支持这种抖音链接。")
        }
    }
}

/// Minimal web API client for `www.douyin.com`. Every request carries the
/// browser cookie jar, the signed default query and the same User-Agent the
/// signature was computed over.
struct DouyinAPIClient {
    static let baseURL = "https://www.douyin.com"
    /// `aid=6383` exposes notes and galleries; `1128` recovers some videos.
    static let detailAIDs = ["6383", "1128"]

    let cookies: DouyinCookieJar
    let userAgent: String
    let fingerprint: String
    private let session: URLSession

    init(cookies: DouyinCookieJar, userAgent: String = DouyinAccess.userAgent,
         fingerprint: String = DouyinABogus.fingerprint()) {
        self.cookies = cookies
        self.userAgent = userAgent
        self.fingerprint = fingerprint
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        configuration.timeoutIntervalForResource = 40
        HTTPRedirectPolicy.configure(configuration)
        self.session = URLSession(configuration: configuration, delegate: DouyinAPIRedirectPolicy(), delegateQueue: nil)
    }

    var hasSession: Bool { !cookies.isEmpty }

    func detail(awemeID: String) async throws -> [String: Any] {
        for aid in Self.detailAIDs {
            let response = try await requestJSON(
                path: "/aweme/v1/web/aweme/detail/",
                overrides: ["aweme_id": awemeID, "aid": aid]
            )
            if let detail = response["aweme_detail"] as? [String: Any], !detail.isEmpty {
                return detail
            }
            if response["filter_detail"] != nil { continue }
            if let code = response["status_code"] as? Int, code != 0 { continue }
        }
        throw DouyinClientError.notFound
    }

    // MARK: - Paged endpoints

    func userPostPage(secUID: String, cursor: Int, count: Int) async throws -> [String: Any] {
        try await requestJSON(
            path: "/aweme/v1/web/aweme/post/",
            overrides: [
                "sec_user_id": secUID,
                "max_cursor": String(cursor),
                "count": String(count),
                "locate_query": "false",
                "show_live_replay_strategy": "1",
                "need_time_list": "1",
                "time_list_query": "0",
                "whale_cut_token": "",
                "cut_version": "1",
                "publish_video_strategy_type": "2",
            ]
        )
    }

    func userInfo(secUID: String) async throws -> [String: Any] {
        try await requestJSON(
            path: "/aweme/v1/web/user/profile/other/",
            overrides: ["sec_user_id": secUID]
        )
    }

    func mixDetail(mixID: String) async throws -> [String: Any] {
        try await requestJSON(path: "/aweme/v1/web/mix/detail/", overrides: ["mix_id": mixID])
    }

    func mixAwemePage(mixID: String, cursor: Int, count: Int) async throws -> [String: Any] {
        try await requestJSON(
            path: "/aweme/v1/web/mix/aweme/",
            overrides: ["mix_id": mixID, "cursor": String(cursor), "count": String(count)]
        )
    }

    func musicDetail(musicID: String) async throws -> [String: Any] {
        try await requestJSON(path: "/aweme/v1/web/music/detail/", overrides: ["music_id": musicID])
    }

    // MARK: - Transport

    func requestJSON(
        path: String,
        overrides: [String: String] = [:],
        body: String? = nil
    ) async throws -> [String: Any] {
        guard hasSession else { throw DouyinClientError.sessionRequired }
        guard let target = URL(string: Self.baseURL + path) else { throw DouyinClientError.invalidResponse }
        var query = defaultQuery(for: target)
        for (key, value) in overrides {
            if let index = query.firstIndex(where: { $0.0 == key }) {
                query[index].1 = value
            } else {
                query.append((key, value))
            }
        }
        let params = query.map { "\(Self.formEncode($0.0))=\(Self.formEncode($0.1))" }.joined(separator: "&")
        let signed = DouyinABogus.sign(
            params: params,
            body: body ?? "",
            userAgent: userAgent,
            fingerprint: fingerprint
        )
        guard let url = URL(string: Self.baseURL + path + "?" + signed.signedParams) else {
            throw DouyinClientError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = body == nil ? "GET" : "POST"
        if let body {
            request.httpBody = Data(body.utf8)
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("https://www.douyin.com/?recommend=1", forHTTPHeaderField: "Referer")
        request.setValue("*/*", forHTTPHeaderField: "Accept")
        request.setValue("zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7", forHTTPHeaderField: "Accept-Language")
        request.setValue(cookies.header(for: url), forHTTPHeaderField: "Cookie")

        let delays: [UInt64] = [0, 1_000_000_000, 2_000_000_000]
        var lastError: DouyinClientError = .invalidResponse
        for (attempt, delay) in delays.enumerated() {
            if delay > 0 { try await Task.sleep(nanoseconds: delay) }
            do {
                let (data, response) = try await session.data(for: request)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                do {
                    return try Self.responseJSON(data: data, status: status)
                } catch let error as DouyinClientError {
                    // Bounded retries for transient rejection; neither HTTP
                    // rejection nor an empty response means cookies are absent.
                    if case .requestRejected = error {
                        lastError = error
                        continue
                    }
                    throw error
                }
            } catch let error as DouyinClientError {
                throw error
            } catch {
                lastError = .invalidResponse
                if attempt == delays.count - 1 { throw error }
            }
        }
        throw lastError
    }

    static func responseJSON(data: Data, status: Int) throws -> [String: Any] {
        if status == 403 || status == 429 || ((200..<300).contains(status) && data.isEmpty) {
            throw DouyinClientError.requestRejected(statusCode: status)
        }
        guard (200..<300).contains(status) else {
            throw DouyinClientError.api(statusCode: status, message: nil)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DouyinClientError.invalidResponse
        }
        if statusCode(json) == 2483 || isLoginRequired(json) {
            throw DouyinClientError.sessionRequired
        }
        return json
    }

    func defaultQuery(for target: URL) -> [(String, String)] {
        let cookies = cookies.values(for: target)
        var query: [(String, String)] = [
            ("device_platform", "webapp"),
            ("aid", "6383"),
            ("channel", "channel_pc_web"),
            ("update_version_code", "170400"),
            ("pc_client_type", "1"),
            ("pc_libra_divert", "Windows"),
            ("version_code", "290100"),
            ("version_name", "29.1.0"),
            ("cookie_enabled", "true"),
            ("screen_width", "1536"),
            ("screen_height", "864"),
            ("browser_language", "zh-CN"),
            ("browser_platform", "Win32"),
            ("browser_name", "Chrome"),
            ("browser_version", "139.0.0.0"),
            ("browser_online", "true"),
            ("engine_name", "Blink"),
            ("engine_version", "139.0.0.0"),
            ("os_name", "Windows"),
            ("os_version", "10"),
            ("cpu_core_num", "16"),
            ("device_memory", "8"),
            ("platform", "PC"),
            ("downlink", "10"),
            ("effective_type", "4g"),
            ("round_trip_time", "200"),
            ("support_h265", "1"),
            ("support_dash", "1"),
            ("uifid", cookies["UIFID"] ?? ""),
        ]
        if let msToken = cookies["msToken"], !msToken.isEmpty {
            query.append(("msToken", msToken))
        }
        return query
    }

    static func statusCode(_ json: [String: Any]) -> Int? {
        if let value = json["status_code"] as? Int { return value }
        if let value = json["status_code"] as? NSNumber { return value.intValue }
        return nil
    }

    static func isLoginRequired(_ json: [String: Any]) -> Bool {
        let message = (json["status_msg"] as? String) ?? ""
        return message.contains("请先登录") || message.contains("用户未登录")
    }

    /// RFC 3986 unreserved set, matching Python's `quote_plus` for the ASCII
    /// parameter values Douyin expects.
    static func formEncode(_ value: String) -> String {
        var allowed = CharacterSet()
        allowed.insert(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }
}

/// API endpoints are exact HTTPS URLs. Redirects are reported to the caller;
/// browser cookies and signed queries never follow a site-provided location.
private final class DouyinAPIRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
