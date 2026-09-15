import XCTest
import NDMCore
@testable import NDMBridge

private final class PageMediaWire: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [(String, String)] = []
    var now = Date()
    func append(_ client: String, _ text: String) -> Bool { lock.lock(); defer { lock.unlock() }; values.append((client, text)); return true }
    func take(_ op: String, client: String) -> [String: String]? {
        lock.lock(); defer { lock.unlock() }
        for value in values.reversed() where value.0 == client {
            let data = Data(value.1.dropFirst(RelayPageMediaRequests.requestPrefix.count).utf8)
            if let object = try? JSONDecoder().decode([String: String].self, from: data), object["op"] == op { return object }
        }
        return nil
    }
    func date() -> Date { lock.lock(); defer { lock.unlock() }; return now }
    func advance() { lock.lock(); defer { lock.unlock() }; now = now.addingTimeInterval(121) }
}

final class RelayPageMediaRequestsTests: XCTestCase {
    private let page = "https://www.douyin.com/video/123456789"
    private let key = "frame-0123456789abcdef"
    private func source(_ id: String = UUID().uuidString, page: String? = nil) -> [String: Any] {
        ["sourceID": id, "pageURL": page ?? self.page, "title": "Fixture", "browser": "chrome", "incognito": false,
         "tabId": 3, "documentID": UUID().uuidString,
         "items": [["mediaKey": key, "title": "1080p", "meta": "MP4", "badge": "1080p", "kind": "video", "quality": "1080"]]]
    }
    private func response(_ object: [String: Any]) throws -> RelayPageMediaRequests.Response {
        try XCTUnwrap(RelayPageMediaRequests.parseResponse(RelayPageMediaRequests.responsePrefix + String(decoding: JSONSerialization.data(withJSONObject: object), as: UTF8.self)))
    }
    private func wait(_ wire: PageMediaWire, _ op: String, _ client: String = "a") async throws -> [String: String] {
        for _ in 0..<1000 {
            if let value = wire.take(op, client: client) { return value }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        throw RelayPageMediaRequests.Failure.timeout
    }
    private func discover(_ requests: RelayPageMediaRequests, wire: PageMediaWire, sources: [[String: Any]]? = nil) async throws -> [RelayPageMediaRequests.Summary] {
        let task = Task { try await requests.discover(pageURL: page) }
        let request = try await wait(wire, "discover")
        await requests.receive(clientID: "a", response: try response(["op": "discover", "requestId": request["requestId"]!, "sources": sources ?? [source()]]))
        return try await task.value
    }
    func testOnlyExplicitPagesAndMetadataOnlyEnvelope() throws {
        XCTAssertEqual(RelayPageMediaRequests.pageIdentity(page + "?share=1"), page)
        XCTAssertEqual(RelayPageMediaRequests.pageIdentity("https://www.douyin.com/jingxuan?modal_id=7684024843209051426"), "https://www.douyin.com/video/7684024843209051426")
        for value in ["https://www.douyin.com/", "https://www.douyin.com/?modal_id=abc", "https://www.douyin.com/?modal_id=123&modal_id=456", "https://douyin.com.evil/video/123", "http://www.douyin.com/video/123", "https://user@www.douyin.com/video/123"] {
            XCTAssertNil(RelayPageMediaRequests.pageIdentity(value))
        }
        let id = UUID().uuidString
        _ = try response(["op": "discover", "requestId": id, "sources": [source()]])
        var leaking = source(); leaking["cookies"] = "secret"
        let raw = RelayPageMediaRequests.responsePrefix + String(decoding: try JSONSerialization.data(withJSONObject: ["op": "discover", "requestId": id, "sources": [leaking]]), as: UTF8.self)
        XCTAssertNil(RelayPageMediaRequests.parseResponse(raw))
    }
    func testProfilesRemainSeparateAndPreparationIsUnicast() async throws {
        let wire = PageMediaWire()
        let requests = RelayPageMediaRequests(timeoutMilliseconds: 1000, clients: { ["a", "b"] }, send: { wire.append($0, $1) })
        let pending = Task { try await requests.discover(pageURL: page) }
        let request = try await wait(wire, "discover")
        let sameSourceID = UUID().uuidString
        for client in ["a", "b"] {
            await requests.receive(clientID: client, response: try response(["op": "discover", "requestId": request["requestId"]!, "sources": [source(sameSourceID)]]))
        }
        let sources = try await pending.value
        XCTAssertEqual(sources.count, 2); XCTAssertNotEqual(sources[0].sourceToken, sources[1].sourceToken)
        let selected = Task { try await requests.prepare(sourceToken: sources[0].sourceToken, mediaKey: key, pageURL: page) }
        let prepared = try await wait(wire, "prepare")
        XCTAssertNil(wire.take("prepare", client: "b"))
        let answer = try response(["op": "prepare", "requestId": prepared["requestId"]!, "sourceID": sameSourceID,
            "mediaKey": key, "pageURL": page, "payload": "1:GET\r\n2:https://cdn.example/clip.mp4\r\n5:\(page)\r\n6:media\r\nCookie: scoped=1\r\n14:full-jar"])
        await requests.receive(clientID: "b", response: answer)
        await requests.receive(clientID: "a", response: answer)
        let result = try await selected.value
        XCTAssertEqual(result.cookies, "scoped=1"); XCTAssertEqual(result.sessionCookies, "")
    }
    func testDisconnectAndExpiryRejectWithoutFallback() async throws {
        let wire = PageMediaWire()
        let requests = RelayPageMediaRequests(timeoutMilliseconds: 1000, now: { wire.date() }, clients: { ["a"] }, send: { wire.append($0, $1) })
        let sources = try await discover(requests, wire: wire)
        let selected = Task { try await requests.prepare(sourceToken: sources[0].sourceToken, mediaKey: key, pageURL: page) }
        _ = try await wait(wire, "prepare")
        await requests.disconnected("a")
        do { _ = try await selected.value; XCTFail("Disconnected selection must fail") } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .navigation) }
        do { _ = try await requests.prepare(sourceToken: sources[0].sourceToken, mediaKey: key, pageURL: page); XCTFail() } catch {}
        let freshWire = PageMediaWire()
        let fresh = RelayPageMediaRequests(now: { freshWire.date() }, clients: { ["a"] }, send: { freshWire.append($0, $1) })
        let available = try await discover(fresh, wire: freshWire)
        freshWire.advance()
        do { _ = try await fresh.prepare(sourceToken: available[0].sourceToken, mediaKey: key, pageURL: page); XCTFail() } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .navigation) }
    }
    func testPageAndVersionMismatchNeverPrepare() async throws {
        let wire = PageMediaWire(), requests = RelayPageMediaRequests(clients: { ["a"] }, send: { _, _ in true })
        do { _ = try await requests.prepare(sourceToken: UUID().uuidString, mediaKey: key, pageURL: page); XCTFail() } catch {}
        let valid = RelayPageMediaRequests(clients: { ["a"] }, send: { wire.append($0, $1) })
        let sources = try await discover(valid, wire: wire)
        for (target, version) in [(page + "0", key), (page, key + "0")] {
            do { _ = try await valid.prepare(sourceToken: sources[0].sourceToken, mediaKey: version, pageURL: target); XCTFail() } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .navigation) }
        }
        XCTAssertNil(wire.take("prepare", client: "a"))
    }
    func testUnsupportedAndTimeoutHaveActionableFailures() async {
        let unsupported = RelayPageMediaRequests(clients: { [] }, send: { _, _ in true })
        do { _ = try await unsupported.discover(pageURL: page); XCTFail() } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .unsupported) }
        let timeout = RelayPageMediaRequests(timeoutMilliseconds: 10, clients: { ["a"] }, send: { _, _ in true })
        do { _ = try await timeout.discover(pageURL: page); XCTFail() } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .timeout) }
    }
    func testPreparedPayloadCannotChangePageOrProtocolOrLoseSecondTrack() throws {
        for payload in ["1:POST\r\n2:https://cdn.example/clip.mp4\r\n5:\(page)",
                        "2:file:///secret\r\n5:\(page)", "2:https://cdn.example/clip.mp4\r\n5:\(page)0",
                        "2:https://cdn.example/clip.mp4\r\n5:\(page)\r\n12:https://cdn.example/audio.m4a",
                        "2:https://cdn.example/clip.m3u8\r\n5:\(page)\r\n3:https://cdn.example/audio.m3u8",
                        "2:\(page)\r\n5:\(page)"] {
            XCTAssertThrowsError(try RelayPageMediaRequests.preparedMessage(payload, pageURL: page))
        }
    }
    func testModalShareURLMatchesCanonicalLookupButBindsActualDocumentURL() async throws {
        let actual = "https://www.douyin.com/jingxuan?modal_id=123456789"
        let wire = PageMediaWire()
        let requests = RelayPageMediaRequests(clients: { ["a"] }, send: { wire.append($0, $1) })
        let pending = Task { try await requests.discover(pageURL: actual) }
        let query = try await wait(wire, "discover")
        XCTAssertEqual(query["pageURL"], page)
        await requests.receive(clientID: "a", response: try response(["op": "discover", "requestId": query["requestId"]!, "sources": [source(page: actual)]]))
        let sources = try await pending.value
        XCTAssertEqual(sources.first?.pageURL, actual)
        let preparing = Task { try await requests.prepare(sourceToken: sources[0].sourceToken, mediaKey: key, pageURL: actual) }
        let preparation = try await wait(wire, "prepare")
        XCTAssertEqual(preparation["pageURL"], actual)
        await requests.disconnected("a")
        do { _ = try await preparing.value; XCTFail() } catch { XCTAssertEqual(error as? RelayPageMediaRequests.Failure, .navigation) }
    }
    func testCreationReceiptBindsSelectionAndDestinationNotTransportCredentials() throws {
        let raw: [String: Any] = ["pageURL": page, "sourceToken": UUID().uuidString, "mediaKey": key, "creationKey": UUID().uuidString, "connections": 32, "folderPath": "/tmp/fixture", "filename": "reviewed.mp4"]
        let admission = try RelayPageMediaAdmission(request: raw)
        var repeated = raw; repeated["cookies"] = "must-not-enter-digest"
        XCTAssertEqual(admission.intent, try RelayPageMediaAdmission(request: repeated).intent)
        for (field, value) in [("mediaKey", key + "0"), ("sourceToken", UUID().uuidString), ("folderPath", "/tmp/other"), ("filename", "different.mp4")] {
            var changed = raw; changed[field] = value
            XCTAssertNotEqual(admission.intent, try RelayPageMediaAdmission(request: changed).intent)
        }
        var message = ParsedBridgeMessage(); message.userAgent = "browser-fixture"; message.cookies = "scoped=1"
        message.extraHeaders = ["Range": "bytes=0-", "X-Fixture": "good", "Bad": "bad\nvalue"]
        XCTAssertEqual(RelayPageMediaAdmission.headers(from: message), ["Cookie: scoped=1", "User-Agent: browser-fixture", "X-Fixture: good"])
    }
}
