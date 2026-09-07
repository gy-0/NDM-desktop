import Foundation
import NDMCore

/// Metadata prepared before the quality picker opens. The original and
/// resolved URL travel with the probe so short links are expanded only once.
public struct MediaPreflightResult: Equatable, Sendable {
    public let originalURL: String
    public let resolvedURL: String
    /// The single media item used for quality selection. This differs from
    /// `resolvedURL` when the pasted address is a collection-only page.
    public let mediaURL: String
    public let didExpandShortLink: Bool
    public let probe: YtDlpProbe
    public let collection: YtDlpCollectionProbe?

    public init(
        originalURL: String,
        resolvedURL: String,
        mediaURL: String? = nil,
        didExpandShortLink: Bool,
        probe: YtDlpProbe,
        collection: YtDlpCollectionProbe? = nil
    ) {
        self.originalURL = originalURL
        self.resolvedURL = resolvedURL
        self.mediaURL = mediaURL ?? resolvedURL
        self.didExpandShortLink = didExpandShortLink
        self.probe = probe
        self.collection = collection
    }
}

/// Keeps the entry flow's preparation decision testable. Short social links
/// are media pages too, so they must not be excluded just because the general
/// page classifier also recognizes them.
public enum MediaPreparationPlan {
    public static func shouldResolveSharedLink(
        _ rawURL: String,
        hasPreparedMetadata: Bool
    ) -> Bool {
        !hasPreparedMetadata && ShortLinkExpander.shouldExpand(rawURL)
    }
}

/// Session-scoped Link Lens store. It deduplicates in-flight work and lets the
/// New Download sheet hand the exact same probe to the quality picker.
public actor MediaPreflightStore {
    public static let shared = MediaPreflightStore()

    /// A store with its own empty cache, for callers that must measure an
    /// uncached probe (see `Sources/NDMProbe`). Reusing `shared` across repeated
    /// runs would let the first attempt's cached probe make later attempts look
    /// instant, which would quietly corrupt the timing it is meant to report.
    public static func uncached() -> MediaPreflightStore {
        MediaPreflightStore()
    }

    typealias Expander = @Sendable (String) async -> ExpandedShortLink
    typealias Prober = @Sendable (String) async throws -> YtDlpProbe
    typealias CollectionProber = @Sendable (String) async throws -> YtDlpCollectionProbe?

    private let expand: Expander
    private let probe: Prober
    private let probeCollection: CollectionProber
    private var completed: [String: MediaPreflightResult] = [:]
    private var aliases: [String: String] = [:]
    private var inFlight: [String: Task<MediaPreflightResult, Error>] = [:]

    init(
        expand: @escaping Expander = { await ShortLinkExpander.expand($0) },
        probe: @escaping Prober = { try await YtDlpTool.probe(url: $0) },
        probeCollection: @escaping CollectionProber = { try await YtDlpTool.probeCollection(url: $0) }
    ) {
        self.expand = expand
        self.probe = probe
        self.probeCollection = probeCollection
    }

    public func cachedResult(for rawURL: String) -> MediaPreflightResult? {
        let key = Self.normalizedKey(rawURL)
        let canonical = aliases[key] ?? key
        return completed[canonical]
    }

    public func result(for rawURL: String) async throws -> MediaPreflightResult {
        let trimmed = rawURL.trimmingCharacters(in: .whitespacesAndNewlines)
        let originalKey = Self.normalizedKey(trimmed)
        let canonical = aliases[originalKey] ?? originalKey
        if let cached = completed[canonical] { return cached }
        if let running = inFlight[canonical] { return try await running.value }

        let expand = self.expand
        let probe = self.probe
        let probeCollection = self.probeCollection
        let task = Task.detached(priority: .userInitiated) {
            let expanded = await expand(trimmed)
            let isCollection = MediaLinkClassifier.looksLikeCollectionURL(expanded.resolvedURL)
            if isCollection,
               !MediaLinkClassifier.hasExplicitSingleMedia(expanded.resolvedURL),
               let collection = try? await probeCollection(expanded.resolvedURL),
               let first = collection.items.first {
                let metadata = try await probe(first.url)
                return MediaPreflightResult(
                    originalURL: expanded.originalURL,
                    resolvedURL: expanded.resolvedURL,
                    mediaURL: first.url,
                    didExpandShortLink: expanded.didExpand,
                    probe: metadata,
                    collection: collection
                )
            }
            let collectionTask = Task { () -> YtDlpCollectionProbe? in
                guard isCollection else { return nil }
                return try? await probeCollection(expanded.resolvedURL)
            }
            let metadata: YtDlpProbe
            var mediaURL = expanded.resolvedURL
            do {
                metadata = try await probe(expanded.resolvedURL)
            } catch {
                let collection = await collectionTask.value
                guard let first = collection?.items.first else { throw error }
                mediaURL = first.url
                metadata = try await probe(first.url)
            }
            let collection = await collectionTask.value
            return MediaPreflightResult(
                originalURL: expanded.originalURL,
                resolvedURL: expanded.resolvedURL,
                mediaURL: mediaURL,
                didExpandShortLink: expanded.didExpand,
                probe: metadata,
                collection: collection
            )
        }
        inFlight[canonical] = task

        do {
            let result = try await task.value
            let resolvedKey = Self.normalizedKey(result.resolvedURL)
            completed[resolvedKey] = result
            aliases[originalKey] = resolvedKey
            aliases[resolvedKey] = resolvedKey
            inFlight[canonical] = nil
            return result
        } catch {
            // Access/cookie failures are intentionally not sticky. Continue can
            // immediately retry through the guided browser-access flow.
            inFlight[canonical] = nil
            throw error
        }
    }

    public func clear() {
        completed.removeAll()
        aliases.removeAll()
        inFlight.removeAll()
    }

    private static func normalizedKey(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed) else { return trimmed }
        components.fragment = nil
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        return components.string ?? trimmed
    }
}

