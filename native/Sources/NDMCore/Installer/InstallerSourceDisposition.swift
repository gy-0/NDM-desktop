import Foundation

/// What happens to the installer file after a successful install.
///
/// The user's stance: most people download a DMG for one reason — to install —
/// and the DMG has no purpose afterwards. So the first-run default asks once,
/// with moving to Trash as the recommended answer, and the dialog can remember
/// the choice (reverse spec 15 §7 action semantics, minus Rapidmg's aggressive
/// silent default).
public enum InstallerSourceDisposition: String, Codable, Sendable, Equatable, CaseIterable {
    /// Ask after every install (the remembered dialog can change this).
    case ask = "ask"
    /// Move the installer to the Trash silently.
    case trash = "trash"
    /// Delete the installer outright.
    case delete = "delete"
    /// Keep the installer where it is.
    case keep = "keep"

    public static let defaultValue = InstallerSourceDisposition.ask

    /// The concrete action a disposition implies, if any.
    public enum SourceAction: Equatable, Sendable {
        case moveToTrash
        case delete
    }

    public var sourceAction: SourceAction? {
        switch self {
        case .ask, .keep:
            return nil
        case .trash:
            return .moveToTrash
        case .delete:
            return .delete
        }
    }

    /// The dialog's "remember my choice" updates the persistent disposition to
    /// whatever the user just picked; a dialog dismissed without remembering
    /// leaves the current disposition untouched.
    public static func disposition(
        choosing action: SourceAction?,
        remember: Bool,
        current: InstallerSourceDisposition
    ) -> InstallerSourceDisposition {
        guard remember, let action else { return current }
        switch action {
        case .moveToTrash:
            return .trash
        case .delete:
            return .delete
        }
    }
}
