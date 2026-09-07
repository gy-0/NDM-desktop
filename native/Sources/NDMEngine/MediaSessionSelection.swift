import Foundation
import NDMCore

/// Explicit session choices must never silently become anonymous requests.
public enum MediaSessionSelection {
    public enum Failure: Error, LocalizedError {
        case unsupportedBrowser
        case invalidSavedOptions

        public var errorDescription: String? {
            switch self {
            case .unsupportedBrowser:
                return L10n.t("Choose a supported browser for this media session.", "请选择受支持的浏览器以使用媒体会话。")
            case .invalidSavedOptions:
                return L10n.t("The saved media options could not be read. Add the media again and choose its browser session.", "无法读取已保存的媒体选项。请重新添加媒体并选择浏览器会话。")
            }
        }
    }

    public static func browser(from value: Any?) throws -> String? {
        guard let value else { return nil }
        guard let browser = value as? String,
              ["chrome", "firefox", "safari", "edge", "brave", "chromium"].contains(browser) else {
            throw Failure.unsupportedBrowser
        }
        return browser
    }

    public static func resumeOptions(data: Data?, filename: String) throws -> YtDlpDownloadOptions {
        guard let data else {
            return YtDlpDownloadOptions(container: filename.lowercased().hasSuffix(".mkv") ? .compactMKV : .compatibleMP4)
        }
        do { return try JSONDecoder().decode(YtDlpDownloadOptions.self, from: data) }
        catch { throw Failure.invalidSavedOptions }
    }
}
