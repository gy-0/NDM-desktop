import Foundation
import NDMCore

/// Optional advanced media resolver. The product never exposes CLI flags —
/// callers get human labels, approximate size, then a downloadable selector.
public struct YtDlpFormat: Equatable, Sendable {
    public var id: String
    /// Display label like `1080p` / `Best`.
    public var label: String
    /// User-facing quality tier (0 = unknown / best). This normally matches
    /// pixel height, but cropped cinema video may be 3840x1920 in the 2160p tier.
    public var height: Int
    /// Rough total bytes (video + audio) when yt-dlp reports sizes.
    public var approximateBytes: Int64?
    /// Per-stream estimates in download order. Keeping video/audio separate lets
    /// the host replace estimates with real totals without a late 100% jump.
    public var componentBytes: [Int64]
    /// Matching estimate for the space-efficient AV1 / VP9 path. Keeping the
    /// two estimates separate prevents the picker from showing an H.264 size
    /// while the eventual MKV download selects a different stream.
    public var compactApproximateBytes: Int64?
    public var compactComponentBytes: [Int64]
    /// Exact selectors resolved during a single-video probe. These keep the
    /// eventual download aligned with the row's quality and size estimate.
    public var compatibleSelectorOverride: String?
    public var compactSelectorOverride: String?
    /// Short container hint for UI (`MP4`).
    public var containerHint: String
    public var isVideo: Bool
    /// YouTube enhanced / Premium 1080p VP9 (itag 616 HLS, 356 HTTPS).
    public var isHighBitrate: Bool

    public init(
        id: String,
        label: String,
        height: Int = 0,
        approximateBytes: Int64? = nil,
        componentBytes: [Int64] = [],
        compactApproximateBytes: Int64? = nil,
        compactComponentBytes: [Int64] = [],
        compatibleSelectorOverride: String? = nil,
        compactSelectorOverride: String? = nil,
        containerHint: String = "MP4",
        isVideo: Bool = true,
        isHighBitrate: Bool = false
    ) {
        self.id = id
        self.label = label
        self.height = height
        self.approximateBytes = approximateBytes
        self.componentBytes = componentBytes
        self.compactApproximateBytes = compactApproximateBytes
        self.compactComponentBytes = compactComponentBytes
        self.compatibleSelectorOverride = compatibleSelectorOverride
        self.compactSelectorOverride = compactSelectorOverride
        self.containerHint = containerHint
        self.isVideo = isVideo
        self.isHighBitrate = isHighBitrate
    }

    /// Compatibility shim for older call sites.
    public var note: String { containerHint }

    public var sizeText: String? {
        sizeText(for: .compatibleMP4)
    }

    public func estimatedBytes(for preference: YtDlpContainerPreference) -> Int64? {
        switch preference {
        case .compatibleMP4:
            return approximateBytes
        case .compactMKV:
            return compactApproximateBytes ?? approximateBytes
        }
    }

    public func estimatedComponentBytes(for preference: YtDlpContainerPreference) -> [Int64] {
        switch preference {
        case .compatibleMP4:
            return componentBytes
        case .compactMKV:
            return compactComponentBytes.isEmpty ? componentBytes : compactComponentBytes
        }
    }

    public func sizeText(for preference: YtDlpContainerPreference) -> String? {
        guard let bytes = estimatedBytes(for: preference), bytes > 0 else { return nil }
        return "≈ " + TaskPresentationFormatting.byteCount(bytes)
    }

    public func selector(for preference: YtDlpContainerPreference) -> String {
        switch preference {
        case .compatibleMP4:
            if let compatibleSelectorOverride { return compatibleSelectorOverride }
        case .compactMKV:
            if let compactSelectorOverride { return compactSelectorOverride }
        }
        return collectionSelector(for: preference)
    }

    /// Collection entries do not necessarily share yt-dlp format IDs, so a
    /// portable height-bounded selector is required instead of probe overrides.
    public func collectionSelector(for preference: YtDlpContainerPreference) -> String {
        let limit = height > 0 ? "[height<=\(height)]" : ""
        if isHighBitrate {
            return "bestvideo\(limit)[format_id=356]+bestaudio/bestvideo\(limit)[format_id=616]+bestaudio/bestvideo\(limit)+bestaudio/best\(limit)"
        }
        switch preference {
        case .compatibleMP4:
            return "bestvideo\(limit)[ext=mp4]+bestaudio[acodec^=mp4a]/bestvideo\(limit)+bestaudio/best\(limit)[ext=mp4]/\(id)"
        case .compactMKV:
            return "bestvideo\(limit)[vcodec^=av01]+bestaudio/bestvideo\(limit)[vcodec^=vp9]+bestaudio/\(id)"
        }
    }
}

public enum YtDlpContainerPreference: String, Codable, Sendable, Equatable {
    case compatibleMP4
    case compactMKV

    public var fileExtension: String { self == .compatibleMP4 ? "mp4" : "mkv" }
    public var mimeType: String { self == .compatibleMP4 ? "video/mp4" : "video/x-matroska" }
}

/// User-selected access state for sites that only expose media to a browser
/// session. This is persisted with the task so Retry behaves like a real retry.
public enum YtDlpCookieSource: Codable, Sendable, Equatable {
    case browser(String)
    case file(String)
}

/// Product-facing access categories. Region and entitlement restrictions are
/// not promises that a browser session can resolve the failure.
public enum YtDlpAccessIssue: Equatable, Sendable {
    case browserSessionRequired
    case browserDataUnavailable
    case regionRestricted
    case entitlementRequired
}

public struct YtDlpSubtitleTrack: Codable, Sendable, Equatable {
    public var code: String
    public var displayName: String
    public var isAutomatic: Bool

    public init(code: String, displayName: String, isAutomatic: Bool) {
        self.code = code
        self.displayName = displayName
        self.isAutomatic = isAutomatic
    }
}

/// A lightweight entry returned by a playlist/channel probe. Quality is chosen
/// once later and expressed as a height-bounded selector that remains valid
/// across entries with slightly different format ladders.
public struct YtDlpCollectionItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var url: String
    public var durationSeconds: Double?
    public var thumbnailURL: String?

    public init(
        id: String,
        title: String,
        url: String,
        durationSeconds: Double? = nil,
        thumbnailURL: String? = nil
    ) {
        self.id = id
        self.title = title
        self.url = url
        self.durationSeconds = durationSeconds
        self.thumbnailURL = thumbnailURL
    }
}

public struct YtDlpCollectionProbe: Codable, Sendable, Equatable {
    public var title: String
    public var items: [YtDlpCollectionItem]
    public var totalCount: Int
    public var isTruncated: Bool
    public var thumbnailURL: String?

    public init(
        title: String,
        items: [YtDlpCollectionItem],
        totalCount: Int,
        isTruncated: Bool,
        thumbnailURL: String? = nil
    ) {
        self.title = title
        self.items = items
        self.totalCount = totalCount
        self.isTruncated = isTruncated
        self.thumbnailURL = thumbnailURL
    }
}

public struct YtDlpDownloadOptions: Codable, Sendable, Equatable {
    public var container: YtDlpContainerPreference
    public var subtitleLanguage: String?
    public var cookieSource: YtDlpCookieSource?
    /// Present only for entries created by one collection enqueue operation.
    /// A generated batch id deliberately keeps two explicit downloads of the
    /// same playlist separate in the desktop presentation.
    public var collectionID: String?
    public var collectionTitle: String?
    public var collectionIndex: Int?
    public var collectionCount: Int?
    /// Probe-captured info JSON to feed through `--load-info-json`. Only
    /// honored while fresh (signed media URLs expire); stale paths fall back
    /// to normal URL extraction automatically.
    public var infoJSONPath: String?

    public init(
        container: YtDlpContainerPreference = .compatibleMP4,
        subtitleLanguage: String? = nil,
        cookieSource: YtDlpCookieSource? = nil,
        collectionID: String? = nil,
        collectionTitle: String? = nil,
        collectionIndex: Int? = nil,
        collectionCount: Int? = nil,
        infoJSONPath: String? = nil
    ) {
        self.container = container
        self.subtitleLanguage = subtitleLanguage
        self.cookieSource = cookieSource
        self.collectionID = collectionID
        self.collectionTitle = collectionTitle
        self.collectionIndex = collectionIndex
        self.collectionCount = collectionCount
        self.infoJSONPath = infoJSONPath
    }
}

public enum YtDlpAvailabilityNotice: String, Sendable { case previewOnly }

