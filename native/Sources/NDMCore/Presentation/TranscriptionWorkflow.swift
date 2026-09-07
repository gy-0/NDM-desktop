import Foundation

/// Pure eligibility and planning rules for turning a delivered media file into a
/// transcript.
///
/// Deliberately free of any `Speech` import: what the system can do is *injected*
/// as `TranscriptionEnvironment`. The decision rules are the part most likely to
/// be wrong, so they must be unit-testable on any macOS version, not only one new
/// enough to run the real transcriber.
public enum TranscriptionWorkflow: Sendable {
    /// Containers this Mac can read speech out of.
    ///
    /// `aiff`, `aif` and `caf` were missing until a real run caught it: they are
    /// standard macOS audio formats — `say` writes AIFF — and the engine reads them
    /// fine, so rejecting them told the user "this file has no audio to read" about a
    /// file full of speech. The engine tests never noticed because they call the
    /// engine directly and never pass through this gate. `m4b` is here for the same
    /// reason: an audiobook is the most obviously transcribable file there is.
    public static let supportedExtensions: Set<String> = [
        "mp3", "wav", "ogg", "opus", "m4a", "m4b", "aac", "flac", "aiff", "aif", "caf",
        "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "ts", "mts", "m2ts",
    ]

    public static func supports(fileURL: URL?) -> Bool {
        guard let fileURL, fileURL.isFileURL else { return false }
        return supportedExtensions.contains(fileURL.pathExtension.lowercased())
    }

    /// What the running system offers. Supplied by the engine layer so this file
    /// stays testable and version-independent.
    public struct Environment: Sendable, Equatable {
        /// False on systems without the on-device transcription framework, which
        /// gates the whole feature rather than degrading it.
        public var isSupportedByOS: Bool
        /// Locale identifiers the transcriber can handle, as the system reports
        /// them (observed form: `zh_CN`, `en_US`).
        public var supportedLocaleIdentifiers: [String]
        /// Subset already present on disk. Anything supported but not installed
        /// needs a system-managed download first.
        public var installedLocaleIdentifiers: [String]
        /// The user's language order, e.g. `Locale.preferredLanguages`.
        public var preferredLanguages: [String]

        public init(
            isSupportedByOS: Bool,
            supportedLocaleIdentifiers: [String] = [],
            installedLocaleIdentifiers: [String] = [],
            preferredLanguages: [String] = []
        ) {
            self.isSupportedByOS = isSupportedByOS
            self.supportedLocaleIdentifiers = supportedLocaleIdentifiers
            self.installedLocaleIdentifiers = installedLocaleIdentifiers
            self.preferredLanguages = preferredLanguages
        }

        public static let unsupported = Environment(isSupportedByOS: false)
    }

    /// Why transcription is not on offer. Worded for someone who has never heard
    /// of a speech framework.
    public enum UnavailableReason: String, Equatable, Sendable, CaseIterable {
        case noMediaFile
        case unsupportedFileType
        case systemTooOld
        case noSupportedLanguage

        public var title: String {
            switch self {
            case .noMediaFile:
                return L10n.t("The file is no longer there", "文件已经不在了")
            case .unsupportedFileType:
                return L10n.t("This file has no audio to read", "这个文件没有可读的语音")
            case .systemTooOld:
                return L10n.t("Needs a newer macOS", "需要更新的 macOS")
            case .noSupportedLanguage:
                return L10n.t("This language isn't available yet", "暂时没有这个语言")
            }
        }

        public var detail: String {
            switch self {
            case .noMediaFile:
                return L10n.t(
                    "Download it again and the transcript can be made from the new copy.",
                    "重新下载之后就可以从新文件生成文稿。"
                )
            case .unsupportedFileType:
                return L10n.t(
                    "Transcripts can be made from video and audio files.",
                    "文稿只能从视频和音频文件生成。"
                )
            case .systemTooOld:
                return L10n.t(
                    "Reading speech on this Mac requires macOS 26 or later. Everything else keeps working.",
                    "在本机识别语音需要 macOS 26 或更新版本。其他功能不受影响。"
                )
            case .noSupportedLanguage:
                return L10n.t(
                    "Your Mac can't read this language yet.",
                    "你的 Mac 还无法识别这个语言。"
                )
            }
        }
    }

    /// A concrete, auditable plan. `source` records *why* this language was
    /// chosen, so a wrong guess can be traced instead of argued about.
    public struct Plan: Equatable, Sendable {
        public enum LanguageSource: String, Equatable, Sendable {
            /// The source site only publishes one language.
            case site
            /// The title's writing system.
            case titleScript
            /// The user's own language order.
            case systemPreference
            /// Nothing matched; English is the last resort.
            case englishFallback
        }

