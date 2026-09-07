import Foundation
import NDMCore

/// Post-download polish: naming, covers (UI), and share-oriented compress presets.
/// Keeps ffmpeg complexity behind one product-facing API.
public enum SharePreset: String, CaseIterable, Sendable {
    /// Target ~25 MB — friendly for WeChat file limits on many clients.
    case wechat
    /// Target ~45 MB — comfortable for Telegram / general chat.
    case telegram
    /// Copy/remux only — never re-encode.
    case original

    public var folderName: String {
        switch self {
        case .wechat: return "WeChat"
        case .telegram: return "Telegram"
        case .original: return "Original"
        }
    }
}

/// Product-facing outcomes. Users choose what they want to do with the file;
/// codec and container decisions remain an implementation detail.
public enum DeliveryRecipe: String, CaseIterable, Sendable {
    case originalQuality
    case mobileCompatible
    case audioOnly
    case weChat

    /// Keep the completion surface focused on outcomes that people repeatedly
    /// ask for. Compatibility and chat-size transcodes remain available to the
    /// engine for callers that need them, but are no longer first-class UI.
    public static let allCases: [DeliveryRecipe] = [.originalQuality, .audioOnly]

    public var createsCopy: Bool { self != .originalQuality }

    fileprivate var folderName: String {
        switch self {
        case .originalQuality: return "Original"
        case .mobileCompatible: return "Mobile"
        case .audioOnly: return "Audio"
        case .weChat: return "WeChat"
        }
    }
}

public struct DeliveryResult: Equatable, Sendable {
    public let recipe: DeliveryRecipe
    public let primaryURL: URL
    public let sidecarURLs: [URL]
    public let createdCopy: Bool

    public init(recipe: DeliveryRecipe, primaryURL: URL, sidecarURLs: [URL], createdCopy: Bool) {
        self.recipe = recipe
        self.primaryURL = primaryURL
        self.sidecarURLs = sidecarURLs
        self.createdCopy = createdCopy
    }
}

/// A real file that belongs to one completed download result. Temporary engine
/// files are deliberately excluded; this model describes only user-ready output.
public struct CompletionArtifact: Equatable, Sendable {
    public enum Kind: Int, Equatable, Sendable {
        case primary = 0
        case subtitle = 1
        case cover = 2
        case audio = 3
        case metadata = 4
        case other = 5
    }

    public let url: URL
    public let kind: Kind
    public let byteCount: Int64

    public init(url: URL, kind: Kind, byteCount: Int64) {
        self.url = url
        self.kind = kind
        self.byteCount = max(0, byteCount)
    }
}

/// One logical result containing the main file and any player-ready sidecars.
public struct CompletionStack: Equatable, Sendable {
    public let primary: CompletionArtifact
    public let artifacts: [CompletionArtifact]

    public init(primary: CompletionArtifact, artifacts: [CompletionArtifact]) {
        self.primary = primary
        self.artifacts = artifacts
    }

    public var sidecars: [CompletionArtifact] {
        artifacts.filter { $0.kind != .primary }
    }
}

/// The on-disk result of Smart Naming. A rename is never reported until the
/// primary file has actually moved; sidecars list only files moved successfully.
public struct SmartNamingResult: Equatable, Sendable {
    public let primaryURL: URL
    public let originalURL: URL
    public let sidecarURLs: [URL]

    public init(primaryURL: URL, originalURL: URL, sidecarURLs: [URL]) {
        self.primaryURL = primaryURL
        self.originalURL = originalURL
        self.sidecarURLs = sidecarURLs
    }

    public var renamed: Bool { primaryURL != originalURL }
}

public enum SmartFinalize {
    private static let videoExtensions: Set<String> = ["mp4", "mov", "m4v", "mkv", "webm", "ts", "avi", "flv"]

    public static func supportsDeliveryRecipes(input: URL?) -> Bool {
        guard let input else { return false }
        return videoExtensions.contains(input.pathExtension.lowercased())
            && FileManager.default.fileExists(atPath: input.path)
    }
    /// Suggest a clean filename from page title + extension (no random IDs or
    /// browser-tab site suffixes). Collection order prefixes are preserved.
    public static func suggestedFilename(pageTitle: String?, fallback: String, ext: String) -> String {
        let cleanExt = normalizedExtension(ext)
        let fallbackStem = (fallback as NSString).deletingPathExtension
        var base: String
        if let title = pageTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
            base = cleanPageTitle(title)
        } else {
            base = sanitize(fallbackStem)
        }

