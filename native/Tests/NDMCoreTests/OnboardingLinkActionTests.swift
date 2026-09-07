import XCTest
@testable import NDMCore

final class OnboardingLinkActionTests: XCTestCase {
    func testTypedLinkWinsOverClipboard() {
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: "https://example.com/manual.zip",
                clipboardText: "https://example.com/clipboard.dmg"
            ),
            .open("https://example.com/manual.zip")
        )
    }

    func testShareTextIsPreservedForTheNewDownloadHandoff() {
        let share = "这个视频很好看 https://youtu.be/abc123 复制打开"
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: share,
                clipboardText: nil
            ),
            .open(share)
        )
    }

    func testClipboardIsInspectedBeforeLeavingWhenTheFieldIsEmpty() {
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: "  ",
                clipboardText: "https://example.com/archive.zip"
            ),
            .inspect("https://example.com/archive.zip")
        )
    }

    func testClipboardShareTextIsPreservedForInspection() {
        let share = "复制这段文字 https://youtu.be/abc123 打开"
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: "",
                clipboardText: share
            ),
            .inspect(share)
        )
    }

    func testInvalidTypedDraftDoesNotSilentlyFallBackToClipboard() {
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: "not a link yet",
                clipboardText: "https://example.com/archive.zip"
            ),
            .needsInput
        )
    }

    func testMissingLinkRequestsInput() {
        XCTAssertEqual(
            OnboardingLinkActionPolicy.action(
                fieldText: "",
                clipboardText: "ordinary clipboard text"
            ),
            .needsInput
        )
    }
}