        /// Identifier in the form the system reported, ready to hand to the engine.
        public var localeIdentifier: String
        /// BCP-47 tag for naming and display, e.g. `zh-Hans`.
        ///
        /// Informational only. The shipped sidecar convention is a language-free
        /// `Movie.srt` (see `YtDlpTool.normalizeSubtitleSidecar`), so C1-5 must
        /// decide deliberately whether to keep that or start suffixing — not
        /// diverge from it by accident.
        public var languageTag: String
        /// True when the language is supported but not yet on disk, so a
        /// system-managed download has to finish first. Must be shown as a real
        /// stage, never as a stall.
        public var needsLanguageDownload: Bool
        public var source: LanguageSource

        public init(
            localeIdentifier: String,
            languageTag: String,
            needsLanguageDownload: Bool,
            source: LanguageSource
        ) {
            self.localeIdentifier = localeIdentifier
            self.languageTag = languageTag
            self.needsLanguageDownload = needsLanguageDownload
            self.source = source
        }
    }

    public enum Decision: Equatable, Sendable {
        case ready(Plan)
        case unavailable(UnavailableReason)

        public var plan: Plan? {
            if case .ready(let plan) = self { return plan }
            return nil
        }

        public var unavailableReason: UnavailableReason? {
            if case .unavailable(let reason) = self { return reason }
            return nil
        }
    }

    /// Decide whether and how to transcribe.
    ///
    /// Checks run cheapest-and-most-certain first so the reason a user sees is the
    /// most useful one: a missing file is a fact, an old system is a fact, and
    /// only then does language guessing enter.
    public static func decide(
        fileURL: URL?,
        pageURL: String? = nil,
        pageTitle: String? = nil,
        environment: Environment,
        fileExists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    ) -> Decision {
        guard let fileURL, fileURL.isFileURL else {
            return .unavailable(.noMediaFile)
        }
        guard supports(fileURL: fileURL) else {
            return .unavailable(.unsupportedFileType)
        }
        guard fileExists(fileURL) else {
            return .unavailable(.noMediaFile)
        }
        guard environment.isSupportedByOS else {
            return .unavailable(.systemTooOld)
        }
        guard let resolved = resolveLanguage(
            pageURL: pageURL,
            pageTitle: pageTitle,
            environment: environment
        ) else {
            return .unavailable(.noSupportedLanguage)
        }
        let installed = environment.installedLocaleIdentifiers.map(normalized)
        return .ready(Plan(
            localeIdentifier: resolved.identifier,
            languageTag: resolved.tag,
            needsLanguageDownload: !installed.contains(normalized(resolved.identifier)),
            source: resolved.source
        ))
    }

    // MARK: - Language resolution

    private struct Resolved {
        var identifier: String
        var tag: String
        var source: Plan.LanguageSource
    }

    /// Order of evidence, strongest first:
    ///
    /// 1. The source site, when it only ever publishes one language. A Bilibili
    ///    video is spoken Chinese regardless of the user's interface language, so
    ///    this deliberately outranks the system preference.
    /// 2. The writing system of the title.
    /// 3. The user's own language order.
    /// 4. English, as an admitted last resort.
    private static func resolveLanguage(
        pageURL: String?,
        pageTitle: String?,
        environment: Environment
    ) -> Resolved? {
        if let tag = siteLanguageTag(pageURL),
           let match = match(tag: tag, in: environment.supportedLocaleIdentifiers) {
            return Resolved(identifier: match, tag: tag, source: .site)
        }
        if let tag = scriptLanguageTag(pageTitle),
           let match = match(tag: tag, in: environment.supportedLocaleIdentifiers) {
            return Resolved(identifier: match, tag: tag, source: .titleScript)
        }
        for preferred in environment.preferredLanguages {
            if let match = match(tag: preferred, in: environment.supportedLocaleIdentifiers) {
                return Resolved(identifier: match, tag: preferred, source: .systemPreference)
            }
        }
        if let match = match(tag: "en", in: environment.supportedLocaleIdentifiers) {
            return Resolved(identifier: match, tag: "en", source: .englishFallback)
        }
        return nil
    }

