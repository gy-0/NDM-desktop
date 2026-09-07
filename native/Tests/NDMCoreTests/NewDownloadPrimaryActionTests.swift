import XCTest
@testable import NDMCore

final class NewDownloadPrimaryActionTests: XCTestCase {
    func testUnavailableLinkKeepsTheActionDisabled() {
        XCTAssertEqual(
            NewDownloadPrimaryActionPolicy.action(
                hasDownloadableLink: false,
                requiresQualityChoice: false,
                hasDuplicate: false
            ),
            .unavailable
        )
    }

    func testDirectFileNamesTheImmediateDownload() {
        XCTAssertEqual(
            NewDownloadPrimaryActionPolicy.action(
                hasDownloadableLink: true,
                requiresQualityChoice: false,
                hasDuplicate: false
            ),
            .downloadFile
        )
    }

    func testMediaPageNamesTheQualityPickerBeforePreparationCompletes() {
        XCTAssertEqual(
            NewDownloadPrimaryActionPolicy.action(
                hasDownloadableLink: true,
                requiresQualityChoice: true,
                hasDuplicate: false
            ),
            .chooseQuality
        )
    }

    func testPreparedDefaultNamesTheExactDownload() {
        XCTAssertEqual(
            NewDownloadPrimaryActionPolicy.action(
                hasDownloadableLink: true,
                requiresQualityChoice: true,
                hasDuplicate: false,
                preparedQuality: "1080p",
                preparedContainer: "MP4"
            ),
            .downloadPrepared(quality: "1080p", container: "MP4")
        )
    }

    func testDuplicateTakesPriorityOverPreparedDefault() {
        XCTAssertEqual(
            NewDownloadPrimaryActionPolicy.action(
                hasDownloadableLink: true,
                requiresQualityChoice: true,
                hasDuplicate: true,
                preparedQuality: "2160p",
                preparedContainer: "MP4"
            ),
            .downloadAgain
        )
    }
}