        if !cleanExt.isEmpty, base.lowercased().hasSuffix(".\(cleanExt)") {
            base = String(base.dropLast(cleanExt.count + 1))
        }
        if let prefix = orderingPrefix(in: fallbackStem), !base.hasPrefix(prefix) {
            base = prefix + base
        }
        let stem = base.isEmpty ? "download" : String(base.prefix(80))
        return cleanExt.isEmpty ? stem : "\(stem).\(cleanExt)"
    }

    public static func sanitize(_ raw: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t")
        let cleaned = raw
            .components(separatedBy: invalid)
            .joined(separator: " ")
            .replacingOccurrences(of: "  +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(
                CharacterSet(charactersIn: ".")
            ))
        return cleaned
    }

    /// Move a completed media file to its clean page-title name and carry every
    /// matching subtitle, cover, audio, and metadata sidecar with it. Existing
    /// files are never overwritten; a Finder-style numeric suffix is chosen.
    public static func applySmartNaming(
        primary primaryURL: URL,
        pageTitle: String?
    ) throws -> SmartNamingResult {
        let fileManager = FileManager.default
        let original = primaryURL.standardizedFileURL
        guard fileManager.fileExists(atPath: original.path) else {
            return SmartNamingResult(primaryURL: original, originalURL: original, sidecarURLs: [])
        }

        let suggested = suggestedFilename(
            pageTitle: pageTitle,
            fallback: original.lastPathComponent,
            ext: original.pathExtension
        )
        guard !suggested.isEmpty,
              suggested.localizedCaseInsensitiveCompare(original.lastPathComponent) != .orderedSame else {
            return SmartNamingResult(
                primaryURL: original,
                originalURL: original,
                sidecarURLs: completionStack(primary: original)?.sidecars.map(\.url) ?? []
            )
        }

        let folder = original.deletingLastPathComponent()
        let suggestedStem = (suggested as NSString).deletingPathExtension
        // Never rename into an extensionless name — keep the on-disk type.
        let ext = original.pathExtension.isEmpty
            ? (suggested as NSString).pathExtension
            : original.pathExtension
        guard !ext.isEmpty else {
            return SmartNamingResult(
                primaryURL: original,
                originalURL: original,
                sidecarURLs: completionStack(primary: original)?.sidecars.map(\.url) ?? []
            )
        }
        let destination = availableOutputURL(
            in: folder,
            stem: suggestedStem,
            extension: ext
        )
        let sidecars = completionStack(primary: original)?.sidecars.map(\.url) ?? []
        let oldStem = original.deletingPathExtension().lastPathComponent
        try fileManager.moveItem(at: original, to: destination)

        let newStem = destination.deletingPathExtension().lastPathComponent
        var movedSidecars: [URL] = []
        for sidecar in sidecars {
            let sidecarStem = sidecar.deletingPathExtension().lastPathComponent
            let suffix = sidecarStem.count > oldStem.count
                ? String(sidecarStem.dropFirst(oldStem.count))
                : ""
            let target = folder.appendingPathComponent(
                "\(newStem)\(suffix).\(sidecar.pathExtension)"
            )
            guard target != sidecar,
                  !fileManager.fileExists(atPath: target.path) else { continue }
            do {
                try fileManager.moveItem(at: sidecar, to: target)
                movedSidecars.append(target)
            } catch {
                // The primary result is already safe. A locked optional cover
                // or metadata file must not make the completed download fail.
            }
        }
        return SmartNamingResult(
            primaryURL: destination,
            originalURL: original,
            sidecarURLs: movedSidecars
        )
    }

    /// Completion copy must only claim page-title naming when the visible file
    /// really reflects that title (including collection and collision suffixes).
    public static func filenameReflectsPageTitle(_ filename: String, pageTitle: String?) -> Bool {
        guard let pageTitle, !pageTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        let ext = (filename as NSString).pathExtension
        let expected = (suggestedFilename(pageTitle: pageTitle, fallback: filename, ext: ext) as NSString)
            .deletingPathExtension
        var actual = (filename as NSString).deletingPathExtension
        if let prefix = orderingPrefix(in: actual), actual.hasPrefix(prefix) {
            actual.removeFirst(prefix.count)
        }
        actual = actual.replacingOccurrences(
            of: #" \([2-9][0-9]*\)$"#,
            with: "",
            options: .regularExpression
        )
        var expectedWithoutPrefix = expected
        if let prefix = orderingPrefix(in: expectedWithoutPrefix), expectedWithoutPrefix.hasPrefix(prefix) {
            expectedWithoutPrefix.removeFirst(prefix.count)
        }
        return actual.localizedCaseInsensitiveCompare(expectedWithoutPrefix) == .orderedSame
    }

    private static func cleanPageTitle(_ raw: String) -> String {
        var value = sanitize(raw)
        let suffixes = [
            " - YouTube", " | YouTube",
            "_哔哩哔哩_bilibili", " - 哔哩哔哩_bilibili", " - 哔哩哔哩",
            " - 抖音", " | 抖音",
            " - 小红书", " | 小红书",
            " - TikTok", " | TikTok",
        ]
        var removed = true
        while removed {
            removed = false
            for suffix in suffixes where value.lowercased().hasSuffix(suffix.lowercased()) {
                value = String(value.dropLast(suffix.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                removed = true
                break
            }
        }
        return sanitize(value)
    }

    private static func orderingPrefix(in stem: String) -> String? {
        guard let range = stem.range(
            of: #"^[0-9]{2,4}\s*[-–—]\s+"#,
            options: .regularExpression
        ) else { return nil }
        return String(stem[range])
    }

    private static func normalizedExtension(_ ext: String) -> String {
        let value = ext.hasPrefix(".") ? String(ext.dropFirst()) : ext
        return sanitize(value).lowercased()
    }

    /// Discover files that players and users understand as one result. Matching
    /// is intentionally conservative so an unrelated file in Downloads is never
    /// pulled into the stack merely because it was created nearby.
    public static func completionStack(primary primaryURL: URL?) -> CompletionStack? {
        guard let primaryURL else { return nil }
        let fileManager = FileManager.default
        let primary = primaryURL.standardizedFileURL
        guard fileManager.fileExists(atPath: primary.path) else { return nil }

        let primaryArtifact = CompletionArtifact(
            url: primary,
            kind: .primary,
            byteCount: fileSize(primary)
        )
        let folder = primary.deletingLastPathComponent()
        let primaryStem = primary.deletingPathExtension().lastPathComponent.lowercased()
        guard let files = try? fileManager.contentsOfDirectory(
            at: folder,
            includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return CompletionStack(primary: primaryArtifact, artifacts: [primaryArtifact])
        }

        let sidecars = files.compactMap { candidate -> CompletionArtifact? in
            let url = candidate.standardizedFileURL
            guard url != primary,
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                return nil
            }
            let ext = url.pathExtension.lowercased()
            guard let kind = artifactKind(forExtension: ext) else { return nil }
            let stem = url.deletingPathExtension().lastPathComponent.lowercased()
            guard stem == primaryStem || stem.hasPrefix(primaryStem + ".") else { return nil }
            return CompletionArtifact(url: url, kind: kind, byteCount: fileSize(url))
        }
        .sorted { lhs, rhs in
            if lhs.kind.rawValue != rhs.kind.rawValue {
                return lhs.kind.rawValue < rhs.kind.rawValue
            }
            return lhs.url.lastPathComponent.localizedStandardCompare(rhs.url.lastPathComponent) == .orderedAscending
        }

        return CompletionStack(primary: primaryArtifact, artifacts: [primaryArtifact] + sidecars)
    }

    private static func artifactKind(forExtension ext: String) -> CompletionArtifact.Kind? {
        switch ext {
        case "srt", "vtt", "ass", "ssa", "sub": return .subtitle
        case "jpg", "jpeg", "png", "webp", "heic": return .cover
        case "m4a", "mp3", "aac", "flac", "wav", "ogg", "opus": return .audio
        // A readable transcript rides along as metadata for now. It deserves its own
        // kind and label, but that means new user-facing wording and an icon, so it
        // belongs in the UI review rather than being decided here (C1-6).
        case "json", "nfo", "description", "chapters", "lrc", "txt": return .metadata
        default: return nil
        }
    }

    private static func fileSize(_ url: URL) -> Int64 {
        let value = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize
        return Int64(max(0, value ?? 0))
    }

    /// Re-encode (or pass-through) for chat-friendly sizes. Requires ffmpeg.
    public static func exportForShare(input: URL, preset: SharePreset) async throws -> URL {
        switch preset {
        case .original:
            return input
        case .wechat, .telegram:
            guard let ffmpeg = FFmpegTool.find() else {
                throw EngineError.mergeFailed("The built-in media component is unavailable — reinstall or update the app")
            }
            let dir = input.deletingLastPathComponent()
                .appendingPathComponent("Share", isDirectory: true)
                .appendingPathComponent(preset.folderName, isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let out = dir.appendingPathComponent(input.lastPathComponent)
            let crf = preset == .wechat ? "28" : "26"
            let maxrate = preset == .wechat ? "1500k" : "2500k"
            try FFmpegTool.transcodeShare(
                ffmpeg: ffmpeg,
                input: input,
                output: out,
                crf: crf,
                maxrate: maxrate
            )
            return out
        }
    }

    /// Create a safe, user-ready version while always preserving the original.
    /// Generated files live in a nearby `NDM Exports` folder and never replace
    /// a previous export. Matching subtitles are copied and renamed with the
    /// generated video so players continue to discover them automatically.
    public static func deliver(input: URL, recipe: DeliveryRecipe) async throws -> DeliveryResult {
        try await Task.detached(priority: .userInitiated) {
            let fileManager = FileManager.default
            let source = input.standardizedFileURL
            guard fileManager.fileExists(atPath: source.path) else {
                throw EngineError.mergeFailed("The original file is no longer available")
            }
            guard recipe.createsCopy else {
                return DeliveryResult(
                    recipe: recipe,
                    primaryURL: source,
                    sidecarURLs: [],
                    createdCopy: false
                )
            }
            guard let ffmpeg = FFmpegTool.find() else {
                throw EngineError.mergeFailed("The built-in media component is unavailable — reinstall or update the app")
            }

            let folder = source.deletingLastPathComponent()
                .appendingPathComponent("NDM Exports", isDirectory: true)
                .appendingPathComponent(recipe.folderName, isDirectory: true)
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            let stem = source.deletingPathExtension().lastPathComponent
            let outputExtension = recipe == .audioOnly ? "m4a" : "mp4"
            let output = availableOutputURL(in: folder, stem: stem, extension: outputExtension)

            switch recipe {
            case .originalQuality:
                break
            case .mobileCompatible:
                try FFmpegTool.transcodeMobileCompatible(ffmpeg: ffmpeg, input: source, output: output)
            case .audioOnly:
                try FFmpegTool.extractAudio(ffmpeg: ffmpeg, input: source, output: output)
            case .weChat:
                try FFmpegTool.transcodeChatFriendly(ffmpeg: ffmpeg, input: source, output: output)
            }

            let sidecars = recipe == .audioOnly
                ? []
                : try copyMatchingSubtitles(from: source, to: output)
            return DeliveryResult(
                recipe: recipe,
                primaryURL: output,
                sidecarURLs: sidecars,
                createdCopy: true
            )
        }.value
    }

    static func availableOutputURL(in folder: URL, stem: String, extension ext: String) -> URL {
        let fileManager = FileManager.default
        let cleanStem = sanitize(stem).isEmpty ? "download" : sanitize(stem)
        let cleanExt = normalizedExtension(ext)
        var index = 1
        while true {
            let suffix = index == 1 ? "" : " (\(index))"
            let filename: String
            if cleanExt.isEmpty {
                // No trailing "." — Finder shows those as extensionless junk.
                filename = "\(cleanStem)\(suffix)"
            } else {
                filename = "\(cleanStem)\(suffix).\(cleanExt)"
            }
            let candidate = folder.appendingPathComponent(filename)
            if !fileManager.fileExists(atPath: candidate.path) { return candidate }
            index += 1
        }
    }

    static func copyMatchingSubtitles(from source: URL, to output: URL) throws -> [URL] {
        guard let stack = completionStack(primary: source) else { return [] }
        let sourceStem = source.deletingPathExtension().lastPathComponent
        let outputStem = output.deletingPathExtension().lastPathComponent
        var copied: [URL] = []
        for subtitle in stack.artifacts where subtitle.kind == .subtitle {
            let subtitleStem = subtitle.url.deletingPathExtension().lastPathComponent
            let suffix = subtitleStem.count > sourceStem.count
                ? String(subtitleStem.dropFirst(sourceStem.count))
                : ""
            let filename = "\(outputStem)\(suffix).\(subtitle.url.pathExtension)"
            let destination = output.deletingLastPathComponent().appendingPathComponent(filename)
            guard !FileManager.default.fileExists(atPath: destination.path) else { continue }
            try FileManager.default.copyItem(at: subtitle.url, to: destination)
            copied.append(destination)
        }
        return copied
    }
}
