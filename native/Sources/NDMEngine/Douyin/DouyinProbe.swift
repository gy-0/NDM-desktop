// Adapted and modified from MIT-licensed douyin-downloader.
// Pinned upstream references and full license: licenses/douyin/NOTICE.md.
import Foundation
import NDMCore

/// Everything a Douyin URL resolves to before a task exists: the payload plus
/// the link identity the receipt/duplicate logic needs.
public struct DouyinPreflight: Equatable, Sendable {
    public let originalURL: String
    public let resolvedURL: String
    public let didExpandShortLink: Bool
    public let resolution: DouyinResolution

    public init(originalURL: String, resolvedURL: String, didExpandShortLink: Bool, resolution: DouyinResolution) {
        self.originalURL = originalURL
        self.resolvedURL = resolvedURL
        self.didExpandShortLink = didExpandShortLink
        self.resolution = resolution
    }
}

/// Resolves Douyin links directly against the web API. The engine gets
/// watermark-free media URLs and gallery item lists that yt-dlp cannot extract.
public enum DouyinProbe {
    public static let galleryFormatID = "douyin-gallery"
    public static let batchFormatID = "douyin-batch"
    public static let audioFormatID = "douyin-audio"
    /// One page per batch keeps a single probe bounded; the picker labels the
    /// exact count so the scope is never a surprise.
    public static let batchPageSize = 20

    public static func isDouyinPage(_ raw: String) -> Bool {
        DouyinURL.isDouyin(raw)
    }

    public static func resolve(
        url: String,
        cookieSource: YtDlpCookieSource?
    ) async throws -> DouyinPreflight {
        let expanded = await ShortLinkExpander.expand(url)
        guard let link = DouyinURL.parse(expanded.resolvedURL) else {
            throw DouyinClientError.unsupportedLink
        }
        let cookies = try await DouyinCookieStore.jar(for: cookieSource)
        let client = DouyinAPIClient(cookies: cookies)
        let resolution = try await resolve(link: link, client: client)
        return DouyinPreflight(
            originalURL: expanded.originalURL,
            resolvedURL: expanded.resolvedURL,
            didExpandShortLink: expanded.didExpand,
            resolution: resolution
        )
    }

