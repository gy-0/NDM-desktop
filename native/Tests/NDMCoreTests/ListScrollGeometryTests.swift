import XCTest
@testable import NDMCore

final class ListScrollGeometryTests: XCTestCase {
    /// 600pt of content in a 200pt viewport, currently showing 100…300.
    private func geometry(currentY: CGFloat = 100) -> ListScrollGeometry {
        ListScrollGeometry(currentY: currentY, viewportHeight: 200, contentHeight: 600)
    }

    // MARK: - Reveal moves as little as possible

    /// The whole point. The old pin forced the revealed row to offset 0, so a
    /// finished download landing anywhere but the top threw the list across.
    func testRevealingAnAlreadyVisibleRowScrollsNothing() {
        let geo = geometry(currentY: 100)
        let y = geo.scrollY(for: .reveal(rowMinY: 150, rowHeight: 40))
        XCTAssertEqual(y, 100, "a row already in view needs no scroll at all")
        XCTAssertTrue(geo.isSettled(for: .reveal(rowMinY: 150, rowHeight: 40)))
    }

    /// The common case: row 0 lands while the user is already at the top.
    func testRevealingRowZeroFromTheTopIsFree() {
        let geo = ListScrollGeometry(currentY: 0, viewportHeight: 200, contentHeight: 600)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 0, rowHeight: 56)), 0)
        XCTAssertTrue(geo.isSettled(for: .reveal(rowMinY: 0, rowHeight: 56)))
    }

    func testRevealingARowAboveTheViewportScrollsUpToItsTop() {
        let geo = geometry(currentY: 100)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 40, rowHeight: 40)), 40)
    }

    func testRevealingARowBelowTheViewportScrollsJustEnough() {
        let geo = geometry(currentY: 100)
        // Row occupies 380…420; viewport bottom is 300. Minimum move puts 420 at
        // the bottom edge, i.e. origin 220 — not the row's top at 380.
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 380, rowHeight: 40)), 220)
    }

    /// A row taller than the viewport cannot be shown whole; show its top.
    func testARowTallerThanTheViewportIsAlignedToItsTop() {
        let geo = geometry(currentY: 0)
        let y = geo.scrollY(for: .reveal(rowMinY: 100, rowHeight: 400))
        XCTAssertEqual(y, 300, "clamped to the bottom stop rather than scrolling past it")
    }

    // MARK: - Anchor holds identity

    func testAnchorPutsTheRowBackAtItsRecordedOffset() {
        let geo = geometry(currentY: 100)
        XCTAssertEqual(geo.scrollY(for: .anchor(rowMinY: 250, offset: 12)), 262)
    }

    func testAnchorWithZeroOffsetPutsTheRowAtTheViewportTop() {
        let geo = geometry(currentY: 100)
        XCTAssertEqual(geo.scrollY(for: .anchor(rowMinY: 250, offset: 0)), 250)
    }

    // MARK: - Clamping

    func testNeverScrollsPastTheBottomStop() {
        let geo = geometry()
        XCTAssertEqual(geo.maximumY, 400)
        XCTAssertEqual(geo.scrollY(for: .anchor(rowMinY: 580, offset: 0)), 400)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 590, rowHeight: 40)), 400)
    }

    func testNeverScrollsAboveZero() {
        let geo = geometry()
        XCTAssertEqual(geo.scrollY(for: .anchor(rowMinY: 10, offset: -50)), 0)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: -20, rowHeight: 40)), 0)
    }

    /// Content shorter than the viewport has nowhere to scroll.
    func testAShortListStaysPinnedAtZero() {
        let geo = ListScrollGeometry(currentY: 0, viewportHeight: 400, contentHeight: 120)
        XCTAssertEqual(geo.maximumY, 0)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 80, rowHeight: 40)), 0)
        XCTAssertEqual(geo.scrollY(for: .anchor(rowMinY: 80, offset: 0)), 0)
    }

    func testDegenerateMeasurementsAreClamped() {
        let geo = ListScrollGeometry(currentY: 0, viewportHeight: -10, contentHeight: -10)
        XCTAssertEqual(geo.viewportHeight, 0)
        XCTAssertEqual(geo.contentHeight, 0)
        XCTAssertEqual(geo.maximumY, 0)
    }

    /// A negative row height must not invert the comparison and scroll backwards.
    func testANegativeRowHeightIsTreatedAsZero() {
        let geo = geometry(currentY: 100)
        XCTAssertEqual(geo.scrollY(for: .reveal(rowMinY: 150, rowHeight: -40)), 100)
    }
}
