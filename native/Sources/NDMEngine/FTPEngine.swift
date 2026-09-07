import Foundation
import Network
import NDMCore

/// Single-connection FTP download (PASV + RETR), aligned with original `NeatSocketFtp` command sequence.
public actor FTPEngine {
    public private(set) var progress: DownloadProgress

    private let request: DownloadRequest
    private let taskID: Int64
    private let workDirectory: URL
    private let ftpProxy: ProxySettings?
    private let token = CancelToken()
    private var logHandle: FileHandle?
    private var activeControl: FTPControlConnection?
    private var activeData: FTPDataConnection?

    public init(
        taskID: Int64,
        request: DownloadRequest,
        workDirectory: URL,
        ftpProxy: ProxySettings? = nil
    ) {
        self.taskID = taskID
        self.request = request
        self.workDirectory = workDirectory
        self.ftpProxy = ftpProxy
        self.progress = DownloadProgress(taskID: taskID, status: .waiting)
    }

    public func pause() {
        token.pause()
        progress.status = .paused
        log("FTP engine paused")
    }

    public func cancel() {
        token.cancel()
        activeControl?.close()
        activeData?.close()
        progress.status = .incomplete
        log("FTP Download Canceled By User.")
    }

    public func currentProgress() -> DownloadProgress { progress }

    @discardableResult
    public func start() async throws -> URL {
        guard !Task.isCancelled else { throw EngineError.cancelled }
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        token.reset()
        openLog()
        progress.status = .downloading
        log("DownloadID = \(taskID) , Protocol = FTP , OS = MAC")
        log("Trying to Start FTP Download for -> \(request.url.absoluteString)")

        guard let host = request.url.host, !host.isEmpty else {
            throw EngineError.invalidResponse
        }
        let port = request.url.port ?? 21
        let remotePath = ftpRemotePath(from: request.url)
        let user = request.username ?? request.url.user ?? "anonymous"
        let pass = request.password ?? request.url.password ?? "ndm@localhost"

        let proxy = ftpProxy.flatMap { candidate in
            candidate.enabled && !candidate.host.isEmpty ? candidate : nil
        }
        let control: FTPControlConnection
        if let proxy {
            log("FTP via HTTP proxy \(proxy.host):\(proxy.port)")
            control = FTPControlConnection(host: proxy.host, port: proxy.port)
        } else {
            control = FTPControlConnection(host: host, port: UInt16(port))
        }
        activeControl = control
        defer {
            control.close()
            if activeControl === control { activeControl = nil }
        }
        try await control.connect()
        try checkCancel()
        if let proxy {
            // HTTP CONNECT tunnel to origin FTP host
            var connect = "CONNECT \(host):\(port) HTTP/1.1\r\nHost: \(host):\(port)\r\n"
            if let u = proxy.username, let p = proxy.password {
                let token = Data("\(u):\(p)".utf8).base64EncodedString()
                connect += "Proxy-Authorization: Basic \(token)\r\n"
            }
            connect += "\r\n"
            try await control.sendRaw(Data(connect.utf8))
            let tunnel = try await control.readHTTPStatus()
            guard tunnel == 200 else { throw FTPError.proxyConnectFailed(tunnel) }
        }

        _ = try await control.readReply() // 220 welcome
        try checkCancel()

        log("Sending FTP Command : USER \(user)")
        try await control.sendCommand("USER \(user)")
        var code = try await control.readReply().code
        if code == 331 {
            log("Sending FTP Command : PASS XXXXXX")
            try await control.sendCommand("PASS \(pass)")
            code = try await control.readReply().code
        }
        guard (200..<300).contains(code) else { throw FTPError.loginFailed(code) }

        log("Sending FTP Command : TYPE I")
        try await control.sendCommand("TYPE I")
        _ = try await control.readReply()

        var totalSize: Int64 = 0
        log("Sending FTP Command : SIZE \(remotePath)")
        try await control.sendCommand("SIZE \(remotePath)")
        let sizeReply = try await control.readReply()
        if sizeReply.code == 213, let n = Int64(sizeReply.message.trimmingCharacters(in: .whitespacesAndNewlines)) {
            totalSize = n
            progress.totalBytes = n
            log("FTP SIZE = \(n)")
        }

        let partialURL = workDirectory.appendingPathComponent("ftp.partial")
        var resumeOffset: Int64 = 0
        if FileManager.default.fileExists(atPath: partialURL.path),
           let attrs = try? FileManager.default.attributesOfItem(atPath: partialURL.path),
           let existing = (attrs[.size] as? NSNumber)?.int64Value,
           existing > 0 {
            resumeOffset = existing
            progress.completedBytes = existing
            log("Sending FTP Command : REST \(resumeOffset)")
            try await control.sendCommand("REST \(resumeOffset)")
            let restReply = try await control.readReply()
            // 350 Requested file action pending further information (RFC959)
            let restOK = restReply.code == 350 || (200..<300).contains(restReply.code)
            if !restOK {
                resumeOffset = 0
                progress.completedBytes = 0
                try? FileManager.default.removeItem(at: partialURL)
                log("REST rejected (\(restReply.code)); restarting from 0")
            }
        }

        log("Sending FTP Command : PASV")
        try await control.sendCommand("PASV")
        let pasvReply = try await control.readReply()
        guard pasvReply.code == 227,
              let endpoint = Self.parsePASV(pasvReply.message) else {
            throw FTPError.badPASV(pasvReply.message)
        }

        let dataConn = FTPDataConnection(host: endpoint.host, port: endpoint.port)
        activeData = dataConn
        defer {
            dataConn.close()
            if activeData === dataConn { activeData = nil }
        }
        try await dataConn.connect()
        try checkCancel()

        log("Sending FTP Command : RETR \(remotePath)")
        try await control.sendCommand("RETR \(remotePath)")
        let retr = try await control.readReply()
        guard (100..<200).contains(retr.code) || (200..<300).contains(retr.code) else {
            throw FTPError.retrFailed(retr.code)
        }

        progress.segmentStates = [
            SegmentState(id: 0, start: 0, end: max(0, totalSize - 1), completed: resumeOffset, isFinished: false)
        ]

        if !FileManager.default.fileExists(atPath: partialURL.path) || resumeOffset == 0 {
            FileManager.default.createFile(atPath: partialURL.path, contents: nil)
        }
        let fileHandle = try FileHandle(forWritingTo: partialURL)
        if resumeOffset > 0 {
            try fileHandle.seek(toOffset: UInt64(resumeOffset))
        }
        defer { try? fileHandle.close() }

        var completed = resumeOffset
        let started = Date()
        while true {
            try checkCancel()
            guard let chunk = try await dataConn.readChunk(maxLength: 64 * 1024) else { break }
            if chunk.isEmpty { break }
            try fileHandle.write(contentsOf: chunk)
            completed += Int64(chunk.count)
            progress.completedBytes = completed
            if totalSize > 0 {
                progress.segmentStates = [
                    SegmentState(id: 0, start: 0, end: totalSize - 1, completed: completed, isFinished: false)
                ]
            }
            let elapsed = Date().timeIntervalSince(started)
            if elapsed > 0 {
                progress.bytesPerSecond = Double(completed - resumeOffset) / elapsed
            }
        }
        try checkCancel()

        // Drain final control reply (226 Transfer complete)
        if let final = try? await control.readReply(timeout: 5) {
            log("FTP final reply \(final.code) \(final.message)")
        }

        try FileManager.default.createDirectory(
            at: request.destinationDirectory,
            withIntermediateDirectories: true
        )
        let filename = request.suggestedFilename?.isEmpty == false
            ? request.suggestedFilename!
            : (request.url.lastPathComponent.isEmpty ? "ftp.bin" : request.url.lastPathComponent)
        let finalURL = request.destinationDirectory.appendingPathComponent(filename)
        if FileManager.default.fileExists(atPath: finalURL.path) {
            try FileManager.default.removeItem(at: finalURL)
        }
        try FileManager.default.moveItem(at: partialURL, to: finalURL)

        if totalSize <= 0 {
            let attrs = try? FileManager.default.attributesOfItem(atPath: finalURL.path)
            progress.totalBytes = (attrs?[.size] as? NSNumber)?.int64Value ?? completed
        }
        progress.completedBytes = progress.totalBytes
        progress.segmentStates = [
            SegmentState(
                id: 0,
                start: 0,
                end: max(0, progress.totalBytes - 1),
                completed: progress.totalBytes,
                isFinished: true
            )
        ]
        progress.status = .complete
        log("DownloadEngine State Changed : Downloading... -> Completed")
        closeLog()
        return finalURL
    }

    // MARK: - Helpers

    private func checkCancel() throws {
        if token.isCancelled {
            if token.isPaused { throw EngineError.paused }
            throw EngineError.cancelled
        }
    }

    private func ftpRemotePath(from url: URL) -> String {
        var path = url.path
        if path.isEmpty { path = "/" }
        // Percent-decode for FTP PATH
        path = path.removingPercentEncoding ?? path
        return path
    }

    /// Parse `227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)`.
    nonisolated static func parsePASV(_ message: String) -> (host: String, port: UInt16)? {
        guard let start = message.firstIndex(of: "("),
              let end = message.firstIndex(of: ")"),
              start < end else { return nil }
        let inner = message[message.index(after: start)..<end]
        let parts = inner.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        guard parts.count >= 6,
              let h1 = Int(parts[0]), let h2 = Int(parts[1]),
              let h3 = Int(parts[2]), let h4 = Int(parts[3]),
              let p1 = Int(parts[4]), let p2 = Int(parts[5]) else { return nil }
        let host = "\(h1).\(h2).\(h3).\(h4)"
        let port = UInt16(p1 * 256 + p2)
        return (host, port)
    }

    private func openLog() {
        let url = workDirectory.appendingPathComponent("LogFile.txt")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: url)
        _ = try? logHandle?.seekToEnd()
        log("Opening LogFile...")
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }

    private func log(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let formatted = "INFO   \(f.string(from: Date())) ( \(Int(Date().timeIntervalSince1970)) )   \(line)\n"
        if let data = formatted.data(using: .utf8) {
            try? logHandle?.write(contentsOf: data)
        }
    }
}

