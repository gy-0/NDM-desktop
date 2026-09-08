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

extension BridgeProtocolTests {
    func testDurableEnvelopePreservesPayloadWithoutLeakingRequestIdentityToHeaders() throws {
        let id = "receipt_fixture_123456"
        let payload = "1:POST\r\n2:https://example.invalid/file\r\nCookie: private-fixture\r\n__0NeatPostData9__:a=one\r\ntwo"
        let json = try JSONSerialization.data(withJSONObject: ["requestId": id, "payload": payload])
        let parsed = try BridgeDurableProtocol.parse(BridgeDurableProtocol.requestPrefix + String(decoding: json, as: UTF8.self))
        XCTAssertEqual(parsed.requestID, id)
        XCTAssertEqual(parsed.message.method, "POST")
        XCTAssertEqual(parsed.message.postData, "a=one\r\ntwo")
        XCTAssertEqual(parsed.message.cookies, "private-fixture")
        XCTAssertTrue(parsed.message.extraHeaders.isEmpty)
    }
    func testDurableEnvelopeRejectsMalformedIdentitiesTypesAndOversize() throws {
        for id in ["short", String(repeating: "x", count: 129), "../../unsafe-identity", "abcdefghijklmnop\r\n", "编号abcdefghijklmnop"] {
            XCTAssertFalse(BridgeDurableProtocol.validRequestID(id))
        }
        for object: [String: Any] in [
            ["requestId": "abcdefghijklmnop", "payload": 123],
            ["requestId": "abcdefghijklmnop", "payload": "2:https://example.invalid", "extra": true],
            ["requestId": 123, "payload": "2:https://example.invalid"],
            ["requestId": "abcdefghijklmnop", "payload": "1:GET"]
        ] {
            let text = BridgeDurableProtocol.requestPrefix + String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
            XCTAssertThrowsError(try BridgeDurableProtocol.parse(text))
        }
        XCTAssertThrowsError(try BridgeDurableProtocol.parse(BridgeDurableProtocol.requestPrefix + "not-json"))
        let text = BridgeDurableProtocol.requestPrefix + String(repeating: "界", count: 40_000)
        XCTAssertNil(BridgeDurableProtocol.requestID(in: text))
        XCTAssertThrowsError(try BridgeDurableProtocol.parse(text))
    }
    func testDurableReceiptHasStableKeysAndDoesNotExposeNativeErrorText() throws {
        let raw = try BridgeDurableProtocol.encodeReceipt(requestID: "abcdefghijklmnop", receipt: .init(status: .deleted, taskID: 42))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.dropFirst(BridgeDurableProtocol.receiptPrefix.count).utf8)) as? [String: Any])
        XCTAssertEqual(object["status"] as? String, "deleted")
        XCTAssertEqual(object["taskId"] as? Int, 42)
        let failure = try BridgeDurableProtocol.encodeReceipt(requestID: "abcdefghijklmnop", receipt: .init(status: .rejected, error: "secret https://example.invalid"))
        XCTAssertFalse(failure.contains("secret")); XCTAssertTrue(failure.contains("internal-error"))
    }
}
