import Foundation

/// Whether this Mac can transcribe a given language *right now*, and what has to
/// happen first if it cannot.
///
/// A first-time language needs a one-off system download. That must read as a
/// stage with a name, not as a hang — the whole reason this type exists is so the
/// waiting has an explanation attached to it.
public enum LanguageAssetReadiness: Equatable, Sendable {
    /// Installed; transcription can start immediately.
    case ready
    /// Supported, but the one-off download has not happened yet.
    case needsPreparation
    /// The download is running. `fraction` is nil until the system reports a real
    /// figure — measured behaviour: a freshly created request reports an
    /// indeterminate progress with a zero total, and showing that as "0%" would be
    /// inventing a number.
    case preparing(fraction: Double?)
    /// This Mac cannot transcribe the language at all.
    case unsupported

    /// Derive readiness from what the system reports.
    ///
    /// Installed-ness comes from the installed-locale list rather than from
    /// `AssetInventory.status`, which was measured returning `.supported` for a
    /// language that is in fact installed and so cannot answer this question.
    public static func from(isInstalled: Bool, isSupported: Bool) -> LanguageAssetReadiness {
        if isInstalled { return .ready }
        return isSupported ? .needsPreparation : .unsupported
    }

    public var isReady: Bool { self == .ready }

    /// True while the user should be looking at a stage rather than a result.
    public var isWaiting: Bool {
        switch self {
        case .needsPreparation, .preparing: return true
        case .ready, .unsupported: return false
        }
    }

    /// Determinate progress, or nil when there is nothing honest to show yet.
    public var fraction: Double? {
        if case .preparing(let fraction) = self { return fraction }
        return nil
    }

    /// `languageName` should already be localized for display, e.g. 中文 / Chinese.
    public func title(languageName: String) -> String {
        switch self {
        case .ready:
            return L10n.t("Ready", "已就绪")
        case .needsPreparation:
            return L10n.t(
                "\(languageName) needs a one-time setup",
                "\(languageName)需要先准备一次"
            )
        case .preparing:
            return L10n.t("Getting ready for \(languageName)", "正在准备\(languageName)")
        case .unsupported:
            return L10n.t(
                "\(languageName) isn't available on this Mac",
                "这台 Mac 不支持\(languageName)"
            )
        }
    }

    public func detail(languageName: String) -> String {
        switch self {
        case .ready:
            return L10n.t(
                "Reading speech happens on this Mac; nothing is uploaded.",
                "语音识别在本机完成，不上传任何内容。"
            )
        case .needsPreparation:
            return L10n.t(
                "The first time you read speech in \(languageName), your Mac downloads what it needs. It happens once.",
                "第一次识别\(languageName)语音时，Mac 会下载所需内容。只有这一次。"
            )
        case .preparing:
            return L10n.t(
                "This happens once. The transcript starts on its own when it's done.",
                "只有这一次。准备好之后会自动开始生成文稿。"
            )
        case .unsupported:
            return L10n.t(
                "Everything else keeps working.",
                "其他功能不受影响。"
            )
        }
    }
}
