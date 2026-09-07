import Foundation

/// Decides what one-click install should do for a finished download.
///
/// Ported from Rapidmg 1.3.1's orchestration (reverse spec 15 §3/§6): after a
/// kind is known and the app bundles inside are enumerated, the plan is either
/// a direct install, a choice among several apps, or a no-app fallback. Pure
/// and offline-testable — the executor (mount/copy/trash) stays in NDMApp.
public enum InstallerPlan: Equatable, Sendable {
    /// Install the single discovered app bundle. The payload is its path
    /// relative to the volume/archive root (e.g. `Foo.app` or
    /// `Some Folder/Bar.app`); the destination name is its last component.
    case install(app: String)
    /// Several app bundles were found; the user picks one by candidate path.
    case chooseApp(candidates: [String])
    /// No app bundle found; the source file needs a human hand.
    case noAppFound
    /// The file is not an installer at all — keep ordinary completion actions.
    case notApplicable

    /// Build a plan from the detected kind and the enumerated entries.
    ///
    /// - Parameters:
    ///   - kind: `InstallerKind.detect(filename:)` result for the file.
    ///   - entries: raw archive/volume entry paths (may include fs private data).
    public static func make(kind: InstallerKind, entries: [String]) -> InstallerPlan {
        guard kind.offersInstall else { return .notApplicable }
        let candidates = InstallerFilter.appBundleCandidates(entries: entries)
        switch candidates.count {
        case 0:
            return .noAppFound
        case 1:
            return .install(app: candidates[0])
        default:
            return .chooseApp(candidates: candidates)
        }
    }

    /// The app bundle name that should land in `/Applications`.
    public var destinationName: String? {
        switch self {
        case .install(let app):
            return (app as NSString).lastPathComponent
        case .chooseApp, .noAppFound, .notApplicable:
            return nil
        }
    }

    /// Pick the app a list row should represent when a disk image carries more
    /// than one bundle. Prefers a name that matches the image filename, then
    /// skips uninstallers, then keeps archive order.
    public static func preferredApp(candidates: [String], filename: String) -> String? {
        guard !candidates.isEmpty else { return nil }
        if candidates.count == 1 { return candidates[0] }
        let stem = normalizedStem(filename)
        if !stem.isEmpty {
            if let exact = candidates.first(where: { normalizedStem($0) == stem }) {
                return exact
            }
            if let fuzzy = candidates.first(where: { candidate in
                let name = normalizedStem(candidate)
                return !name.isEmpty && (stem.contains(name) || name.contains(stem))
            }) {
                return fuzzy
            }
        }
        let usable = candidates.filter { !normalizedStem($0).contains("uninstall") }
        return usable.first ?? candidates.first
    }

    private static func normalizedStem(_ path: String) -> String {
        let last = (path as NSString).lastPathComponent
        return ((last as NSString).deletingPathExtension as String)
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "-", with: "")
            .replacingOccurrences(of: "_", with: "")
    }
}
