import Foundation

/// Persists host settings in this app's standard bundle preferences domain.
public enum SettingsStore {
    private static let key = "AppSettingsJSON"

    private struct DiskSettings: Codable {
        var downloadDirectory: String
        var maxConnections: Int
        var downloadAllAtOnce: Bool
        var showCompletionDialog: Bool
        var launchAtLogin: Bool
        var useCategoryFolders: Bool
        var customUserAgent: String?
        var useCustomUserAgent: Bool
        var httpProxy: ProxySettings?
        var httpsProxy: ProxySettings?
        var ftpProxy: ProxySettings?
        var socksProxy: SocksProxySettings?
        var bridgePort: UInt16
        var bandwidthLimitBytesPerSecond: Int64?
        var showBrowserMediaPanel: Bool?
        var confirmBrowserDownloads: Bool?
        var appearanceMode: String?
        var accentTheme: String?
        var customAccentHex: String?
        var languageMode: String?
        var smartConnections: Bool?
        var onboardingCompleted: Bool?
        var clipboardWatch: Bool?
        /// Was missing entirely, so a chosen quality was silently discarded on every
        /// relaunch even though the settings window read and wrote it.
        var mediaQuality: MediaQualityPreference?
        var transcriptionScope: String?
        var transcriptionLanguage: String?
        var transcriptionWritesTextFile: Bool?
        var quickActions: [QuickAction]?
        var installerSourceDisposition: String?
        var installerAutoAcceptLicense: Bool?
    }

    /// QA, preview, and packaged-QA launches redirect the support directory via
    /// NDM_SUPPORT_DIR. Settings must follow: writing them to the process's
    /// standard domain is exactly how an isolated run once leaked a QA bridge
    /// port into the user's real preferences.
    public static func activeDefaults() -> UserDefaults {
        if let dir = ProcessInfo.processInfo.environment["NDM_SUPPORT_DIR"], !dir.isEmpty {
            // Stable per-path suite keeps one isolated root readable across
            // restarts while never touching dev.ndm.open / NDMHost domains.
            var hash: UInt64 = 0xcbf29ce484222325
            for byte in dir.utf8 {
                hash = (hash ^ UInt64(byte)) &* 0x100000001b3
            }
            return UserDefaults(suiteName: "ndm.support.\(String(hash, radix: 16))") ?? .standard
        }
        return .standard
    }

    public static func load() -> AppSettings {
        load(defaults: activeDefaults())
    }

    /// Internal injection point keeps tests out of the production preferences domain.
    static func load(defaults: UserDefaults) -> AppSettings {
        guard let data = defaults.data(forKey: key),
              let disk = try? JSONDecoder().decode(DiskSettings.self, from: data) else {
            return AppSettings()
        }
        var settings = AppSettings(
            downloadDirectory: URL(fileURLWithPath: disk.downloadDirectory),
            maxConnections: disk.maxConnections,
            downloadAllAtOnce: disk.downloadAllAtOnce,
            showCompletionDialog: disk.showCompletionDialog,
            launchAtLogin: disk.launchAtLogin,
            useCategoryFolders: disk.useCategoryFolders,
            customUserAgent: disk.customUserAgent,
            useCustomUserAgent: disk.useCustomUserAgent,
            httpProxy: disk.httpProxy,
            httpsProxy: disk.httpsProxy,
            ftpProxy: disk.ftpProxy,
            socksProxy: disk.socksProxy,
            // Builds before the NDM-specific bridge used Neat's 10007. Migrate
            // that default so an existing install can coexist with Neat after
            // upgrading. Preserve any genuinely custom port.
            bridgePort: disk.bridgePort == BridgeConstants.legacyNeatPort
                ? BridgeConstants.port
                : disk.bridgePort,
            bandwidthLimitBytesPerSecond: disk.bandwidthLimitBytesPerSecond ?? 0,
            showBrowserMediaPanel: disk.showBrowserMediaPanel ?? true,
            confirmBrowserDownloads: disk.confirmBrowserDownloads ?? false,
            appearanceMode: AppearanceMode(rawValue: disk.appearanceMode ?? "") ?? .system,
            accentTheme: AccentTheme(rawValue: disk.accentTheme ?? "") ?? .classicBlue,
            customAccentHex: disk.customAccentHex,
            languageMode: AppLanguageMode(rawValue: disk.languageMode ?? "") ?? .system,
            smartConnections: disk.smartConnections ?? false
        )
        settings.onboardingCompleted = disk.onboardingCompleted
        settings.clipboardWatch = disk.clipboardWatch
        settings.mediaQuality = disk.mediaQuality
        settings.transcriptionScope = disk.transcriptionScope
            .flatMap(TranscriptionScope.init(rawValue:))
        settings.transcriptionLanguage = disk.transcriptionLanguage
        settings.transcriptionWritesTextFile = disk.transcriptionWritesTextFile
        settings.quickActions = disk.quickActions
        settings.installerSourceDisposition = disk.installerSourceDisposition
            .flatMap(InstallerSourceDisposition.init(rawValue:))
        settings.installerAutoAcceptLicense = disk.installerAutoAcceptLicense
        return settings
    }

    public static func save(_ settings: AppSettings) {
        save(settings, defaults: activeDefaults())
    }

    /// Internal injection point keeps tests out of the production preferences domain.
    static func save(_ settings: AppSettings, defaults: UserDefaults) {
        let disk = DiskSettings(
            downloadDirectory: settings.downloadDirectory.path,
            maxConnections: settings.maxConnections,
            downloadAllAtOnce: settings.downloadAllAtOnce,
            showCompletionDialog: settings.showCompletionDialog,
            launchAtLogin: settings.launchAtLogin,
            useCategoryFolders: settings.useCategoryFolders,
            customUserAgent: settings.customUserAgent,
            useCustomUserAgent: settings.useCustomUserAgent,
            httpProxy: settings.httpProxy,
            httpsProxy: settings.httpsProxy,
            ftpProxy: settings.ftpProxy,
            socksProxy: settings.socksProxy,
            bridgePort: settings.bridgePort,
            bandwidthLimitBytesPerSecond: settings.bandwidthLimitBytesPerSecond,
            showBrowserMediaPanel: settings.showBrowserMediaPanel,
            confirmBrowserDownloads: settings.confirmBrowserDownloads,
            appearanceMode: settings.appearanceMode.rawValue,
            accentTheme: settings.accentTheme.rawValue,
            customAccentHex: settings.customAccentHex,
            languageMode: settings.languageMode.rawValue,
            smartConnections: settings.smartConnections,
            onboardingCompleted: settings.onboardingCompleted,
            clipboardWatch: settings.clipboardWatch,
            mediaQuality: settings.mediaQuality,
            transcriptionScope: settings.transcriptionScope?.rawValue,
            transcriptionLanguage: settings.transcriptionLanguage,
            transcriptionWritesTextFile: settings.transcriptionWritesTextFile,
            quickActions: settings.quickActions,
            installerSourceDisposition: settings.installerSourceDisposition?.rawValue,
            installerAutoAcceptLicense: settings.installerAutoAcceptLicense
        )
        if let data = try? JSONEncoder().encode(disk) {
            defaults.set(data, forKey: key)
            defaults.synchronize()
        }
    }

    /// Mark first-run complete without rewriting unrelated settings.
    public static func markOnboardingCompleted() {
        var settings = load()
        settings.onboardingCompleted = true
        save(settings)
    }
}
