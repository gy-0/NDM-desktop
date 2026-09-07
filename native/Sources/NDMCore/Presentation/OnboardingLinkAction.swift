import Foundation

public enum OnboardingLinkAction: Equatable, Sendable {
    /// Put clipboard content into the welcome screen first so the user can see
    /// what NDM recognized before leaving the first-run experience.
    case inspect(String)
    case open(String)
    case needsInput
}

/// Keeps the first-run primary action predictable and independently testable.
/// Typed content always wins. Clipboard content is only a fallback when the
/// field is empty, and is inspected in place before the user continues, so an
/// invalid draft can never be silently replaced or leave the screen.
public enum OnboardingLinkActionPolicy {
    public static func action(
        fieldText: String,
        clipboardText: String?
    ) -> OnboardingLinkAction {
        let field = fieldText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !field.isEmpty {
            return SharedLinkResolver.resolve(field) == nil
                ? .needsInput
                : .open(field)
        }

        let clipboard = clipboardText?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !clipboard.isEmpty,
              SharedLinkResolver.resolve(clipboard) != nil else {
            return .needsInput
        }
        return .inspect(clipboard)
    }
}
