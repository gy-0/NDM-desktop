import XCTest
@testable import NDMBridge

final class RelaySessionRequestsTests: XCTestCase {
    func testResponseParserRejectsMalformedOrOversizeCorrelations() throws {
        let id = UUID().uuidString
        let text = "NDMRelaySessionResponse:" + String(decoding: try JSONSerialization.data(withJSONObject:
            ["requestId": id, "sessionID": id, "cookies": "ZmFrZQ=="]), as: UTF8.self)
        XCTAssertEqual(RelaySessionRequests.parseResponse(text)?.sessionID, id)
        for text in ["not a session response", "NDMRelaySessionResponse:{}",
            "NDMRelaySessionResponse:{\"requestId\":\"short\",\"sessionID\":\"short\",\"cookies\":\"\"}",
            "NDMRelaySessionResponse:" + String(repeating: "x", count: 120_000)] {
            XCTAssertNil(RelaySessionRequests.parseResponse(text))
        }
    }

    func testOnlyMatchingSessionResponseResolvesPendingRequest() async throws {
        actor Messages {
            var values: [String] = []
            func append(_ value: String) { values.append(value) }
            func first() -> String? { values.first }
        }
        let messages = Messages()
        let requests = RelaySessionRequests(timeoutMilliseconds: 1000) { value in Task { await messages.append(value) } }
        let sessionID = UUID().uuidString
        let pending = Task { await requests.request(sessionID: sessionID, url: "https://example.test/watch") }
        var message: String?
        for _ in 0..<100 {
            message = await messages.first()
            if message != nil { break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        let raw = try XCTUnwrap(message)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.dropFirst("NDMRelaySessionRequest:".count).utf8)) as? [String: String])
        let requestID = try XCTUnwrap(object["requestId"])
        func response(_ session: String, cookies: String) throws -> RelaySessionRequests.Response {
            try XCTUnwrap(RelaySessionRequests.parseResponse("NDMRelaySessionResponse:" + String(decoding:
                JSONSerialization.data(withJSONObject: ["requestId": requestID, "sessionID": session, "cookies": cookies]), as: UTF8.self)))
        }
        await requests.receive(try response(UUID().uuidString, cookies: "wrong"))
        await requests.receive(try response(sessionID, cookies: "correct"))
        let result = await pending.value
        XCTAssertEqual(result, "correct")
    }

    func testDisconnectedProfileTimesOutWithoutCookieOrBrowserFallback() async {
        let requests = RelaySessionRequests(timeoutMilliseconds: 20) { _ in }
        let result = await requests.request(sessionID: UUID().uuidString, url: "https://example.test/watch")
        XCTAssertNil(result)
    }
}
