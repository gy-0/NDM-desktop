import Foundation

/// What to do with the source installer file after a successful install.
///
/// Mirrors Rapidmg's `RDNoAppAction` / `RDActionAfterExpand` enum (reverse
/// spec 15 §7). NDM defaults to `.leaveAlone`: the completion window is a
/// handoff surface, not a janitor — destroying a download the user may still
/// want is an explicit choice, never a default.
public enum InstallerAfterAction: Int, CaseIterable, Equatable, Sendable {
    case leaveAlone = 0
    case moveToTrash = 1
    case delete = 2
    case mount = 3
    case expandInPlace = 4

    /// Whether the action mutates or removes the source file.
    public var isDestructive: Bool {
        switch self {
        case .leaveAlone, .mount, .expandInPlace:
            return false
        case .moveToTrash, .delete:
            return true
        }
    }
}