/// Shared URL classification keeps the entry sheet and the download path in
/// agreement about which links should receive media recognition.
public enum MediaLinkClassifier {
    /// Installers, archives, documents, and other non-stream files. A capture
    /// of one of these must keep its own URL even when the referring page is a
    /// yt-dlp site (e.g. a `.dmg` clicked on app.bilibili.com).
    private static let ordinaryFileExtensions: Set<String> = [
        "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "tgz",
        "dmg", "pkg", "exe", "msi", "iso", "apk", "appimage",
        "pdf", "epub", "mobi", "azw3", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "rtf", "txt", "md", "csv",
        "jpg", "jpeg", "png", "gif", "webp", "heic", "svg", "ico",
        "json", "xml", "yaml", "yml", "toml", "js", "css", "sh", "py", "swift", "dat", "bin",
        "gguf", "safetensors", "ckpt", "onnx", "pth", "pt", "tflite", "mlmodel",
        "npy", "npz", "parquet", "arrow",
        "ttf", "otf", "woff", "woff2",
    ]

    private static let mediaOrPageDirectExtensions: Set<String> = [
        "mp4", "mkv", "mov", "m4v", "webm", "mp3", "m4a", "flac", "wav",
        "aac", "ogg", "opus", "avi", "flv", "ts", "m3u8", "m3u",
    ]

    /// Hosts whose *page* URLs need yt-dlp. Ordinary files on these hosts
    /// (a `.dmg` on bilibili CDN) stay on the Neat HTTP engine.
    private static let videoSiteHostMarkers = [
        "youtube.com", "youtu.be", "youtube-nocookie.com",
        "bilibili.com", "b23.tv",
        "douyin.com", "iesdouyin.com",
        "tiktok.com",
        "xiaohongshu.com", "xhslink.com",
        "instagram.com",
        "twitter.com", "x.com",
        "vimeo.com",
    ]

