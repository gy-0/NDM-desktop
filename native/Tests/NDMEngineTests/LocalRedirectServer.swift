import Foundation
import Network
import CryptoKit

/// Independent loopback fixture: every redirect hop records the exact request
/// before responding. Different loopback hostnames are distinct HTTP origins.
final class LocalRedirectServer: @unchecked Sendable {
    struct Request: Sendable {
        let stage: Int
        let method: String
        let target: String
        let headers: [String: String]
        let body: Data
    }

    let payload: Data
    let entityTag: String
    let hosts: [String]
    private let headStatus: Int
    private let sendsValidator: Bool
    private let redirectStatus: Int
    private let redirectedUserInfo: Bool
    private let challengeMethod: String?
    private let sendsChallengeHeader: Bool
    private let chunkSize: Int
    private let chunkDelay: TimeInterval
    private let queue = DispatchQueue(label: "ndm.test.redirectserver")
    private let lock = NSLock()
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var recorded: [Request] = []
    private var finalFilename = "fixture.bin"
    private var getFinalFilename: String?
    private(set) var port: UInt16 = 0

    init(payload: Data, hosts: [String] = ["127.0.0.1", "localhost"],
         headStatus: Int = 200, sendsValidator: Bool = true,
         redirectStatus: Int = 307, redirectedUserInfo: Bool = false,
         challengeMethod: String? = nil, sendsChallengeHeader: Bool = true,
         chunkSize: Int = 65_536, chunkDelay: TimeInterval = 0) {
        precondition(hosts.count >= 2)
        self.payload = payload
        self.hosts = hosts
        self.headStatus = headStatus
        self.sendsValidator = sendsValidator
        self.redirectStatus = redirectStatus
        self.redirectedUserInfo = redirectedUserInfo
        self.challengeMethod = challengeMethod
        self.sendsChallengeHeader = sendsChallengeHeader
        self.chunkSize = max(1, chunkSize)
        self.chunkDelay = chunkDelay
        self.entityTag = "\"" + SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined() + "\""
    }

    var requests: [Request] { lock.lock(); defer { lock.unlock() }; return recorded }
    var finalStage: Int { hosts.count - 1 }
    var url: URL { url(at: 0) }
    func url(at stage: Int) -> URL {
        lock.lock(); let filename = stage == finalStage ? finalFilename : "fixture.bin"; lock.unlock()
        return URL(string: "http://\(hosts[stage]):\(port)/hop/\(stage)/\(filename)")!
    }

    /// Keep bytes and ETag unchanged while changing which URI serves them.
    func replaceFinalPath(with filename: String, getOnly: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        if getOnly { getFinalFilename = filename }
        else { finalFilename = filename }
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            self.lock.lock(); self.connections.append(connection); self.lock.unlock()
            connection.start(queue: self.queue)
            self.read(connection, accumulated: Data())
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 3) == .success, port != 0 else {
            listener.cancel()
            throw NSError(domain: "LocalRedirectServer", code: 1)
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        lock.lock(); let active = connections; connections.removeAll(); lock.unlock()
        active.forEach { $0.cancel() }
    }

