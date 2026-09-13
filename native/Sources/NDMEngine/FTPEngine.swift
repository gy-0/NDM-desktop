import Foundation
import Darwin
import Network
import NDMCore

/// Single-connection FTP download (PASV + RETR), aligned with original `NeatSocketFtp` command sequence.
public actor FTPEngine {
    public private(set) var progress: DownloadProgress

    private let request: DownloadRequest
    private let taskID: Int64
    private let workDirectory: URL
    private let ftpProxy: ProxySettings?
    private let socksProxy: SocksProxySettings?
    private let limiter: BandwidthLimiter
    private let throttleQueue = DispatchQueue(label: "ndm.ftp.throttle")
    private let token = CancelToken()
    private var logHandle: FileHandle?
    private var activeControl: FTPControlConnection?
    private var activeData: FTPDataConnection?

    public init(
        taskID: Int64,
        request: DownloadRequest,
        workDirectory: URL,
        ftpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        globalBandwidthLimit: Int64 = 0
    ) {
        self.taskID = taskID
        self.request = request
        self.workDirectory = workDirectory
        self.ftpProxy = ftpProxy
        self.socksProxy = socksProxy
        let limit = max(0, request.bandwidthLimitBytesPerSecond > 0 ? request.bandwidthLimitBytesPerSecond : globalBandwidthLimit)
        self.limiter = BandwidthLimiter(bytesPerSecond: limit)
        self.progress = DownloadProgress(taskID: taskID, status: .waiting, currentConnections: 1, effectiveBandwidthLimitBytesPerSecond: limit)
    }

    public func pause() {
        token.pause()
        activeControl?.close()
        activeData?.close()
        progress.status = .paused
        progress.bytesPerSecond = 0
        log("FTP engine paused")
    }

    public func cancel() {
        token.cancel()
        activeControl?.close()
        activeData?.close()
        progress.status = .incomplete
        progress.bytesPerSecond = 0
        log("FTP Download Canceled By User.")
    }

    public func currentProgress() -> DownloadProgress { progress }

    public func applyBandwidthLimit(_ bytesPerSecond: Int64) {
        let limit = max(0, bytesPerSecond)
        progress.effectiveBandwidthLimitBytesPerSecond = limit
        limiter.updateLimit(limit)
    }

    @discardableResult
    public func start() async throws -> URL {
        do {
            return try await withTaskCancellationHandler {
                try await download()
            } onCancel: { [token] in token.cancel() }
        } catch {
            // Closing a socket wakes its pending read with a network error. Preserve
            // the user's stop intent instead of reporting that as a failed transfer.
            try checkCancel()
            progress.status = .error
            progress.bytesPerSecond = 0
            throw error
        }
    }

    private func download() async throws -> URL {
        guard !Task.isCancelled else { throw EngineError.cancelled }
        // Resume uses a new engine; startup must retain an earlier stop intent.
        if token.isPaused { throw EngineError.paused }
        if token.isCancelled { throw EngineError.cancelled }
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        try MergeStagingReceipt.recover(taskID: taskID, in: workDirectory)
        openLog()
        defer { closeLog() }
        progress.status = .downloading
        log("DownloadID = \(taskID) , Protocol = FTP , OS = MAC")
        log("Trying to Start FTP Download for -> \(request.url.absoluteString)")

        guard let host = request.url.host, !host.isEmpty else {
            throw EngineError.invalidResponse
        }
        let port = request.url.port ?? 21
        guard (1...65535).contains(port) else { throw EngineError.invalidResponse }
        let remotePath = ftpRemotePath(from: request.url)
        let user = request.username ?? request.url.user ?? "anonymous"
        let pass = request.password ?? request.url.password ?? "ndm@localhost"

        let control = FTPControlConnection(host: host, port: UInt16(port), httpProxy: ftpProxy, socksProxy: socksProxy)
        activeControl = control
        let controlCancellation = token.registerCancellationHandler { control.close() }
        defer {
            token.removeCancellationHandler(controlCancellation)
            control.close()
            if activeControl === control { activeControl = nil }
        }
        try await control.connect()
        try checkCancel()

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

        var expectedSize: Int64?
        log("Sending FTP Command : SIZE \(remotePath)")
        try await control.sendCommand("SIZE \(remotePath)")
        let sizeReply = try await control.readReply()
        // readReply retains the reply code in its message (for example, "213 42").
        // Keep an absent SIZE distinct from a server-confirmed empty file.
        if sizeReply.code == 213,
           sizeReply.message.hasPrefix("213 "),
           let n = Int64(sizeReply.message.dropFirst(4).trimmingCharacters(in: .whitespacesAndNewlines)), n >= 0 {
            expectedSize = n
            progress.totalBytes = n
            log("FTP SIZE = \(n)")
        }

        let totalSize = expectedSize ?? 0
        let partialURL = workDirectory.appendingPathComponent("ftp.partial")
        var resumeOffset: Int64 = 0
        if FileManager.default.fileExists(atPath: partialURL.path),
           let attrs = try? FileManager.default.attributesOfItem(atPath: partialURL.path),
           let existing = (attrs[.size] as? NSNumber)?.int64Value,
           existing > 0 {
            if let expectedSize, existing > expectedSize {
                throw EngineError.incompleteResponse(expected: expectedSize, received: existing)
            }
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
                // Retain the old partial until RETR is accepted and a replacement
                // transfer can actually begin.
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

        let dataConn = FTPDataConnection(host: endpoint.host, port: endpoint.port, httpProxy: ftpProxy, socksProxy: socksProxy)
        activeData = dataConn
        let dataCancellation = token.registerCancellationHandler { dataConn.close() }
        defer {
            token.removeCancellationHandler(dataCancellation)
            dataConn.close()
            if activeData === dataConn { activeData = nil }
        }
        try await dataConn.connect()
        try checkCancel()

        log("Sending FTP Command : RETR \(remotePath)")
        try await control.sendCommand("RETR \(remotePath)")
        let retr = try await control.readReply()
        try checkCancel()
        guard [125, 150, 226, 250].contains(retr.code) else {
            throw FTPError.retrFailed(retr.code)
        }

        progress.segmentStates = [
            SegmentState(id: 0, start: 0, end: max(0, totalSize - 1), completed: resumeOffset, isFinished: false)
        ]

        if !FileManager.default.fileExists(atPath: partialURL.path) {
            FileManager.default.createFile(atPath: partialURL.path, contents: nil)
        }
        let fileHandle = try FileHandle(forWritingTo: partialURL)
        defer { try? fileHandle.close() }
        if resumeOffset > 0 {
            try fileHandle.seek(toOffset: UInt64(resumeOffset))
        } else {
            try fileHandle.truncate(atOffset: 0)
        }

        var completed = resumeOffset
        let started = Date()
        while true {
            try checkCancel()
            guard let chunk = try await dataConn.readChunk(maxLength: 64 * 1024) else { break }
            if chunk.isEmpty { break }
            try await consumeBandwidth(chunk.count)
            try checkCancel()
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

        // Data EOF alone does not mean RETR succeeded. Require its positive
        // completion reply before exposing the partial as a finished download.
        let final = retr.code < 200 ? try await control.readReply(timeout: 5) : retr
        try checkCancel()
        log("FTP final reply \(final.code) \(final.message)")
        guard final.code == 226 || final.code == 250 else {
            throw FTPError.retrFailed(final.code)
        }
        if let expectedSize, completed != expectedSize {
            throw EngineError.incompleteResponse(expected: expectedSize, received: completed)
        }
        try fileHandle.synchronize()
        try fileHandle.close()
        try checkCancel()

        try FileManager.default.createDirectory(
            at: request.destinationDirectory,
            withIntermediateDirectories: true
        )
        let filename = request.suggestedFilename?.isEmpty == false
            ? request.suggestedFilename!
            : (request.url.lastPathComponent.isEmpty ? "ftp.bin" : request.url.lastPathComponent)
        let safeFilename = DownloadFilename.sanitize(filename)
        let proposedURL = request.destinationDirectory.appendingPathComponent(safeFilename.isEmpty ? "ftp.bin" : safeFilename)
        let canReplace = request.replacingDestination?.standardizedFileURL == proposedURL.standardizedFileURL
        let finalURL = canReplace ? proposedURL : DownloadFilename.uniqueURL(proposedURL)
        try publish(partialURL, to: finalURL, replacingExisting: canReplace, completed: completed)

        progress.totalBytes = expectedSize ?? completed
        progress.completedBytes = completed
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
        progress.bytesPerSecond = 0
        log("DownloadEngine State Changed : Downloading... -> Completed")
        return finalURL
    }

    // MARK: - Helpers

    /// Match HTTP publication: preserve the old destination until the verified
    /// replacement is ready, and never overwrite without the exact task receipt.
    private func publish(_ partial: URL, to destination: URL, replacingExisting: Bool, completed: Int64) throws {
        let flags: UInt32 = replacingExisting ? 0 : UInt32(RENAME_EXCL)
        if renamex_np(partial.path, destination.path, flags) == 0 { return }
        let renameError = errno
        guard renameError == EXDEV else {
            throw POSIXError(POSIXErrorCode(rawValue: renameError) ?? .EIO)
        }

        // Cross-volume downloads need a candidate on the destination volume for
        // atomic publication. Reuse the existing ownership receipt for recovery.
        let staging = destination.deletingLastPathComponent()
            .appendingPathComponent(".ndm-merge-\(taskID)-\(UUID()).partial")
        let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL, 0o666)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? output.close() }
        let receipt = try MergeStagingReceipt.register(taskID: taskID, staging: staging,
                                                      descriptor: descriptor, in: workDirectory)
        defer { try? receipt.finish(in: workDirectory) }
        let input = try FileHandle(forReadingFrom: partial)
        defer { try? input.close() }
        var copied: Int64 = 0
        while let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty {
            try checkCancel()
            try output.write(contentsOf: chunk)
            copied += Int64(chunk.count)
        }
        guard copied == completed else {
            throw EngineError.incompleteResponse(expected: completed, received: copied)
        }
        try output.synchronize()
        try output.close()
        try checkCancel()
        guard renamex_np(staging.path, destination.path, flags) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        // Publication has succeeded; a cleanup error cannot turn it into a
        // reported transfer failure. The private task directory remains owned.
        try? FileManager.default.removeItem(at: partial)
    }

    private func consumeBandwidth(_ count: Int) async throws {
        // BandwidthLimiter waits synchronously. Keep it off the actor so runtime
        // cap updates and pause/cancel can wake the pending quota within 50 ms.
        let admitted = await withCheckedContinuation { continuation in
            throttleQueue.async { [limiter, token] in
                continuation.resume(returning: limiter.consume(count, isCancelled: { token.isCancelled }))
            }
        }
        if !admitted { try checkCancel(); throw EngineError.cancelled }
    }

    private func checkCancel() throws {
        if token.isCancelled {
            if token.isPaused { throw EngineError.paused }
            throw EngineError.cancelled
        }
        if Task.isCancelled { throw EngineError.cancelled }
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
        guard parts.count == 6,
              let h1 = Int(parts[0]), let h2 = Int(parts[1]),
              let h3 = Int(parts[2]), let h4 = Int(parts[3]),
              let p1 = Int(parts[4]), let p2 = Int(parts[5]) else { return nil }
        guard [h1, h2, h3, h4, p1, p2].allSatisfy({ (0...255).contains($0) }), p1 != 0 || p2 != 0 else { return nil }
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
    private let transport: FTPDataConnection
    private var buffer = Data()
    private let lock = NSLock()

    init(host: String, port: UInt16, httpProxy: ProxySettings?, socksProxy: SocksProxySettings?) {
        transport = FTPDataConnection(host: host, port: port, httpProxy: httpProxy, socksProxy: socksProxy)
    }
    func connect() async throws { try await transport.connect() }
    func close() { transport.close() }
    func sendCommand(_ line: String) async throws {
        guard !line.contains("\r"), !line.contains("\n") else { throw EngineError.invalidResponse }
        try await transport.sendRaw(Data((line + "\r\n").utf8))
    }
    func readReply(timeout: TimeInterval = 30) async throws -> (code: Int, message: String) {
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        while ProcessInfo.processInfo.systemUptime < deadline {
            if let reply = popCompleteReply() { return reply }
            guard let bytes = try await transport.readChunk(maxLength: 64 * 1024,
                timeout: max(0.001, deadline - ProcessInfo.processInfo.systemUptime)) else { throw FTPError.disconnected }
            lock.withLock { buffer.append(bytes) }
            guard buffer.count <= 1024 * 1024 else { throw EngineError.invalidResponse }
        }
        throw FTPError.timeout
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

public enum FTPError: Error, LocalizedError, Equatable {
    case loginFailed(Int)
    case badPASV(String)
    case retrFailed(Int)
    case disconnected
    case timeout
    case proxyConnectFailed(Int)
    case socksConnectFailed(Int)
    case unsupportedProxy(String)

    public var errorDescription: String? {
        switch self {
        case .loginFailed(let c): return "FTP login failed (\(c))"
        case .badPASV(let m): return "Bad PASV reply: \(m)"
        case .retrFailed(let c): return "FTP RETR failed (\(c))"
        case .disconnected: return "FTP disconnected"
        case .timeout: return "FTP reply timeout"
        case .proxyConnectFailed(let c): return "FTP proxy CONNECT failed (\(c))"
        case .socksConnectFailed(let c): return "FTP SOCKS CONNECT failed (\(c))"
        case .unsupportedProxy(let reason): return reason
        }
    }
}
