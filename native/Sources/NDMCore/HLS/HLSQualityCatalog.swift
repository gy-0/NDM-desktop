import Foundation

/// One row in the quality picker: a deduplicated, human-labeled HLS variant.
public struct HLSQualityOption: Equatable, Sendable {
    public var variant: HLSPlaylist.Variant
    /// "1080p" / "720p", or a bitrate label when the master has no RESOLUTION.
    public var label: String
    /// Codec / bitrate hint shown under the label.
    public var detail: String
    /// Duration-based estimate; nil when the stream duration is unknown.
    public var estimatedBytes: Int64?

    public init(variant: HLSPlaylist.Variant, label: String, detail: String, estimatedBytes: Int64?) {
        self.variant = variant
        self.label = label
        self.detail = detail
        self.estimatedBytes = estimatedBytes
    }

    public var estimatedSizeText: String? {
        estimatedBytes.map { "≈ " + TaskPresentationFormatting.byteCount($0) }
    }
}

/// Turns a raw master playlist (often a dozen redundant entries) into the
/// three-or-so honest choices a person actually wants to pick from.
public enum HLSQualityCatalog {
    /// Deduplicate by rendition height (keep the highest bandwidth per height),
    /// sort best-first, and attach size estimates when `duration` is known.
    public static func options(
        from master: HLSPlaylist.Master,
        duration: Double? = nil
    ) -> [HLSQualityOption] {
        var bestPerKey: [String: HLSPlaylist.Variant] = [:]
        for variant in master.variants {
            let key = heightLabel(resolution: variant.resolution)
                ?? "bw-\(bandwidthBucket(variant.bandwidth))"
            if let existing = bestPerKey[key], existing.bandwidth >= variant.bandwidth {
                continue
            }
            bestPerKey[key] = variant
        }
        let deduped = bestPerKey.values.sorted { a, b in
            let ha = height(resolution: a.resolution) ?? 0
            let hb = height(resolution: b.resolution) ?? 0
            if ha != hb { return ha > hb }
            return a.bandwidth > b.bandwidth
        }
        return deduped.map { variant in
            HLSQualityOption(
                variant: variant,
                label: heightLabel(resolution: variant.resolution) ?? mbpsLabel(variant.bandwidth),
                detail: detailText(variant),
                estimatedBytes: duration.flatMap { d in
                    guard d > 0, variant.bandwidth > 0 else { return nil }
                    return Int64(d * Double(variant.bandwidth) / 8)
                }
            )
        }
    }

    /// "1920x1080" → 1080. Accepts x or ×.
    public static func height(resolution: String?) -> Int? {
        guard let resolution else { return nil }
        let parts = resolution.lowercased()
            .replacingOccurrences(of: "×", with: "x")
            .split(separator: "x")
        guard parts.count == 2, let h = Int(parts[1]) else { return nil }
        return h
    }

    /// "1920x1080" → "1080p".
    public static func heightLabel(resolution: String?) -> String? {
        height(resolution: resolution).map { "\($0)p" }
    }

    private static func mbpsLabel(_ bandwidth: Int) -> String {
        String(format: "%.1f Mbps", Double(bandwidth) / 1_000_000)
    }

    private static func bandwidthBucket(_ bandwidth: Int) -> Int {
        // Streams within ~500 kbps of each other are the same choice to a human.
        bandwidth / 500_000
    }

    private static func detailText(_ variant: HLSPlaylist.Variant) -> String {
        var parts: [String] = []
        if let codecs = variant.codecs {
            let c = codecs.lowercased()
            if c.contains("avc1") || c.contains("h264") { parts.append("H.264") }
            else if c.contains("hvc1") || c.contains("hev1") { parts.append("HEVC") }
            else if c.contains("av01") { parts.append("AV1") }
            else if c.contains("vp09") { parts.append("VP9") }
        }
        if variant.bandwidth > 0 {
            parts.append(mbpsLabel(variant.bandwidth))
        }
        return parts.joined(separator: " · ")
    }

    /// Total duration of a media playlist (sum of EXTINF), for size estimates.
    public static func totalDuration(of media: HLSPlaylist.Media) -> Double {
        media.segments.reduce(0) { $0 + $1.duration }
    }
}