    private func read(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self, error == nil else { connection.cancel(); return }
            var bytes = accumulated
            if let data { bytes.append(data) }
            guard bytes.count <= 1_048_576 else { connection.cancel(); return }
            guard let split = bytes.range(of: Data("\r\n\r\n".utf8)),
                  let header = String(data: bytes.prefix(upTo: split.lowerBound), encoding: .utf8) else {
                if complete { connection.cancel() } else { self.read(connection, accumulated: bytes) }
                return
            }
            let lines = header.components(separatedBy: "\r\n")
            let first = (lines.first ?? "").split(separator: " ")
            guard first.count >= 2 else { connection.cancel(); return }
            var headers: [String: String] = [:]
            for line in lines.dropFirst() {
                guard let colon = line.firstIndex(of: ":") else { continue }
                headers[String(line[..<colon]).lowercased()] = String(line[line.index(after: colon)...])
                    .trimmingCharacters(in: .whitespaces)
            }
            let bodyCount = Int(headers["content-length"] ?? "0") ?? 0
            guard bytes.count - split.upperBound >= bodyCount else {
                if complete { connection.cancel() } else { self.read(connection, accumulated: bytes) }
                return
            }
            let target = String(first[1])
            let parts = target.split(separator: "/")
            let stage = parts.count > 1 ? Int(parts[1]) ?? -1 : -1
            let request = Request(stage: stage, method: String(first[0]), target: target,
                headers: headers, body: bytes.subdata(in: split.upperBound..<(split.upperBound + bodyCount)))
            self.lock.lock(); self.recorded.append(request); self.lock.unlock()
            self.respond(to: request, connection: connection)
        }
    }

    private func respond(to request: Request, connection: NWConnection) {
        guard hosts.indices.contains(request.stage) else {
            send(status: 404, headers: [:], body: Data(), connection: connection)
            return
        }
        if request.stage < finalStage {
            var target = url(at: request.stage + 1)
            lock.lock(); let getOverride = getFinalFilename; lock.unlock()
            if request.stage + 1 == finalStage, request.method == "GET", let getOverride {
                target = target.deletingLastPathComponent().appendingPathComponent(getOverride)
            }
            var next = URLComponents(url: target, resolvingAgainstBaseURL: false)!
            if redirectedUserInfo { next.user = "fixture-user"; next.password = "fixture-secret" }
            send(status: redirectStatus, headers: ["Location": next.string!], body: Data(), connection: connection)
            return
        }
        if request.method == challengeMethod {
            let headers = sendsChallengeHeader ? ["WWW-Authenticate": "Basic realm=\"redirect-fixture\""] : [:]
            send(status: 401, headers: headers, body: Data(), connection: connection)
            return
        }
        if request.method == "HEAD", headStatus != 200 {
            send(status: headStatus, headers: [:], body: Data(), connection: connection)
            return
        }
        var headers = ["Accept-Ranges": "bytes", "Content-Type": "application/octet-stream"]
        if sendsValidator { headers["ETag"] = entityTag }
        if request.method == "HEAD" {
            headers["Content-Length"] = String(payload.count)
            send(status: 200, headers: headers, body: Data(), connection: connection)
            return
        }
        if let range = request.headers["range"], range.hasPrefix("bytes=") {
            let parts = range.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
            guard parts.count == 2, let start = Int(parts[0]), start >= 0, start < payload.count else {
                send(status: 416, headers: ["Content-Range": "bytes */\(payload.count)"], body: Data(), connection: connection)
                return
            }
            let end = min(Int(parts[1]) ?? payload.count - 1, payload.count - 1)
            guard end >= start else { connection.cancel(); return }
            headers["Content-Range"] = "bytes \(start)-\(end)/\(payload.count)"
            send(status: 206, headers: headers, body: payload.subdata(in: start..<(end + 1)), connection: connection)
        } else {
            send(status: 200, headers: headers, body: payload, connection: connection)
        }
    }

    private func send(status: Int, headers: [String: String], body: Data, connection: NWConnection) {
        var headers = headers
        if headers["Content-Length"] == nil { headers["Content-Length"] = String(body.count) }
        headers["Connection"] = "close"
        let lines = headers.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)" }.joined(separator: "\r\n")
        let head = Data("HTTP/1.1 \(status) Fixture\r\n\(lines)\r\n\r\n".utf8)
        connection.send(content: head, completion: .contentProcessed { [weak self] error in
            guard let self, error == nil, !body.isEmpty else { connection.cancel(); return }
            self.sendBody(body, offset: 0, connection: connection)
        })
    }

    private func sendBody(_ body: Data, offset: Int, connection: NWConnection) {
        let end = min(offset + chunkSize, body.count)
        connection.send(content: body.subdata(in: offset..<end), completion: .contentProcessed { [weak self] error in
            guard let self, error == nil, end < body.count else { connection.cancel(); return }
            self.queue.asyncAfter(deadline: .now() + self.chunkDelay) {
                self.sendBody(body, offset: end, connection: connection)
            }
        })
    }
}
