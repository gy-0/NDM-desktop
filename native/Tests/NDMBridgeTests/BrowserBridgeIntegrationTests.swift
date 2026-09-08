import XCTest
@testable import NDMBridge
@testable import NDMCore
@testable import NDMEngine
import Foundation
import Network

private final class FirstPositiveCount: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int?

    func record(_ count: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard count > 0, value == nil else { return false }
        value = count
        return true
    }

    func read() -> Int? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

final class BrowserBridgeIntegrationTests: XCTestCase {
    func testRelayIdentityRejectsUnsupportedAndMalformedAnnouncements() {
        let prefix = "NDMRelayHello:"
        XCTAssertEqual(BrowserBridge.parseRelayHello(prefix + #"{"version":"1.4.4","protocol":1,"role":"worker"}"#)?.version, "1.4.4")
        for json in [
            #"{"version":"1.4.4","protocol":2,"role":"worker"}"#,
            #"{"version":"1.4.4","protocol":1,"role":"popup"}"#,
            #"{"version":"latest","protocol":1,"role":"worker"}"#,
            #"{"version":"1.4.4","protocol":1.5,"role":"worker"}"#,
            #"{"version":"1.4.4","protocol":true,"role":"worker"}"#,
            #"{"version":"1.4.4"}"#,
            "not json"
        ] {
            XCTAssertNil(BrowserBridge.parseRelayHello(prefix + json), json)
        }
        XCTAssertNil(BrowserBridge.parseRelayHello("1.4.4"))
    }
    func testCloseFrameMustBeCompleteBeforeClosingBrowserConnection() {
        XCTAssertFalse(WebSocketFraming.hasCompleteCloseFrame(Data([0x88])))
        XCTAssertFalse(WebSocketFraming.hasCompleteCloseFrame(Data([0x88, 0x80, 1, 2])))
        XCTAssertTrue(WebSocketFraming.hasCompleteCloseFrame(Data([0x88, 0x80, 1, 2, 3, 4])))
        XCTAssertFalse(WebSocketFraming.hasCompleteCloseFrame(Data([0x81, 0x80, 1, 2, 3, 4])))
        XCTAssertFalse(WebSocketFraming.hasCompleteCloseFrame(Data([0x88, 0, 1, 2, 3, 4])))
    }

    func testWaitingNowaitingAndTaskCreated() async throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-bridge-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 1,
            useCategoryFolders: false,
            confirmBrowserDownloads: false
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let bridge = BrowserBridge(port: 0)
        let gotWaiting = expectation(description: "waiting")
        let gotNoWaiting = expectation(description: "nowaiting")
        var hostMessages: [String] = []

        bridge.onDownloadMessage = { msg in
            Task {
                // Mirror AppDelegate without Wait UI
                bridge.sendToAllClients(BridgeConstants.waiting)
                do {
                    let task = try await manager.addFromBridge(msg)
                    // Don't actually download remote — just persist
                    _ = task
                } catch {
                    XCTFail(error.localizedDescription)
                }
                bridge.sendToAllClients(BridgeConstants.noWaiting)
            }
        }
        try bridge.start()
        defer { bridge.stop() }
        XCTAssertGreaterThan(bridge.boundPort, 0)

        // Client WebSocket via URLSession
        let url = URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!
        var req = URLRequest(url: url)
        req.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let session = URLSession(configuration: .ephemeral)
        let task = session.webSocketTask(with: req)
        task.resume()

        // Receive host pushes
        func receiveLoop() {
            task.receive { result in
                if case .success(let message) = result {
                    if case .string(let text) = message {
                        hostMessages.append(text)
                        if text == BridgeConstants.waiting { gotWaiting.fulfill() }
                        if text == BridgeConstants.noWaiting { gotNoWaiting.fulfill() }
                    }
                    receiveLoop()
                }
            }
        }
        receiveLoop()

        let payload = """
        1:GET\r
        2:https://example.com/file.bin\r
        3:file.bin\r
        6:normal\r
        4:Example\r
        5:https://example.com/\r
        """
        try await task.send(.string(payload))

        await fulfillment(of: [gotWaiting, gotNoWaiting], timeout: 5)

        // Give addFromBridge a moment
        try await Task.sleep(nanoseconds: 200_000_000)
        let tasks = try await manager.listTasks()
        XCTAssertTrue(tasks.contains { $0.url.contains("example.com/file.bin") })
        task.cancel()
    }

    func testShowPanelMessagesArePushedOverWebSocket() async throws {
        let bridge = BrowserBridge(port: 0)
        let connected = expectation(description: "client connected")
        bridge.onClientCountChanged = { count in
            if count == 1 { connected.fulfill() }
        }
        try bridge.start()
        defer { bridge.stop() }

        let url = URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!
        var request = URLRequest(url: url)
        request.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()
        await fulfillment(of: [connected], timeout: 3)
        // An awaited send also exercises a client text frame before host pushes.
        try await socket.send(.string("bridge-ready"))

        let expected = Set(BridgeConstants.showPanelMessages(enabled: true))
        for message in expected { bridge.sendToAllClients(message) }
        var received: Set<String> = []
        for _ in expected {
            if case .string(let text) = try await socket.receive() {
                received.insert(text)
            }
        }
        XCTAssertEqual(received, expected)
        socket.cancel()
    }

    func testFocusControlMessageReachesHostWithoutBecomingDownload() async throws {
        let bridge = BrowserBridge(port: 0)
        let focused = expectation(description: "focus request")
        let unexpectedDownload = expectation(description: "download message")
        unexpectedDownload.isInverted = true
        bridge.onFocusRequest = { focused.fulfill() }
        bridge.onDownloadMessage = { _ in unexpectedDownload.fulfill() }
        try bridge.start()
        defer { bridge.stop() }

        let url = URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!
        var request = URLRequest(url: url)
        request.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()
        try await socket.send(.string(BridgeConstants.focusApp + "\r\n"))

        await fulfillment(of: [focused, unexpectedDownload], timeout: 1)
        socket.cancel()
        session.invalidateAndCancel()
    }

    func testConcurrentBroadcastAndStopIsSerialized() throws {
        let bridge = BrowserBridge(port: 0)
        try bridge.start()
        DispatchQueue.concurrentPerform(iterations: 100) { index in
            bridge.sendToAllClients("ShowPanelChrome=\(index % 2)")
        }
        bridge.stop()
        XCTAssertEqual(bridge.boundPort, 0)
    }

    func testRejectsLegacyNeatPathAndSubprotocol() async throws {
        let bridge = BrowserBridge(port: 0)
        try bridge.start()
        defer { bridge.stop() }

        await assertWebSocketRejected(
            port: bridge.boundPort,
            path: "/download",
            subprotocol: BridgeConstants.subprotocol
        )
        await assertWebSocketRejected(
            port: bridge.boundPort,
            path: BridgeConstants.path,
            subprotocol: "neatextension.v1"
        )
    }

    func testRejectsOrdinaryWebsiteOrigin() async throws {
        let bridge = BrowserBridge(port: 0)
        try bridge.start()
        defer { bridge.stop() }

        await assertWebSocketRejected(
            port: bridge.boundPort,
            path: BridgeConstants.path,
            subprotocol: BridgeConstants.subprotocol,
            origin: "https://attacker.example"
        )
    }

    func testAcceptsBrowserExtensionOrigin() async throws {
        let bridge = BrowserBridge(port: 0)
        let connected = expectation(description: "extension client connected")
        bridge.onClientCountChanged = { count in
            if count == 1 { connected.fulfill() }
        }
        try bridge.start()
        defer { bridge.stop() }

        let url = URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!
        var request = URLRequest(url: url)
        request.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        request.setValue("chrome-extension://abcdefghijklmnop", forHTTPHeaderField: "Origin")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()

        await fulfillment(of: [connected], timeout: 3)
        socket.cancel()
        session.invalidateAndCancel()
    }

    func testIncompleteHandshakeDoesNotCountAsAWebSocketClient() async throws {
        let bridge = BrowserBridge(port: 0)
        let observedCount = expectation(description: "one upgraded websocket client")
        let firstPositiveCount = FirstPositiveCount()
        bridge.onClientCountChanged = { count in
            if firstPositiveCount.record(count) { observedCount.fulfill() }
        }
        try bridge.start()
        defer { bridge.stop() }

        let rawReady = expectation(description: "raw TCP connection ready")
        let raw = NWConnection(
            host: NWEndpoint.Host(BridgeConstants.host),
            port: NWEndpoint.Port(rawValue: bridge.boundPort)!,
            using: .tcp
        )
        raw.stateUpdateHandler = { state in
            if case .ready = state { rawReady.fulfill() }
        }
        raw.start(queue: .global())
        await fulfillment(of: [rawReady], timeout: 2)

        let url = URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!
        var request = URLRequest(url: url)
        request.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        request.setValue("chrome-extension://abcdefghijklmnop", forHTTPHeaderField: "Origin")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()

        await fulfillment(of: [observedCount], timeout: 3)
        XCTAssertEqual(firstPositiveCount.read(), 1)
        raw.cancel()
        socket.cancel()
        session.invalidateAndCancel()
    }

    func testIncompleteHandshakeIsEvictedAfterTimeout() async throws {
        let bridge = BrowserBridge(port: 0, handshakeTimeout: 1)
        try bridge.start()
        defer { bridge.stop() }

        let rawReady = expectation(description: "raw TCP connection ready")
        let raw = NWConnection(
            host: NWEndpoint.Host(BridgeConstants.host),
            port: NWEndpoint.Port(rawValue: bridge.boundPort)!,
            using: .tcp
        )
        raw.stateUpdateHandler = { state in
            if case .ready = state { rawReady.fulfill() }
        }
        raw.start(queue: .global())
        await fulfillment(of: [rawReady], timeout: 2)
        for _ in 0..<50 where bridge.pendingHandshakeCount == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(bridge.pendingHandshakeCount, 1)

        try await Task.sleep(for: .milliseconds(1_200))
        XCTAssertEqual(bridge.pendingHandshakeCount, 0)
        XCTAssertEqual(bridge.connectedClientCount, 0)
        raw.cancel()
    }

    func testOriginPolicyAllowsExtensionsAndNativeClients() {
        XCTAssertTrue(BrowserBridge.allowsBrowserOrigin(nil))
        XCTAssertTrue(BrowserBridge.allowsBrowserOrigin("chrome-extension://abcdefghijklmnop"))
        XCTAssertTrue(BrowserBridge.allowsBrowserOrigin("moz-extension://relay-id"))
        XCTAssertTrue(BrowserBridge.allowsBrowserOrigin("safari-web-extension://dev.ndm.relay"))
        XCTAssertFalse(BrowserBridge.allowsBrowserOrigin("https://attacker.example"))
        XCTAssertFalse(BrowserBridge.allowsBrowserOrigin("http://127.0.0.1:3000"))
        XCTAssertFalse(BrowserBridge.allowsBrowserOrigin("null"))
    }

    func testHandshakeRequiresRFC6455UpgradeHeadersAndKey() {
        let valid = """
        GET /ndm/download HTTP/1.1\r
        Upgrade: websocket\r
        Connection: keep-alive, Upgrade\r
        Sec-WebSocket-Version: 13\r
        Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r
        \r

        """
        XCTAssertTrue(BrowserBridge.hasValidWebSocketUpgradeHeaders(valid))
        XCTAssertFalse(BrowserBridge.hasValidWebSocketUpgradeHeaders(
            valid.replacingOccurrences(of: "Upgrade: websocket", with: "X-Note: upgrade: websocket")
        ))
        XCTAssertFalse(BrowserBridge.hasValidWebSocketUpgradeHeaders(
            valid.replacingOccurrences(of: "Sec-WebSocket-Version: 13", with: "Sec-WebSocket-Version: 12")
        ))
        XCTAssertFalse(BrowserBridge.hasValidWebSocketUpgradeHeaders(
            valid.replacingOccurrences(of: "dGhlIHNhbXBsZSBub25jZQ==", with: "not-a-valid-key")
        ))
    }

    func testClientFramesMustBeMasked() {
        XCTAssertNil(WebSocketFraming.isMaskedClientFrame(Data([0x81])))
        XCTAssertFalse(WebSocketFraming.isMaskedClientFrame(Data([0x81, 0x05]))!)
        XCTAssertTrue(WebSocketFraming.isMaskedClientFrame(Data([0x81, 0x85]))!)
        XCTAssertNil(WebSocketFraming.decodeTextFrame(from: Data([0x81, 0x02, 0x68, 0x69])))
    }

    func testDefaultBridgeUsesDedicatedNDMPort() throws {
        let bridge = BrowserBridge()
        XCTAssertEqual(bridge.configuredPort, BridgeConstants.port)
        XCTAssertNotEqual(bridge.configuredPort, BridgeConstants.legacyNeatPort)
    }

    func testParseUrlaField() throws {
        let raw = "1:GET\r\n2:https://v.example/video\r\n12:https://v.example/audio\r\nurla:https://v.example/audio2\r\n"
        let msg = try BridgeMessageParser.parse(raw)
        // last urla wins if both present — urla header overwrites 12
        XCTAssertEqual(msg.alternateURL, "https://v.example/audio2")
    }

    private func assertWebSocketRejected(
        port: UInt16,
        path: String,
        subprotocol: String,
        origin: String? = nil
    ) async {
        let rejected = expectation(description: "WebSocket handshake rejected")
        let url = URL(string: "ws://127.0.0.1:\(port)\(path)")!
        var request = URLRequest(url: url)
        request.setValue(subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        if let origin { request.setValue(origin, forHTTPHeaderField: "Origin") }
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request)
        socket.resume()
        socket.receive { result in
            switch result {
            case .failure:
                rejected.fulfill()
            case .success:
                XCTFail("Legacy bridge identity unexpectedly completed a WebSocket handshake")
                rejected.fulfill()
            }
        }
        await fulfillment(of: [rejected], timeout: 3)
        socket.cancel()
        session.invalidateAndCancel()
    }
}

extension BrowserBridgeIntegrationTests {
    private func durableClient(_ bridge: BrowserBridge) -> (URLSession, URLSessionWebSocketTask) {
        var request = URLRequest(url: URL(string: "ws://127.0.0.1:\(bridge.boundPort)\(BridgeConstants.path)")!)
        request.setValue(BridgeConstants.subprotocol, forHTTPHeaderField: "Sec-WebSocket-Protocol")
        let session = URLSession(configuration: .ephemeral)
        let socket = session.webSocketTask(with: request); socket.resume()
        return (session, socket)
    }
    private func nextBridgeJSON(_ socket: URLSessionWebSocketTask, prefix: String) async throws -> [String: Any] {
        for _ in 0..<12 {
            if case .string(let text) = try await socket.receive(), text.hasPrefix(prefix) {
                return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.dropFirst(prefix.count).utf8)) as? [String: Any])
            }
        }
        throw BridgeDurableProtocol.Failure.malformed
    }
    func testDurableCapabilityAndCorrelatedReceiptDoNotUseLegacyCallback() async throws {
        for enabled in [false, true] {
            let bridge = BrowserBridge(port: 0)
            bridge.onDownloadMessage = { _ in XCTFail("Envelope entered legacy path") }
            if enabled {
                bridge.onDurableDownloadMessage = { message, requestID, reply in
                    XCTAssertEqual(requestID, "fixture_request_1234")
                    XCTAssertEqual(message.postData, "fixture=value")
                    XCTAssertTrue(message.extraHeaders.isEmpty)
                    reply(.init(status: .accepted, taskID: 77))
                    reply(.init(status: .rejected, error: "duplicate-callback"))
                }
            }
            try bridge.start()
            let (session, socket) = durableClient(bridge)
            defer { socket.cancel(); session.invalidateAndCancel(); bridge.stop() }
            try await socket.send(.string(#"NDMRelayHello:{"version":"1.4.9","protocol":1,"role":"worker"}"#))
            let status = try await nextBridgeJSON(socket, prefix: "NDMRelayStatus:")
            XCTAssertEqual(status["durableHandoff"] as? Int, enabled ? 1 : nil)
            let envelope: [String: String] = ["requestId": "fixture_request_1234", "payload": "1:POST\r\n2:https://example.invalid/file\r\n__0NeatPostData9__:fixture=value"]
            let text = BridgeDurableProtocol.requestPrefix + String(decoding: try JSONSerialization.data(withJSONObject: envelope), as: UTF8.self)
            try await socket.send(.string(text))
            let receipt = try await nextBridgeJSON(socket, prefix: BridgeDurableProtocol.receiptPrefix)
            XCTAssertEqual(receipt["requestId"] as? String, "fixture_request_1234")
            XCTAssertEqual(receipt["status"] as? String, enabled ? "accepted" : "rejected")
            if enabled { XCTAssertEqual(receipt["taskId"] as? Int, 77) }
            else { XCTAssertEqual(receipt["error"] as? String, "unsupported") }
            bridge.sendToAllClients("receipt-marker")
            if case .string(let next) = try await socket.receive() { XCTAssertEqual(next, "receipt-marker") }
            else { XCTFail("Expected marker without duplicate receipt") }
        }
    }
    func testMalformedDurablePayloadRejectsWithoutLegacyFallback() async throws {
        let bridge = BrowserBridge(port: 0)
        bridge.onDownloadMessage = { _ in XCTFail("Malformed envelope reached legacy callback") }
        bridge.onDurableDownloadMessage = { _, _, _ in XCTFail("Malformed envelope reached durable callback") }
        try bridge.start()
        let (session, socket) = durableClient(bridge)
        defer { socket.cancel(); session.invalidateAndCancel(); bridge.stop() }
        try await socket.send(.string(#"NDMRelayDownload:{"requestId":"fixture_invalid_123","payload":"1:GET"}"#))
        let reply = try await nextBridgeJSON(socket, prefix: BridgeDurableProtocol.receiptPrefix)
        XCTAssertEqual(reply["status"] as? String, "rejected")
        XCTAssertEqual(reply["error"] as? String, "invalid-request")
    }
}

private final class DeferredDurableReply: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: (@Sendable (BridgeDurableReceipt) -> Void)?
    func set(_ reply: @escaping @Sendable (BridgeDurableReceipt) -> Void) { lock.lock(); stored = reply; lock.unlock() }
    func send() { lock.lock(); let reply = stored; lock.unlock(); reply?(.init(status: .accepted, taskID: 91)) }
}

extension BrowserBridgeIntegrationTests {
    func testDelayedReceiptNeverMovesToReplacementConnection() async throws {
        let bridge = BrowserBridge(port: 0)
        let received = expectation(description: "old request received")
        let deferred = DeferredDurableReply()
        bridge.onDurableDownloadMessage = { _, _, reply in deferred.set(reply); received.fulfill() }
        try bridge.start()
        let (oldSession, oldSocket) = durableClient(bridge)
        try await oldSocket.send(.string(#"NDMRelayDownload:{"requestId":"fixture_old_123456","payload":"2:https://example.invalid/file"}"#))
        await fulfillment(of: [received], timeout: 3)
        oldSocket.cancel(with: .normalClosure, reason: nil); oldSession.invalidateAndCancel()
        let deadline = Date().addingTimeInterval(3)
        while bridge.connectedClientCount != 0 && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertEqual(bridge.connectedClientCount, 0)
        let (session, socket) = durableClient(bridge)
        defer { socket.cancel(); session.invalidateAndCancel(); bridge.stop() }
        try await socket.send(.string(#"NDMRelayHello:{"version":"1.4.9","protocol":1,"role":"worker"}"#))
        _ = try await nextBridgeJSON(socket, prefix: "NDMRelayStatus:")
        deferred.send()
        bridge.sendToAllClients("replacement-marker")
        if case .string(let next) = try await socket.receive() { XCTAssertEqual(next, "replacement-marker") }
        else { XCTFail("Expected marker without old connection receipt") }
    }
}
