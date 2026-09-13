import Foundation
import Network
import Darwin
import NDMCore

/// Both control and passive data use the same selected proxy. Minimal SOCKS
/// CONNECT negotiation runs over the existing NW byte transport: system proxy
/// APIs can silently bypass loopback targets even with failover disabled. v4
/// resolves IPv4 locally; v5 sends domain names to the proxy, without substitution
/// or a direct fallback. HTTP proxies likewise tunnel each socket with CONNECT.
final class FTPDataConnection: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private let httpProxy: ProxySettings?
    private let socksProxy: SocksProxySettings?
    private let queue = DispatchQueue(label: "ndm.ftp.transport")
    private let lock = NSLock()
    private var connection: NWConnection?
    private var resolution: FTPContinuation<Data>?
    private var closed = false
    private var reachedEOF = false
    private var buffered = Data()

    init(host: String, port: UInt16, httpProxy: ProxySettings? = nil, socksProxy: SocksProxySettings? = nil) {
        self.host = host
        self.port = port
        self.socksProxy = socksProxy?.enabled == true ? socksProxy : nil
        self.httpProxy = httpProxy?.enabled == true ? httpProxy : nil
    }

    func connect() async throws {
        guard port > 0, !host.isEmpty, !host.contains("\r"), !host.contains("\n") else { throw EngineError.invalidResponse }
        let parameters = NWParameters.tcp
        var endpointHost = httpProxy?.host ?? host
        var endpointPort = httpProxy?.port ?? port
        if let proxy = socksProxy {
            guard proxy.port > 0, !proxy.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw EngineError.invalidResponse }
            endpointHost = proxy.host
            endpointPort = proxy.port
        } else if let proxy = httpProxy {
            guard proxy.port > 0, !proxy.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw EngineError.invalidResponse }
        }
        let conn = NWConnection(host: NWEndpoint.Host(endpointHost),
                                port: NWEndpoint.Port(rawValue: endpointPort)!, using: parameters)
        try lock.withLock {
            guard !closed else { throw FTPError.disconnected }
            connection = conn
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let pending = FTPContinuation(continuation)
            pending.timeout(on: queue, after: 30) { conn.cancel() }
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready: pending.finish(.success(()))
                case .failed(let error): pending.finish(.failure(error))
                case .cancelled: pending.finish(.failure(FTPError.disconnected))
                default: break
                }
            }
            conn.start(queue: queue)
        }
        if let proxy = socksProxy {
            if proxy.version == .v4 { try await negotiateSOCKS4(proxy) }
            else { try await negotiateSOCKS5(proxy) }
        } else if let proxy = httpProxy {
            let authority = host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
            var header = "CONNECT \(authority) HTTP/1.1\r\nHost: \(authority)\r\n"
            if let user = proxy.username, !user.isEmpty {
                header += "Proxy-Authorization: Basic \(Data("\(user):\(proxy.password ?? "")".utf8).base64EncodedString())\r\n"
            }
            try await sendRaw(Data((header + "\r\n").utf8))
            var response = Data()
            let deadline = ProcessInfo.processInfo.systemUptime + 30
            while response.range(of: Data("\r\n\r\n".utf8)) == nil {
                guard response.count < 64 * 1024 else { throw EngineError.invalidResponse }
                guard let bytes = try await readChunk(maxLength: 16 * 1024,
                    timeout: max(0.001, deadline - ProcessInfo.processInfo.systemUptime)) else { throw FTPError.disconnected }
                response.append(bytes)
            }
            let separator = response.range(of: Data("\r\n\r\n".utf8))!
            let head = String(decoding: response[..<separator.lowerBound], as: UTF8.self)
            let line = head.components(separatedBy: "\r\n").first ?? ""
            let parts = line.split(separator: " ")
            let status = parts.count > 1 && parts[0].hasPrefix("HTTP/") ? Int(parts[1]) ?? 0 : 0
            guard status == 200 else { throw FTPError.proxyConnectFailed(status) }
            lock.withLock { buffered.append(response[separator.upperBound...]) }
        }
    }

    func close() {
        let (conn, pending) = lock.withLock { () -> (NWConnection?, FTPContinuation<Data>?) in
            closed = true
            let value = (connection, resolution)
            connection = nil
            resolution = nil
            return value
        }
        conn?.cancel()
        pending?.finish(.failure(FTPError.disconnected))
    }

    func sendRaw(_ data: Data) async throws {
        let conn = try lock.withLock { () -> NWConnection? in
            guard !closed else { throw FTPError.disconnected }
            return connection
        }
        guard let conn else { throw FTPError.disconnected }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let pending = FTPContinuation(continuation)
            pending.timeout(on: queue, after: 30) { conn.cancel() }
            conn.send(content: data, completion: .contentProcessed { error in
                if let error { pending.finish(.failure(error)) }
                else { pending.finish(.success(())) }
            })
        }
    }

    func readChunk(maxLength: Int, timeout: TimeInterval = 60) async throws -> Data? {
        let (conn, cached, eof) = try lock.withLock { () -> (NWConnection?, Data?, Bool) in
            guard !closed else { throw FTPError.disconnected }
            var cached: Data?
            if !buffered.isEmpty {
                cached = Data(buffered.prefix(maxLength))
                buffered.removeFirst(cached!.count)
            }
            return (connection, cached, reachedEOF)
        }
        if let cached { return cached }
        if eof { return nil }
        guard let conn else { throw FTPError.disconnected }
        return try await withCheckedThrowingContinuation { continuation in
            let pending = FTPContinuation<Data?>(continuation)
            pending.timeout(on: queue, after: timeout) { conn.cancel() }
            func receive() {
                conn.receive(minimumIncompleteLength: 1, maximumLength: maxLength) { data, _, complete, error in
                    if let error { pending.finish(.failure(error)); return }
                    // Retain terminal EOF even if the last callback also has bytes.
                    if complete { self.lock.withLock { self.reachedEOF = true } }
                    if let data, !data.isEmpty { pending.finish(.success(data)) }
                    else if complete { pending.finish(.success(nil)) }
                    else { receive() }
                }
            }
            receive()
        }
    }
    private func negotiateSOCKS4(_ proxy: SocksProxySettings) async throws {
        let user = Data((proxy.username ?? "").utf8)
        guard user.count <= 255, !user.contains(0) else { throw EngineError.invalidResponse }
        let address = try await localIPv4Address()
        var request = Data([4, 1, UInt8(port >> 8), UInt8(port & 0xff)])
        request.append(address)
        request.append(user)
        request.append(0)
        try await sendRaw(request)
        var reply = Data()
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while reply.count < 8 {
            guard let bytes = try await readChunk(maxLength: 8 - reply.count,
                timeout: max(0.001, deadline - ProcessInfo.processInfo.systemUptime)) else { throw FTPError.disconnected }
            reply.append(bytes)
        }
        guard reply[0] == 0, reply[1] == 90 else { throw FTPError.socksConnectFailed(Int(reply[1])) }
    }

    private func negotiateSOCKS5(_ proxy: SocksProxySettings) async throws {
        let user = Data((proxy.username ?? "").utf8)
        let password = Data((proxy.password ?? "").utf8)
        guard user.count <= 255, password.count <= 255 else { throw EngineError.invalidResponse }
        let methods: [UInt8] = user.isEmpty ? [0] : [0, 2]
        try await sendRaw(Data([5, UInt8(methods.count)] + methods))
        let selected = try await readExactly(2)
        guard selected[0] == 5, methods.contains(selected[1]) else { throw FTPError.socksConnectFailed(Int(selected[1])) }
        if selected[1] == 2 {
            var authentication = Data([1, UInt8(user.count)])
            authentication.append(user)
            authentication.append(UInt8(password.count))
            authentication.append(password)
            try await sendRaw(authentication)
            let reply = try await readExactly(2)
            guard reply[0] == 1, reply[1] == 0 else { throw FTPError.socksConnectFailed(Int(reply[1])) }
        }
        var request = Data([5, 1, 0])
        if let address = IPv4Address(host) { request.append(1); request.append(address.rawValue) }
        else if let address = IPv6Address(host) { request.append(4); request.append(address.rawValue) }
        else {
            let name = Data(host.utf8)
            guard !name.isEmpty, name.count <= 255, !name.contains(0) else { throw EngineError.invalidResponse }
            request.append(3)
            request.append(UInt8(name.count))
            request.append(name)
        }
        request.append(contentsOf: [UInt8(port >> 8), UInt8(port & 0xff)])
        try await sendRaw(request)
        let reply = try await readExactly(4)
        guard reply[0] == 5, reply[1] == 0, reply[2] == 0 else { throw FTPError.socksConnectFailed(Int(reply[1])) }
        switch reply[3] {
        case 1: _ = try await readExactly(4 + 2)
        case 4: _ = try await readExactly(16 + 2)
        case 3:
            let length = try await readExactly(1)
            guard length[0] > 0 else { throw EngineError.invalidResponse }
            _ = try await readExactly(Int(length[0]) + 2)
        default: throw EngineError.invalidResponse
        }
    }

    private func readExactly(_ count: Int) async throws -> Data {
        var bytes = Data()
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        while bytes.count < count {
            guard let next = try await readChunk(maxLength: count - bytes.count,
                timeout: max(0.001, deadline - ProcessInfo.processInfo.systemUptime)) else { throw FTPError.disconnected }
            bytes.append(next)
        }
        return bytes
    }

    private func localIPv4Address() async throws -> Data {
        if let address = IPv4Address(host) { return address.rawValue }
        // SOCKS4 has no hostname field. Resolve only in this explicit v4 branch;
        // cancellation resumes immediately even while the OS resolver is finishing.
        return try await withCheckedThrowingContinuation { continuation in
            let pending = FTPContinuation<Data>(continuation)
            let accepted = lock.withLock { () -> Bool in
                guard !closed else { return false }
                resolution = pending
                return true
            }
            guard accepted else { pending.finish(.failure(FTPError.disconnected)); return }
            pending.timeout(on: queue, after: 30) { [weak self] in self?.close() }
            DispatchQueue.global(qos: .utility).async { [host] in
                var hints = addrinfo()
                hints.ai_family = AF_INET
                hints.ai_socktype = SOCK_STREAM
                hints.ai_protocol = IPPROTO_TCP
                var result: UnsafeMutablePointer<addrinfo>?
                let code = getaddrinfo(host, nil, &hints, &result)
                defer { if let result { freeaddrinfo(result) } }
                guard code == 0, let result, let socket = result.pointee.ai_addr else {
                    pending.finish(.failure(FTPError.unsupportedProxy("SOCKS4 could not resolve the FTP host to an IPv4 address.")))
                    return
                }
                let address = socket.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee.sin_addr.s_addr }
                pending.finish(.success(withUnsafeBytes(of: address) { Data($0) }))
            }
        }
    }

}

private final class FTPContinuation<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var timer: DispatchWorkItem?
    init(_ continuation: CheckedContinuation<Value, Error>) { self.continuation = continuation }
    func timeout(on queue: DispatchQueue, after seconds: TimeInterval, cancel: @escaping @Sendable () -> Void) {
        let work = DispatchWorkItem { [weak self] in
            if self?.finish(.failure(FTPError.timeout)) == true { cancel() }
        }
        lock.withLock { timer = work }
        queue.asyncAfter(deadline: .now() + max(0.001, seconds), execute: work)
    }
    @discardableResult func finish(_ result: Result<Value, Error>) -> Bool {
        let pending = lock.withLock { () -> CheckedContinuation<Value, Error>? in
            let pending = continuation
            continuation = nil
            timer?.cancel()
            timer = nil
            return pending
        }
        pending?.resume(with: result)
        return pending != nil
    }
}
