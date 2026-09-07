import Testing
@testable import NDMCore

@Suite("Inspector responsive policy")
struct InspectorResponsivePolicyTests {
    @Test("Compact automatic layout collapses an open inspector")
    func compactCollapsesOpenInspector() {
        let decision = resolve(width: 840, isCollapsed: false)

        #expect(decision == .init(action: .collapse, isAutoCollapsed: true))
    }

    @Test("Compact launch remembers an inspector that began collapsed")
    func compactLaunchRemembersAutomaticCollapse() {
        let decision = resolve(width: 840, isCollapsed: true)

        #expect(decision == .init(action: .none, isAutoCollapsed: true))
    }

    @Test("Hysteresis band preserves the automatic state")
    func middleBandPreservesState() {
        let decision = resolve(width: 1_000, isCollapsed: true, wasAutoCollapsed: true)

        #expect(decision == .init(action: .none, isAutoCollapsed: true))
    }

    @Test("Wide layout restores an automatically collapsed inspector")
    func wideRestoresInspectorWithSelection() {
        let decision = resolve(
            width: 1_100,
            isCollapsed: true,
            hasSelection: true,
            wasAutoCollapsed: true
        )

        #expect(decision == .init(action: .expand, isAutoCollapsed: false))
    }

    @Test("Wide layout waits for content before restoring the inspector")
    func wideWaitsForSelection() {
        let decision = resolve(
            width: 1_100,
            isCollapsed: true,
            hasSelection: false,
            wasAutoCollapsed: true
        )

        #expect(decision == .init(action: .none, isAutoCollapsed: true))
    }

    @Test("A manually collapsed inspector stays collapsed after selection")
    func manualCollapseWins() {
        let decision = resolve(
            width: 1_440,
            preference: .userCollapsed,
            isCollapsed: true,
            hasSelection: true,
            wasAutoCollapsed: true
        )

        #expect(decision == .init(action: .none, isAutoCollapsed: false))
    }

    @Test("A manually expanded inspector stays visible at compact width")
    func manualExpansionWins() {
        let decision = resolve(
            width: 840,
            preference: .userExpanded,
            isCollapsed: false
        )

        #expect(decision == .init(action: .none, isAutoCollapsed: false))
    }

    @Test("An already visible wide inspector clears stale automatic state")
    func visibleWideInspectorClearsAutomaticState() {
        let decision = resolve(
            width: 1_100,
            isCollapsed: false,
            wasAutoCollapsed: true
        )

        #expect(decision == .init(action: .none, isAutoCollapsed: false))
    }

    private func resolve(
        width: Double,
        preference: InspectorVisibilityPreference = .automatic,
        isCollapsed: Bool,
        hasSelection: Bool = false,
        wasAutoCollapsed: Bool = false
    ) -> InspectorResponsiveDecision {
        InspectorResponsivePolicy.resolve(
            windowWidth: width,
            preference: preference,
            isInspectorCollapsed: isCollapsed,
            hasSelection: hasSelection,
            wasAutoCollapsed: wasAutoCollapsed
        )
    }
}