// MARK: - Connections

private final class FTPControlConnection: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "ndm.ftp.control")
    private var buffer = Data()
    private let lock = NSLock()

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
    }

    func connect() async throws {
        let conn = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!,
            using: .tcp
        )
        self.connection = conn
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let box = ResumeBox()
            conn.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.startReceiveLoop()
                    box.resume(cont)
                case .failed(let err):
                    box.resume(cont, throwing: err)
                case .cancelled:
                    box.resume(cont, throwing: FTPError.disconnected)
                default:
                    break
                }
            }
            conn.start(queue: queue)
        }
    }

    func close() {
        connection?.cancel()
        connection = nil
    }

    func sendCommand(_ line: String) async throws {
        try await sendRaw(Data((line + "\r\n").utf8))
    }

    func sendRaw(_ data: Data) async throws {
        guard let connection else { throw FTPError.disconnected }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) }
                else { cont.resume() }
            })
        }
    }

    /// Read HTTP status line after CONNECT (e.g. `HTTP/1.1 200 Connection established`).
    func readHTTPStatus(timeout: TimeInterval = 30) async throws -> Int {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let text = lock.withLock { String(data: buffer, encoding: .utf8) ?? "" }
            if let range = text.range(of: "\r\n\r\n") {
                let head = String(text[..<range.lowerBound])
                let consumed = Data(String(text[..<range.upperBound]).utf8)
                lock.withLock {
                    if buffer.count >= consumed.count { buffer.removeFirst(consumed.count) }
                }
                let code = head.split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0
                return code
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw FTPError.timeout
    }

    func readReply(timeout: TimeInterval = 30) async throws -> (code: Int, message: String) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let reply = popCompleteReply() {
                return reply
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        throw FTPError.timeout
    }

    private func startReceiveLoop() {
        guard let connection else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.lock.lock()
                self.buffer.append(data)
                self.lock.unlock()
            }
            if error == nil, !isComplete {
                self.startReceiveLoop()
            }
        }
    }

    /// RFC959 multi-line: `123-...` then final `123 ...`
    private func popCompleteReply() -> (code: Int, message: String)? {
        lock.lock()
        defer { lock.unlock() }
        guard let text = String(data: buffer, encoding: .utf8), !text.isEmpty else { return nil }

        var lines = text.components(separatedBy: "\r\n")
        if text.hasSuffix("\r\n") {
            // keep empty last from split — drop it
            if lines.last?.isEmpty == true { lines.removeLast() }
        } else {
            // incomplete last line
            if lines.count <= 1 { return nil }
            lines.removeLast()
        }
        guard !lines.isEmpty else { return nil }

        guard let first = lines.first, first.count >= 3,
              let code = Int(first.prefix(3)) else { return nil }

        let isMulti = first.count > 3 && first[first.index(first.startIndex, offsetBy: 3)] == "-"
        if isMulti {
            guard let endIdx = lines.firstIndex(where: { line in
                line.count >= 4
                    && line.hasPrefix(String(format: "%03d ", code))
            }) else { return nil }
            let consumed = lines[0...endIdx].joined(separator: "\r\n") + "\r\n"
            let consumedData = Data(consumed.utf8)
            buffer.removeFirst(min(consumedData.count, buffer.count))
            let msg = lines[0...endIdx].joined(separator: "\n")
            return (code, msg)
        } else {
            let consumed = lines[0] + "\r\n"
            let consumedData = Data(consumed.utf8)
            // Prefer finding exact prefix in buffer
            if let range = buffer.range(of: consumedData) {
                buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            } else if buffer.count >= consumedData.count {
                buffer.removeFirst(consumedData.count)
            }
            return (code, lines[0])
        }
    }
}

