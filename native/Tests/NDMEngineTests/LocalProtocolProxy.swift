import Foundation
import Network

/// Loopback-only HTTP CONNECT/forward and SOCKS4/5 proxy. Destination names are
/// recorded, then routed exclusively to local fixture ports (never the internet).
final class LocalProtocolProxy: @unchecked Sendable {
    struct Route: Equatable { var kind: String; var host: String; var port: UInt16; var authorization: String? }
    private let queue = DispatchQueue(label: "ndm.test.protocol-proxy")
    private let rejectRoute: Int?
    private let credentials: (String, String)?
    private let fragmentReplies: Bool
    private var authenticated = 0
    var authenticatedConnections: Int { queue.sync { authenticated } }
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var pendingConnections: Set<ObjectIdentifier> = []
    private let stoppedResources = DispatchGroup()
    private var routes: [Route] = []
    private var stopped = false
    private(set) var port: UInt16 = 0
    var recordedRoutes: [Route] { queue.sync { routes } }
    init(rejectRoute: Int? = nil, credentials: (String, String)? = nil, fragmentReplies: Bool = false) {
        self.rejectRoute = rejectRoute
        self.credentials = credentials
        self.fragmentReplies = fragmentReplies
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        stoppedResources.enter()
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state { self?.port = listener.port?.rawValue ?? 0; ready.signal() }
            if case .failed = state { ready.signal() }
            if case .cancelled = state { self?.stoppedResources.leave(); listener.stateUpdateHandler = nil }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self, !self.stopped else { connection.cancel(); return }
            self.track(connection)
            connection.start(queue: self.queue)
            self.readHandshake(connection, buffer: Data(), phase: 0)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, port > 0 else { throw NSError(domain: "LocalProtocolProxy", code: 1) }
    }
    @discardableResult func stop() -> Bool {
        queue.sync {
            stopped = true
            listener?.cancel()
            connections.forEach { $0.cancel() }
        }
        let result = stoppedResources.wait(timeout: .now() + 3) == .success
        queue.sync { listener = nil; connections = [] }
        return result
    }
    private func track(_ connection: NWConnection, onState: ((NWConnection.State) -> Void)? = nil) {
        connections.append(connection)
        pendingConnections.insert(ObjectIdentifier(connection))
        stoppedResources.enter()
        // Install once, before starting: replacing a handler during stop can miss
        // a cancellation that Network.framework has already queued for delivery.
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            if case .cancelled = state {
                if self.pendingConnections.remove(ObjectIdentifier(connection)) != nil { self.stoppedResources.leave() }
                connection.stateUpdateHandler = nil
            } else { onState?(state) }
        }
    }
    private func readHandshake(_ client: NWConnection, buffer: Data, phase: Int) {
        client.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, !self.stopped, let data, !data.isEmpty, error == nil else { client.cancel(); return }
            var bytes = buffer
            bytes.append(data)
            guard bytes.count < 64 * 1024 else { client.cancel(); return }
            if !self.parseHandshake(client, bytes: bytes, phase: phase) {
                if complete { client.cancel() }
                else { self.readHandshake(client, buffer: bytes, phase: phase) }
            }
        }
    }
    private func parseHandshake(_ client: NWConnection, bytes: Data, phase: Int) -> Bool {
        if phase == 2 {
            guard bytes.count >= 3 else { return false }
            let userEnd = 2 + Int(bytes[1])
            guard bytes.count > userEnd else { return false }
            let passwordEnd = userEnd + 1 + Int(bytes[userEnd])
            guard bytes.count >= passwordEnd else { return false }
            let user = String(decoding: bytes[2..<userEnd], as: UTF8.self)
            let password = String(decoding: bytes[(userEnd + 1)..<passwordEnd], as: UTF8.self)
            let accepted = bytes[0] == 1 && user == credentials?.0 && password == credentials?.1
            if accepted { authenticated += 1 }
            sendHandshake(client, bytes: Data([1, accepted ? 0 : 1])) { [weak self] in
                if accepted { self?.readHandshake(client, buffer: Data(), phase: 1) }
                else { client.cancel() }
            }
            return true
        }
        if bytes.first == 5 {
            if phase == 0 {
                guard bytes.count >= 2, bytes.count >= Int(bytes[1]) + 2 else { return false }
                let method: UInt8 = credentials == nil ? 0 : 2
                sendHandshake(client, bytes: Data([5, method])) { [weak self] in
                    self?.readHandshake(client, buffer: Data(), phase: method == 2 ? 2 : 1)
                }
                return true
            }
            guard bytes.count >= 5 else { return false }
            let offset: Int
            let host: String
            if bytes[3] == 3 {
                offset = 5 + Int(bytes[4])
                guard bytes.count >= offset + 2 else { return false }
                host = String(decoding: bytes[5..<offset], as: UTF8.self)
            } else if bytes[3] == 1 {
                offset = 8
                guard bytes.count >= 10 else { return false }
                host = bytes[4..<8].map(String.init).joined(separator: ".")
            } else { client.cancel(); return true }
            let port = UInt16(bytes[offset]) * 256 + UInt16(bytes[offset + 1])
            connect(client, route: Route(kind: "socks5", host: host, port: port), initial: Data(),
                    success: Data([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]), failure: Data([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
            return true
        }
        if bytes.first == 4 {
            guard bytes.count >= 9, let userEnd = bytes[8...].firstIndex(of: 0) else { return false }
            let port = UInt16(bytes[2]) * 256 + UInt16(bytes[3])
            var host = bytes[4..<8].map(String.init).joined(separator: ".")
            if bytes[4..<7] == Data([0, 0, 0]), bytes[7] != 0 {
                let start = userEnd + 1
                guard start < bytes.count, let end = bytes[start...].firstIndex(of: 0) else { return false }
                host = String(decoding: bytes[start..<end], as: UTF8.self)
            }
            connect(client, route: Route(kind: "socks4", host: host, port: port), initial: Data(),
                    success: Data([0, 90, 0, 0, 0, 0, 0, 0]), failure: Data([0, 91, 0, 0, 0, 0, 0, 0]))
            return true
        }
        guard let end = bytes.range(of: Data("\r\n\r\n".utf8)) else { return false }
        let lines = String(decoding: bytes[..<end.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count >= 3 else { client.cancel(); return true }
        let tunnel = parts[0] == "CONNECT"
        guard let url = URL(string: tunnel ? "http://\(parts[1])" : String(parts[1])),
              let host = url.host, let port = UInt16(exactly: url.port ?? 80) else { client.cancel(); return true }
        let authorization = lines.first { $0.lowercased().hasPrefix("proxy-authorization:") }.map { String($0.dropFirst("proxy-authorization:".count)).trimmingCharacters(in: .whitespaces) }
        var initial = Data()
        if !tunnel {
            let path = (url.path.isEmpty ? "/" : url.path) + (url.query.map { "?\($0)" } ?? "")
            var headers = ["\(parts[0]) \(path) HTTP/1.1"]
            headers += lines.dropFirst().filter { !$0.lowercased().hasPrefix("proxy-authorization:") }
            initial = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
            initial.append(bytes[end.upperBound...])
        }
        connect(client, route: Route(kind: tunnel ? "connect" : "http", host: host, port: port, authorization: authorization), initial: initial,
                success: tunnel ? Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8) : Data(),
                failure: Data("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
        return true
    }
    private func connect(_ client: NWConnection, route: Route, initial: Data, success: Data, failure: Data) {
        routes.append(route)
        if routes.count == rejectRoute {
            client.send(content: failure, completion: .contentProcessed { _ in client.cancel() })
            return
        }
        guard route.port > 0 else { client.cancel(); return }
        let upstream = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: route.port)!, using: .tcp)
        track(upstream) { [weak self] state in
            guard let self, !self.stopped else { return }
            switch state {
            case .ready:
                self.sendHandshake(client, bytes: success) {
                    if !initial.isEmpty { upstream.send(content: initial, completion: .contentProcessed { _ in }) }
                    self.pipe(client, to: upstream)
                    self.pipe(upstream, to: client)
                }
            case .failed:
                client.send(content: failure, completion: .contentProcessed { _ in client.cancel(); upstream.cancel() })
            default: break
            }
        }
        upstream.start(queue: queue)
    }
    private func sendHandshake(_ client: NWConnection, bytes: Data, completion: @escaping @Sendable () -> Void) {
        if fragmentReplies, bytes.count > 1 {
            client.send(content: Data(bytes.prefix(1)), completion: .contentProcessed { [weak self] _ in
                self?.queue.asyncAfter(deadline: .now() + 0.01) {
                    client.send(content: Data(bytes.dropFirst()), completion: .contentProcessed { _ in completion() })
                }
            })
        } else { client.send(content: bytes, completion: .contentProcessed { _ in completion() }) }
    }
    private func pipe(_ source: NWConnection, to destination: NWConnection) {
        source.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self, !self.stopped else { return }
            guard let data, !data.isEmpty else { source.cancel(); destination.cancel(); return }
            destination.send(content: data, completion: .contentProcessed { sendError in
                if complete || error != nil || sendError != nil { source.cancel(); destination.cancel() }
                else { self.pipe(source, to: destination) }
            })
        }
    }
}
