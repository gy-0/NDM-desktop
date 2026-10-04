import XCTest
@testable import NDMEngine

final class RangeRetryHandoffTests: XCTestCase {
    func testOneHealthyCompletionCanWakeOnlyOneRetry() {
        let handoff = RangeRetryHandoff()
        handoff.beginWait()
        handoff.beginWait()
        XCTAssertTrue(handoff.hasWaiter)
        XCTAssertFalse(handoff.take())
        handoff.offer()
        XCTAssertTrue(handoff.take())
        XCTAssertFalse(handoff.take(), "Repeated failures cannot create another immediate retry")
        handoff.endWait()
        XCTAssertTrue(handoff.hasWaiter)
        handoff.endWait()
        XCTAssertFalse(handoff.hasWaiter)
    }

    func testHealthyCompletionBeforeDisconnectCallbackIsNotLost() {
        let handoff = RangeRetryHandoff()
        handoff.offer()
        handoff.beginWait()
        XCTAssertTrue(handoff.take())
        handoff.endWait()
        handoff.beginWait()
        XCTAssertFalse(handoff.take())
        handoff.endWait()
        XCTAssertFalse(RangeRetryHandoff().take(), "A new round must not inherit old opportunities")
    }
}