public struct YtDlpProbe: Equatable, Sendable {
    public var availabilityNotice: YtDlpAvailabilityNotice?
    public var title: String
    public var durationSeconds: Double?
    public var formats: [YtDlpFormat]
    /// Best available remote cover (YouTube / site thumbnail).
    public var thumbnailURL: String?
    public var subtitleTracks: [YtDlpSubtitleTrack]
    /// Raw yt-dlp info JSON captured by this probe. Feeding it back through
    /// `--load-info-json` lets the download skip the whole extraction round
    /// trip that the probe already paid for.
    public var infoJSONPath: String?

    public init(
        title: String,
        durationSeconds: Double?,
        formats: [YtDlpFormat],
        thumbnailURL: String? = nil,
        subtitleTracks: [YtDlpSubtitleTrack] = [],
        infoJSONPath: String? = nil,
        availabilityNotice: YtDlpAvailabilityNotice? = nil
    ) {
        self.availabilityNotice = availabilityNotice
        self.title = title
        self.durationSeconds = durationSeconds
        self.formats = formats
        self.thumbnailURL = thumbnailURL
        self.subtitleTracks = subtitleTracks
        self.infoJSONPath = infoJSONPath
    }
}

public enum YtDlpTool {
    // NDM owns cookies, output and execution options; ambient CLI configuration must not override them.
    static func executionArguments(_ arguments: [String]) -> [String] { ["--ignore-config"] + arguments }

    /// Must match the support root the site-compatibility updater installs
    /// into. The app sets this once at launch (QA previews use an isolated
    /// root); the default covers tests and headless tools.
    public static var siteCompatibilitySupportRoot: URL = DownloadStore.defaultSupportDirectory

    public static func find() -> String? {
        if let configuration = SiteCompatibilityConfiguration.fromBundle(),
           let refreshed = SiteCompatibilityToolStore.activeTool(
            configuration: configuration,
            supportRoot: siteCompatibilitySupportRoot
           ) {
            return refreshed.url.path
        }
        if let bundled = BundledToolLocator.find(
            ["yt-dlp", "yt-dlp_macos"],
            developerFallbacks: [
                "/opt/homebrew/bin/yt-dlp",
                "/usr/local/bin/yt-dlp",
            ]
        ) { return bundled }
#if DEBUG
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        proc.arguments = ["yt-dlp"]
        let out = Pipe()
        proc.standardOutput = out
        proc.standardError = Pipe()
        try? proc.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let path = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return path.isEmpty ? nil : path
#else
        // A release missing its private toolchain is a broken package. Never
        // let a developer's Homebrew install hide that shipping error.
        return nil
#endif
    }

    public static var isAvailable: Bool { find() != nil }

    /// Pay Gatekeeper's one-time scan of the unpackaged yt-dlp runtime in the
    /// background so the first user-visible probe does not sit on a 25s launch.
    public static func warm() {
        guard let bin = find() else { return }
        _ = ToolVersionProbe.run(toolAt: URL(fileURLWithPath: bin), arguments: executionArguments(["--version"]))
    }

    /// Load only plugins reviewed and shipped inside NDM's signed app bundle.
    /// yt-dlp otherwise searches user-writable default locations and imports
    /// every plugin it finds, which is too broad a trust boundary for an app.
    static func pluginArguments(bundle: Bundle = .main) -> [String] {
        pluginArguments(resourceURL: bundle.resourceURL)
    }

