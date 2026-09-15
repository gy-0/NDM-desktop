import XCTest
@testable import NDMEngine

final class DouyinSessionTests: XCTestCase {
    func testScopeExpiryAndHttpOnlyCookies() {
        let jar = """
        # Netscape HTTP Cookie File
        #HttpOnly_.douyin.com\tTRUE\t/\tTRUE\t0\tsessionid\tselected-user
        .douyin.com\tTRUE\t/\tTRUE\t10\texpired\told
        .douyin.com.evil.example\tTRUE\t/\tTRUE\t0\tsessionid\tother-user
        .youtube.com\tTRUE\t/\tTRUE\t0\tunrelated\tsecret
        """
        XCTAssertEqual(DouyinCookieStore.parse(jar, now: Date(timeIntervalSince1970: 100)),
                       ["sessionid": "selected-user"])
    }

    func testCookieDomainPathSecureAndDuplicateNameScope() {
        let jar = DouyinCookieJar("""
        .douyin.com\tTRUE\t/\tFALSE\t0\tsid\troot
        www.douyin.com\tFALSE\t/aweme/\tTRUE\t0\tsid\tapi
        www.douyin.com\tFALSE\t/aweme-extra\tTRUE\t0\twrongPath\tno
        douyin.com\tFALSE\t/\tTRUE\t0\thostOnly\tno
        .iesdouyin.com\tTRUE\t/\tTRUE\t0\tsid\tother-origin
        .amemv.com\tTRUE\t/\tTRUE\t0\totherSibling\tno
        live.douyin.com\tFALSE\t/\tTRUE\t0\tliveOnly\tno
        """)
        let api = URL(string: "https://www.douyin.com/aweme/v1/web/aweme/detail/")!
        XCTAssertEqual(jar.values(for: api), ["sid": "api"])
        XCTAssertEqual(jar.header(for: api), "sid=api; sid=root")
        XCTAssertEqual(jar.header(for: URL(string: "http://www.douyin.com/aweme/x")!), "sid=root")
        XCTAssertEqual(jar.header(for: URL(string: "https://www.douyin.com/awemex")!), "sid=root")
        XCTAssertEqual(jar.header(for: URL(string: "https://example.org/aweme/x")!), "")
    }

    func testAccessRejectionsNeverClaimMissingCookies() {
        for (status, body) in [(403, "denied"), (429, "slow down"), (200, "")] {
            XCTAssertThrowsError(try DouyinAPIClient.responseJSON(data: Data(body.utf8), status: status)) { error in
                XCTAssertEqual(error as? DouyinClientError, .requestRejected(statusCode: status))
                XCTAssertNil(YtDlpTool.accessIssue(error: error))
            }
        }
    }

    func testExplicitLoginFailureRemainsActionable() {
        for json in [#"{"status_code":2483}"#, #"{"status_code":1,"status_msg":"用户未登录"}"#] {
            XCTAssertThrowsError(try DouyinAPIClient.responseJSON(data: Data(json.utf8), status: 200)) { error in
                XCTAssertEqual(error as? DouyinClientError, .sessionRequired)
                XCTAssertEqual(YtDlpTool.accessIssue(error: error), .browserSessionRequired)
            }
        }
    }

    func testServerFailureAndUnreadableDataAreDistinct() {
        XCTAssertThrowsError(try DouyinAPIClient.responseJSON(data: Data("upstream".utf8), status: 503)) {
            XCTAssertEqual($0 as? DouyinClientError, .api(statusCode: 503, message: nil))
        }
        XCTAssertThrowsError(try DouyinAPIClient.responseJSON(data: Data("html challenge".utf8), status: 200)) {
            XCTAssertEqual($0 as? DouyinClientError, .invalidResponse)
        }
    }

    func testBrowserReadErrorDoesNotExposeProfilePath() {
        let error = DouyinCookieStore.browserDataFailure(in: "ERROR: Could not copy cookie database /Users/private-user/Profile 7/Cookies")
        XCTAssertNotNil(error)
        XCTAssertFalse(error?.contains("private-user") == true)
        XCTAssertFalse(error?.contains("Profile 7") == true)
    }
}
