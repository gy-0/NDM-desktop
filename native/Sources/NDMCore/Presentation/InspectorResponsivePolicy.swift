/// The user's explicit inspector choice for the current window session.
///
/// `.automatic` lets the window protect the task list at compact widths.
/// Once the user touches the inspector toggle, their choice wins until the
/// window is closed.
public enum InspectorVisibilityPreference: Equatable, Sendable {
    case automatic
    case userExpanded
    case userCollapsed
}

public enum InspectorResponsiveAction: Equatable, Sendable {
    case none
    case collapse
    case expand
}

public struct InspectorResponsiveDecision: Equatable, Sendable {
    public let action: InspectorResponsiveAction
    public let isAutoCollapsed: Bool

    public init(action: InspectorResponsiveAction, isAutoCollapsed: Bool) {
        self.action = action
        self.isAutoCollapsed = isAutoCollapsed
    }
}

/// Keeps the primary task list useful while still respecting an explicit pane
/// choice. Separate collapse and restore thresholds provide hysteresis, so the
/// inspector does not chatter while the user drags around a single boundary.
public enum InspectorResponsivePolicy {
    public static let collapseAtOrBelowWidth: Double = 960
    public static let restoreAtOrAboveWidth: Double = 1060

    public static func resolve(
        windowWidth: Double,
        preference: InspectorVisibilityPreference,
        isInspectorCollapsed: Bool,
        hasSelection: Bool,
        wasAutoCollapsed: Bool
    ) -> InspectorResponsiveDecision {
        guard preference == .automatic else {
            return InspectorResponsiveDecision(action: .none, isAutoCollapsed: false)
        }

        if windowWidth <= collapseAtOrBelowWidth {
            return InspectorResponsiveDecision(
                action: isInspectorCollapsed ? .none : .collapse,
                isAutoCollapsed: true
            )
        }

        if windowWidth >= restoreAtOrAboveWidth, wasAutoCollapsed {
            if !isInspectorCollapsed {
                return InspectorResponsiveDecision(action: .none, isAutoCollapsed: false)
            }
            if hasSelection {
                return InspectorResponsiveDecision(action: .expand, isAutoCollapsed: false)
            }
        }

        return InspectorResponsiveDecision(action: .none, isAutoCollapsed: wasAutoCollapsed)
    }
}
