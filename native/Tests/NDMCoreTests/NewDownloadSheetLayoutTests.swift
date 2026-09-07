import XCTest
@testable import NDMCore

final class NewDownloadSheetLayoutTests: XCTestCase {
    func testCompactStateIgnoresSupplementalRows() {
        XCTAssertEqual(
            NewDownloadSheetLayout.contentHeight(
                hasPreview: false,
                showsStatus: true,
                showsHint: true
            ),
            214
        )
    }

    func testPreviewUsesOnlyTheSpaceItsVisibleRowsNeed() {
        XCTAssertEqual(
            NewDownloadSheetLayout.contentHeight(
                hasPreview: true,
                showsStatus: false,
                showsHint: false
            ),
            316
        )
        XCTAssertEqual(
            NewDownloadSheetLayout.contentHeight(
                hasPreview: true,
                showsStatus: true,
                showsHint: false
            ),
            335
        )
        XCTAssertEqual(
            NewDownloadSheetLayout.contentHeight(
                hasPreview: true,
                showsStatus: false,
                showsHint: true
            ),
            347
        )
        XCTAssertEqual(
            NewDownloadSheetLayout.contentHeight(
                hasPreview: true,
                showsStatus: true,
                showsHint: true
            ),
            366
        )
    }
}
