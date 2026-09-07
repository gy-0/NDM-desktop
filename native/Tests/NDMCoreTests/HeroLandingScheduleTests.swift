import XCTest
@testable import NDMCore

final class HeroLandingScheduleTests: XCTestCase {
    /// The regression. Teardown used to be scheduled at `duration + 0.02` from the
    /// call while the animation ran from `1/60 + duration`, leaving ~3ms of slack.
    /// A single dropped frame then removed the overlay while the frozen cover was
    /// still fully opaque, which reads on screen as a pop.
    func testTeardownLandsAClearMarginAfterTheLastAnimatedFrame() {
        let schedule = HeroLandingSchedule(duration: 0.46)
        XCTAssertGreaterThan(
            schedule.teardownSlack,
            2 * HeroLandingSchedule.frame,
            "one busy frame must not be enough to yank the overlay early"
        )
    }

    func testTeardownAccountsForTheBeginOffset() {
        let schedule = HeroLandingSchedule(duration: 0.46)
        XCTAssertGreaterThan(
            schedule.teardownAt,
            schedule.beginOffset + schedule.duration,
            "scheduling teardown from the call time instead of the begin time was the bug"
        )
    }

    /// The handoff lands exactly on the morph's last frame, where the overlay and the
    /// row are in the same place. Earlier only worked while the row was stationary;
    /// with the Hero strip collapsing during the morph the row is still travelling, so
    /// an early reveal would show it offset from the overlay.
    func testRevealLandsOnTheMorphsLastFrame() {
        let schedule = HeroLandingSchedule(duration: 0.46)
        XCTAssertGreaterThan(schedule.revealAt, schedule.beginsAt)
        XCTAssertEqual(schedule.revealAt, schedule.endsAt, accuracy: 1e-9)
    }

    /// …and strictly before the overlay is removed, so the swap is never a frame with
    /// nothing drawn.
    func testRevealPrecedesTeardown() {
        let schedule = HeroLandingSchedule(duration: 0.46)
        XCTAssertLessThan(schedule.revealAt, schedule.teardownAt)
    }

    func testRevealAlsoShiftsWithTheBeginOffset() {
        let withOffset = HeroLandingSchedule(duration: 0.46, beginOffset: HeroLandingSchedule.frame)
        let withoutOffset = HeroLandingSchedule(duration: 0.46, beginOffset: 0)
        XCTAssertEqual(
            withOffset.revealAt - withoutOffset.revealAt,
            HeroLandingSchedule.frame,
            accuracy: 1e-9,
            "the reveal is measured in animation time, not call time"
        )
    }

    // MARK: - Ordering holds at any duration

    func testStagesStayOrderedAcrossPlausibleDurations() {
        for duration in [0.0, 0.12, 0.3, 0.46, 0.9, 2.0] {
            let schedule = HeroLandingSchedule(duration: duration)
            XCTAssertLessThanOrEqual(schedule.beginsAt, schedule.revealAt, "duration \(duration)")
            XCTAssertLessThanOrEqual(schedule.revealAt, schedule.endsAt, "duration \(duration)")
            XCTAssertLessThan(schedule.endsAt, schedule.teardownAt, "duration \(duration)")
        }
    }

    /// A zero-length morph still has to tear down after it starts, not before.
    func testAZeroDurationMorphStillTearsDownAfterItBegins() {
        let schedule = HeroLandingSchedule(duration: 0)
        XCTAssertEqual(schedule.endsAt, schedule.beginOffset)
        XCTAssertGreaterThan(schedule.teardownAt, schedule.beginsAt)
    }

    // MARK: - Clamping

    func testDegenerateInputsAreClampedRatherThanTrusted() {
        let schedule = HeroLandingSchedule(
            duration: -1,
            beginOffset: -1,
            revealFraction: 4,
            teardownMargin: 0
        )
        XCTAssertEqual(schedule.duration, 0)
        XCTAssertEqual(schedule.beginOffset, 0)
        XCTAssertEqual(schedule.revealFraction, 1)
        XCTAssertGreaterThanOrEqual(
            schedule.teardownMargin,
            HeroLandingSchedule.frame,
            "a zero margin is the defect; refuse it at construction"
        )
    }

    func testFrameIsOneSixtiethOfASecond() {
        XCTAssertEqual(HeroLandingSchedule.frame, 1.0 / 60.0, accuracy: 1e-12)
    }
}
