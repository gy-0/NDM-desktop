import Foundation
import Network
import NDMCore

/// Task-owned HTTP proxy adapter. TLS stays end-to-end in URLSession; the
/// adapter only tunnels bytes through the explicitly selected SOCKS endpoint.
final class SOCKSHTTPBridge: @unchecked Sendable {
    private let socks: SocksProxySettings
    private let queue = DispatchQueue(label: "ndm.socks.http-bridge")
    private let lock = NSLock()
    private var listener: NWListener?
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private var upstreams: [ObjectIdentifier: FTPDataConnection] = [:]
    private var closed = false
    let username = UUID().uuidString
    let password = UUID().uuidString

    init(socks: SocksProxySettings) { self.socks = socks }

    static func authorize(_ request: inout URLRequest, endpoint: ProxySettings) {
        let value = Data("\(endpoint.username ?? ""):\(endpoint.password ?? "")".utf8).base64EncodedString()
        request.setValue("Basic " + value, forHTTPHeaderField: "Proxy-Authorization")
    }

    static func matches(_ challenge: URLAuthenticationChallenge, endpoint: ProxySettings) -> Bool {
        let space = challenge.protectionSpace
        return challenge.previousFailureCount == 0 && space.isProxy() && space.host == endpoint.host
            && space.port == Int(endpoint.port) && space.authenticationMethod == NSURLAuthenticationMethodHTTPBasic
            && endpoint.username != nil && endpoint.password != nil
    }

    func start() async throws -> ProxySettings {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        try lock.withLock {
            guard !closed else { throw EngineError.cancelled }
            self.listener = listener
        }
        listener.newConnectionHandler = { [weak self] client in self?.accept(client) }
        let port: UInt16 = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let pending = FTPContinuation<UInt16>(continuation)
                pending.timeout(on: queue, after: 5) { listener.cancel() }
                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        if let port = listener.port { pending.finish(.success(port.rawValue)) }
                    case .failed(let error): pending.finish(.failure(error))
                    case .cancelled: pending.finish(.failure(EngineError.cancelled))
                    default: break
                    }
                }
                listener.start(queue: queue)
            }
        } onCancel: { self.close() }
        return ProxySettings(host: "127.0.0.1", port: port, username: username, password: password, enabled: true)
    }

    func close() {
        let resources = lock.withLock { () -> (NWListener?, [NWConnection], [FTPDataConnection]) in
            closed = true
            let result = (listener, Array(clients.values), Array(upstreams.values))
            listener = nil; clients.removeAll(); upstreams.removeAll()
            return result
        }
        resources.0?.cancel()
        resources.1.forEach { $0.cancel() }
        resources.2.forEach { $0.close() }
    }

    private func accept(_ client: NWConnection) {
        let id = ObjectIdentifier(client)
        guard lock.withLock({ () -> Bool in
            guard !closed else { return false }
            clients[id] = client; return true
        }) else { client.cancel(); return }
        client.start(queue: queue)
        Task { [self] in
            defer {
                let upstream = lock.withLock { () -> FTPDataConnection? in
                    clients.removeValue(forKey: id)
                    return upstreams.removeValue(forKey: id)
                }
                upstream?.close(); client.cancel()
            }
            do { try await serve(client, id: id) }
            catch { client.cancel() }
        }
    }

    private func serve(_ client: NWConnection, id: ObjectIdentifier) async throws {
        var bytes = Data()
        let separator = Data("\r\n\r\n".utf8)
        while bytes.range(of: separator) == nil {
            guard bytes.count < 65536, let chunk = try await read(client) else { throw EngineError.invalidResponse }
            bytes.append(chunk)
        }
        let boundary = bytes.range(of: separator)!
        let lines = String(decoding: bytes[..<boundary.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3, first[2] == "HTTP/1.1" || first[2] == "HTTP/1.0" else { throw EngineError.invalidResponse }
        let headers = lines.dropFirst().compactMap { line -> (String, String)? in
            guard let colon = line.firstIndex(of: ":") else { return nil }
            return (String(line[..<colon]), line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces))
        }
        let credential = "Basic " + Data("\(username):\(password)".utf8).base64EncodedString()
        guard headers.contains(where: { $0.0.lowercased() == "proxy-authorization" && $0.1 == credential }) else {
            try await send(client, Data("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"NDM internal transport\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
            return
        }
        let tunnel = first[0] == "CONNECT"
        guard let url = URLComponents(string: tunnel ? "https://\(first[1])" : String(first[1])),
              let rawHost = url.host, url.user == nil, url.password == nil,
              tunnel || url.scheme == "http", let port = UInt16(exactly: url.port ?? (tunnel ? 443 : 80)), port > 0 else {
            throw EngineError.invalidResponse
        }
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let upstream = FTPDataConnection(host: host, port: port, socksProxy: socks)
        try lock.withLock {
            guard !closed else { throw EngineError.cancelled }
            upstreams[id] = upstream
        }
        do { try await upstream.connect(failOnRefused: true) }
        catch {
            try await send(client, Data("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
            return
        }
        if tunnel {
            try await send(client, Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8))
        } else {
            let target = (url.percentEncodedPath.isEmpty ? "/" : url.percentEncodedPath) + (url.percentEncodedQuery.map { "?" + $0 } ?? "")
            var outgoing = "\(first[0]) \(target) \(first[2])\r\n"
            for (name, value) in headers where !["proxy-authorization", "proxy-connection", "connection"].contains(name.lowercased()) {
                outgoing += "\(name): \(value)\r\n"
            }
            outgoing += "Connection: close\r\n\r\n"
            try await upstream.sendRaw(Data(outgoing.utf8))
        }
        if boundary.upperBound < bytes.endIndex { try await upstream.sendRaw(Data(bytes[boundary.upperBound...])) }
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                do { while let data = try await self.read(client) { try await upstream.sendRaw(data) } } catch { }
            }
            group.addTask {
                do { while let data = try await upstream.readChunk(maxLength: 65536) { try await self.send(client, data) } } catch { }
            }
            _ = await group.next()
            client.cancel(); upstream.close()
            group.cancelAll()
        }
    }

    private func read(_ connection: NWConnection) async throws -> Data? {
        try await withCheckedThrowingContinuation { continuation in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, complete, error in
                if let error { continuation.resume(throwing: error) }
                else if let data, !data.isEmpty { continuation.resume(returning: data) }
                else if complete { continuation.resume(returning: nil) }
                else { continuation.resume(throwing: EngineError.invalidResponse) }
            }
        }
    }

    private func send(_ connection: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume() }
            })
        }
    }
}