    /// Sites whose audio language is not in doubt. Global platforms are absent on
    /// purpose: a YouTube video can be in anything, and guessing from the domain
    /// would be worse than falling through to the title and the user's own
    /// languages.
    static func siteLanguageTag(_ pageURL: String?) -> String? {
        guard let pageURL,
              let host = URL(string: pageURL.trimmingCharacters(in: .whitespacesAndNewlines))?.host?
                  .lowercased()
        else { return nil }
        let simplified = [
            "bilibili.com", "b23.tv", "douyin.com", "iesdouyin.com",
            "xiaohongshu.com", "xhslink.com", "weibo.com", "weibo.cn",
            "kuaishou.com", "iqiyi.com", "youku.com", "qq.com", "mgtv.com",
        ]
        let traditional = ["bilibili.tv"]
        for domain in traditional where host == domain || host.hasSuffix("." + domain) {
            return "zh-Hant"
        }
        for domain in simplified where host == domain || host.hasSuffix("." + domain) {
            return "zh-Hans"
        }
        if host.hasSuffix(".tw") || host.hasSuffix(".hk") || host.hasSuffix(".mo") {
            return "zh-Hant"
        }
        if host.hasSuffix(".cn") { return "zh-Hans" }
        if host.hasSuffix(".jp") { return "ja" }
        if host.hasSuffix(".kr") { return "ko" }
        return nil
    }

    /// Characters that exist only in Traditional Chinese. A short list is enough
    /// to separate the two scripts in a title, and being wrong here costs a
    /// slightly worse transcript, not a failure.
    private static let traditionalMarkers: Set<Character> = [
        "這", "個", "們", "為", "說", "電", "灣", "與", "後", "還",
        "麼", "來", "時", "會", "沒", "過", "開", "關", "體", "點",
        "實", "業", "學", "萬", "億", "圖", "書", "樂", "無", "從",
    ]

    static func scriptLanguageTag(_ title: String?) -> String? {
        guard let title, !title.isEmpty else { return nil }
        var hasHan = false
        var hasKana = false
        var hasHangul = false
        var hasTraditional = false
        for scalar in title.unicodeScalars {
            switch scalar.value {
            case 0x4E00...0x9FFF, 0x3400...0x4DBF, 0xF900...0xFAFF:
                hasHan = true
            case 0x3040...0x309F, 0x30A0...0x30FF:
                hasKana = true
            case 0xAC00...0xD7AF, 0x1100...0x11FF:
                hasHangul = true
            default:
                break
            }
        }
        for character in title where traditionalMarkers.contains(character) {
            hasTraditional = true
            break
        }
        // Kana settles it: Japanese uses Han characters too, so Han alone cannot
        // be read as Chinese when kana are present.
        if hasKana { return "ja" }
        if hasHangul { return "ko" }
        if hasHan { return hasTraditional ? "zh-Hant" : "zh-Hans" }
        return nil
    }

    // MARK: - Identifier matching

    /// Public because the engine layer must compare identifiers the same way this
    /// file does — two spellings of one language pack are the same pack.
    public static func normalized(_ identifier: String) -> String {
        identifier
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "-", with: "_")
            .lowercased()
    }

    /// Candidate identifiers for a language tag, best first. Keeps the messy
    /// mapping between BCP-47 tags and the system's `language_REGION` identifiers
    /// in one place.
    static func candidates(for tag: String) -> [String] {
        let key = normalized(tag)
        // Chinese needs script-aware handling, and the region can be anything: a
        // Simplified user living in the US reports `zh-Hans-US`. Keying off the
        // script subtag rather than enumerating regions means an unexpected region
        // cannot land a Simplified speaker on a Traditional model.
        if key == "zh" || key.hasPrefix("zh_") {
            if key.contains("hant") || key.contains("_tw") || key.contains("_hk")
                || key.contains("_mo") {
                return ["zh_tw", "zh_hk", "zh_hant"]
            }
            // Simplified is the default for bare `zh` and for every other region.
            return ["zh_cn", "zh_sg", "zh_hans"]
        }
        // Generic: exact match, then any identifier sharing the base language.
        let base = key.split(separator: "_").first.map(String.init) ?? key
        return key == base ? [base] : [key, base]
    }

    /// Resolve a tag against what the system supports, returning the identifier in
    /// the system's own spelling so the engine gets something it recognises.
    public static func match(tag: String, in supported: [String]) -> String? {
        let candidates = candidates(for: tag)
        for candidate in candidates {
            if let hit = supported.first(where: { normalized($0) == candidate }) {
                return hit
            }
        }
        // Fall back to the base language: `de-AT` should still find `de_DE`.
        for candidate in candidates {
            let base = candidate.split(separator: "_").first.map(String.init) ?? candidate
            if let hit = supported.first(where: {
                normalized($0).split(separator: "_").first.map(String.init) == base
            }) {
                return hit
            }
        }
        return nil
    }
}
