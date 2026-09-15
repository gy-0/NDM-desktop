// Adapted and modified from MIT-licensed douyin-downloader.
// Pinned upstream references and full license: licenses/douyin/NOTICE.md.
import Foundation

/// One selectable download URL set for a Douyin video. Mirrors are kept in
/// preference order: watermark-free direct CDN hosts first, the signed
/// `douyin.com` play endpoint as fallback.
public struct DouyinVideoTier: Equatable, Sendable {
    public let height: Int
    public let width: Int
    public let dataSize: Int64?
    public let urls: [String]

    public init(height: Int, width: Int, dataSize: Int64?, urls: [String]) {
        self.height = height
        self.width = width
        self.dataSize = dataSize
        self.urls = urls
    }

    /// Direct CDN endpoint chosen for a plain HTTP download.
    public var primaryURL: String? { urls.first }

    public var isPlayEndpoint: Bool {
        guard let url = primaryURL, let host = URL(string: url)?.host?.lowercased() else { return false }
        return host == "douyin.com" || host.hasSuffix(".douyin.com")
    }
}

public struct DouyinGalleryImage: Equatable, Sendable {
    public let width: Int
    public let height: Int
    /// Watermark-free candidates in ranked order.
    public let urls: [String]

    public init(width: Int, height: Int, urls: [String]) {
        self.width = width
        self.height = height
        self.urls = urls
    }

    public var primaryURL: String? { urls.first }
}

public enum DouyinMediaKind: Equatable, Sendable {
    case video
    case gallery
}

/// One track returned by the music detail endpoint.
public struct DouyinAudioTrack: Equatable, Sendable {
    public let title: String
    public let durationSeconds: Double?
    public let urls: [String]

    public init(title: String, durationSeconds: Double?, urls: [String]) {
        self.title = title
        self.durationSeconds = durationSeconds
        self.urls = urls
    }
}

/// An author profile or collection expanded into individual awemes. Batch
/// downloads pick a tier per item without a per-item quality picker.
public struct DouyinBatch: Equatable, Sendable {
    public let title: String
    public let items: [DouyinMedia]

    public init(title: String, items: [DouyinMedia]) {
        self.title = title
        self.items = items
    }
}

/// What a Douyin link resolved to.
public enum DouyinResolution: Equatable, Sendable {
    case single(DouyinMedia)
    case batch(DouyinBatch)
    case audio(DouyinAudioTrack)
}

/// A resolved aweme: everything a task needs without another API round trip.
public struct DouyinMedia: Equatable, Sendable {
    public let awemeID: String
    public let kind: DouyinMediaKind
    public let title: String
    public let authorName: String?
    public let coverURL: String?
    public let durationSeconds: Double?
    public let videoTiers: [DouyinVideoTier]
    public let galleryImages: [DouyinGalleryImage]
    /// Live-photo clips attached to gallery items, in item order.
    public let livePhotoVideos: [DouyinVideoTier]

    public init(
        awemeID: String,
        kind: DouyinMediaKind,
        title: String,
        authorName: String?,
        coverURL: String?,
        durationSeconds: Double?,
        videoTiers: [DouyinVideoTier],
        galleryImages: [DouyinGalleryImage],
        livePhotoVideos: [DouyinVideoTier]
    ) {
        self.awemeID = awemeID
        self.kind = kind
        self.title = title
        self.authorName = authorName
        self.coverURL = coverURL
        self.durationSeconds = durationSeconds
        self.videoTiers = videoTiers
        self.galleryImages = galleryImages
        self.livePhotoVideos = livePhotoVideos
    }
}

/// Pure projection of the web detail payload. Ported from the reference
/// downloader's media-selection rules (watermark-free preference, bit_rate
/// ladder, gallery candidate ranking).
public enum DouyinMediaParser {
    static let galleryAwemeTypes: Set<Int> = [2, 68, 150]
    static let playAddrKeys = ["play_addr_h264", "play_addr_265", "play_addr_256", "play_addr"]

