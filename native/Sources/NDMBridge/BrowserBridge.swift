import Foundation
import Network
import CryptoKit
import NDMCore

/// Local browser bridge using NDM's own endpoint and WebSocket subprotocol.
public final class BrowserBridge: @unchecked Sendable {
    public var onDownloadMessage: (@Sendable (ParsedBridgeMessage) -> Void)?
    public var onFocusRequest: (@Sendable () -> Void)?
    public var onClientCountChanged: (@Sendable (Int) -> Void)?

    private let requestedPort: NWEndpoint.Port
    /// Exposes configuration to `@testable` tests without forcing a bind to a
    /// fixed port that the OS may legitimately be using as an ephemeral
    /// outbound source port. Actual listening is covered with port 0.
    var configuredPort: UInt16 { requestedPort.rawValue }
    private let handshakeTimeout: TimeInterval
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "dev.ndm.bridge", qos: .userInitiated)
    private let queueKey = DispatchSpecificKey<UInt8>()
    private var pendingConnections: [ObjectIdentifier: NWConnection] = [:]
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    var pendingHandshakeCount: Int { syncOnQueue { pendingConnections.count } }
    var connectedClientCount: Int { syncOnQueue { connections.count } }
    /// Actual bound port (useful when `port == 0` for tests).
    private var _boundPort: UInt16 = 0
    public var boundPort: UInt16 { syncOnQueue { _boundPort } }

    public init(
        port: UInt16 = BridgeConstants.port,
        handshakeTimeout: TimeInterval = 3
    ) {
        // `0` means ephemeral — used by integration tests.
        self.requestedPort = NWEndpoint.Port(rawValue: port)
            ?? NWEndpoint.Port(rawValue: BridgeConstants.port)!
        self.handshakeTimeout = max(0.05, handshakeTimeout)
        queue.setSpecific(key: queueKey, value: 1)
    }

    public func start() throws {
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = false
        params.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host(BridgeConstants.host),
            port: requestedPort
        )
        let listener = try NWListener(using: params)
        syncOnQueue { self.listener = listener }
        let ready = DispatchSemaphore(value: 0)
        var startError: Error?
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?._boundPort = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed(let err):
                startError = err
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.accept(conn)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        if let startError { throw startError }
        if boundPort == 0, let p = listener.port?.rawValue {
            syncOnQueue { _boundPort = p }
        }
        guard boundPort != 0 else {
            throw NSError(domain: "BrowserBridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to bind WebSocket port",
            ])
        }
    }

    public func stop() {
        syncOnQueue {
            listener?.cancel()
            listener = nil
            pendingConnections.values.forEach { $0.cancel() }
            pendingConnections.removeAll()
            connections.values.forEach { $0.cancel() }
            connections.removeAll()
            _boundPort = 0
        }
    }

    public func sendToAllClients(_ text: String) {
        let frame = WebSocketFraming.encodeText(text)
        asyncOnQueue { [weak self] in
            guard let self else { return }
            for conn in connections.values {
                conn.send(content: frame, completion: .contentProcessed { _ in })
            }
        }
    }

    private func accept(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        pendingConnections[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.removeConnection(id: id) }
            if case .cancelled = state { self?.removeConnection(id: id) }
        }
        queue.asyncAfter(deadline: .now() + handshakeTimeout) { [weak self, weak connection] in
            guard let self,
                  let connection,
                  self.pendingConnections.removeValue(forKey: id) != nil
            else { return }
            connection.cancel()
        }
        connection.start(queue: queue)
        receiveHTTPUpgrade(on: connection, buffer: Data())
    }

    private func removeConnection(id: ObjectIdentifier) {
        pendingConnections[id] = nil
        if connections.removeValue(forKey: id) != nil {
            onClientCountChanged?(connections.count)
        }
    }

    private func promoteConnection(_ connection: NWConnection) -> Bool {
        let id = ObjectIdentifier(connection)
        guard pendingConnections.removeValue(forKey: id) != nil else {
            connection.cancel()
            return false
        }
        connections[id] = connection
        onClientCountChanged?(connections.count)
        return true
    }

    private func receiveHTTPUpgrade(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var accumulated = buffer
            if let data { accumulated.append(data) }
            guard accumulated.count <= 64 * 1024 else {
                connection.cancel()
                return
            }
            guard let headerRange = accumulated.range(of: Data("\r\n\r\n".utf8)) else {
                if isComplete || error != nil { connection.cancel() }
                else { self.receiveHTTPUpgrade(on: connection, buffer: accumulated) }
                return
            }
            let headerData = accumulated[..<headerRange.upperBound]
            let remainder = Data(accumulated[headerRange.upperBound...])
            guard let req = String(data: headerData, encoding: .utf8) else {
                connection.cancel()
                return
            }
            let firstLine = req.components(separatedBy: "\r\n").first ?? ""
            let requestParts = firstLine.split(separator: " ")
            let isLegacyPort = self.configuredPort == BridgeConstants.legacyNeatPort
            let pathOK = requestParts.count >= 3
                && requestParts[0] == "GET"
                && requestParts[2] == "HTTP/1.1"
                && (requestParts[1] == Substring(BridgeConstants.path) || (isLegacyPort && (requestParts[1] == "/" || requestParts[1] == "/download")))
            let upgradeOK = Self.hasValidWebSocketUpgradeHeaders(req)
            let requestedProtocols = Self.headerValue(req, name: "Sec-WebSocket-Protocol")?
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? []
            let protocolOK = requestedProtocols.contains(BridgeConstants.subprotocol)
                || (isLegacyPort && (requestedProtocols.contains("neatextension.v1") || requestedProtocols.isEmpty))
            let originOK = Self.allowsBrowserOrigin(Self.headerValue(req, name: "Origin"))
            guard pathOK, upgradeOK, protocolOK, originOK else {
                connection.cancel()
                return
            }
            let key = Self.headerValue(req, name: "Sec-WebSocket-Key") ?? ""
            let accept = WebSocketFraming.acceptKey(clientKey: key)
            var response = "HTTP/1.1 101 Switching Protocols\r\n"
            response += "Upgrade: websocket\r\n"
            response += "Connection: Upgrade\r\n"
            response += "Sec-WebSocket-Accept: \(accept)\r\n"
            let chosenProtocol = requestedProtocols.contains(BridgeConstants.subprotocol)
                ? BridgeConstants.subprotocol
                : (requestedProtocols.first ?? BridgeConstants.subprotocol)
            response += "Sec-WebSocket-Protocol: \(chosenProtocol)\r\n"
            response += "\r\n"
            connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] error in
                guard let self, error == nil else {
                    connection.cancel()
                    return
                }
                guard self.promoteConnection(connection) else { return }
                self.receiveFrames(on: connection, buffer: remainder)
            })
        }
    }

    private func receiveFrames(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: BridgeConstants.maxMessageBytes + 14) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            if let masked = WebSocketFraming.isMaskedClientFrame(buf), !masked {
                connection.cancel()
                return
            }
            if buf.count > BridgeConstants.maxMessageBytes + 14
                || (WebSocketFraming.declaredPayloadLength(from: buf) ?? 0) > BridgeConstants.maxMessageBytes {
                connection.cancel()
                return
            }
            while let (message, rest) = WebSocketFraming.decodeTextFrame(from: buf) {
                buf = rest
                if message.trimmingCharacters(in: .whitespacesAndNewlines) == BridgeConstants.focusApp {
                    self.onFocusRequest?()
                    continue
                }
                if let parsed = try? BridgeMessageParser.parse(message) {
                    self.onDownloadMessage?(parsed)
                }
            }
            if isComplete || error != nil {
                connection.cancel()
            } else {
                self.receiveFrames(on: connection, buffer: buf)
            }
        }
    }

    private static func headerValue(_ req: String, name: String) -> String? {
        for line in req.components(separatedBy: "\r\n") {
            if line.lowercased().hasPrefix(name.lowercased() + ":") {
                return line.split(separator: ":", maxSplits: 1).last?
                    .trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    /// Browser WebSockets always send an Origin header. Accept extension
    /// origins, but reject ordinary web pages so a site cannot drive NDM's
    /// loopback bridge (cross-site WebSocket hijacking). Native loopback
    /// clients omit Origin and remain compatible.
    static func allowsBrowserOrigin(_ rawValue: String?) -> Bool {
        guard let rawValue else { return true }
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              let scheme = URLComponents(string: value)?.scheme?.lowercased()
        else { return false }
        return scheme == "chrome-extension"
            || scheme == "moz-extension"
            || scheme == "safari-web-extension"
    }

    static func hasValidWebSocketUpgradeHeaders(_ request: String) -> Bool {
        let upgrade = headerValue(request, name: "Upgrade")?.lowercased()
        let connectionTokens = headerValue(request, name: "Connection")?
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? []
        let version = headerValue(request, name: "Sec-WebSocket-Version")
        let key = headerValue(request, name: "Sec-WebSocket-Key") ?? ""
        return upgrade == "websocket"
            && connectionTokens.contains("upgrade")
            && version == "13"
            && Data(base64Encoded: key)?.count == 16
    }

    private func syncOnQueue<T>(_ body: () throws -> T) rethrows -> T {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            return try body()
        }
        return try queue.sync(execute: body)
    }

    private func asyncOnQueue(_ body: @escaping @Sendable () -> Void) {
        if DispatchQueue.getSpecific(key: queueKey) != nil {
            body()
        } else {
            queue.async(execute: body)
        }
    }
}

enum WebSocketFraming {
    static let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    static func acceptKey(clientKey: String) -> String {
        let combined = clientKey + magic
        let digest = Insecure.SHA1.hash(data: Data(combined.utf8))
        return Data(digest).base64EncodedString()
    }

    static func encodeText(_ text: String) -> Data {
        let payload = Data(text.utf8)
        var frame = Data()
        frame.append(0x81) // FIN + text
        if payload.count < 126 {
            frame.append(UInt8(payload.count))
        } else if payload.count <= 0xffff {
            frame.append(126)
            frame.append(UInt8((payload.count >> 8) & 0xff))
            frame.append(UInt8(payload.count & 0xff))
        } else {
            frame.append(127)
            var len = UInt64(payload.count).bigEndian
            withUnsafeBytes(of: &len) { frame.append(contentsOf: $0) }
        }
        frame.append(payload)
        return frame
    }

    static func declaredPayloadLength(from data: Data) -> Int? {
        guard data.count >= 2 else { return nil }
        let marker = Int(data[1] & 0x7f)
        if marker < 126 { return marker }
        if marker == 126 {
            guard data.count >= 4 else { return nil }
            return (Int(data[2]) << 8) | Int(data[3])
        }
        guard data.count >= 10 else { return nil }
        var length: UInt64 = 0
        for i in 0..<8 {
            length = (length << 8) | UInt64(data[2 + i])
        }
        return length > UInt64(Int.max) ? Int.max : Int(length)
    }

    static func isMaskedClientFrame(_ data: Data) -> Bool? {
        guard data.count >= 2 else { return nil }
        return (data[1] & 0x80) != 0
    }

    /// Returns (text, remaining) if a full client frame is available.
    static func decodeTextFrame(from data: Data) -> (String, Data)? {
        guard data.count >= 2 else { return nil }
        let b0 = data[0]
        let b1 = data[1]
        let opcode = b0 & 0x0f
        let masked = (b1 & 0x80) != 0
        guard masked else { return nil }
        var len = Int(b1 & 0x7f)
        var offset = 2
        if len == 126 {
            guard data.count >= 4 else { return nil }
            len = (Int(data[2]) << 8) | Int(data[3])
            offset = 4
        } else if len == 127 {
            guard data.count >= 10 else { return nil }
            len = 0
            for i in 0..<8 { len = (len << 8) | Int(data[2 + i]) }
            offset = 10
        }
        let maskLen = masked ? 4 : 0
        guard data.count >= offset + maskLen + len else { return nil }
        var payload = Data(data[(offset + maskLen)..<(offset + maskLen + len)])
        if masked {
            let mask = data[offset..<(offset + 4)]
            for i in 0..<payload.count {
                payload[i] ^= mask[mask.startIndex + (i % 4)]
            }
        }
        let rest = data[(offset + maskLen + len)...]
        if opcode == 0x8 { // close
            return nil
        }
        if opcode == 0x1 || opcode == 0x0 {
            if let text = String(data: payload, encoding: .utf8) {
                return (text, Data(rest))
            }
        }
        return ("", Data(rest))
    }
}
