import Foundation

/// Quiet Finder appearance preference. Default follows macOS System Settings.
public enum AppearanceMode: String, Codable, Sendable, Equatable, CaseIterable {
    case system
    case light
    case dark

    public var settingsTitle: String {
        switch self {
        case .system: return L10n.t("System", "跟随系统")
        case .light: return L10n.t("Light", "浅色")
        case .dark: return L10n.t("Dark", "深色")
        }
    }
}

/// Accent colors are intentionally restrained and used sparingly for primary
/// actions, selection, and progress. The surrounding surfaces stay neutral.
public enum AccentTheme: String, Codable, Sendable, Equatable, CaseIterable {
    case classicBlue
    case indigo
    case graphite
    case jade
    case violet
    case rose
    case amber
    case custom

    public var settingsTitle: String {
        switch self {
        case .classicBlue: return L10n.t("Classic Blue", "经典蓝")
        case .indigo: return L10n.t("Indigo", "靛蓝")
        case .graphite: return L10n.t("Graphite", "石墨")
        case .jade: return L10n.t("Jade", "青玉")
        case .violet: return L10n.t("Violet", "紫罗兰")
        case .rose: return L10n.t("Rose", "玫瑰")
        case .amber: return L10n.t("Amber", "琥珀")
        case .custom: return L10n.t("Custom…", "自定义…")
        }
    }
}

/// When a transcript is produced without being asked for.
///
/// Default is `off`, and deliberately so. Reading speech is fast — measured at
/// roughly sixteen times realtime — but a two-hour lecture is still minutes of
/// sustained CPU, it writes two files the user did not request, and the first use
/// of a language may pull a download. Most decisively: a large share of audio
/// downloads are music, and transcribing a song produces nonsense. Discovery
/// belongs to a visible one-click action on a finished download, not to work
/// happening quietly on every file.
public enum TranscriptionScope: String, Codable, Sendable, Equatable, CaseIterable {
    /// Never automatic; still available on demand.
    case off
    /// Audio-only downloads, where the point is usually the words.
    case audioOnly
    case everything

    public var settingsTitle: String {
        switch self {
        case .off: return L10n.t("Only when I ask", "只在我要求时")
        case .audioOnly: return L10n.t("Audio downloads", "音频下载")
        case .everything: return L10n.t("Every video and audio download", "所有视频和音频")
        }
    }
}

public struct AppSettings: Codable, Sendable, Equatable {
    public var downloadDirectory: URL
    public var maxConnections: Int
    public var downloadAllAtOnce: Bool
    public var showCompletionDialog: Bool
    public var launchAtLogin: Bool
    public var useCategoryFolders: Bool
    public var customUserAgent: String?
    public var useCustomUserAgent: Bool
    public var httpProxy: ProxySettings?
    public var httpsProxy: ProxySettings?
    public var ftpProxy: ProxySettings?
    public var socksProxy: SocksProxySettings?
    public var bridgePort: UInt16
    /// Global bandwidth cap in bytes/sec (`BandWidthLimit`; 0 = unlimited).
    public var bandwidthLimitBytesPerSecond: Int64
    /// Push `ShowPanel*=1|0` to browser extensions (media floating panel).
    public var showBrowserMediaPanel: Bool
    /// Confirm each browser-captured download before starting (`NeatWaitWindow`).
    public var confirmBrowserDownloads: Bool
    /// Window chrome: System (default) / Light / Dark.
    public var appearanceMode: AppearanceMode
    /// Restrained app accent; new installs start with NDM's classic blue.
    public var accentTheme: AccentTheme
    /// User-selected sRGB accent (`#RRGGBB`) when `accentTheme == .custom`.
    public var customAccentHex: String?
    /// UI language: System (default) / English / 简体中文.
    public var languageMode: AppLanguageMode
    /// Smart connection tuning: start low, double while it pays off.
    /// Optional for older settings files. Default off — original NDM filled
    /// MaxAllowedConnection as soon as Range was confirmed.
    public var smartConnections: Bool?
    /// First-run onboarding shown? Optional for backward-compatible decoding.
    public var onboardingCompleted: Bool?
    /// Offer to download links found on the clipboard when the app activates.
    public var clipboardWatch: Bool?
    /// How to choose video quality: always ask, always highest, or highest up
    /// to a cap. Optional for backward-compatible decoding. Default: highest.
    public var mediaQuality: MediaQualityPreference?
    /// Nil until the user chooses; see `transcriptionScopePreference`.
    public var transcriptionScope: TranscriptionScope?
    /// BCP-47 tag forcing a transcription language, e.g. `zh-Hans`. Nil means let
    /// `TranscriptionWorkflow` decide from the source, the title and the user's own
    /// languages — which is right far more often than a fixed choice.
    public var transcriptionLanguage: String?
    /// Whether a readable `.txt` accompanies the subtitles. On by default: the
    /// transcript is the artifact that makes a download searchable and re-readable,
    /// and it costs kilobytes.
    public var transcriptionWritesTextFile: Bool?
    /// User-configured actions for a finished download. Optional so settings
    /// written by older builds continue to decode without migration work.
    public var quickActions: [QuickAction]?