    static func resolve(link: DouyinLink, client: DouyinAPIClient) async throws -> DouyinResolution {
        switch link {
        case .video, .gallery:
            guard let awemeID = DouyinURL.awemeID(for: link) else { throw DouyinClientError.unsupportedLink }
            let detail = try await client.detail(awemeID: awemeID)
            guard let media = DouyinMediaParser.parse(detail) else { throw DouyinClientError.notFound }
            // A video without a playable ladder is not better served natively;
            // let the caller fall back to yt-dlp.
            if media.kind == .video && media.videoTiers.isEmpty { throw DouyinClientError.notFound }
            return .single(media)

        case .user(let secUID):
            let info = try? await client.userInfo(secUID: secUID)
            let nickname = (info?["user"] as? [String: Any])?["nickname"] as? String
            let page = try await client.userPostPage(secUID: secUID, cursor: 0, count: batchPageSize)
            let items = parseAwemeList(page)
            guard !items.isEmpty else { throw DouyinClientError.notFound }
            return .batch(DouyinBatch(title: nickname ?? "博主作品", items: items))

        case .collection(let mixID):
            let detail = try? await client.mixDetail(mixID: mixID)
            let mixInfo = (detail?["mix_info"] as? [String: Any]) ?? [:]
            let name = (mixInfo["mix_name"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let page = try await client.mixAwemePage(mixID: mixID, cursor: 0, count: batchPageSize)
            let items = parseAwemeList(page)
            guard !items.isEmpty else { throw DouyinClientError.notFound }
            return .batch(DouyinBatch(
                title: (name?.isEmpty == false ? name! : "合集"),
                items: items
            ))

        case .music(let musicID):
            let detail = try await client.musicDetail(musicID: musicID)
            guard let track = parseMusic(detail) else { throw DouyinClientError.notFound }
            return .audio(track)

        case .short, .live, .liveReplay:
            throw DouyinClientError.unsupportedLink
        }
    }

    static func parseAwemeList(_ page: [String: Any]) -> [DouyinMedia] {
        let list = (page["aweme_list"] as? [Any]) ?? []
        return list
            .compactMap { $0 as? [String: Any] }
            .compactMap { DouyinMediaParser.parse($0) }
            .filter { media in
                media.kind == .video ? !media.videoTiers.isEmpty : !media.galleryImages.isEmpty
            }
            .prefix(batchPageSize)
            .map { $0 }
    }

    static func parseMusic(_ detail: [String: Any]) -> DouyinAudioTrack? {
        // The detail endpoint answers with `music_info` on current clients;
        // older shapes wrap the same object in `music`.
        let music = (detail["music_info"] as? [String: Any])
            ?? (detail["music"] as? [String: Any])
            ?? detail
        // Prefer the full-quality original; the low-bitrate fallback still
        // beats failing the probe outright.
        var urls = [String]()
        for key in ["play_url", "play_url_lowbr", "audio_url"] {
            urls += DouyinMediaParser.urlsFrom(music[key])
        }
        urls = DouyinMediaParser.deduplicate(urls)
        guard !urls.isEmpty else { return nil }
        let title = (music["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        // Music duration arrives in seconds, but a millisecond variant exists
        // in older payloads; the magnitude separates them.
        let rawDuration = DouyinMediaParser.integer64(music["duration"])
        let duration = rawDuration.map { $0 > 10_000 ? Double($0) / 1000 : Double($0) }
        return DouyinAudioTrack(
            title: (title?.isEmpty == false ? title! : "抖音音乐"),
            durationSeconds: duration,
            urls: urls
        )
    }

    /// The synthetic probe that feeds the existing quality picker and task
    /// creation. Videos map tiers to rows; a gallery is one "original images"
    /// row; profiles/collections are a single batch row; music is one track.
    public static func probe(from preflight: DouyinPreflight) -> YtDlpProbe {
        switch preflight.resolution {
        case .single(let media):
            let title = media.title.isEmpty ? (media.authorName ?? "抖音作品") : media.title
            return YtDlpProbe(
                title: title,
                durationSeconds: media.durationSeconds,
                formats: singleFormats(for: media),
                thumbnailURL: media.coverURL
            )

        case .batch(let batch):
            let galleryCount = batch.items.filter { $0.kind == .gallery }.count
            let label = galleryCount == 0
                ? "作品 · \(batch.items.count) 个"
                : "作品 · \(batch.items.count) 个（含图集）"
            return YtDlpProbe(
                title: batch.title,
                durationSeconds: nil,
                formats: [
                    YtDlpFormat(id: batchFormatID, label: label, height: 0, containerHint: "MP4", isVideo: true),
                ],
                thumbnailURL: batch.items.first?.coverURL
            )

        case .audio(let track):
            return YtDlpProbe(
                title: track.title,
                durationSeconds: track.durationSeconds,
                formats: [
                    YtDlpFormat(id: audioFormatID, label: "原声 · MP3", height: 0, containerHint: "MP3", isVideo: false),
                ],
                thumbnailURL: nil
            )
        }
    }

    static func singleFormats(for media: DouyinMedia) -> [YtDlpFormat] {
        switch media.kind {
        case .video:
            return media.videoTiers.map { tier in
                YtDlpFormat(
                    id: formatID(for: tier),
                    label: "\(tier.height)p",
                    height: tier.height,
                    approximateBytes: tier.dataSize,
                    componentBytes: tier.dataSize.map { [$0] } ?? [],
                    containerHint: "MP4",
                    isVideo: true
                )
            }
        case .gallery:
            let count = media.galleryImages.count
            return [
                YtDlpFormat(
                    id: galleryFormatID,
                    label: count > 1 ? "原图 · \(count) 张" : "原图",
                    height: 0,
                    containerHint: "IMG",
                    isVideo: false
                ),
            ]
        }
    }

    public static func formatID(for tier: DouyinVideoTier) -> String {
        "douyin-\(tier.height)"
    }

    /// Direct CDN URL for a tier; play endpoints get an X-Bogus signature at
    /// download time so the timestamp is fresh.
    public static func downloadURL(for tier: DouyinVideoTier) -> String? {
        guard var url = tier.primaryURL else { return nil }
        if tier.isPlayEndpoint, !url.contains("X-Bogus=") {
            let signature = DouyinXBogus.sign(
                url: url,
                userAgent: DouyinAccess.userAgent,
                timestamp: Int(Date().timeIntervalSince1970)
            )
            url += "&X-Bogus=" + signature
        }
        return url
    }

    /// Media requests need the site Referer; the CDN 403s without it.
    public static var downloadHeaders: [String] {
        ["Referer: https://www.douyin.com/", "User-Agent: \(DouyinAccess.userAgent)"]
    }

    /// Mirrors the reference extension inference: known suffix wins, otherwise
    /// the last media-looking extension inside the path.
    public static func imageExtension(for urlString: String) -> String {
        let allowed = Set(["jpg", "jpeg", "png", "webp", "gif"])
        guard let path = URL(string: urlString)?.path.lowercased() else { return "jpg" }
        let suffix = (path as NSString).pathExtension
        if allowed.contains(suffix) { return suffix }
        let pattern = #"\.(jpe?g|png|webp|gif)(?=[^a-z0-9]|$)"#
        if let expression = try? NSRegularExpression(pattern: pattern) {
            let matches = expression.matches(in: path, range: NSRange(path.startIndex..., in: path))
            if let last = matches.last, let range = Range(last.range(at: 1), in: path) {
                return String(path[range])
            }
        }
        return "jpg"
    }

    public static func isGalleryFormat(_ formatID: String) -> Bool {
        formatID == galleryFormatID
    }

    public static func isBatchFormat(_ formatID: String) -> Bool {
        formatID == batchFormatID
    }

    public static func isAudioFormat(_ formatID: String) -> Bool {
        formatID == audioFormatID
    }
}
