import XCTest
@testable import NDMCore

final class TaskRowTrailingMetricPolicyTests: XCTestCase {
    func testCompactCompletedRowPrioritizesFilename() {
        XCTAssertFalse(TaskRowTrailingMetricPolicy.showsTrailingMetric(
            rowWidth: 359,
            interfaceScale: 1,
            isDownloading: false
        ))
    }

    func testWideCompletedRowKeepsFileSize() {
        XCTAssertTrue(TaskRowTrailingMetricPolicy.showsTrailingMetric(
            rowWidth: 360,
            interfaceScale: 1,
            isDownloading: false
        ))
    }

    func testLiveProgressRemainsVisibleAtEveryWidth() {
        XCTAssertTrue(TaskRowTrailingMetricPolicy.showsTrailingMetric(
            rowWidth: 240,
            interfaceScale: 1.35,
            isDownloading: true
        ))
    }

    func testInterfaceScaleRaisesTheReadabilityThreshold() {
        XCTAssertFalse(TaskRowTrailingMetricPolicy.showsTrailingMetric(
            rowWidth: 400,
            interfaceScale: 1.2,
            isDownloading: false
        ))
    }
}
