import XCTest
@testable import NDMCore

final class FilenameDisplayTextTests: XCTestCase {
    func testAddsBreaksInsideStemAndKeepsExtensionTogether() {
        XCTAssertEqual(
            FilenameDisplayText.wrapping("TencentVideo2.175.0.55797.dmg"),
            "TencentVideo2.\u{200B}175.\u{200B}0.\u{200B}55797\u{2060}.\u{2060}dmg"
        )
    }

    func testHandlesNamesWithoutExtensions() {
        XCTAssertEqual(
            FilenameDisplayText.wrapping("release_candidate-final"),
            "release_\u{200B}candidate-\u{200B}final"
        )
    }

    func testLeavesLeadingAndTrailingDotsAsOrdinaryStemText() {
        XCTAssertEqual(FilenameDisplayText.wrapping(".env"), ".\u{200B}env")
        XCTAssertEqual(FilenameDisplayText.wrapping("download."), "download.\u{200B}")
    }
}