    public static func looksLikeVideoSitePage(_ raw: String) -> Bool {
        guard !looksLikeOrdinaryFileDownload(raw) else { return false }
        guard let host = URL(string: raw)?.host?.lowercased() else { return false }
        return videoSiteHostMarkers.contains { marker in
            host == marker || host.hasSuffix("." + marker)
        }
    }

    /// Which download engine should own this URL.
    /// Ordinary files always stay on the Neat HTTP engine. yt-dlp is only
    /// the extra page-resolver the product added on top of original NDM.
    public static func engineLinkType(
        url: String,
        requestedType: String = "normal",
        formatID: String? = nil
    ) -> String {
        if looksLikeOrdinaryFileDownload(url) { return "normal" }
        if let formatID, !formatID.isEmpty { return "ytdlp" }
        let requested = requestedType.lowercased()
        if requested == "ytdlp" || requested == "media-page" { return "ytdlp" }
        return requested.isEmpty ? "normal" : requested
    }

    public static func looksLikeMediaPage(_ raw: String) -> Bool {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return false }
        if looksLikeOrdinaryFileDownload(raw) {
            return false
        }
        let ext = url.pathExtension.lowercased()
        if mediaOrPageDirectExtensions.contains(ext) {
            return false
        }
        return url.host != nil
    }

    public static func looksLikeOrdinaryFileDownload(
        _ raw: String,
        suggestedFilename: String? = nil
    ) -> Bool {
        guard let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" || scheme == "ftp" else { return false }
        var candidates = [url.lastPathComponent]
        if let suggestedFilename, !suggestedFilename.isEmpty {
            candidates.append(suggestedFilename)
        }
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        for item in queryItems {
            let key = item.name.lowercased()
            if key.contains("filename") || key.contains("disposition") || key == "rscd" {
                candidates.append(item.value ?? "")
            }
        }
        return candidates.contains { candidate in
            let decoded = candidate.removingPercentEncoding ?? candidate
            let ext = (decoded as NSString).pathExtension
                .lowercased()
                .trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
            return ordinaryFileExtensions.contains(ext)
        }
    }

    /// Browser captures from supported video sites used to always rewrite the
    /// sniffed URL to the tab's page URL for yt-dlp. That is correct for short
    /// MP4/TS sniffs, but wrong for resource-shelf rows and installer/document
    /// direct links — those must keep field `2` as the download target.
    public static func shouldPreferPageResolver(url: String, ltype: String, pageURL: String) -> Bool {
        if looksLikeOrdinaryFileDownload(url) { return false }
        switch ltype.lowercased() {
        case "media-page":
            return looksLikeMediaPage(url) || looksLikeMediaPage(pageURL)
        case "media", "hls":
            return true
        case "normal", "":
            // Context-menu / catcher of a video page link itself.
            return looksLikeMediaPage(url)
                && SharedLinkResolver.source(forURLString: url) != .web
        default:
            return false
        }
    }

    public static func looksLikeCollectionURL(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let host = url.host?.lowercased() else { return false }
        let path = url.path.lowercased()
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let queryNames = Set(queryItems.map { $0.name.lowercased() })
        if queryNames.contains("list") || queryNames.contains("playlist") || queryNames.contains("series") {
            return true
        }
        if host.contains("youtube.com") {
            return path.contains("/playlist") || path.contains("/channel/") || path.contains("/@")
        }
        if host.contains("bilibili.com") {
            return path.contains("/medialist/") || path.contains("/list/") || path.contains("/series/")
        }
        return path.contains("playlist") || path.contains("collection") || path.contains("series")
    }

    public static func hasExplicitSingleMedia(_ raw: String) -> Bool {
        guard let url = URL(string: raw), let host = url.host?.lowercased() else { return false }
        let path = url.path.lowercased()
        let queryItems = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if host == "youtu.be" { return !path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).isEmpty }
        if host.contains("youtube.com") {
            return queryItems.contains { $0.name.lowercased() == "v" && $0.value?.isEmpty == false }
                || path.contains("/shorts/")
                || path.contains("/live/")
        }
        if host.contains("bilibili.com") {
            return path.contains("/video/")
        }
        return false
    }
}