    static func pluginArguments(resourceURL: URL?) -> [String] {
        var arguments = ["--no-plugin-dirs"]
        guard let resourceURL else { return arguments }
        let directory = resourceURL.appendingPathComponent("yt-dlp-plugins", isDirectory: true)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: directory.path, isDirectory: &isDirectory),
              isDirectory.boolValue else { return arguments }
        arguments += ["--plugin-dirs", directory.path]
        return arguments
    }

    private static func javascriptRuntimeArguments() -> [String] {
        guard let deno = BundledToolLocator.find(
            ["deno"],
            developerFallbacks: ["/opt/homebrew/bin/deno", "/usr/local/bin/deno"]
        ) else { return [] }
        return ["--js-runtimes", "deno:\(deno)"]
    }

    private static func bundledMediaArguments() -> [String] {
        guard let ffmpeg = FFmpegTool.find() else { return [] }
        return ["--ffmpeg-location", ffmpeg]
    }

    /// The standalone Python runtime does not automatically inherit macOS
    /// Keychain trust (for example a user's trusted local HTTPS proxy). Keep
    /// TLS verification enabled while asking yt-dlp to use our system CA bridge.
    private static func trustStoreArguments() -> [String] {
        guard MacOSTrustStore.certificateBundleURL != nil else { return [] }
        return ["--compat-options", "no-certifi"]
    }

    static func findAria2c() -> String? {
        for path in ["/opt/homebrew/bin/aria2c", "/usr/local/bin/aria2c"] {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    /// Probe page metadata + 3–5 quality tiers with size estimates.
    public static func probe(
        url: String,
        cookieSource: YtDlpCookieSource? = nil
    ) async throws -> YtDlpProbe {
        guard let bin = find() else {
            // An empty probe used to masquerade as "not a video page" and made
            // the composer fall back to a plain HTTP fetch — saving TikTok
            // pages as .mp4. A missing tool is an error the UI can recover
            // from (install/point NDM_TOOL_DIR), not a quiet downgrade.
            throw EngineError.mergeFailed("yt-dlp not found")
        }
        return try await probe(url: url, cookieSource: cookieSource, usingExecutable: bin)
    }

    static func probe(url: String, cookieSource: YtDlpCookieSource? = nil, usingExecutable bin: String, cacheDirectory: URL? = nil) async throws -> YtDlpProbe {
        let captured = try await runCaptured(
            bin,
            pluginArguments() + trustStoreArguments() + javascriptRuntimeArguments() + bundledMediaArguments() + cookieArguments(cookieSource) + [
            "-J",
            "--no-download",
            "--no-playlist",
            "--socket-timeout", "20",
            url,
        ], timeoutSeconds: 90, cancelToken: nil, onLine: nil)
        guard let jsonText = extractJSONObject(from: captured.stdout),
              let data = jsonText.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EngineError.mergeFailed("yt-dlp returned no usable video info")
        }
        if let err = json["error"] as? String, !err.isEmpty {
            throw EngineError.mergeFailed(err)
        }

        let title = (json["title"] as? String) ?? ""
        let duration = json["duration"] as? Double
        let formats = (json["formats"] as? [[String: Any]]) ?? []
        let tiers = buildTiers(
            from: formats,
            duration: duration,
            includeYouTubeHighBitrate: isYouTubeMediaURL(url)
        )
        return YtDlpProbe(
            title: title,
            durationSeconds: duration,
            formats: tiers,
            thumbnailURL: pickThumbnailURL(from: json),
            subtitleTracks: subtitleTracks(from: json),
            infoJSONPath: cacheInfoJSON(jsonText, forURL: url, directory: cacheDirectory),
            availabilityNotice: availabilityNotice(json: json, stderr: captured.stderr)
        )
    }

    static func availabilityNotice(json: [String: Any], stderr: String) -> YtDlpAvailabilityNotice? {
        guard json["extractor_key"] as? String == "BiliBiliBangumi" else { return nil }
        let prefix = "WARNING: [BiliBiliBangumi] Only preview format is available,"
        return stderr.split(whereSeparator: { $0 == "\n" || $0 == "\r" }).contains {
            $0.trimmingCharacters(in: .whitespaces).hasPrefix(prefix)
        } ? .previewOnly : nil
    }

    /// The probe already carried the full extraction (signed media URLs
    /// included). Persist it so the actual download can start transferring
    /// immediately through `--load-info-json` instead of re-extracting.
    static let infoJSONFreshness: TimeInterval = 30 * 60
    /// Below this size, aria2c's per-piece ramp-up is slower than yt-dlp's
    /// native downloader (measured ~10s vs ~1s on a 3 MB audio stream).
    static let aria2MinimumBytes: Int64 = 48 * 1024 * 1024

    static func isYouTubeMediaURL(_ url: String) -> Bool {
        guard let host = URLComponents(string: url)?.host?
            .lowercased()
            .trimmingCharacters(in: CharacterSet(charactersIn: ".")) else {
            return false
        }
        return ["youtube.com", "youtu.be", "youtube-nocookie.com", "googlevideo.com"]
            .contains { host == $0 || host.hasSuffix(".\($0)") }
    }

    static func infoJSONCacheDirectory(
        supportDirectory: String? = ProcessInfo.processInfo.environment["NDM_SUPPORT_DIR"]
    ) -> URL {
        if let supportDirectory, !supportDirectory.isEmpty {
            return URL(fileURLWithPath: supportDirectory, isDirectory: true)
                .appendingPathComponent("Preflight", isDirectory: true)
        }
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base
            .appendingPathComponent("dev.ndm.open", isDirectory: true)
            .appendingPathComponent("Preflight", isDirectory: true)
    }

    private static func cacheInfoJSON(_ jsonText: String, forURL url: String, directory suppliedDirectory: URL? = nil) -> String? {
        let directory = suppliedDirectory ?? infoJSONCacheDirectory()
        let fileManager = FileManager.default
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        // Opportunistic pruning keeps the cache bounded without a scheduler.
        if let siblings = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ) {
            let cutoff = Date().addingTimeInterval(-24 * 3600)
            for sibling in siblings {
                let modified = (try? sibling.resourceValues(forKeys: [.contentModificationDateKey])
                    .contentModificationDate) ?? .distantPast
                if modified < cutoff { try? fileManager.removeItem(at: sibling) }
            }
        }
        var hash: UInt64 = 1_469_598_103_934_665_603
        for byte in url.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 1_099_511_628_211
        }
        let destination = directory.appendingPathComponent(String(format: "%016llx.yt1.info.json", hash))
        guard (try? jsonText.write(to: destination, atomically: true, encoding: .utf8)) != nil else {
            return nil
        }
        return destination.path
    }

    static func freshInfoJSONPath(_ path: String?) -> String? {
        guard let path, FileManager.default.fileExists(atPath: path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attrs[.modificationDate] as? Date,
              Date().timeIntervalSince(modified) < infoJSONFreshness else {
            return nil
        }
        return path
    }

    /// Fetch a lightweight collection index without resolving formats for
    /// every entry. The first item's normal probe is reused for quality choice.
    public static func probeCollection(
        url: String,
        cookieSource: YtDlpCookieSource? = nil,
        limit: Int = 100
    ) async throws -> YtDlpCollectionProbe? {
        guard let bin = find() else { return nil }
        let cappedLimit = max(1, min(500, limit))
        let output = try await run(
            bin,
            pluginArguments() + trustStoreArguments() + javascriptRuntimeArguments() + cookieArguments(cookieSource) + [
                "-J",
                "--flat-playlist",
                "--playlist-end", "\(cappedLimit)",
                "--no-download",
                "--no-warnings",
                "--socket-timeout", "20",
                url,
            ],
            timeoutSeconds: 90
        )
        guard let jsonText = extractJSONObject(from: output),
              let data = jsonText.data(using: .utf8),
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw EngineError.mergeFailed("media resolver returned no usable collection info")
        }
        return collectionProbe(from: json, sourceURL: url, limit: cappedLimit)
    }

    static func collectionProbe(
        from json: [String: Any],
        sourceURL: String,
        limit: Int
    ) -> YtDlpCollectionProbe? {
        let rawEntries = (json["entries"] as? [[String: Any]]) ?? []
        let type = (json["_type"] as? String)?.lowercased()
        guard type == "playlist" || !rawEntries.isEmpty else { return nil }

        let items = rawEntries.prefix(max(1, limit)).compactMap { item -> YtDlpCollectionItem? in
            guard let resolvedURL = collectionEntryURL(item, sourceURL: sourceURL) else { return nil }
            let id = (item["id"] as? String) ?? resolvedURL
            let title = ((item["title"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return YtDlpCollectionItem(
                id: id,
                title: title.isEmpty ? id : title,
                url: resolvedURL,
                durationSeconds: number(item["duration"]),
                thumbnailURL: pickThumbnailURL(from: item)
            )
        }
        guard !items.isEmpty else { return nil }

        let declaredCount = integer(json["playlist_count"])
            ?? integer(json["n_entries"])
        let reportedCount = declaredCount ?? rawEntries.count
        let totalCount = max(items.count, reportedCount)
        let title = ((json["title"] as? String)
            ?? (json["playlist_title"] as? String)
            ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return YtDlpCollectionProbe(
            title: title,
            items: items,
            totalCount: totalCount,
            isTruncated: totalCount > items.count
                || (declaredCount == nil && rawEntries.count >= limit),
            thumbnailURL: pickThumbnailURL(from: json)
        )
    }

    private static func collectionEntryURL(
        _ item: [String: Any],
        sourceURL: String
    ) -> String? {
        for key in ["webpage_url", "original_url", "url"] {
            guard let value = item[key] as? String, !value.isEmpty else { continue }
            if let url = URL(string: value),
               let scheme = url.scheme?.lowercased(),
               scheme == "http" || scheme == "https" {
                return value
            }
        }
        guard let id = item["id"] as? String, !id.isEmpty,
              let host = URL(string: sourceURL)?.host?.lowercased() else { return nil }
        if host.contains("youtube.com") || host == "youtu.be" {
            return "https://www.youtube.com/watch?v=\(id)"
        }
        if host.contains("bilibili.com"), id.uppercased().hasPrefix("BV") {
            return "https://www.bilibili.com/video/\(id)"
        }
        return nil
    }

    private static func number(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        return nil
    }

    private static func integer(_ value: Any?) -> Int? {
        if let value = value as? Int { return value }
        if let value = value as? NSNumber { return value.intValue }
        return nil
    }

    static func subtitleTracks(from json: [String: Any]) -> [YtDlpSubtitleTrack] {
        let manual = (json["subtitles"] as? [String: Any]) ?? [:]
        let automatic = (json["automatic_captions"] as? [String: Any]) ?? [:]
        let codes = Set(manual.keys).union(automatic.keys)
        let locale = Locale.current
        let tracks = codes.map { code in
            let base = code.split(separator: "-").first.map(String.init) ?? code
            let localized = locale.localizedString(forLanguageCode: base) ?? code
            return YtDlpSubtitleTrack(
                code: code,
                displayName: localized,
                isAutomatic: manual[code] == nil
            )
        }
        return tracks.sorted { a, b in
            let aRank = subtitlePreferenceRank(code: a.code, preferredLanguages: Locale.preferredLanguages)
            let bRank = subtitlePreferenceRank(code: b.code, preferredLanguages: Locale.preferredLanguages)
            if aRank != bRank { return aRank < bRank }
            if a.isAutomatic != b.isAutomatic { return !a.isAutomatic }
            return a.displayName.localizedStandardCompare(b.displayName) == .orderedAscending
        }
    }

    /// Pick a sensible first-use language without silently enabling subtitles.
    /// Exact system-language matches win, followed by the same base language,
    /// then English. An uncommon alphabetical first item must never become the
    /// apparent default merely because yt-dlp returned an unordered dictionary.
    public static func preferredSubtitleIndex(
        in tracks: [YtDlpSubtitleTrack],
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> Int? {
        guard let index = tracks.indices.min(by: { lhs, rhs in
            let left = subtitlePreferenceRank(
                code: tracks[lhs].code,
                preferredLanguages: preferredLanguages
            )
            let right = subtitlePreferenceRank(
                code: tracks[rhs].code,
                preferredLanguages: preferredLanguages
            )
            if left != right { return left < right }
            if tracks[lhs].isAutomatic != tracks[rhs].isAutomatic {
                return !tracks[lhs].isAutomatic
            }
            return tracks[lhs].displayName.localizedStandardCompare(tracks[rhs].displayName) == .orderedAscending
        }) else { return nil }
        return subtitlePreferenceRank(
            code: tracks[index].code,
            preferredLanguages: preferredLanguages
        ) < 20_000 ? index : nil
    }

    private static func subtitlePreferenceRank(
        code: String,
        preferredLanguages: [String]
    ) -> Int {
        let normalized = code.replacingOccurrences(of: "_", with: "-").lowercased()
        let base = normalized.split(separator: "-").first.map(String.init) ?? normalized
        for (index, rawPreference) in preferredLanguages.enumerated() {
            let preference = rawPreference.replacingOccurrences(of: "_", with: "-").lowercased()
            let preferredBase = preference.split(separator: "-").first.map(String.init) ?? preference
            if normalized == preference { return index * 4 }
            if base == preferredBase { return index * 4 + 1 }
        }
        if base == "en" { return 10_000 }
        if base == "zh" { return 10_001 }
        return 20_000
    }

    private static func pickThumbnailURL(from json: [String: Any]) -> String? {
        if let direct = json["thumbnail"] as? String, !direct.isEmpty {
            return direct
        }
        let thumbs = (json["thumbnails"] as? [[String: Any]]) ?? []
        // Prefer the largest width when yt-dlp provides a ladder.
        let ranked = thumbs.compactMap { item -> (Int, String)? in
            guard let url = item["url"] as? String, !url.isEmpty else { return nil }
            let w = (item["width"] as? Int) ?? (item["height"] as? Int) ?? 0
            return (w, url)
        }
        .sorted { $0.0 > $1.0 }
        return ranked.first?.1
    }

    /// Back-compat wrapper used by tests / simple callers.
    public static func listFormats(url: String) async throws -> [YtDlpFormat] {
        try await probe(url: url).formats
    }

    public static func accessIssue(error: Error) -> YtDlpAccessIssue? {
        accessIssue(in: error.localizedDescription)
    }

    static func accessIssue(in rawOutput: String) -> YtDlpAccessIssue? {
        let text = rawOutput.folding(
            options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
            locale: Locale(identifier: "en_US_POSIX")
        )
        let browserDataMarkers = [
            "could not copy", "cookie database", "cookies could not be loaded",
            "failed to decrypt", "permission denied", "database is locked",
            "keyring", "keychain", "dpapi", "secretstorage",
        ]
        if text.contains("cookie"), browserDataMarkers.contains(where: text.contains) {
            return .browserDataUnavailable
        }

        // These restrictions describe viewing rights, not proof that cookies
        // are missing. Specific causes outrank generic browser-login advice.
        let regionMarkers = [
            "not available in your country", "not available in your region",
            "geo-restricted", "geo restricted", "地区限制", "所在地区不可用",
        ]
        if regionMarkers.contains(where: text.contains) { return .regionRestricted }
        let entitlementMarkers = [
            "members-only", "members only", "premium-only", "premium only",
            "subscriber-only", "subscriber only", "仅限会员", "会员专享",
            "メンバー限定", "회원 전용",
        ]
        if entitlementMarkers.contains(where: text.contains) { return .entitlementRequired }

        let sessionMarkers = [
            "fresh cookies", "cookies are needed", "cookies-from-browser",
            "sign in to confirm", "sign in to view", "sign in required",
            "login required", "log in to", "authentication required",
            "account required", "confirm your age", "age-restricted",
            "age restricted", "only available to registered users",
            "this video is private", "private video",
            // Major supported sites frequently return localized access text.
            "请登录", "需要登录", "登录后", "账号登录", "私密视频", "年龄限制",
            "ログイン", "サインイン", "非公開", "年齢制限",
            "로그인", "비공개", "연령 제한",
            "inicia sesión", "iniciar sesión", "vídeo privado",
            "connexion requise", "connectez-vous", "vidéo privée",
            "anmelden", "privates video",
        ]
        if sessionMarkers.contains(where: text.contains) {
            return .browserSessionRequired
        }
        return nil
    }

    public static func requiresCookies(error: Error) -> Bool {
        switch accessIssue(error: error) {
        case .browserSessionRequired, .browserDataUnavailable: return true
        case .regionRestricted, .entitlementRequired, nil: return false
        }
    }

    /// Preserve the specific restriction even when generic cookie advice follows
    /// it on a later stderr line. No new access or cookie retry is performed here.
    static func failureMessage(stderr: String, stdout: String) -> String {
        let lines = stderr.split(separator: "\n").map(String.init)
        let issue = accessIssue(in: stderr)
        let accessLine = issue.flatMap { issue in lines.reversed().first { accessIssue(in: $0) == issue } }
        return accessLine ?? lines.last ?? stdout.split(separator: "\n").last.map(String.init) ?? "yt-dlp failed"
    }

    static func cookieArguments(_ source: YtDlpCookieSource?) -> [String] {
        switch source {
        case .browser(let browser):
            return ["--cookies-from-browser", browser]
        case .file(let path):
            return ["--cookies", path]
        case nil:
            return []
        }
    }

    static func buildTiers(
        from formats: [[String: Any]],
        duration: Double?,
        includeYouTubeHighBitrate: Bool = false
    ) -> [YtDlpFormat] {
        var heights = Set<Int>()
        for fmt in formats {
            let vcodec = (fmt["vcodec"] as? String) ?? "none"
            guard vcodec != "none" else { continue }
            let h = qualityHeight(of: fmt)
            if h > 0 { heights.insert(h) }
        }

        let ladder = [2160, 1440, 1080, 720, 480, 360, 240]
        var picked = ladder.filter(heights.contains)
        if picked.isEmpty {
            picked = Array(heights.sorted(by: >).prefix(4))
        } else if picked.count < 4 {
            for height in heights.sorted(by: >) where !picked.contains(height) {
                picked.append(height)
                if picked.count == 4 { break }
            }
            picked.sort(by: >)
        }
        if picked.isEmpty {
            guard let video = bestCompatibleVideo(in: formats, maxHeight: nil) else {
                // yt-dlp's GenericExtractor exposes arbitrary attachments as a
                // format too. No video stream means there is no quality picker.
                return []
            }
            let audio = needsSeparateAudio(video) ? bestCompatibleAudio(in: formats) : nil
            let components = estimateComponentBytes(video: video, audio: audio, duration: duration)
            let compactVideo = bestCompactVideo(in: formats, maxHeight: nil) ?? video
            let compactAudio = needsSeparateAudio(compactVideo) ? bestAudio(in: formats) : nil
            let compactComponents = estimateComponentBytes(
                video: compactVideo,
                audio: compactAudio,
                duration: duration
            )
            return [
                YtDlpFormat(
                    id: "bv*+ba/b",
                    label: "Best",
                    height: 0,
                    approximateBytes: components.isEmpty ? nil : components.reduce(0, +),
                    componentBytes: components,
                    compactApproximateBytes: compactComponents.isEmpty ? nil : compactComponents.reduce(0, +),
                    compactComponentBytes: compactComponents,
                    containerHint: "MP4",
                    isVideo: true
                ),
            ]
        }

        let regularFormats = includeYouTubeHighBitrate
            ? formats.filter { !isYouTubeHighBitrateFormat($0) }
            : formats
        let catalog = picked.map { h in
            makeHeightTier(from: regularFormats, height: h, duration: duration)
        }
        var expanded: [YtDlpFormat] = []
        expanded.reserveCapacity(catalog.count + 2)
        for tier in catalog {
            if includeYouTubeHighBitrate,
               let high = highBitrateTier(from: formats, height: tier.height, duration: duration) {
                expanded.append(high)
            }
            expanded.append(tier)
        }
        return expanded
    }

    private static func makeHeightTier(
        from formats: [[String: Any]],
        height: Int,
        duration: Double?
    ) -> YtDlpFormat {
        let video = bestCompatibleVideo(in: formats, maxHeight: height)
        let audio = needsSeparateAudio(video) ? bestCompatibleAudio(in: formats) : nil
        let components = estimateComponentBytes(video: video, audio: audio, duration: duration)
        let bytes = components.isEmpty ? nil : components.reduce(0, +)
        let compactVideo = bestCompactVideo(in: formats, maxHeight: height)
        let compactAudio = needsSeparateAudio(compactVideo) ? bestAudio(in: formats) : nil
        let compactComponents = estimateComponentBytes(
            video: compactVideo,
            audio: compactAudio,
            duration: duration
        )
        return YtDlpFormat(
            id: "bestvideo[height<=\(height)]+bestaudio/best[height<=\(height)]/best",
            label: "\(height)p",
            height: height,
            approximateBytes: bytes,
            componentBytes: components,
            compactApproximateBytes: compactComponents.isEmpty ? nil : compactComponents.reduce(0, +),
            compactComponentBytes: compactComponents,
            compatibleSelectorOverride: exactSelector(video: video, audio: audio),
            compactSelectorOverride: exactSelector(video: compactVideo, audio: compactAudio),
            containerHint: "MP4",
            isVideo: true
        )
    }

    /// itag 616 (iOS HLS) and 356 (HTTPS) are the enhanced-bitrate 1080p VP9
    /// encodes. Regular AVC 137 is often a higher number of bits for worse
    /// efficiency, so it is never promoted just because `tbr` is larger.
    static let youtubeHighBitrateFormatIDs: Set<String> = ["616", "356"]

    static func formatID(of format: [String: Any]) -> String {
        if let value = format["format_id"] as? String { return value }
        if let value = format["format_id"] as? Int { return String(value) }
        return ""
    }

    static func canonicalYouTubeFormatID(_ raw: String) -> String {
        String(raw.split(separator: "-").first ?? Substring(raw))
    }

    static func isYouTubeHighBitrateFormat(_ format: [String: Any]) -> Bool {
        let id = canonicalYouTubeFormatID(formatID(of: format))
        if youtubeHighBitrateFormatIDs.contains(id) { return true }
        let note = ((format["format_note"] as? String) ?? "").lowercased()
        return note.contains("premium") || note.contains("enhanced bitrate")
    }

    static func highBitrateTier(
        from formats: [[String: Any]],
        height: Int,
        duration: Double?
    ) -> YtDlpFormat? {
        let candidates = formats.filter {
            isYouTubeHighBitrateFormat($0) && qualityHeight(of: $0) == height
        }
        guard let video = bestVideo(in: candidates, maxHeight: nil) else { return nil }
        let audio = needsSeparateAudio(video)
            ? (bestCompatibleAudio(in: formats) ?? bestAudio(in: formats))
            : nil
        guard let selector = exactSelector(video: video, audio: audio) else { return nil }
        let components = estimateComponentBytes(video: video, audio: audio, duration: duration)
        return YtDlpFormat(
            id: selector,
            label: "\(height)p 高码率",
            height: height,
            approximateBytes: components.isEmpty ? nil : components.reduce(0, +),
            componentBytes: components,
            compactApproximateBytes: components.isEmpty ? nil : components.reduce(0, +),
            compactComponentBytes: components,
            compatibleSelectorOverride: selector,
            compactSelectorOverride: selector,
            containerHint: "MP4",
            isVideo: true,
            isHighBitrate: true
        )
    }

    private static func bestCompatibleVideo(
        in formats: [[String: Any]],
        maxHeight: Int?
    ) -> [String: Any]? {
        let topTier = formatsAtBestQuality(in: formats, maxHeight: maxHeight)
        return bestVideo(in: topTier, maxHeight: nil, codecPrefixes: ["avc1"])
            ?? bestVideo(in: topTier, maxHeight: nil, extensions: ["mp4"])
            ?? bestVideo(in: topTier, maxHeight: nil)
    }

    private static func bestCompactVideo(
        in formats: [[String: Any]],
        maxHeight: Int?
    ) -> [String: Any]? {
        let topTier = formatsAtBestQuality(in: formats, maxHeight: maxHeight)
        return bestVideo(in: topTier, maxHeight: nil, codecPrefixes: ["av01"])
            ?? bestVideo(in: topTier, maxHeight: nil, codecPrefixes: ["vp9", "vp09"])
            ?? bestVideo(in: topTier, maxHeight: nil)
    }

    private static func formatsAtBestQuality(
        in formats: [[String: Any]],
        maxHeight: Int?
    ) -> [[String: Any]] {
        let candidates = formats.filter { format in
            let vcodec = (format["vcodec"] as? String) ?? "none"
            guard vcodec != "none" else { return false }
            let height = qualityHeight(of: format)
            guard height > 0 else { return false }
            return maxHeight.map { height <= $0 } ?? true
        }
        guard let bestHeight = candidates.map(qualityHeight(of:)).max() else { return [] }
        return candidates.filter { qualityHeight(of: $0) == bestHeight }
    }

    /// YouTube and other platforms name cinematic/cropped streams by their
    /// standard quality tier. For example 3840x1920 is still the 2160p tier.
    /// Falling back to the physical height keeps generic sites working.
    private static func qualityHeight(of format: [String: Any]) -> Int {
        if let note = format["format_note"] as? String,
           let match = note.range(of: #"\b\d{3,4}p"#, options: .regularExpression) {
            let digits = note[match].dropLast()
            if let tier = Int(digits), tier > 0 { return tier }
        }
        return format["height"] as? Int ?? 0
    }

    private static func exactSelector(
        video: [String: Any]?,
        audio: [String: Any]?
    ) -> String? {
        guard let video,
              let videoID = video["format_id"] as? String,
              !videoID.isEmpty else { return nil }
        guard needsSeparateAudio(video) else { return videoID }
        guard let audioID = audio?["format_id"] as? String,
              !audioID.isEmpty else {
            // Some extractors expose an HLS audio rendition only while yt-dlp
            // evaluates its format selector. X/Twitter is the important case:
            // the probed `formats` array contains video-only `hls-*` entries,
            // but `bestvideo+bestaudio` resolves the matching
            // `hls-audio-*-Audio` rendition. Pinning just the known video ID
            // overrides that resolver behavior and produces a silent file.
            // Fall back to our portable selector so yt-dlp remains responsible
            // for pairing the site's video and audio streams.
            return nil
        }
        return "\(videoID)+\(audioID)"
    }

    private static func bestCompatibleAudio(in formats: [[String: Any]]) -> [String: Any]? {
        let mp4Audio = formats.filter {
            let vcodec = ($0["vcodec"] as? String) ?? "none"
            let acodec = ($0["acodec"] as? String) ?? "none"
            return vcodec == "none" && acodec.hasPrefix("mp4a")
        }
        return mp4Audio.isEmpty ? bestAudio(in: formats) : bestAudio(in: mp4Audio)
    }

    private static func bestVideo(
        in formats: [[String: Any]],
        maxHeight: Int?,
        codecPrefixes: [String] = [],
        extensions: [String] = []
    ) -> [String: Any]? {
        let candidates = formats.filter { fmt in
            let vcodec = (fmt["vcodec"] as? String) ?? "none"
            guard vcodec != "none" else { return false }
            let h = qualityHeight(of: fmt)
            guard h > 0 else { return false }
            if let maxHeight, h > maxHeight { return false }
            if !codecPrefixes.isEmpty,
               !codecPrefixes.contains(where: vcodec.hasPrefix) { return false }
            if !extensions.isEmpty {
                let ext = (fmt["ext"] as? String) ?? ""
                if !extensions.contains(ext) { return false }
            }
            return true
        }
        // A `bestvideo+bestaudio/best` selector prefers video-only streams.
        // Estimating from a progressive stream and then adding audio again is
        // the main source of an inflated total and the late progress jump.
        let videoOnly = candidates.filter {
            (($0["acodec"] as? String) ?? "none") == "none"
        }
        return (videoOnly.isEmpty ? candidates : videoOnly).max { a, b in
            let ha = a["height"] as? Int ?? 0
            let hb = b["height"] as? Int ?? 0
            if ha != hb { return ha < hb }
            let ta = a["tbr"] as? Double ?? 0
            let tb = b["tbr"] as? Double ?? 0
            return ta < tb
        }
    }

    private static func needsSeparateAudio(_ video: [String: Any]?) -> Bool {
        guard let video else { return false }
        return ((video["acodec"] as? String) ?? "none") == "none"
    }

    private static func bestAudio(in formats: [[String: Any]]) -> [String: Any]? {
        let candidates = formats.filter { fmt in
            let vcodec = (fmt["vcodec"] as? String) ?? "none"
            let acodec = (fmt["acodec"] as? String) ?? "none"
            return vcodec == "none" && acodec != "none"
        }
        return candidates.max { a, b in
            let ta = a["tbr"] as? Double ?? a["abr"] as? Double ?? 0
            let tb = b["tbr"] as? Double ?? b["abr"] as? Double ?? 0
            return ta < tb
        }
    }

    private static func reportedSize(_ fmt: [String: Any]?) -> Int64? {
        guard let fmt else { return nil }
        if let n = fmt["filesize"] as? Int64, n > 0 { return n }
        if let n = fmt["filesize"] as? Int, n > 0 { return Int64(n) }
        if let n = fmt["filesize_approx"] as? Int64, n > 0 { return n }
        if let n = fmt["filesize_approx"] as? Int, n > 0 { return Int64(n) }
        if let n = fmt["filesize_approx"] as? Double, n > 0 { return Int64(n) }
        return nil
    }

    private static func estimateComponentBytes(
        video: [String: Any]?,
        audio: [String: Any]?,
        duration: Double?
    ) -> [Int64] {
        func estimate(_ format: [String: Any]?, audio: Bool) -> Int64? {
            if let size = reportedSize(format), size > 0 { return size }
            guard let format, let duration, duration > 0 else { return nil }
            let kbps = audio
                ? (format["abr"] as? Double ?? format["tbr"] as? Double ?? 0)
                : (format["tbr"] as? Double ?? 0)
            guard kbps > 0 else { return nil }
            return Int64((kbps * 1000 / 8) * duration)
        }

        return [estimate(video, audio: false), estimate(audio, audio: true)]
            .compactMap { $0 }
            .filter { $0 > 0 }
    }

    /// Live progress parsed from yt-dlp `--newline` / progress-template output.
    public struct ProgressReport: Sendable, Equatable {
        public var downloadedBytes: Int64
        public var totalBytes: Int64
        public var bytesPerSecond: Double
        public var etaSeconds: Double?
        /// yt-dlp format id, or aria2 transfer id. Stable component ids let the
        /// engine aggregate any site's separate video/audio streams correctly.
        public var componentID: String?
        public var status: String?
        /// Present for true yt-dlp postprocessor events. This lets the product
        /// distinguish track merging from subtitle preparation without parsing
        /// human log text.
        public var phase: DownloadPhase?

        public init(
            downloadedBytes: Int64 = 0,
            totalBytes: Int64 = 0,
            bytesPerSecond: Double = 0,
            etaSeconds: Double? = nil,
            componentID: String? = nil,
            status: String? = nil,
            phase: DownloadPhase? = nil
        ) {
            self.downloadedBytes = downloadedBytes
            self.totalBytes = totalBytes
            self.bytesPerSecond = bytesPerSecond
            self.etaSeconds = etaSeconds
            self.componentID = componentID
            self.status = status
            self.phase = phase
        }
    }

    /// Download a chosen format selector into `directory`.
    /// Streams yt-dlp progress lines into `onProgress` when provided.
    public static func download(
        url: String,
        formatID: String,
        directory: URL,
        preferredName: String?,
        connections: Int = 1,
        forceOverwrite: Bool = false,
        options: YtDlpDownloadOptions = .init(),
        estimatedBytes: Int64 = 0,
        temporaryDirectory: URL? = nil,
        cancelToken: CancelToken? = nil,
        onProgress: (@Sendable (ProgressReport) -> Void)? = nil
    ) async throws -> URL {
        guard let bin = find() else {
            throw EngineError.mergeFailed("yt-dlp not found")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let temporaryDirectory {
            try FileManager.default.createDirectory(
                at: temporaryDirectory,
                withIntermediateDirectories: true
            )
        }
        let before = Set(
            ((try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            )) ?? []).map(\.path)
        )
        let template: String
        if let preferredName, !preferredName.isEmpty {
            let stem = sanitizeFilename(preferredName)
            template = directory.appendingPathComponent("\(stem).%(ext)s").path
        } else {
            template = directory.appendingPathComponent("%(title)s.%(ext)s").path
        }
        func attempt(infoJSONPath: String?) async throws -> String {
            let args = pluginArguments() + trustStoreArguments() + javascriptRuntimeArguments() + bundledMediaArguments() + downloadArguments(
                url: url,
                formatID: formatID,
                outputTemplate: template,
                connections: connections,
                forceOverwrite: forceOverwrite,
                aria2cPath: findAria2c(),
                options: options,
                estimatedBytes: estimatedBytes,
                infoJSONPath: infoJSONPath,
                temporaryDirectory: temporaryDirectory
            )
            return try await runStreaming(
                bin,
                args,
                timeoutSeconds: 60 * 30,
                cancelToken: cancelToken,
                onLine: { line in
                    if let report = parseProgressLine(line) {
                        onProgress?(report)
                    }
                }
            )
        }
        var output: String
        if let freshInfoJSON = freshInfoJSONPath(options.infoJSONPath) {
            do {
                output = try await attempt(infoJSONPath: freshInfoJSON)
            } catch {
                if cancelToken?.isPaused == true { throw EngineError.paused }
                if cancelToken?.isCancelled == true { throw EngineError.cancelled }
                // Signed media URLs inside the replayed probe can expire or be
                // bound to another network path. Drop the poisoned cache so a
                // later retry cannot reuse the same 403 address.
                try? FileManager.default.removeItem(atPath: freshInfoJSON)
                output = try await attempt(infoJSONPath: nil)
            }
        } else {
            output = try await attempt(infoJSONPath: nil)
        }
        if cancelToken?.isPaused == true { throw EngineError.paused }
        if cancelToken?.isCancelled == true { throw EngineError.cancelled }
        if let pathLine = output.split(whereSeparator: \.isNewline)
            .last(where: { $0.hasPrefix("NDM_DEST|") }) {
            let path = String(pathLine.dropFirst("NDM_DEST|".count))
            let exact = URL(fileURLWithPath: path)
            if FileManager.default.fileExists(atPath: exact.path) {
                try normalizeSubtitleSidecarIfNeeded(
                    for: exact,
                    options: options,
                    forceOverwrite: forceOverwrite
                )
                try validateExpectedAudio(in: exact, selector: formatID, cancelToken: cancelToken)
                return exact
            }
        }
        let after = ((try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )) ?? [])
        let created = after.filter { !before.contains($0.path) }
        let candidates = created.isEmpty ? after : created
        guard let newest = candidates.max(by: { a, b in
            let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return da < db
        }) else {
            throw EngineError.mergeFailed("yt-dlp finished but no file appeared")
        }
        try normalizeSubtitleSidecarIfNeeded(
            for: newest,
            options: options,
            forceOverwrite: forceOverwrite
        )
        try validateExpectedAudio(in: newest, selector: formatID, cancelToken: cancelToken)
        return newest
    }

    /// A selector containing `+` asks yt-dlp to combine independent streams;
    /// NDM's video selectors use that second component for audio. Validate the
    /// result so a failed site-specific rendition/merge cannot be reported as
    /// a successful but silent download.
    static func selectorExpectsAudio(_ selector: String) -> Bool {
        selector.split(separator: "/").contains { branch in
            branch.contains("+")
        }
    }

    private static func validateExpectedAudio(
        in file: URL,
        selector: String,
        cancelToken: CancelToken?
    ) throws {
        guard selectorExpectsAudio(selector) else { return }
        guard let ffmpeg = FFmpegTool.find() else {
            throw EngineError.mergeFailed(L10n.t(
                "The downloaded video's audio track could not be verified because the built-in media component is unavailable.",
                "内置媒体组件不可用，无法验证下载视频的音轨。"
            ))
        }
        let streams = try FFmpegTool.streamPresence(ffmpeg: ffmpeg, input: file, cancelToken: cancelToken)
        guard streams.hasAudio else {
            throw EngineError.mergeFailed(L10n.t(
                "The site returned a video without the requested audio track. The file was preserved, but the download was not marked complete.",
                "网站返回的视频缺少所选音轨。文件已保留，但本次下载不会被标记为完成。"
            ))
        }
    }

    /// yt-dlp normally writes `Movie.zh-Hans.srt`. NDM currently lets the user
    /// choose one subtitle language, so publish the conventional sidecar name
    /// `Movie.srt`; players can then discover it without language-specific rules.
    static func normalizeSubtitleSidecar(
        for videoURL: URL,
        forceOverwrite: Bool
    ) throws -> URL? {
        let folder = videoURL.deletingLastPathComponent()
        let videoStem = videoURL.deletingPathExtension().lastPathComponent
        let target = folder.appendingPathComponent(videoStem).appendingPathExtension("srt")
        let fileManager = FileManager.default

        let files = try fileManager.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        )
        let candidates = files.filter { url in
            guard url.pathExtension.lowercased() == "srt", url != target else { return false }
            let stem = url.deletingPathExtension().lastPathComponent
            return stem.hasPrefix(videoStem + ".")
        }
        .sorted { lhs, rhs in
            let left = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            let right = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate ?? .distantPast
            return left > right
        }

        guard let source = candidates.first else {
            return fileManager.fileExists(atPath: target.path) ? target : nil
        }
        if fileManager.fileExists(atPath: target.path) {
            guard forceOverwrite else { return target }
            try fileManager.removeItem(at: target)
        }
        try fileManager.moveItem(at: source, to: target)
        return target
    }

    private static func normalizeSubtitleSidecarIfNeeded(
        for videoURL: URL,
        options: YtDlpDownloadOptions,
        forceOverwrite: Bool
    ) throws {
        guard options.subtitleLanguage?.isEmpty == false else { return }
        _ = try normalizeSubtitleSidecar(for: videoURL, forceOverwrite: forceOverwrite)
    }

    static func downloadArguments(
        url: String,
        formatID: String,
        outputTemplate: String,
        connections: Int,
        forceOverwrite: Bool,
        aria2cPath: String?,
        options: YtDlpDownloadOptions = .init(),
        estimatedBytes: Int64 = 0,
        infoJSONPath: String? = nil,
        temporaryDirectory: URL? = nil
    ) -> [String] {
        let n = max(1, min(32, connections))
        let progressTemplate =
            "NDM|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s|%(progress.status)s"
        let postprocessTemplate =
            "postprocess:NDM_POST|%(progress.postprocessor)s|%(progress.status)s"
        var args = [
            "-f", formatID,
            "--merge-output-format", options.container.fileExtension,
            "-o", outputTemplate,
            "--no-playlist",
            "--newline",
            "--progress",
            "--progress-template", progressTemplate,
            "--progress-template", postprocessTemplate,
            "--print", "after_move:NDM_DEST|%(filepath)s",
            "--no-simulate",
            "--socket-timeout", "20",
            "--retries", "10",
            "--fragment-retries", "10",
        ]
        if let temporaryDirectory {
            args.append(contentsOf: ["--paths", "temp:\(temporaryDirectory.path)"])
        }
        if forceOverwrite {
            // A user-requested retry is a fresh network fetch, never a resume
            // from a shared-destination .part left by an older build.
            args.append(contentsOf: ["--force-overwrites", "--no-continue"])
        }
        if let language = options.subtitleLanguage, !language.isEmpty {
            args.append(contentsOf: [
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs", language,
                "--sub-format", "srt/best",
                "--convert-subs", "srt",
            ])
        }
        args.append(contentsOf: cookieArguments(options.cookieSource))
        // Range-parallel aria2c is a large win on big generic HTTP files
        // (16 connections beat a single-stream throttle), but:
        // - small transfers never finish their ramp-up (~10s vs ~1s on 3 MB)
        // - YouTube signed googlevideo URLs regularly answer 403 to aria2c
        //   (exit 22). Retry then works because a fresh extraction gets a
        //   new URL. Keep YouTube on yt-dlp's native downloader.
        let largeEnoughForAria2 = estimatedBytes <= 0 || estimatedBytes >= aria2MinimumBytes
        if n > 1 {
            // Native yt-dlp concurrency for DASH/HLS fragments.
            args.append(contentsOf: ["--concurrent-fragments", "\(n)"])
            // For ordinary HTTP media, aria2c supplies real range connections.
            if let aria2cPath, largeEnoughForAria2, !isYouTubeMediaURL(url) {
                // aria2c hard-caps --max-connection-per-server at 16 and exits
                // with code 28 for anything higher, before downloading a byte.
                let a = min(n, 16)
                args.append(contentsOf: [
                    "--downloader", aria2cPath,
                    "--downloader-args",
                    "aria2c:-x\(a) -s\(a) -k1M --file-allocation=none --summary-interval=1 --console-log-level=warn",
                ])
            }
        }
        if let infoJSONPath {
            // The probe's extraction is replayed instead of re-fetched; the
            // positional URL must stay away or yt-dlp would download twice.
            args.append(contentsOf: ["--load-info-json", infoJSONPath])
        } else {
            args.append(url)
        }
        return args
    }

    public static func sanitizeFilename(_ name: String) -> String {
        let stem = (name as NSString).deletingPathExtension
        let cleaned = stem
            .replacingOccurrences(of: "/", with: "-")
            .replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if cleaned.isEmpty { return "video" }
        // APFS caps filenames at 255 UTF-8 bytes; CJK titles reach that long
        // before 120 characters (120 × 3 bytes ≈ 360). Cap by bytes, leaving
        // headroom for quality suffixes and the extension.
        var stemOut = ""
        var usedBytes = 0
        for character in cleaned {
            let width = String(character).utf8.count
            if usedBytes + width > 180 || stemOut.count >= 120 { break }
            stemOut.append(character)
            usedBytes += width
        }
        return stemOut.isEmpty ? "video" : stemOut
    }

    /// Parse yt-dlp progress-template lines or classic `[download] xx% …` output.
    static func parseProgressLine(_ line: String) -> ProgressReport? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("NDM_POST|") {
            let parts = trimmed.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard parts.count >= 3 else { return nil }
            let postprocessor = parts[1].lowercased()
            let phase: DownloadPhase
            if postprocessor.contains("merger") {
                phase = .merging
            } else if postprocessor.contains("subtitle") {
                phase = .subtitles
            } else {
                phase = .finalizing
            }
            return ProgressReport(
                componentID: parts[1],
                status: parts[2],
                phase: phase
            )
        }
        if trimmed.hasPrefix("NDM|") {
            let parts = trimmed.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            // NDM|downloaded|total|estimate|speed|eta|format_id|status
            guard parts.count >= 6 else { return nil }
            let downloaded = Int64(parts[1]) ?? 0
            let totalRaw = Int64(parts[2]) ?? 0
            // HLS extractors such as X commonly emit a decimal estimate (for
            // example `1257879.0`).  Treat it as a byte count rather than
            // dropping it: without a total, the first downloaded bytes become
            // the whole component and the journey jumps straight to 96%.
            let estimate = Int64(Double(parts[3]) ?? 0)
            let total = totalRaw > 0 ? totalRaw : estimate
            let speed = Double(parts[4]) ?? 0
            let eta: Double?
            if let e = Double(parts[5]), e >= 0 { eta = e } else { eta = nil }
            guard downloaded > 0 || total > 0 || speed > 0 else { return nil }
            return ProgressReport(
                downloadedBytes: max(0, downloaded),
                totalBytes: max(0, total),
                bytesPerSecond: max(0, speed),
                etaSeconds: eta,
                componentID: parts.count > 6 ? nonEmpty(parts[6]) : nil,
                status: parts.count > 7 ? nonEmpty(parts[7]) : nil
            )
        }
        // aria2c external downloader, for example:
        // [#abc123 5.0MiB/10MiB(50%) CN:8 DL:1.2MiB ETA:4s]
        if trimmed.hasPrefix("[#"),
           let idRange = trimmed.range(of: #"\[#([^\s]+)"#, options: .regularExpression),
           let ratioRange = trimmed.range(
               of: #"([\d.]+\s*[KMGT]?i?B)/([\d.]+\s*[KMGT]?i?B)"#,
               options: [.regularExpression, .caseInsensitive]
           ) {
            let idToken = String(trimmed[idRange]).dropFirst(2)
            let ratio = String(trimmed[ratioRange]).split(separator: "/", maxSplits: 1)
            let downloaded = ratio.first.flatMap { parseByteCount(in: String($0)) } ?? 0
            let total = ratio.count > 1 ? (parseByteCount(in: String(ratio[1])) ?? 0) : 0
            let speed: Double
            if let dlRange = trimmed.range(
                of: #"DL:([\d.]+\s*[KMGT]?i?B)"#,
                options: [.regularExpression, .caseInsensitive]
            ) {
                speed = Double(parseByteCount(in: String(trimmed[dlRange])) ?? 0)
            } else {
                speed = 0
            }
            let eta: Double?
            if let etaRange = trimmed.range(of: #"ETA:([^\]\s]+)"#, options: .regularExpression) {
                eta = parseCompactDuration(
                    String(trimmed[etaRange]).replacingOccurrences(of: "ETA:", with: "")
                )
            } else {
                eta = nil
            }
            return ProgressReport(
                downloadedBytes: downloaded,
                totalBytes: total,
                bytesPerSecond: speed,
                etaSeconds: eta,
                componentID: "aria2:\(idToken)",
                status: downloaded >= total && total > 0 ? "finished" : "downloading"
            )
        }
        // [download]  12.3% of  50.00MiB at  1.23MiB/s ETA 00:39
        // [download]  12.3% of ~ 50.00MiB at  1.23MiB/s ETA 00:39
        guard trimmed.contains("[download]"), trimmed.contains("%") else { return nil }
        var report = ProgressReport()
        if let pctRange = trimmed.range(of: #"(\d+(?:\.\d+)?)%"#, options: .regularExpression) {
            let pctText = trimmed[pctRange].dropLast()
            if let pct = Double(pctText), pct > 0 {
                // Prefer absolute sizes below; pct alone is a last-resort fraction.
                report.downloadedBytes = Int64(pct * 1000) // placeholder until size known
            }
        }
        if let ofRange = trimmed.range(of: #"of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)"#, options: [.regularExpression, .caseInsensitive]) {
            let chunk = String(trimmed[ofRange])
            if let bytes = parseByteCount(in: chunk) {
                report.totalBytes = bytes
                if let pctRange = trimmed.range(of: #"(\d+(?:\.\d+)?)%"#, options: .regularExpression),
                   let pct = Double(trimmed[pctRange].dropLast()) {
                    report.downloadedBytes = Int64(Double(bytes) * pct / 100.0)
                }
            }
        }
        if let atRange = trimmed.range(of: #"at\s+([\d.]+)\s*([KMGT]?i?B)/s"#, options: [.regularExpression, .caseInsensitive]) {
            let chunk = String(trimmed[atRange]).replacingOccurrences(of: "at", with: "")
            if let speed = parseByteCount(in: chunk) {
                report.bytesPerSecond = Double(speed)
            }
        }
        if let etaRange = trimmed.range(of: #"ETA\s+(\d+:\d+(?::\d+)?)"#, options: .regularExpression) {
            let etaText = String(trimmed[etaRange])
                .replacingOccurrences(of: "ETA", with: "")
                .trimmingCharacters(in: .whitespaces)
            report.etaSeconds = parseETA(etaText)
        }
        guard report.downloadedBytes > 0 || report.totalBytes > 0 || report.bytesPerSecond > 0 else {
            return nil
        }
        return report
    }

    private static func parseByteCount(in text: String) -> Int64? {
        guard let match = text.range(of: #"([\d.]+)\s*([KMGT]?i?B)"#, options: [.regularExpression, .caseInsensitive]) else {
            return nil
        }
        let token = String(text[match]).replacingOccurrences(of: " ", with: "")
        let number = token.prefix { $0.isNumber || $0 == "." }
        guard let value = Double(number) else { return nil }
        let unit = String(token.dropFirst(number.count)).lowercased()
        let mult: Double
        switch unit {
        case "b": mult = 1
        case "kb", "kib": mult = 1024
        case "mb", "mib": mult = 1024 * 1024
        case "gb", "gib": mult = 1024 * 1024 * 1024
        case "tb", "tib": mult = 1024 * 1024 * 1024 * 1024
        default: mult = 1
        }
        return Int64(value * mult)
    }

    private static func parseETA(_ text: String) -> Double? {
        let parts = text.split(separator: ":").compactMap { Double($0) }
        switch parts.count {
        case 3: return parts[0] * 3600 + parts[1] * 60 + parts[2]
        case 2: return parts[0] * 60 + parts[1]
        case 1: return parts[0]
        default: return nil
        }
    }

    private static func parseCompactDuration(_ text: String) -> Double? {
        if text.contains(":") { return parseETA(text) }
        var total = 0.0
        for (pattern, multiplier) in [(#"([\d.]+)h"#, 3600.0), (#"([\d.]+)m"#, 60.0), (#"([\d.]+)s"#, 1.0)] {
            if let range = text.range(of: pattern, options: .regularExpression),
               let value = Double(text[range].dropLast()) {
                total += value * multiplier
            }
        }
        return total > 0 ? total : nil
    }

    private static func nonEmpty(_ text: String) -> String? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value == "NA" || value == "None" ? nil : value
    }

    private static func extractJSONObject(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{") { return trimmed }
        guard let start = trimmed.lastIndex(of: "{"),
              let end = trimmed.lastIndex(of: "}"),
              start < end else {
            return nil
        }
        return String(trimmed[start...end])
    }

    private static func run(
        _ bin: String,
        _ args: [String],
        timeoutSeconds: TimeInterval = 90
    ) async throws -> String {
        try await runStreaming(bin, args, timeoutSeconds: timeoutSeconds, cancelToken: nil, onLine: nil)
    }

    private struct CapturedOutput { let stdout: String; let stderr: String }

    private static func runStreaming(_ bin: String, _ args: [String], timeoutSeconds: TimeInterval,
                                     cancelToken: CancelToken?, onLine: (@Sendable (String) -> Void)?) async throws -> String {
        let captured = try await runCaptured(bin, args, timeoutSeconds: timeoutSeconds, cancelToken: cancelToken, onLine: onLine)
        return captured.stdout.isEmpty ? captured.stderr : captured.stdout
    }

    /// Process runner that can stream stdout/stderr lines (for live download progress).
    private static func runCaptured(
        _ bin: String,
        _ args: [String],
        timeoutSeconds: TimeInterval,
        cancelToken: CancelToken?,
        onLine: (@Sendable (String) -> Void)?
    ) async throws -> CapturedOutput {
        try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let proc = Process()
                    proc.executableURL = URL(fileURLWithPath: bin)
                    proc.arguments = executionArguments(args)
                    if let trustStore = MacOSTrustStore.certificateBundleURL {
                        var environment = ProcessInfo.processInfo.environment
                        environment["SSL_CERT_FILE"] = trustStore.path
                        proc.environment = environment
                    }
                    let out = Pipe()
                    let err = Pipe()
                    proc.standardOutput = out
                    proc.standardError = err

                    let lock = NSLock()
                    var stdoutData = Data()
                    var stderrData = Data()
                    var leftoverOut = Data()
                    var leftoverErr = Data()

                    func consume(_ chunk: Data, leftover: inout Data, into bag: inout Data) {
                        bag.append(chunk)
                        leftover.append(chunk)
                        // yt-dlp uses newlines; aria2c refreshes progress with CR.
                        // Treat both as line boundaries so external multi-range
                        // transfers still update the UI live.
                        while let boundary = leftover.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
                            let lineData = leftover.subdata(in: leftover.startIndex..<boundary)
                            leftover.removeSubrange(leftover.startIndex...boundary)
                            if !lineData.isEmpty,
                               let line = String(data: lineData, encoding: .utf8) {
                                onLine?(line)
                            }
                        }
                    }

                    out.fileHandleForReading.readabilityHandler = { handle in
                        let chunk = handle.availableData
                        if chunk.isEmpty {
                            handle.readabilityHandler = nil
                            return
                        }
                        lock.lock()
                        consume(chunk, leftover: &leftoverOut, into: &stdoutData)
                        lock.unlock()
                    }
                    err.fileHandleForReading.readabilityHandler = { handle in
                        let chunk = handle.availableData
                        if chunk.isEmpty {
                            handle.readabilityHandler = nil
                            return
                        }
                        lock.lock()
                        consume(chunk, leftover: &leftoverErr, into: &stderrData)
                        lock.unlock()
                    }

                    let cancelID = cancelToken?.registerCancellationHandler {
                        if proc.isRunning { proc.terminate() }
                    }

                    try proc.run()

                    let deadline = DispatchTime.now() + timeoutSeconds
                    var timedOut = false
                    while proc.isRunning {
                        if cancelToken?.isCancelled == true {
                            proc.terminate()
                            break
                        }
                        if DispatchTime.now() > deadline {
                            timedOut = true
                            proc.terminate()
                            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                                if proc.isRunning { proc.interrupt() }
                            }
                            break
                        }
                        Thread.sleep(forTimeInterval: 0.05)
                    }

                    out.fileHandleForReading.readabilityHandler = nil
                    err.fileHandleForReading.readabilityHandler = nil
                    // Drain remaining bytes so we don't lose the final progress line.
                    lock.lock()
                    consume(out.fileHandleForReading.readDataToEndOfFile(), leftover: &leftoverOut, into: &stdoutData)
                    consume(err.fileHandleForReading.readDataToEndOfFile(), leftover: &leftoverErr, into: &stderrData)
                    if !leftoverOut.isEmpty, let line = String(data: leftoverOut, encoding: .utf8) {
                        onLine?(line)
                    }
                    if !leftoverErr.isEmpty, let line = String(data: leftoverErr, encoding: .utf8) {
                        onLine?(line)
                    }
                    let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
                    let stderr = String(data: stderrData, encoding: .utf8) ?? ""
                    lock.unlock()

                    if let cancelID {
                        cancelToken?.removeCancellationHandler(cancelID)
                    }

                    if cancelToken?.isPaused == true {
                        cont.resume(throwing: EngineError.paused)
                        return
                    }
                    if cancelToken?.isCancelled == true {
                        cont.resume(throwing: EngineError.cancelled)
                        return
                    }
                    if timedOut {
                        cont.resume(throwing: EngineError.mergeFailed(
                            L10n.t(
                                "Parsing timed out: the page is unusually large or the network is slow. Try again shortly.",
                                "解析超时：页面信息过大或网络过慢，请稍后重试"
                            )
                        ))
                        return
                    }
                    if proc.terminationStatus != 0 {
                        let msg = failureMessage(stderr: stderr, stdout: stdout)
                        cont.resume(throwing: EngineError.mergeFailed(msg))
                    } else {
                        cont.resume(returning: CapturedOutput(stdout: stdout, stderr: stderr))
                    }
                } catch {
                    cont.resume(throwing: error)
                }
            }
        }
    }
}
