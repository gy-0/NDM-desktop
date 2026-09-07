import XCTest
@testable import NDMCore

final class SmoothProgressTrackerTests: XCTestCase {
    func testDisplayEasesTowardTargetWithoutOvershoot() {
        var tracker = SmoothProgressTracker(seed: 0.87)
        tracker.setTarget(0.95)

        var previous = tracker.display
        for _ in 0..<120 {
            let value = tracker.advance(by: 1.0 / 60.0)
            XCTAssertGreaterThanOrEqual(value, previous - 0.000_001)
            XCTAssertLessThanOrEqual(value, 0.95 + 0.000_001)
            previous = value
        }
        XCTAssertEqual(tracker.display, 0.95, accuracy: 0.002)
        XCTAssertTrue(tracker.isSettled)
    }

    func testMidFlightTargetIncreaseAcceleratesCatchUp() {
        var slow = SmoothProgressTracker(seed: 0.80)
        slow.setTarget(0.87)
        for _ in 0..<18 { _ = slow.advance(by: 1.0 / 60.0) }

        var fast = slow
        fast.setTarget(0.95)

        // After the same wall time, the accelerated tracker should be ahead.
        for _ in 0..<30 {
            _ = slow.advance(by: 1.0 / 60.0)
            _ = fast.advance(by: 1.0 / 60.0)
        }
        XCTAssertGreaterThan(fast.display, slow.display + 0.01)
        XCTAssertLessThanOrEqual(fast.display, 0.95 + 0.000_001)
    }

    func testIgnoresRetreatUnlessAllowed() {
        var tracker = SmoothProgressTracker(seed: 0.5)
        tracker.setTarget(0.7)
        tracker.setTarget(0.4)
        XCTAssertEqual(tracker.target, 0.7, accuracy: 0.000_001)

        tracker.setTarget(0.4, allowRetreat: true)
        XCTAssertEqual(tracker.target, 0.4, accuracy: 0.000_001)
    }

    func testCompleteConvergesQuicklyToOne() {
        var tracker = SmoothProgressTracker(seed: 0.92)
        tracker.setTarget(0.96, complete: true)

        for _ in 0..<30 {
            _ = tracker.advance(by: 1.0 / 60.0)
        }
        XCTAssertEqual(tracker.display, 1.0, accuracy: 0.002)
        XCTAssertTrue(tracker.isSettled)
    }

    func testResetAllowsTaskSwitch() {
        var tracker = SmoothProgressTracker(seed: 0.9)
        tracker.setTarget(0.95)
        _ = tracker.advance(by: 0.1)
        tracker.reset(to: 0.1)
        XCTAssertEqual(tracker.display, 0.1, accuracy: 0.000_001)
        XCTAssertEqual(tracker.target, 0.1, accuracy: 0.000_001)
        XCTAssertTrue(tracker.isSettled)
    }

    func testDurationScalesWithGap() {
        XCTAssertLessThan(
            SmoothProgressTracker.duration(forGap: 0.02),
            SmoothProgressTracker.duration(forGap: 0.12)
        )
        XCTAssertEqual(SmoothProgressTracker.duration(forGap: 0), 0.28, accuracy: 0.001)
        XCTAssertEqual(SmoothProgressTracker.duration(forGap: 1), 1.05, accuracy: 0.001)
    }
}
