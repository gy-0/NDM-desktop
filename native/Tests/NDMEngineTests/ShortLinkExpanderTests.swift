import XCTest
@testable import NDMCore
@testable import NDMEngine

final class ShortLinkExpanderTests: XCTestCase {
    /// The resolver's ranking list and the expander's allowlist describe the
    /// same product capability; if one gains a host the other must too, or
    /// short links from that host silently skip expansion.
    func testShortLinkHostsStayInLockstepWithResolver() {
        XCTAssertEqual(SharedLinkResolver.shortLinkHosts, ShortLinkExpander.exactHosts)
    }

    func testRecognizesKnownShortLinkHosts() {
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://v.douyin.com/abc/"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://xhslink.com/a/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://b23.tv/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://youtu.be/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://vm.tiktok.com/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://v.kuaishou.com/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://fb.watch/abc"))
        XCTAssertTrue(ShortLinkExpander.shouldExpand("https://dai.ly/abc"))
    }

    func testLeavesFullAndDirectURLsAlone() {
        XCTAssertFalse(ShortLinkExpander.shouldExpand("https://www.youtube.com/watch?v=abc"))
        XCTAssertFalse(ShortLinkExpander.shouldExpand("https://example.com/video.mp4"))
        XCTAssertFalse(ShortLinkExpander.shouldExpand("file:///tmp/video.mp4"))
    }

    func testExpansionUsesFinalWebURLAndRemovesFragment() async {
        let result = await ShortLinkExpander.expand("https://b23.tv/abc") { request in
            XCTAssertEqual(request.httpMethod, "HEAD")
            return URL(string: "https://www.bilibili.com/video/BV123?p=1#reply")
        }
        XCTAssertEqual(result.resolvedURL, "https://www.bilibili.com/video/BV123?p=1")
        XCTAssertTrue(result.didExpand)
    }

    func testHeadFailureFallsBackToRangeGet() async {
        let result = await ShortLinkExpander.expand("https://v.douyin.com/abc/") { request in
            if request.httpMethod == "HEAD" { return request.url }
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=0-0")
            return URL(string: "https://www.douyin.com/video/123456")
        }
        XCTAssertEqual(result.resolvedURL, "https://www.douyin.com/video/123456")
        XCTAssertTrue(result.didExpand)
    }

    func testRejectsNonWebRedirectAndFallsBack() async {
        let original = "https://xhslink.com/a/abc"
        let result = await ShortLinkExpander.expand(original) { _ in
            URL(fileURLWithPath: "/tmp/not-web")
        }
        XCTAssertEqual(result.resolvedURL, original)
        XCTAssertFalse(result.didExpand)
    }
}
