import Foundation
import Network
@testable import NDMCore

/// Minimal HTTP server implementing NTLM Type1→Type2→Type3 handshake for integration tests.
final class LocalNTLMServer: @unchecked Sendable {
    private let payload: Data
    private let username: String
    private let password: String
    private let domain: String
    private let serverChallenge: Data
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ndm.test.ntlmserver")
    private(set) var port: UInt16 = 0

    init(
        payload: Data,
        username: String = "User",
        password: String = "Password",
        domain: String = "Domain",
        serverChallenge: Data = Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF])
    ) {
        self.payload = payload
        self.username = username
        self.password = password
        self.domain = domain
        self.serverChallenge = serverChallenge
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        var failed: Error?
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = listener.port?.rawValue ?? 0
                ready.signal()
            case .failed(let err):
                failed = err
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        if let failed { throw failed }
        guard port != 0 else { throw NSError(domain: "LocalNTLMServer", code: 1) }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/file.bin")! }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, error in
            guard let self else {
                connection.cancel()
                return
            }
            if error != nil || data == nil {
                connection.cancel()
                return
            }
            guard let req = String(data: data!, encoding: .utf8) else {
                connection.cancel()
                return
            }
            let response = self.buildResponse(for: req)
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    private func buildResponse(for request: String) -> Data {
        let lines = request.components(separatedBy: "\r\n")
        let first = lines.first ?? ""
        let method = first.split(separator: " ").first.map(String.init) ?? "GET"
        let auth = lines.first(where: { $0.lowercased().hasPrefix("authorization:") })
            .map { String($0.split(separator: ":", maxSplits: 1).last ?? "").trimmingCharacters(in: .whitespaces) }
            ?? ""

        if auth.isEmpty || auth.uppercased().hasPrefix("BASIC") {
            return http(401, headers: ["WWW-Authenticate": "NTLM"], body: Data())
        }

        guard let token = NTLMAuth.ntlmToken(from: auth), token.count >= 12 else {
            return http(401, headers: ["WWW-Authenticate": "NTLM"], body: Data())
        }

        let type = token[8]
        if type == 1 {
            let type2 = makeType2()
            return http(401, headers: [
                "WWW-Authenticate": "NTLM \(type2.base64EncodedString())",
            ], body: Data())
        }
        if type == 3 {
            if verifyType3(token) {
                if method == "HEAD" {
                    return http(200, headers: [
                        "Content-Length": "\(payload.count)",
                        "Accept-Ranges": "bytes",
                        "Content-Type": "application/octet-stream",
                    ], body: Data())
                }
                if let rangeLine = lines.first(where: { $0.lowercased().hasPrefix("range:") }) {
                    return rangeResponse(rangeLine)
                }
                return http(200, headers: [
                    "Content-Length": "\(payload.count)",
                    "Accept-Ranges": "bytes",
                    "Content-Type": "application/octet-stream",
                ], body: payload)
            }
            return http(401, headers: ["WWW-Authenticate": "NTLM"], body: Data())
        }
        return http(400, headers: [:], body: Data())
    }

    private func rangeResponse(_ rangeHeader: String) -> Data {
        let spec = rangeHeader.split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespaces) ?? ""
        let body = spec.replacingOccurrences(of: "bytes=", with: "")
        let parts = body.split(separator: "-")
        let start = Int(parts.first ?? "0") ?? 0
        let end: Int
        if parts.count > 1, let e = Int(parts[1]) {
            end = min(e, payload.count - 1)
        } else {
            end = payload.count - 1
        }
        guard start <= end, start < payload.count else {
            return http(416, headers: [:], body: Data())
        }
        let slice = payload.subdata(in: start..<(end + 1))
        return http(206, headers: [
            "Content-Length": "\(slice.count)",
            "Content-Range": "bytes \(start)-\(end)/\(payload.count)",
            "Accept-Ranges": "bytes",
            "Content-Type": "application/octet-stream",
        ], body: slice)
    }

    private func makeType2() -> Data {
        let target = NTLMAuth.utf16LE(domain)
        var msg = Data(capacity: 48 + target.count)
        msg.append(contentsOf: [0x4E, 0x54, 0x4C, 0x4D, 0x53, 0x53, 0x50, 0x00]) // NTLMSSP\0
        msg.append(contentsOf: [2, 0, 0, 0])
        let targetOff: UInt32 = 48
        appendU16(&msg, UInt16(target.count))
        appendU16(&msg, UInt16(target.count))
        appendU32(&msg, targetOff)
        appendU32(&msg, 0xA288_8205)
        msg.append(serverChallenge)
        msg.append(contentsOf: [UInt8](repeating: 0, count: 8))
        let infoOff = targetOff + UInt32(target.count)
        appendU16(&msg, 0)
        appendU16(&msg, 0)
        appendU32(&msg, infoOff)
        while msg.count < Int(targetOff) { msg.append(0) }
        msg.append(target)
        return msg
    }

    private func verifyType3(_ token: Data) -> Bool {
        guard token.count >= 64 else { return false }
        let ntLen = Int(token[20]) | (Int(token[21]) << 8)
        let ntOff = Int(token[24]) | (Int(token[25]) << 8) | (Int(token[26]) << 16) | (Int(token[27]) << 24)
        guard ntOff >= 0, ntLen >= 16, ntOff + ntLen <= token.count else { return false }
        let ntResp = token.subdata(in: ntOff..<(ntOff + ntLen))
        let blob = ntResp.suffix(from: 16)
        guard blob.count >= 28 else { return false }
        let clientChallenge = Data(blob[blob.startIndex.advanced(by: 16)..<blob.startIndex.advanced(by: 24)])
        let timestamp = Data(blob[blob.startIndex.advanced(by: 8)..<blob.startIndex.advanced(by: 16)])
        let targetInfo: Data
        if blob.count > 32 {
            let tiStart = blob.startIndex.advanced(by: 28)
            let tiEnd = blob.index(blob.endIndex, offsetBy: -4)
            targetInfo = tiStart < tiEnd ? Data(blob[tiStart..<tiEnd]) : Data()
        } else {
            targetInfo = Data()
        }

        let expected = NTLMAuth.ntlmV2Response(
            password: password,
            user: username,
            domain: domain,
            serverChallenge: serverChallenge,
            clientChallenge: clientChallenge,
            timestamp: timestamp,
            targetInfo: targetInfo
        )
        return ntResp == expected
    }

    private func http(_ status: Int, headers: [String: String], body: Data) -> Data {
        let reason: String
        switch status {
        case 200: reason = "OK"
        case 206: reason = "Partial Content"
        case 401: reason = "Unauthorized"
        case 416: reason = "Range Not Satisfiable"
        default: reason = "Error"
        }
        var h = "HTTP/1.1 \(status) \(reason)\r\n"
        h += "Connection: close\r\n"
        for (k, v) in headers { h += "\(k): \(v)\r\n" }
        if headers.keys.first(where: { $0.lowercased() == "content-length" }) == nil {
            h += "Content-Length: \(body.count)\r\n"
        }
        h += "\r\n"
        var out = Data(h.utf8)
        out.append(body)
        return out
    }

    private func appendU16(_ data: inout Data, _ v: UInt16) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private func appendU32(_ data: inout Data, _ v: UInt32) {
        var le = v.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
}
