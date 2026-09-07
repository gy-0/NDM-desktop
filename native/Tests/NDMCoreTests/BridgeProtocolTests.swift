import XCTest
@testable import NDMCore

final class BridgeProtocolTests: XCTestCase {
    func testParseNDMRelayShape() throws {
        let raw = [
            "1:GET",
            "2:https://example.com/file.zip",
            "6:normal",
            "4:Title",
            "Origin: https://example.com",
            "Referer: https://example.com/page",
            "5:https://example.com/page",
            "Cookie: a=b",
            "7:12345",
            "8:application/zip",
            "",
        ].joined(separator: "\r\n")
        let msg = try BridgeMessageParser.parse(raw)
        XCTAssertEqual(msg.method, "GET")
        XCTAssertEqual(msg.url, "https://example.com/file.zip")
        XCTAssertEqual(msg.ltype, "normal")
        XCTAssertEqual(msg.pageTitle, "Title")
        XCTAssertEqual(msg.origin, "https://example.com")
        XCTAssertEqual(msg.cookies, "a=b")
        XCTAssertEqual(msg.fileSize, 12345)
        XCTAssertEqual(msg.contentType, "application/zip")
    }

    func testConstantsUseNDMIdentityInsteadOfOriginalNeatBridge() {
        XCTAssertEqual(BridgeConstants.port, 51_873)
        XCTAssertNotEqual(BridgeConstants.port, BridgeConstants.legacyNeatPort)
        XCTAssertEqual(BridgeConstants.path, "/ndm/download")
        XCTAssertEqual(BridgeConstants.subprotocol, "ndm.open.v1")
        XCTAssertEqual(BridgeConstants.endpoint, "ws://127.0.0.1:51873/ndm/download")
        XCTAssertEqual(BridgeConstants.waiting, "waiting")
    }

    func testParseFirstClassMediaPageRoute() throws {
        let raw = [
            "1:GET",
            "2:https://x.com/example/status/123",
            "6:media-page",
            "4:Download with NDM",
            "Referer: https://x.com/home",
            "",
        ].joined(separator: "\r\n")

        let message = try BridgeMessageParser.parse(raw)
        XCTAssertEqual(message.url, "https://x.com/example/status/123")
        XCTAssertEqual(message.ltype, "media-page")
    }
}
