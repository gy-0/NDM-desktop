import Foundation
import NDMCore

/// A captured media request is already a download target. Its request context
/// must reach the engine intact instead of being reduced to a composer URL.
public enum BrowserCaptureRouting {
    public enum Failure: Error, LocalizedError, Equatable {
        case conflictingAudioSource, invalidAudioSource, crossOriginAudioCredentials
        public var errorDescription: String? {
            switch self {
            case .conflictingAudioSource: return "浏览器传来的音轨来源冲突，请回到网页重新选择视频。"
            case .invalidAudioSource: return "浏览器传来的音轨地址无效，请回到网页重新选择视频。"
            case .crossOriginAudioCredentials: return "音视频来自不同来源，无法安全共用登录信息，请使用网页视频解析。"
            }
        }
    }

    private static let mediaExtensions: Set<String> = [
        "mp4", "mkv", "mov", "m4v", "webm", "mp3", "m4a", "flac", "wav",
        "aac", "ogg", "opus", "avi", "flv", "ts", "m3u8", "m3u"
    ]
    private static let hlsTypes: Set<String> = [
        "application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"
    ]

    /// nil means that the page still needs media recognition. A typed failure
    /// must not fall back to a bare URL, which could silently discard an audio track.
    public static func normalizedFileMessage(
        _ message: ParsedBridgeMessage, fallbackFilename: String? = nil
    ) throws -> ParsedBridgeMessage? {
        let requested = message.ltype.lowercased()
        guard requested != "media-page" else { return nil }
        var normalized = message
        let legacyAudio = ["media", "hls"].contains(requested)
            && message.filename.range(of: #"^https?:"#, options: [.regularExpression, .caseInsensitive]) != nil
        if legacyAudio {
            guard let audio = sourceURL(message.filename) else { throw Failure.invalidAudioSource }
            if !message.alternateURL.isEmpty && sourceURL(message.alternateURL) != audio {
                throw Failure.conflictingAudioSource
            }
            // The retired extension protocol used field 3 for a second track;
            // the current native parser reserves 3 for a filename and 12 for audio.
            normalized.alternateURL = message.filename
            normalized.filename = ""
        }
        if !normalized.alternateURL.isEmpty {
            guard let video = sourceURL(normalized.url), let audio = sourceURL(normalized.alternateURL) else {
                throw Failure.invalidAudioSource
            }
            let sensitive = !normalized.cookies.isEmpty || normalized.extraHeaders.keys.contains {
                ["cookie", "authorization", "proxy-authorization"].contains($0.lowercased())
            }
            if origin(video) != origin(audio) && sensitive { throw Failure.crossOriginAudioCredentials }
        }
        let filename = normalized.filename.isEmpty ? (legacyAudio ? nil : fallbackFilename) : normalized.filename
        let ordinary = MediaLinkClassifier.looksLikeOrdinaryFileDownload(normalized.url, suggestedFilename: filename)
        if ordinary {
            normalized.ltype = "normal"
            if let filename { normalized.filename = filename }
            return normalized
        }
        let mime = normalized.contentType.split(separator: ";", maxSplits: 1).first.map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        guard mime != "text/html", mime != "application/xhtml+xml" else { return nil }
        let directExtension = URL(string: normalized.url)?.pathExtension.lowercased() ?? ""
        let filenameExtension = filename.map { ($0 as NSString).pathExtension.lowercased() } ?? ""
        let explicitMedia = ["media", "hls"].contains(requested)
        let capturedMIME = mime.hasPrefix("video/") || mime.hasPrefix("audio/") || hlsTypes.contains(mime)
        let capturedAddress = mediaExtensions.contains(directExtension)
            || (explicitMedia && mediaExtensions.contains(filenameExtension))
        let capturedPair = explicitMedia && !normalized.alternateURL.isEmpty
        if sourceURL(normalized.url) != nil && (capturedMIME || capturedAddress || capturedPair) {
            let hls = hlsTypes.contains(mime) || ["m3u", "m3u8"].contains(directExtension)
                || ["m3u", "m3u8"].contains(filenameExtension)
            normalized.ltype = hls ? "hls" : (normalized.alternateURL.isEmpty ? "normal" : "media")
            if let filename { normalized.filename = filename }
            return normalized
        }
        if MediaLinkClassifier.looksLikeMediaPage(normalized.url) { return nil }
        if let filename { normalized.filename = filename }
        return normalized
    }

    private static func sourceURL(_ value: String) -> URL? {
        guard value.rangeOfCharacter(from: .controlCharacters) == nil,
              value.range(of: #"^https?://"#, options: [.regularExpression, .caseInsensitive]) != nil,
              let url = URL(string: value), url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    private static func origin(_ url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? ""
        return "\(scheme)://\(url.host?.lowercased() ?? ""):\(url.port ?? (scheme == "https" ? 443 : 80))"
    }
}
