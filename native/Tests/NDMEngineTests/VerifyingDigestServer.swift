import Foundation
import Network
import CryptoKit

/// Independent verifier: expected signatures come from the captured HTTP line,
/// never from NDMCore.DigestAuth or from the client's declared digest-uri.
final class VerifyingDigestServer: @unchecked Sendable {
    struct Observation: Sendable {
        let method: String
        let target: String
        let proxy: Bool
        let nonce: String
        let cnonce: String
        let count: UInt32
    }
    private let queue = DispatchQueue(label: "ndm.test.digest")
    private let lock = NSLock()
    private var listener: NWListener?
    private var authorizationValues: [String] = []
    private let redirectTo: URL?
    private let redirectOnGetOnly: Bool
    private let basicChallenge: Bool
    private var observations: [Observation] = []
    private var failures: [String] = []
    private var seenCounts: Set<String> = []
    private var nonceVersion = 1
    private var rotated = false
    private let proxyRequired: Bool
    private let rotateAfter: Int?
    private let algorithm: String
    private let qop: String
    let payload = Data((0..<1048576).map { UInt8($0 % 251) })
    private(set) var port: UInt16 = 0
    init(proxy: Bool = false, rotateAfter: Int? = nil, algorithm: String = "MD5", qop: String = "auth", redirectTo: URL? = nil, redirectOnGetOnly: Bool = false, basicChallenge: Bool = false) {
        self.redirectTo = redirectTo; self.redirectOnGetOnly = redirectOnGetOnly; self.basicChallenge = basicChallenge
        proxyRequired = proxy; self.rotateAfter = rotateAfter; self.algorithm = algorithm; self.qop = qop
    }
    var receivedAuthorization: [String] { lock.lock(); defer { lock.unlock() }; return authorizationValues }
    var accepted: [Observation] { lock.lock(); defer { lock.unlock() }; return observations }
    var rejected: [String] { lock.lock(); defer { lock.unlock() }; return failures }
    var url: URL { URL(string: "http://127.0.0.1:\(port)/encoded%2Ffile%20name.bin?token=a%2Bb&part=1")! }
    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { self.port = listener.port!.rawValue; ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { connection in connection.start(queue: self.queue); self.read(connection, Data()) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 2) == .success, port > 0 else { throw URLError(.cannotConnectToHost) }
    }
    func stop() { listener?.cancel() }
    private func read(_ connection: NWConnection, _ prefix: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, done, _ in
            let received = prefix + (data ?? Data())
            guard let text = String(data: received, encoding: .utf8), text.contains("\r\n\r\n") else {
                if !done { self.read(connection, received) } else { connection.cancel() }; return
            }
            self.respond(connection, text)
        }
    }
    private func send(_ connection: NWConnection, status: Int, headers: [String: String], body: Data = Data()) {
        var text = "HTTP/1.1 \(status) Fixture\r\nConnection: close\r\n"
        for (name, value) in headers { text += "\(name): \(value)\r\n" }
        text += "\r\n"
        connection.send(content: Data(text.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }
    private func challenge(_ connection: NWConnection, proxy: Bool) {
        let realm = proxy ? "proxy-realm" : "origin-realm"
        let nonce = proxy ? "proxy-nonce" : "origin-\(nonceVersion)"
        let challengeText = basicChallenge ? "Basic realm=\"redirect-target\"" : "Digest realm=\"\(realm)\", nonce=\"\(nonce)\", algorithm=\(algorithm), qop=\"\(qop)\""
        send(connection, status: proxy ? 407 : 401, headers: ["Content-Length": "0", proxy ? "Proxy-Authenticate" : "WWW-Authenticate":
            challengeText])
    }
    private func respond(_ connection: NWConnection, _ request: String) {
        let lines = request.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ")
        guard first.count == 3 else { connection.cancel(); return }
        let method = String(first[0]), target = String(first[1])
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if let colon = line.firstIndex(of: ":") { headers[String(line[..<colon]).lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces) }
        }
        lock.lock(); authorizationValues.append(headers["authorization"] ?? ""); lock.unlock()
        if proxyRequired && !verify(headers["proxy-authorization"], method: method, target: target, proxy: true) {
            challenge(connection, proxy: true); return
        }
        if let rotateAfter, !rotated, accepted.filter({ !$0.proxy }).count >= rotateAfter {
            nonceVersion += 1; rotated = true
        }
        guard verify(headers["authorization"], method: method, target: target, proxy: false) else { challenge(connection, proxy: false); return }
        if let redirectTo, !redirectOnGetOnly || method != "HEAD" {
            send(connection, status: 302, headers: ["Content-Length": "0", "Location": redirectTo.absoluteString]); return
        }
        let total = payload.count
        var response = ["Content-Length": "\(total)", "Accept-Ranges": "bytes", "ETag": "\"stable-digest-fixture\""]
        if method == "HEAD" { send(connection, status: 200, headers: response); return }
        if let range = headers["range"], range.hasPrefix("bytes=") {
            let bounds = range.dropFirst(6).split(separator: "-")
            guard let start = Int(bounds[0]), let end = Int(bounds.last!), start >= 0, end >= start, end < total else {
                send(connection, status: 416, headers: ["Content-Length": "0"]); return
            }
            response["Content-Length"] = "\(end - start + 1)"
            response["Content-Range"] = "bytes \(start)-\(end)/\(total)"
            send(connection, status: 206, headers: response, body: payload.subdata(in: start..<(end + 1))); return
        }
        send(connection, status: 200, headers: response, body: payload)
    }
    private func verify(_ header: String?, method: String, target: String, proxy: Bool) -> Bool {
        guard let header, header.hasPrefix("Digest ") else { return false }
        let pattern = #"([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))"#
        let expression = try! NSRegularExpression(pattern: pattern)
        var fields: [String: String] = [:]
        for match in expression.matches(in: header, range: NSRange(header.startIndex..., in: header)) {
            let key = String(header[Range(match.range(at: 1), in: header)!]).lowercased()
            let value = Range(match.range(at: 2), in: header) ?? Range(match.range(at: 3), in: header)!
            fields[key] = String(header[value])
        }
        let user = proxy ? "proxy-user" : "origin-user"
        let password = proxy ? "proxy-pass" : "origin-pass"
        let realm = proxy ? "proxy-realm" : "origin-realm"
        let nonce = proxy ? "proxy-nonce" : "origin-\(nonceVersion)"
        // A stale nonce is a normal rechallenge, not an invalid-signature finding.
        if fields["nonce"] != nonce { return false }
        let cnonce = fields["cnonce"] ?? ""
        let nc = fields["nc"] ?? ""
        let hash: (String) -> String = algorithm == "SHA-256" ? Self.sha256 : Self.md5
        let ha1 = hash("\(user):\(realm):\(password)")
        let ha2 = hash("\(method):\(target)")
        let expected = hash("\(ha1):\(nonce):\(nc):\(cnonce):auth:\(ha2)")
        let key = "\(proxy):\(nonce):\(cnonce):\(nc)"
        lock.lock(); defer { lock.unlock() }
        guard fields["username"] == user, fields["realm"] == realm, fields["uri"] == target,
              fields["qop"] == "auth", (fields["algorithm"] ?? "MD5").uppercased() == algorithm,
              fields["response"] == expected, !cnonce.isEmpty,
              let count = UInt32(nc, radix: 16), count > 0, !seenCounts.contains(key) else {
            failures.append("Invalid \(proxy ? "proxy" : "origin") signature for \(method) \(target); supplied uri=\(fields["uri"] ?? "nil"), nc=\(nc), algorithm=\(fields["algorithm"] ?? "nil")"); return false
        }
        seenCounts.insert(key)
        observations.append(Observation(method: method, target: target, proxy: proxy, nonce: nonce, cnonce: cnonce, count: count))
        return true
    }
    private static func sha256(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
    private static func md5(_ text: String) -> String { Insecure.MD5.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
}
