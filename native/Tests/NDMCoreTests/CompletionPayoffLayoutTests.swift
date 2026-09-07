import Testing
@testable import NDMCore

@Suite("Completion payoff layout")
struct CompletionPayoffLayoutTests {
    @Test("Primary actions immediately follow the finished file")
    func primaryActionsStayWithResult() {
        let sections = CompletionPayoffLayout.sections(
            hasPromotedActions: true,
            hasArtifacts: true,
            hasDeliveryNotice: true
        )

        #expect(Array(sections.prefix(2)) == [.fileIdentity, .primaryActions])
    }

    @Test("Optional actions never outrank primary actions")
    func promotedActionsRemainSecondary() {
        let sections = CompletionPayoffLayout.sections(
            hasPromotedActions: true,
            hasArtifacts: false,
            hasDeliveryNotice: false
        )

        #expect(sections == [
            .fileIdentity,
            .primaryActions,
            .promotedActions,
            .audioStatus,
        ])
    }

    @Test("Absent optional content leaves a compact reading order")
    func omitsAbsentSections() {
        let sections = CompletionPayoffLayout.sections(
            hasPromotedActions: false,
            hasArtifacts: false,
            hasDeliveryNotice: false
        )

        #expect(sections == [.fileIdentity, .primaryActions, .audioStatus])
    }
}
