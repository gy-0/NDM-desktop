import Foundation
import Network
import CryptoKit

/// Minimal HTTP server supporting HEAD / GET / Range for engine integration tests.
final class LocalRangeServer: @unchecked Sendable {
    let entityTag: String
    private let authenticationChallenge: String
    private let headStatus: Int
    private let sendsValidator: Bool
    private let responseHeaders: @Sendable (String, Int?) -> [String: String]
    private let headContentLength: Int?
    private let omitHeadContentLength: Bool
    private let bodyChunkSize: Int?
    private let bodyChunkDelay: @Sendable (Int) -> TimeInterval
    private let payload: Data
    private let responseDelay: TimeInterval
    private let rangeResponseDelay: @Sendable (Int) -> TimeInterval
    private let ignoresRangeRequests: Bool
    private let contentRangeTotalOffset: Int
    private let injectedRangeFailureStatus: Int?
    private let injectRangeFailureAfterCount: Int
    private let injectedRangeFailureLimit: Int
    private let injectedRangeFailureStartAtOrAbove: Int?
    private let retryAfter: String?
    private let maximumActiveRangeRequests: Int?
    private var acceptedRangeRequests = 0
    private var _peakAcceptedRangeRequests = 0
    private var _rejectedRangeRequests = 0
    private var injectedRangeFailures = 0
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "ndm.test.httpserver")
    private let recordLock = NSLock()
    private var _recordedRanges: [String] = []
    private var _recordedMethods: [String] = []
    private var _recordedBodies: [String] = []
    private var _recordedHeaders: [[String: String]] = []
    private(set) var port: UInt16 = 0

    init(
        payload: Data,
        authenticationChallenge: String = "Basic realm=\"fixture\"",
        bodyChunkSize: Int? = nil,
        bodyChunkDelay: @escaping @Sendable (Int) -> TimeInterval = { _ in 0 },
        headContentLength: Int? = nil,
        omitHeadContentLength: Bool = false,
        responseDelay: TimeInterval = 0,
        rangeResponseDelay: @escaping @Sendable (Int) -> TimeInterval = { _ in 0 },
        ignoresRangeRequests: Bool = false,
        contentRangeTotalOffset: Int = 0,
        injectedRangeFailureStatus: Int? = nil,
        injectRangeFailureAfterCount: Int = .max,
        injectedRangeFailureLimit: Int = 0,
        injectedRangeFailureStartAtOrAbove: Int? = nil,
        retryAfter: String? = nil,
        maximumActiveRangeRequests: Int? = nil,
        sendsValidator: Bool = true,
        headStatus: Int = 200,
        responseHeaders: @escaping @Sendable (String, Int?) -> [String: String] = { _, _ in [:] }
    ) {
        self.authenticationChallenge = authenticationChallenge
        self.bodyChunkSize = bodyChunkSize
        self.bodyChunkDelay = bodyChunkDelay
        self.headStatus = headStatus
        self.sendsValidator = sendsValidator
        self.responseHeaders = responseHeaders
        self.entityTag = "\"" + SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined() + "\""
        self.maximumActiveRangeRequests = maximumActiveRangeRequests
        self.retryAfter = retryAfter
        self.headContentLength = headContentLength
        self.omitHeadContentLength = omitHeadContentLength
        self.payload = payload
        self.responseDelay = responseDelay
        self.rangeResponseDelay = rangeResponseDelay
        self.ignoresRangeRequests = ignoresRangeRequests
        self.contentRangeTotalOffset = contentRangeTotalOffset
        self.injectedRangeFailureStatus = injectedRangeFailureStatus
        self.injectRangeFailureAfterCount = injectRangeFailureAfterCount
        self.injectedRangeFailureLimit = injectedRangeFailureLimit
        self.injectedRangeFailureStartAtOrAbove = injectedRangeFailureStartAtOrAbove
    }

    var recordedRanges: [String] {
        recordLock.lock(); defer { recordLock.unlock() }
        return _recordedRanges
    }

    var peakAcceptedRangeRequests: Int {
        recordLock.lock(); defer { recordLock.unlock() }
        return _peakAcceptedRangeRequests
    }
    var rejectedRangeRequests: Int {
        recordLock.lock(); defer { recordLock.unlock() }
        return _rejectedRangeRequests
    }

    /// Request methods in arrival order, so tests can assert the engine actually
    /// spoke the verb the task asked for instead of silently downgrading to GET.
    var recordedMethods: [String] {
        recordLock.lock(); defer { recordLock.unlock() }
        return _recordedMethods
    }

    /// Request bodies (empty string when a request carried none).
    var recordedBodies: [String] {
        recordLock.lock(); defer { recordLock.unlock() }
        return _recordedBodies
    }

    var recordedHeaders: [[String: String]] {
        recordLock.lock(); defer { recordLock.unlock() }
        return _recordedHeaders
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
        guard port != 0 else { throw NSError(domain: "LocalRangeServer", code: 1) }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)/file.bin")! }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        readRequest(connection, buffer: Data())
    }

    /// URLSession commonly writes a POST's headers and body as separate TCP
    /// segments, so a single `receive` sees headers only. Keep reading until the
    /// declared `Content-Length` has arrived, otherwise body assertions in tests
    /// would silently pass against an empty string.
    private func readRequest(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, _ in
            guard let self else {
                connection.cancel()
                return
            }
            var accumulated = buffer
            if let data { accumulated.append(data) }
            guard let req = String(data: accumulated, encoding: .utf8) else {
                connection.cancel()
                return
            }
            guard let sep = req.range(of: "\r\n\r\n") else {
                if isComplete || data == nil {
                    connection.cancel()
                } else {
                    self.readRequest(connection, buffer: accumulated)
                }
                return
            }
            let declared = req.components(separatedBy: "\r\n")
                .first { $0.lowercased().hasPrefix("content-length:") }
                .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?
                    .trimmingCharacters(in: .whitespaces) ?? "") } ?? 0
            if req[sep.upperBound...].utf8.count < declared, !isComplete, data != nil {
                self.readRequest(connection, buffer: accumulated)
                return
            }
            self.respond(connection, req: req, bodyStart: sep.upperBound)
        }
    }

    private func respond(_ connection: NWConnection, req: String, bodyStart: String.Index) {
        recordLock.lock()
        _recordedMethods.append(
            (req.components(separatedBy: "\r\n").first ?? "")
                .split(separator: " ").first.map(String.init) ?? ""
        )
        _recordedBodies.append(String(req[bodyStart...]))
        _recordedHeaders.append(Dictionary(
            uniqueKeysWithValues: req.components(separatedBy: "\r\n").dropFirst().compactMap { line in
                guard let colon = line.firstIndex(of: ":") else { return nil }
                let name = String(line[..<colon]).lowercased()
                let value = String(line[line.index(after: colon)...])
                    .trimmingCharacters(in: .whitespaces)
                return (name, value)
            }
        ))
        var rangeOrdinal: Int?
        let rangeLine = req.components(separatedBy: "\r\n")
            .first { $0.lowercased().hasPrefix("range:") }
        if let rangeLine {
            _recordedRanges.append(rangeLine)
            rangeOrdinal = _recordedRanges.count
        }
        let rejected = rangeLine != nil && maximumActiveRangeRequests.map { acceptedRangeRequests >= $0 } == true
        if rangeLine != nil {
            if rejected { _rejectedRangeRequests += 1 }
            else {
                acceptedRangeRequests += 1
                _peakAcceptedRangeRequests = max(_peakAcceptedRangeRequests, acceptedRangeRequests)
            }
        }
        recordLock.unlock()

        let response = rejected ? errorResponse(status: 429, total: payload.count) : buildResponse(for: req, rangeOrdinal: rangeOrdinal)
        let send = {
            if rangeLine != nil && !rejected {
                self.recordLock.lock()
                self.acceptedRangeRequests -= 1
                self.recordLock.unlock()
            }
            if let size = self.bodyChunkSize, let start = self.rangeStart(in: req), !rejected {
                self.sendChunks(response, offset: 0, size: max(1, size), delay: self.bodyChunkDelay(start), connection: connection)
                return
            }
            connection.send(content: response, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
        let start = rangeStart(in: req)
        let delay = rejected ? 0 : responseDelay + (start.map(rangeResponseDelay) ?? 0)
        if delay > 0 {
            queue.asyncAfter(deadline: .now() + delay, execute: send)
        } else {
            send()
        }
    }

    private func sendChunks(_ data: Data, offset: Int, size: Int, delay: TimeInterval, connection: NWConnection) {
        let end = min(data.count, offset + size)
        connection.send(content: data.subdata(in: offset..<end), completion: .contentProcessed { error in
            guard error == nil, end < data.count else { connection.cancel(); return }
            self.queue.asyncAfter(deadline: .now() + delay) {
                self.sendChunks(data, offset: end, size: size, delay: delay, connection: connection)
            }
        })
    }

    private func rangeStart(in request: String) -> Int? {
        guard let line = request.components(separatedBy: "\r\n")
            .first(where: { $0.lowercased().hasPrefix("range:") }) else {
            return nil
        }
        let spec = line.split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "bytes=", with: "") ?? ""
        return Int(spec.split(separator: "-", maxSplits: 1).first ?? "")
    }

    private func buildResponse(
        for request: String,
        rangeOrdinal: Int?
    ) -> Data {
        let lines = request.components(separatedBy: "\r\n")
        let first = lines.first ?? ""
        let method = first.split(separator: " ").first.map(String.init) ?? "GET"
        let rangeHeader = lines.first(where: { $0.lowercased().hasPrefix("range:") })
        let total = payload.count
        var metadata = sendsValidator ? ["ETag": entityTag] : [:]
        metadata.merge(responseHeaders(method, rangeOrdinal)) { _, replacement in replacement }
        let extraHeaders = metadata.sorted { $0.key < $1.key }.map { "\($0.key): \($0.value)\r\n" }.joined()

        if method == "HEAD" {
            if headStatus != 200 { return Data("HTTP/1.1 \(headStatus) Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8) }
            var h = "HTTP/1.1 200 OK\r\n"
            if !omitHeadContentLength { h += "Content-Length: \(headContentLength ?? total)\r\n" }
            h += "Accept-Ranges: bytes\r\n"
            h += "Content-Type: application/octet-stream\r\n"
            h += extraHeaders
            h += "Connection: close\r\n\r\n"
            return Data(h.utf8)
        }

        if let rangeHeader, !ignoresRangeRequests {
            // bytes=START-END
            let spec = rangeHeader.split(separator: ":", maxSplits: 1).last?
                .trimmingCharacters(in: .whitespaces) ?? ""
            let body = spec.replacingOccurrences(of: "bytes=", with: "")
            let parts = body.split(separator: "-")
            let start = Int(parts.first ?? "0") ?? 0
            if let rangeOrdinal,
               let status = injectedRangeFailureStatus,
               rangeOrdinal > injectRangeFailureAfterCount,
               injectedRangeFailureStartAtOrAbove.map({ start >= $0 }) ?? true,
               injectedRangeFailures < injectedRangeFailureLimit {
                injectedRangeFailures += 1
                return errorResponse(status: status, total: total)
            }
            guard start >= 0, start < total else {
                return errorResponse(status: 416, total: total)
            }
            let end: Int
            if parts.count > 1, let e = Int(parts[1]) {
                end = min(e, total - 1)
            } else {
                end = total - 1
            }
            let slice = payload.subdata(in: start..<(end + 1))
            var h = "HTTP/1.1 206 Partial Content\r\n"
            h += "Content-Length: \(slice.count)\r\n"
            h += "Content-Range: bytes \(start)-\(end)/\(total + contentRangeTotalOffset)\r\n"
            h += "Accept-Ranges: bytes\r\n"
            h += "Content-Type: application/octet-stream\r\n"
            h += extraHeaders
            h += "Connection: close\r\n\r\n"
            var out = Data(h.utf8)
            out.append(slice)
            return out
        }

        var h = "HTTP/1.1 200 OK\r\n"
        h += "Content-Length: \(total)\r\n"
        h += "Accept-Ranges: bytes\r\n"
        h += "Content-Type: application/octet-stream\r\n"
        h += extraHeaders
            h += "Connection: close\r\n\r\n"
        var out = Data(h.utf8)
        out.append(payload)
        return out
    }

    private func errorResponse(status: Int, total: Int) -> Data {
        let reason: String
        switch status {
        case 416: reason = "Range Not Satisfiable"
        case 500: reason = "Internal Server Error"
        case 503: reason = "Service Unavailable"
        default: reason = "Error"
        }
        var headers = "HTTP/1.1 \(status) \(reason)\r\n"
        if status == 401 { headers += "WWW-Authenticate: \(authenticationChallenge)\r\n" }
        if status == 407 { headers += "Proxy-Authenticate: \(authenticationChallenge)\r\n" }
        if status == 416 {
            headers += "Content-Range: bytes */\(total)\r\n"
        }
        if let retryAfter { headers += "Retry-After: \(retryAfter)\r\n" }
        headers += "Content-Length: 0\r\n"
        headers += "Connection: close\r\n\r\n"
        return Data(headers.utf8)
    }
}
