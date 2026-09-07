/// Resolves the trailing handoff between passive row metadata and hover actions.
public struct TaskRowHoverPresentation: Equatable, Sendable {
    public let showsActions: Bool
    public let showsTrailingMetric: Bool

    public static func resolve(
        isHovered: Bool,
        hasActions: Bool,
        metricAvailable: Bool
    ) -> Self {
        let showsActions = isHovered && hasActions
        return Self(
            showsActions: showsActions,
            showsTrailingMetric: metricAvailable && !showsActions
        )
    }
}
