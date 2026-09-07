import Foundation

/// What a finished download actually is, for the one-click install surface.
///
/// Mirrors Rapidmg 1.3.1's archive handling (reverse spec 15): a `.dmg` is a
/// UDIF image carrying an HFS+/APFS volume, a `.pkg` is an installer package,
/// and a `.zip`-family file may contain app bundles. Everything else is just a
/// file — the completion window keeps its ordinary actions.
public enum InstallerKind: Equatable, Sendable {
    case dmg
    case pkg
    case appBundle
    case archive
    case notInstaller

    /// Known compression/archive extensions that may carry an app bundle.
    private static let archiveExtensions: Set<String> = [
        "zip", "7z", "tar", "gz", "tgz", "tbz", "tbz2", "bz2", "xz", "txz",
        "rar", "tar.gz", "tar.bz2", "tar.xz",
    ]

    public static func detect(filename: String) -> InstallerKind {
        let name = (filename as NSString).lastPathComponent
        guard !name.isEmpty, !name.hasPrefix(".") else { return .notInstaller }
        let ext = (name as NSString).pathExtension.lowercased()
        if ext.isEmpty { return .notInstaller }
        switch ext {
        case "dmg", "iso":
            return .dmg
        case "pkg", "mpkg":
            return .pkg
        case "app":
            return .appBundle
        default:
            return archiveExtensions.contains(ext) ? .archive : .notInstaller
        }
    }

    /// Whether the completion surface should offer an install action at all.
    public var offersInstall: Bool {
        switch self {
        case .dmg, .pkg, .appBundle, .archive:
            return true
        case .notInstaller:
            return false
        }
    }
}