    /// What to do with the installer file after a successful one-click
    /// install. Nil until the user chooses; see `installerSourceDispositionValue`.
    public var installerSourceDisposition: InstallerSourceDisposition?

    /// Whether license agreements on disk images are accepted automatically.
    /// The user grants this explicitly (the accept dialog's checkbox or the
    /// settings toggle); it never defaults on.
    public var installerAutoAcceptLicense: Bool?

    public var smartConnectionsEnabled: Bool { smartConnections ?? false }
    public var needsOnboarding: Bool { !(onboardingCompleted ?? false) }
    public var clipboardWatchEnabled: Bool { clipboardWatch ?? true }
    public var mediaQualityPreference: MediaQualityPreference { mediaQuality ?? .highest }
    public var transcriptionScopePreference: TranscriptionScope { transcriptionScope ?? .off }
    public var transcriptionWritesTextFileEnabled: Bool { transcriptionWritesTextFile ?? true }
    public var completionQuickActions: [QuickAction] { quickActions ?? [] }
    public var installerSourceDispositionValue: InstallerSourceDisposition {
        installerSourceDisposition ?? .defaultValue
    }
    public var installerAutoAcceptLicenseValue: Bool {
        installerAutoAcceptLicense ?? false
    }

    /// Whether a finished download should be transcribed without being asked.
    ///
    /// Category rather than file extension, so it agrees with what the rest of the
    /// app already decided this download is.
    public func transcribesAutomatically(category: DownloadCategory) -> Bool {
        switch transcriptionScopePreference {
        case .off: return false
        case .audioOnly: return category == .audio
        case .everything: return category == .audio || category == .video
        }
    }