private final class FTPDataConnection: @unchecked Sendable {
    private let host: String
    private let port: UInt16
    private var connection: NWConnection?
    private let queue = DispatchQueue(label: "ndm.ftp.data")

    init(host: String, port: UInt16) {
        self.host = host
        self.port = port
    }

    func connect() async throws {
        let conn = NWConnection(
            host: NWEndpoint.Host(host),
            port: NWEndpoint.Port(rawValue: port)!,
            using: .tcp
        )
        self.connection = conn
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let box = ResumeBox()
            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    box.resume(cont)
                case .failed(let err):
                    box.resume(cont, throwing: err)
                case .cancelled:
                    box.resume(cont, throwing: FTPError.disconnected)
                default:
                    break
                }
            }
            conn.start(queue: queue)
        }
    }

    func close() {
        connection?.cancel()
        connection = nil
    }

    /// Returns nil on EOF.
    func readChunk(maxLength: Int) async throws -> Data? {
        guard let connection else { return nil }
        return try await withCheckedThrowingContinuation { cont in
            func receiveOnce() {
                connection.receive(minimumIncompleteLength: 1, maximumLength: maxLength) { data, _, isComplete, error in
                    if let data, !data.isEmpty {
                        cont.resume(returning: data)
                        return
                    }
                    // Peer closed / no more stream data — treat as EOF.
                    if isComplete || error != nil {
                        cont.resume(returning: nil)
                        return
                    }
                    receiveOnce()
                }
            }
            receiveOnce()
        }
    }
}

/// One-shot resume helper safe across NWConnection callbacks.
private final class ResumeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    func resume(_ cont: CheckedContinuation<Void, Error>) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true
        cont.resume()
    }

    func resume(_ cont: CheckedContinuation<Void, Error>, throwing error: Error) {
        lock.lock(); defer { lock.unlock() }
        guard !done else { return }
        done = true
        cont.resume(throwing: error)
    }
}

public enum FTPError: Error, LocalizedError, Equatable {
    case loginFailed(Int)
    case badPASV(String)
    case retrFailed(Int)
    case disconnected
    case timeout
    case proxyConnectFailed(Int)

    public var errorDescription: String? {
        switch self {
        case .loginFailed(let c): return "FTP login failed (\(c))"
        case .badPASV(let m): return "Bad PASV reply: \(m)"
        case .retrFailed(let c): return "FTP RETR failed (\(c))"
        case .disconnected: return "FTP disconnected"
        case .timeout: return "FTP reply timeout"
        case .proxyConnectFailed(let c): return "FTP proxy CONNECT failed (\(c))"
        }
    }
}
