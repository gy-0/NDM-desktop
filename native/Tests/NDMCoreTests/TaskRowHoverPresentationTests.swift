import XCTest
@testable import NDMCore

final class TaskRowHoverPresentationTests: XCTestCase {
    func testHoverHandsMetricSpaceToAvailableActions() {
        XCTAssertEqual(
            TaskRowHoverPresentation.resolve(
                isHovered: true,
                hasActions: true,
                metricAvailable: true
            ),
            TaskRowHoverPresentation(showsActions: true, showsTrailingMetric: false)
        )
    }

    func testRestingRowShowsItsAvailableMetric() {
        XCTAssertEqual(
            TaskRowHoverPresentation.resolve(
                isHovered: false,
                hasActions: true,
                metricAvailable: true
            ),
            TaskRowHoverPresentation(showsActions: false, showsTrailingMetric: true)
        )
    }

    func testHoverWithoutActionsDoesNotEraseMetadata() {
        XCTAssertEqual(
            TaskRowHoverPresentation.resolve(
                isHovered: true,
                hasActions: false,
                metricAvailable: true
            ),
            TaskRowHoverPresentation(showsActions: false, showsTrailingMetric: true)
        )
    }

    func testUnavailableMetricStaysHiddenAtRest() {
        XCTAssertEqual(
            TaskRowHoverPresentation.resolve(
                isHovered: false,
                hasActions: true,
                metricAvailable: false
            ),
            TaskRowHoverPresentation(showsActions: false, showsTrailingMetric: false)
        )
    }
}
