import XCTest
@testable import NDMEngine

final class YtDlpAccessTaxonomyTests: XCTestCase {
    private func error(_ text: String) -> NSError { NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    func testGeographicMarkersNeverRequestCookies() {
        for text in ["not available in your country", "not available in your region", "geo-restricted", "geo restricted", "地区限制", "所在地区不可用"] {
            XCTAssertEqual(YtDlpTool.accessIssue(error: error(text)), .regionRestricted, text)
            XCTAssertFalse(YtDlpTool.requiresCookies(error: error(text)), text)
        }
    }
    func testEntitlementMarkersNeverRequestCookies() {
        for text in ["members-only", "members only", "premium-only", "premium only", "subscriber-only", "subscriber only", "仅限会员", "会员专享", "メンバー限定", "회원 전용"] {
            XCTAssertEqual(YtDlpTool.accessIssue(error: error(text)), .entitlementRequired, text)
            XCTAssertFalse(YtDlpTool.requiresCookies(error: error(text)), text)
        }
    }
    func testSpecificRestrictionOutranksGenericCookieSuggestion() {
        for (text, expected) in [("This video is geo-restricted. Use --cookies-from-browser", YtDlpAccessIssue.regionRestricted),
                                 ("Members-only video. Login required; use --cookies-from-browser", .entitlementRequired)] {
            XCTAssertEqual(YtDlpTool.accessIssue(error: error(text)), expected)
            XCTAssertFalse(YtDlpTool.requiresCookies(error: error(text)))
        }
    }
    func testLoginAndBrowserReadFailuresRetainClassification() {
        for text in ["Fresh cookies are needed", "Sign in to confirm your age", "This video is private", "请登录", "only available to registered users"] {
            XCTAssertEqual(YtDlpTool.accessIssue(error: error(text)), .browserSessionRequired)
            XCTAssertTrue(YtDlpTool.requiresCookies(error: error(text)))
        }
        let locked = error("Could not copy Chrome cookie database: database is locked")
        XCTAssertEqual(YtDlpTool.accessIssue(error: locked), .browserDataUnavailable)
        XCTAssertTrue(YtDlpTool.requiresCookies(error: locked))
    }
    func testOrdinaryToolLimitAndDRMFailuresDoNotBecomeAccessActions() {
        for text in ["HTTP Error 429: Too Many Requests", "No supported JavaScript runtime could be found", "This video is DRM protected", "Unsupported URL", "Unable to download webpage: Connection refused"] {
            XCTAssertNil(YtDlpTool.accessIssue(error: error(text)))
            XCTAssertFalse(YtDlpTool.requiresCookies(error: error(text)))
        }
    }

    func testMultilineRestrictionSurvivesTrailingLoginAdvice() {
        for (reason, expected) in [("ERROR: This video is not available in your country", YtDlpAccessIssue.regionRestricted),
                                   ("ERROR: Members-only content", .entitlementRequired)] {
            let selected = YtDlpTool.failureMessage(stderr: reason + "\nUse --cookies-from-browser to log in\nERROR: Unable to download video", stdout: "")
            XCTAssertEqual(selected, reason)
            XCTAssertEqual(YtDlpTool.accessIssue(in: selected), expected)
            XCTAssertFalse(YtDlpTool.requiresCookies(error: error(selected)))
        }
    }
    func testFailureSelectionPreservesCookieAndOrdinaryErrors() {
        let cookie = "ERROR: Could not copy Chrome cookie database"
        XCTAssertEqual(YtDlpTool.failureMessage(stderr: cookie + "\nERROR: Unable to download", stdout: ""), cookie)
        for line in ["ERROR: HTTP Error 429: Too Many Requests", "ERROR: This video is DRM protected", "ERROR: No supported JavaScript runtime could be found"] {
            XCTAssertEqual(YtDlpTool.failureMessage(stderr: "WARNING: temporary diagnostic\n" + line, stdout: ""), line)
        }
        XCTAssertEqual(YtDlpTool.failureMessage(stderr: "", stdout: "diagnostic\nfinal tool failure"), "final tool failure")
    }
}