    public static func parse(_ detail: [String: Any]) -> DouyinMedia? {
        guard let awemeID = string(detail["aweme_id"]), !awemeID.isEmpty else { return nil }
        let video = dictionary(detail["video"])
        let items = galleryItems(detail)
        let awemeType = integer(detail["aweme_type"])

        let kind: DouyinMediaKind
        if !items.isEmpty {
            kind = .gallery
        } else if let awemeType, galleryAwemeTypes.contains(awemeType) {
            kind = hasVideoSource(video) ? .video : .gallery
        } else {
            kind = .video
        }

        let images = items.compactMap { galleryImage($0) }
        if kind == .gallery && images.isEmpty { return nil }

        let tiers = kind == .video ? videoTiers(video) : []
        let livePhotos = items.compactMap { livePhotoTier($0) }

        let title = (string(detail["desc"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let author = dictionary(detail["author"])
        let cover = firstURL(dictionary(video["cover"])) ?? firstURL(dictionary(video["origin_cover"]))
        let duration = integer64(video["duration"]).map { Double($0) / 1000 }

        return DouyinMedia(
            awemeID: awemeID,
            kind: kind,
            title: title,
            authorName: string(author["nickname"]),
            coverURL: cover,
            durationSeconds: duration,
            videoTiers: tiers,
            galleryImages: images,
            livePhotoVideos: livePhotos
        )
    }

    // MARK: - Video

    /// Distinct quality tiers from the `bit_rate` ladder, highest first. The
    /// raw ladder repeats every resolution across codec/host variants; the UI
    /// only needs one row per short edge.
    static func videoTiers(_ video: [String: Any]) -> [DouyinVideoTier] {
        var best: [Int: (bitrate: Int, pixels: Int, tier: DouyinVideoTier)] = [:]

        for entry in list(video["bit_rate"]) {
            let entry = dictionary(entry)
            let playAddr = dictionary(entry["play_addr"])
            guard !playAddr.isEmpty else { continue }
            let metrics = resolutionMetrics(entry: entry, playAddr: playAddr)
            guard metrics.shortEdge > 0 else { continue }
            // Douyin's own tier names are authoritative: a "540" gear is often
            // 1024x576, and grouping by raw short edge would split one tier
            // into two rows.
            let height = nominalHeight(gearName: string(entry["gear_name"]), shortEdge: metrics.shortEdge)
            let tier = DouyinVideoTier(
                height: height,
                width: integer(playAddr["width"]) ?? integer(entry["width"]) ?? 0,
                dataSize: integer64(playAddr["data_size"]),
                urls: rankedVideoURLs(playAddr)
            )
            guard !tier.urls.isEmpty else { continue }
            let bitrate = integer(entry["bit_rate"]) ?? 0
            if let existing = best[height] {
                if (bitrate, metrics.pixels) > (existing.bitrate, existing.pixels) {
                    best[height] = (bitrate, metrics.pixels, tier)
                }
            } else {
                best[height] = (bitrate, metrics.pixels, tier)
            }
        }

        if best.isEmpty {
            // No ladder: fall back to the single primary address.
            for key in playAddrKeys {
                let candidate = dictionary(video[key])
                guard !candidate.isEmpty else { continue }
                let urls = rankedVideoURLs(candidate)
                if urls.isEmpty { continue }
                let metrics = resolutionMetrics(entry: [:], playAddr: candidate)
                return [DouyinVideoTier(
                    height: metrics.shortEdge,
                    width: integer(candidate["width"]) ?? 0,
                    dataSize: integer64(candidate["data_size"]),
                    urls: urls
                )]
            }
            return []
        }

        return best.values
            .sorted { lhs, rhs in
                lhs.tier.height == rhs.tier.height
                    ? lhs.bitrate > rhs.bitrate
                    : lhs.tier.height > rhs.tier.height
            }
            .map(\.tier)
    }

    /// Direct CDN mirrors first (watermark-free preferred), signed play
    /// endpoint as the fallback.
    static func rankedVideoURLs(_ playAddr: [String: Any]) -> [String] {
        let urls = urlList(playAddr)
        let sorted = urls.enumerated().sorted { lhs, rhs in
            let left = rankingScore(lhs.element)
            let right = rankingScore(rhs.element)
            return left == right ? lhs.offset < rhs.offset : left < right
        }.map(\.element)
        return deduplicate(sorted)
    }

    private static func rankingScore(_ url: String) -> Int {
        var score = 0
        if !isWatermarked(url) { score += 2 }
        guard let host = URL(string: url)?.host?.lowercased() else { return score }
        if !(host == "douyin.com" || host.hasSuffix(".douyin.com")) { score += 4 }
        return -score
    }

    static func resolutionMetrics(entry: [String: Any], playAddr: [String: Any]) -> (shortEdge: Int, pixels: Int) {
        let width = integer(playAddr["width"]) ?? integer(entry["width"]) ?? 0
        let height = integer(playAddr["height"]) ?? integer(entry["height"]) ?? 0
        if width > 0 && height > 0 {
            return (min(width, height), width * height)
        }
        let longEdge = max(width, height)
        return longEdge > 0 ? (longEdge, longEdge) : (0, 0)
    }

    /// First integer embedded in the gear name (`normal_1080_0` → 1080);
    /// falls back to the measured short edge when the name carries no size.
    static func nominalHeight(gearName: String?, shortEdge: Int) -> Int {
        guard let gearName else { return shortEdge }
        let digits = gearName.split(separator: "_").compactMap { Int($0) }.first { $0 >= 144 && $0 <= 4320 }
        return digits ?? shortEdge
    }

    // MARK: - Gallery

    static func galleryItems(_ detail: [String: Any]) -> [[String: Any]] {
        let imagePost = dictionary(detail["image_post_info"])
        if !imagePost.isEmpty {
            for key in ["images", "image_list"] {
                let candidate = list(imagePost[key])
                if !candidate.isEmpty { return candidate.map(dictionary) }
            }
        }
        for key in ["images", "image_list"] {
            let candidate = list(detail[key])
            if !candidate.isEmpty { return candidate.map(dictionary) }
        }
        return []
    }

    static func galleryImage(_ item: [String: Any]) -> DouyinGalleryImage? {
        let urls = rankedGalleryURLs(item)
        guard !urls.isEmpty else { return nil }
        let metrics = imageResolution(item)
        return DouyinGalleryImage(width: metrics.width, height: metrics.height, urls: urls)
    }

    /// Candidate sources in reference rank order: watermark-free download
    /// list, origin image, display image, the item itself, then progressively
    /// more watermarked/lower-priority variants.
    static func rankedGalleryURLs(_ item: [String: Any]) -> [String] {
        let sources: [(source: Any?, metadata: [String: Any], rank: Int)] = [
            (item["watermark_free_download_url_list"], item, 0),
            (item["origin_image"], dictionary(item["origin_image"]), 1),
            (item["display_image"], dictionary(item["display_image"]), 2),
            (item, item, 3),
            (item["download_url"], dictionary(item["download_url"]), 4),
            (item["download_addr"], dictionary(item["download_addr"]), 5),
            (item["download_url_list"], item, 6),
            (item["owner_watermark_image"], dictionary(item["owner_watermark_image"]), 7),
        ]

        var entries: [(key: (Int, Int, Int, Int), url: String)] = []
        for source in sources {
            for url in urlsFrom(source.source) {
                entries.append((gallerySortKey(url: url, metadata: source.metadata, sourceRank: source.rank), url))
            }
        }
        entries.sort { $0.key < $1.key }
        var seen = Set<String>()
        var output = [String]()
        for entry in entries where seen.insert(entry.url).inserted {
            output.append(entry.url)
        }
        return output
    }

    private static func gallerySortKey(
        url: String,
        metadata: [String: Any],
        sourceRank: Int
    ) -> (Int, Int, Int, Int) {
        let watermarkRank = sourceRank >= 4 || isWatermarked(url) ? 1 : 0
        let pixels = imageResolution(metadata).pixels
        let webpPenalty = url.lowercased().contains(".webp") ? 1 : 0
        return (watermarkRank, -pixels, sourceRank, webpPenalty)
    }

    private static func imageResolution(_ source: [String: Any]) -> (width: Int, height: Int, pixels: Int) {
        let width = positiveInt(source["width"]) ?? positiveInt(source["w"]) ?? 0
        let height = positiveInt(source["height"]) ?? positiveInt(source["h"]) ?? 0
        let pixels = width > 0 && height > 0 ? width * height : max(width, height)
        return (width, height, pixels)
    }

    /// Live photos ride along a gallery item as a short video clip.
    static func livePhotoTier(_ item: [String: Any]) -> DouyinVideoTier? {
        let video = dictionary(item["video"])
        guard !video.isEmpty else { return nil }
        for candidate in [preferredPlayAddr(video), dictionary(item["video_play_addr"]), dictionary(item["video_download_addr"])] {
            guard !candidate.isEmpty else { continue }
            let urls = rankedVideoURLs(candidate)
            guard !urls.isEmpty else { continue }
            let metrics = resolutionMetrics(entry: [:], playAddr: candidate)
            return DouyinVideoTier(
                height: metrics.shortEdge,
                width: integer(candidate["width"]) ?? 0,
                dataSize: integer64(candidate["data_size"]),
                urls: urls
            )
        }
        return nil
    }

    static func preferredPlayAddr(_ video: [String: Any]) -> [String: Any] {
        if let primary = video["play_addr"] as? [String: Any], !primary.isEmpty,
           !urlList(primary).isEmpty || string(primary["uri"]) != nil {
            return primary
        }
        for key in playAddrKeys {
            let candidate = dictionary(video[key])
            if !candidate.isEmpty, !urlList(candidate).isEmpty || string(candidate["uri"]) != nil {
                return candidate
            }
        }
        return [:]
    }

    static func hasVideoSource(_ video: [String: Any]) -> Bool {
        if !preferredPlayAddr(video).isEmpty { return true }
        if string(video["vid"]) != nil { return true }
        return string(dictionary(video["download_addr"])["uri"]) != nil
    }

    // MARK: - Shared helpers

    static func isWatermarked(_ url: String) -> Bool {
        let normalized = url.lowercased()
        let hints = ["tplv-dy-water", "dy-water", "owner_watermark", "watermark_image", "watermark=1", "playwm"]
        return hints.contains { normalized.contains($0) }
    }

    static func urlList(_ source: [String: Any]) -> [String] {
        if let list = source["url_list"] as? [Any] {
            return list.compactMap { $0 as? String }.filter { !$0.isEmpty }
        }
        if let list = source["urlList"] as? [Any] {
            return list.compactMap { $0 as? String }.filter { !$0.isEmpty }
        }
        return []
    }

    static func firstURL(_ source: [String: Any]) -> String? {
        urlList(source).first
    }

    static func urlsFrom(_ source: Any?) -> [String] {
        if let source = source as? [String: Any] { return urlList(source) }
        if let source = source as? [Any] { return source.compactMap { $0 as? String }.filter { !$0.isEmpty } }
        if let source = source as? String, !source.isEmpty { return [source] }
        return []
    }

    static func deduplicate(_ urls: [String]) -> [String] {
        var seen = Set<String>()
        return urls.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func dictionary(_ value: Any?) -> [String: Any] {
        value as? [String: Any] ?? [:]
    }

    static func list(_ value: Any?) -> [Any] {
        value as? [Any] ?? []
    }

    static func string(_ value: Any?) -> String? {
        if let value = value as? String { return value }
        if let value = value as? NSNumber { return value.stringValue }
        return nil
    }

    static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        if let value = value as? String { return Int(value) }
        return nil
    }

    static func integer64(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        if let value = value as? String { return Int64(value) }
        return nil
    }

    static func positiveInt(_ value: Any?) -> Int? {
        guard let number = integer(value), number > 0 else { return nil }
        return number
    }
}
