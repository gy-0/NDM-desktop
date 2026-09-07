import XCTest
@testable import NDMCore

final class TaskRowInteractionStateTests: XCTestCase {
    func testSelectedRowWithListFocusIsKeyboardFocused() {
        XCTAssertEqual(
            TaskRowInteractionState.resolve(
                isSelected: true,
                isHovered: false,
                listHasKeyboardFocus: true
            ),
            .keyboardFocused
        )
    }

    func testSelectedRowRemainsSelectedWhenPointerAlsoHoversIt() {
        XCTAssertEqual(
            TaskRowInteractionState.resolve(
                isSelected: true,
                isHovered: true,
                listHasKeyboardFocus: false
            ),
            .selected
        )
    }

    func testRestingRowBecomesHoveredUnderPointer() {
        XCTAssertEqual(
            TaskRowInteractionState.resolve(
                isSelected: false,
                isHovered: true,
                listHasKeyboardFocus: false
            ),
            .hovered
        )
    }

    func testListFocusDoesNotHighlightAnUnselectedRow() {
        XCTAssertEqual(
            TaskRowInteractionState.resolve(
                isSelected: false,
                isHovered: false,
                listHasKeyboardFocus: true
            ),
            .resting
        )
    }

    func testHoverStillWorksOnUnselectedRowWhileListHasFocus() {
        XCTAssertEqual(
            TaskRowInteractionState.resolve(
                isSelected: false,
                isHovered: true,
                listHasKeyboardFocus: true
            ),
            .hovered
        )
    }
}
