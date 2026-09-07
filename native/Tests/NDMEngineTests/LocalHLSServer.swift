import Foundation
import Network

/// Minimal static-file HTTP server for HLS playlist + TS segment integration tests.
final class LocalHLSServer: @unchecked Sendable {
    private let files: [String: Data]
    private let supportsHEAD: Bool
    private let delayedGETs: [String: TimeInterval]
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ndm.test.hlsserver")
    private(set) var port: UInt16 = 0

    init(
        files: [String: Data],
        supportsHEAD: Bool = true,
        delayedGETs: [String: TimeInterval] = [:]
    ) {
        self.files = files
        self.supportsHEAD = supportsHEAD
        self.delayedGETs = delayedGETs
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                if let p = listener.port?.rawValue {
                    self?.port = p
                }
                ready.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        guard port != 0 else { throw NSError(domain: "LocalHLSServer", code: 1) }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    func url(path: String) -> URL {
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return URL(string: "http://127.0.0.1:\(port)/\(trimmed)")!
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let req = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            let response = self.buildResponse(for: req)
            let send = {
                connection.send(content: response, completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
            let delay = self.getDelay(for: req)
            if delay > 0 {
                self.queue.asyncAfter(deadline: .now() + delay, execute: send)
            } else {
                send()
            }
        }
    }

    private func getDelay(for request: String) -> TimeInterval {
        let first = request.components(separatedBy: "\r\n").first ?? ""
        let parts = first.split(separator: " ")
        guard parts.first == "GET", parts.count > 1 else { return 0 }
        let pathPart = String(parts[1])
        let path = pathPart.split(separator: "?").first.map(String.init) ?? pathPart
        let key = path.hasPrefix("/") ? String(path.dropFirst()) : path
        return delayedGETs[key] ?? 0
    }

    private func buildResponse(for request: String) -> Data {
        let lines = request.components(separatedBy: "\r\n")
        let first = lines.first ?? ""
        let parts = first.split(separator: " ")
        let method = parts.first.map(String.init) ?? "GET"
        let pathPart = parts.count > 1 ? String(parts[1]) : "/"
        let path = pathPart.split(separator: "?").first.map(String.init) ?? pathPart
        let key = path.hasPrefix("/") ? String(path.dropFirst()) : path

        let rangeHeader = lines.first(where: { $0.lowercased().hasPrefix("range:") })

        guard let body = files[key] else {
            let h = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            return Data(h.utf8)
        }

        if method == "HEAD", !supportsHEAD {
            let h = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            return Data(h.utf8)
        }

        let mime: String
        if key.hasSuffix(".m3u8") {
            mime = "application/vnd.apple.mpegurl"
        } else if key.hasSuffix(".ts") {
            mime = "video/mp2t"
        } else {
            mime = "application/octet-stream"
        }

        if method == "HEAD" {
            var h = "HTTP/1.1 200 OK\r\n"
            h += "Content-Length: \(body.count)\r\n"
            h += "Content-Type: \(mime)\r\n"
            h += "Connection: close\r\n\r\n"
            return Data(h.utf8)
        }

        if let rangeHeader {
            let spec = rangeHeader.split(separator: ":", maxSplits: 1).last?
                .trimmingCharacters(in: .whitespaces) ?? ""
            let bodySpec = spec.replacingOccurrences(of: "bytes=", with: "")
            let rp = bodySpec.split(separator: "-")
            let start = Int(rp.first ?? "0") ?? 0
            let end: Int
            if rp.count > 1, let e = Int(rp[1]) {
                end = min(e, body.count - 1)
            } else {
                end = body.count - 1
            }
            let slice = body.subdata(in: start..<(end + 1))
            var h = "HTTP/1.1 206 Partial Content\r\n"
            h += "Content-Length: \(slice.count)\r\n"
            h += "Content-Range: bytes \(start)-\(end)/\(body.count)\r\n"
            h += "Content-Type: \(mime)\r\n"
            h += "Connection: close\r\n\r\n"
            var out = Data(h.utf8)
            out.append(slice)
            return out
        }

        var h = "HTTP/1.1 200 OK\r\n"
        h += "Content-Length: \(body.count)\r\n"
        h += "Content-Type: \(mime)\r\n"
        h += "Connection: close\r\n\r\n"
        var out = Data(h.utf8)
        out.append(body)
        return out
    }
}
