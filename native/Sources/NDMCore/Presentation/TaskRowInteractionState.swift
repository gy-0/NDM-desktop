/// The single visual state a task row should present at any moment.
///
/// Keeping the precedence here prevents hover, selection, and keyboard focus
/// from stacking into an ambiguous collection of independent effects.
public enum TaskRowInteractionState: Equatable, Sendable {
    case resting
    case hovered
    case selected
    case keyboardFocused

    public static func resolve(
        isSelected: Bool,
        isHovered: Bool,
        listHasKeyboardFocus: Bool
    ) -> Self {
        if isSelected {
            return listHasKeyboardFocus ? .keyboardFocused : .selected
        }
        return isHovered ? .hovered : .resting
    }
}
