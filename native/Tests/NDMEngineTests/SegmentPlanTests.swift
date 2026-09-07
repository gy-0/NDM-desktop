import XCTest
@testable import NDMCore

/// Placeholder — segment planning tests will expand with engine internals.
final class SegmentPlanTests: XCTestCase {
    func testSegmentStateLength() {
        let s = SegmentState(id: 0, start: 0, end: 99)
        XCTAssertEqual(s.length, 100)
    }
}