    public init(
        downloadDirectory: URL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0],
        maxConnections: Int = 32,
        downloadAllAtOnce: Bool = true,
        showCompletionDialog: Bool = true,
        launchAtLogin: Bool = false,
        useCategoryFolders: Bool = false,
        customUserAgent: String? = nil,
        useCustomUserAgent: Bool = false,
        httpProxy: ProxySettings? = nil,
        httpsProxy: ProxySettings? = nil,
        ftpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        bridgePort: UInt16 = BridgeConstants.port,
        bandwidthLimitBytesPerSecond: Int64 = 0,
        showBrowserMediaPanel: Bool = true,
        confirmBrowserDownloads: Bool = false,
        // Most users live in light mode — the signature look must carry there.
        // Dark (Obsidian Cinema) stays a full first-class option, not the default.
        appearanceMode: AppearanceMode = .system,
        accentTheme: AccentTheme = .classicBlue,
        customAccentHex: String? = nil,
        languageMode: AppLanguageMode = .system,
        smartConnections: Bool? = false,
        mediaQuality: MediaQualityPreference? = nil,
        transcriptionScope: TranscriptionScope? = nil,
        transcriptionLanguage: String? = nil,
        transcriptionWritesTextFile: Bool? = nil,
        quickActions: [QuickAction]? = nil,
        installerSourceDisposition: InstallerSourceDisposition? = nil,
        installerAutoAcceptLicense: Bool? = nil
    ) {
        self.downloadDirectory = downloadDirectory
        self.maxConnections = maxConnections
        self.downloadAllAtOnce = downloadAllAtOnce
        self.showCompletionDialog = showCompletionDialog
        self.launchAtLogin = launchAtLogin
        self.useCategoryFolders = useCategoryFolders
        self.customUserAgent = customUserAgent
        self.useCustomUserAgent = useCustomUserAgent
        self.httpProxy = httpProxy
        self.httpsProxy = httpsProxy
        self.ftpProxy = ftpProxy
        self.socksProxy = socksProxy
        self.bridgePort = bridgePort
        self.bandwidthLimitBytesPerSecond = bandwidthLimitBytesPerSecond
        self.showBrowserMediaPanel = showBrowserMediaPanel
        self.confirmBrowserDownloads = confirmBrowserDownloads
        self.appearanceMode = appearanceMode
        self.accentTheme = accentTheme
        self.customAccentHex = customAccentHex
        self.languageMode = languageMode
        self.smartConnections = smartConnections
        self.mediaQuality = mediaQuality
        self.transcriptionScope = transcriptionScope
        self.transcriptionLanguage = transcriptionLanguage
        self.transcriptionWritesTextFile = transcriptionWritesTextFile
        self.quickActions = quickActions
        self.installerSourceDisposition = installerSourceDisposition
        self.installerAutoAcceptLicense = installerAutoAcceptLicense
    }
}

/// How the app chooses a video quality when a media page is downloaded.
public enum MediaQualityPreference: Codable, Equatable, Sendable {
    /// Always show the quality picker.
    case ask
    /// Always take the highest available quality, no picker.
    case highest
    /// Highest available quality no taller than this many pixels (e.g. 1080);
    /// falls back to the picker if nothing at or below the cap exists.
    case maxHeight(Int)

    /// Menu order for Settings.
    public static let presetCases: [MediaQualityPreference] =
        [.highest, .maxHeight(2160), .maxHeight(1080), .maxHeight(720), .maxHeight(480), .ask]

    public var settingsTitle: String {
        switch self {
        case .ask: return L10n.t("Ask every time", "每次询问")
        case .highest: return L10n.t("Always highest", "始终最高画质")
        case .maxHeight(let h): return L10n.t("Up to \(h)p", "最高 \(h)P")
        }
    }

    /// The format index to auto-select, or nil to show the picker. `heights`
    /// is the probe's format list, ordered highest-first.
    public func autoSelectIndex(heights: [Int]) -> Int? {
        guard !heights.isEmpty else { return nil }
        switch self {
        case .ask:
            return nil
        case .highest:
            return 0
        case .maxHeight(let cap):
            // Highest tier at or below the cap; if nothing fits, ask so the
            // user knows their preferred ceiling isn't available here.
            return heights.firstIndex { $0 <= cap }
        }
    }
}

public struct ProxySettings: Codable, Sendable, Equatable {
    public var host: String
    public var port: UInt16
    public var username: String?
    public var password: String?
    public var enabled: Bool

    public init(host: String, port: UInt16, username: String? = nil, password: String? = nil, enabled: Bool = false) {
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.enabled = enabled
    }
}

public struct SocksProxySettings: Codable, Sendable, Equatable {
    public var host: String
    public var port: UInt16
    public var version: SocksVersion
    public var username: String?
    public var password: String?
    public var enabled: Bool

    public init(
        host: String,
        port: UInt16,
        version: SocksVersion = .v5,
        username: String? = nil,
        password: String? = nil,
        enabled: Bool = false
    ) {
        self.host = host
        self.port = port
        self.version = version
        self.username = username
        self.password = password
        self.enabled = enabled
    }
}

public enum SocksVersion: Int, Codable, Sendable {
    case v4 = 4
    case v5 = 5
}

public struct AuthCredential: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var target: String
    public var protocolName: String
    public var username: String
    public var password: String

    public init(id: Int64 = 0, target: String, protocolName: String, username: String, password: String) {
        self.id = id
        self.target = target
        self.protocolName = protocolName
        self.username = username
        self.password = password
    }
}
