import Foundation
import Network

/// Real loopback FTP server with deterministic failure injection. All connection
/// state belongs to `queue`; no callback blocks the queue waiting for another one.
final class LocalFTPServer: @unchecked Sendable {
    struct Behavior {
        enum SizeReply {
            case actual
            case unavailable
            case advertised(Int)
            case raw(String)
        }

        enum FinalReply {
            case reply(Int)
            case disconnect
            case omit
        }

        var sizeReply: SizeReply = .actual
        var maximumTransferBytes: Int?
        var finalReply: FinalReply = .reply(226)
        var finalReplyDelay: TimeInterval = 0
        var acceptsREST = true
        var onDataTransferFinished: (@Sendable () -> Void)?
    }

    private let files: [String: Data]
    private let username: String
    private let password: String
    private let behavior: Behavior
    private var controlListener: NWListener?
    private var dataListener: NWListener?
    private var pendingDataConnection: NWConnection?
    private var controlConnections: [NWConnection] = []
    private var dataConnections: [NWConnection] = []
    private var listeners: [NWListener] = []
    private var restOffsets: [Int64] = []
    private let queue = DispatchQueue(label: "ndm.test.ftpserver")
    private var stopped = false
    private(set) var port: UInt16 = 0

    init(
        files: [String: Data],
        username: String = "user",
        password: String = "pass",
        behavior: Behavior = Behavior()
    ) {
        var normalized: [String: Data] = [:]
        for (key, value) in files {
            normalized[key.hasPrefix("/") ? key : "/" + key] = value
        }
        self.files = normalized
        self.username = username
        self.password = password
        self.behavior = behavior
    }

    var receivedRESTOffsets: [Int64] { queue.sync { restOffsets } }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        queue.sync {
            controlListener = listener
            listeners.append(listener)
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.port = listener.port?.rawValue ?? 0
                    ready.signal()
                case .failed, .cancelled:
                    ready.signal()
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self, !self.stopped else { connection.cancel(); return }
                self.handleControl(connection)
            }
            listener.start(queue: queue)
        }
        guard ready.wait(timeout: .now() + 3) == .success, port != 0 else {
            stop()
            throw NSError(domain: "LocalFTPServer", code: 1)
        }
    }

    @discardableResult
    func stop() -> Bool {
        let cancelled = DispatchGroup()
        let resources = queue.sync {
            stopped = true
            let connections = controlConnections + dataConnections
            let allListeners = listeners
            for connection in connections {
                if case .cancelled = connection.state { continue }
                cancelled.enter()
                connection.stateUpdateHandler = { [weak connection] state in
                    guard case .cancelled = state else { return }
                    connection?.stateUpdateHandler = nil
                    cancelled.leave()
                }
                connection.cancel()
            }
            for listener in allListeners {
                if case .cancelled = listener.state { continue }
                cancelled.enter()
                listener.stateUpdateHandler = { [weak listener] state in
                    guard case .cancelled = state else { return }
                    listener?.stateUpdateHandler = nil
                    cancelled.leave()
                }
                listener.cancel()
            }
            controlListener = nil
            dataListener = nil
            pendingDataConnection = nil
            controlConnections.removeAll()
            dataConnections.removeAll()
            listeners.removeAll()
            return (connections, allListeners)
        }
        // Wait outside the serial callback queue and retain each NW object until
        // its cancelled callback has run, so teardown cannot strand a callback.
        return withExtendedLifetime(resources) {
            cancelled.wait(timeout: .now() + 3) == .success
        }
    }

    func url(path: String) -> URL {
        let path = path.hasPrefix("/") ? path : "/" + path
        return URL(string: "ftp://127.0.0.1:\(port)\(path)")!
    }

    private func handleControl(_ connection: NWConnection) {
        controlConnections.append(connection)
        connection.start(queue: queue)
        send(connection, "220 NDM Local FTP ready\r\n")

        var buffer = Data()
        var loggedIn = false
        var pendingUser: String?
        var restOffset: Int64 = 0

        func loop() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
                guard let self, !self.stopped else { return }
                if let data { buffer.append(data) }
                while let range = buffer.range(of: Data("\r\n".utf8)) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                    buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                    let line = String(data: lineData, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    self.handleCommand(
                        line,
                        connection: connection,
                        loggedIn: &loggedIn,
                        pendingUser: &pendingUser,
                        restOffset: &restOffset
                    )
                }
                if !isComplete, error == nil { loop() }
            }
        }
        loop()
    }

    private func handleCommand(
        _ line: String,
        connection: NWConnection,
        loggedIn: inout Bool,
        pendingUser: inout String?,
        restOffset: inout Int64
    ) {
        let upper = line.uppercased()
        if upper.hasPrefix("USER ") {
            pendingUser = String(line.dropFirst(5))
            send(connection, "331 Password required\r\n")
        } else if upper.hasPrefix("PASS ") {
            if pendingUser == username, String(line.dropFirst(5)) == password {
                loggedIn = true
                send(connection, "230 Login successful\r\n")
            } else {
                send(connection, "530 Login incorrect\r\n")
            }
        } else if upper.hasPrefix("TYPE ") {
            send(connection, "200 Type set to I\r\n")
        } else if upper.hasPrefix("SIZE ") {
            let path = normalizePath(String(line.dropFirst(5)))
            guard let data = files[path] else {
                send(connection, "550 File not found\r\n")
                return
            }
            switch behavior.sizeReply {
            case .actual: send(connection, "213 \(data.count)\r\n")
            case .unavailable: send(connection, "502 SIZE not implemented\r\n")
            case .advertised(let size): send(connection, "213 \(size)\r\n")
            case .raw(let reply): send(connection, reply + "\r\n")
            }
        } else if upper.hasPrefix("REST ") {
            let requestedOffset = Int64(String(line.dropFirst(5))) ?? 0
            restOffsets.append(requestedOffset)
            if behavior.acceptsREST {
                restOffset = requestedOffset
                send(connection, "350 Restarting at \(restOffset)\r\n")
            } else {
                restOffset = 0
                send(connection, "502 REST not implemented\r\n")
            }
        } else if upper == "PASV" {
            beginPASV(control: connection)
        } else if upper.hasPrefix("RETR ") {
            let path = normalizePath(String(line.dropFirst(5)))
            guard loggedIn, let payload = files[path] else {
                send(connection, "550 File not found\r\n")
                return
            }
            let offset = max(0, min(restOffset, Int64(payload.count)))
            restOffset = 0
            var slice = payload.subdata(in: Int(offset)..<payload.count)
            if let limit = behavior.maximumTransferBytes {
                slice = Data(slice.prefix(max(0, limit)))
            }
            send(connection, "150 Opening BINARY mode data connection\r\n")
            deliverData(slice, deadline: Date().addingTimeInterval(3)) { [weak self] ok in
                guard let self, !self.stopped else { return }
                self.behavior.onDataTransferFinished?()
                self.queue.asyncAfter(deadline: .now() + self.behavior.finalReplyDelay) { [weak self] in
                    guard let self, !self.stopped else { return }
                    guard ok else {
                        self.send(connection, "426 Transfer aborted\r\n")
                        return
                    }
                    switch self.behavior.finalReply {
                    case .reply(let code): self.send(connection, "\(code) Transfer result\r\n")
                    case .disconnect:
                        connection.send(content: nil, contentContext: .finalMessage, isComplete: true,
                                        completion: .contentProcessed { _ in })
                    case .omit: break
                    }
                }
            }
        } else if upper == "QUIT" {
            send(connection, "221 Goodbye\r\n")
        } else {
            send(connection, "502 Command not implemented\r\n")
        }
    }

    private func beginPASV(control: NWConnection) {
        dataListener?.cancel()
        pendingDataConnection?.cancel()
        pendingDataConnection = nil
        do {
            let listener = try NWListener(using: .tcp, on: .any)
            dataListener = listener
            listeners.append(listener)
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self, let listener, !self.stopped else { return }
                switch state {
                case .ready:
                    guard let port = listener.port?.rawValue else { return }
                    self.send(control, "227 Entering Passive Mode (127,0,0,1,\(port / 256),\(port % 256))\r\n")
                case .failed:
                    self.send(control, "425 Can't open data connection\r\n")
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self, !self.stopped else { connection.cancel(); return }
                self.dataConnections.append(connection)
                connection.stateUpdateHandler = { [weak self, weak connection] state in
                    guard let self, let connection, case .ready = state else { return }
                    if !self.stopped, self.pendingDataConnection == nil {
                        self.pendingDataConnection = connection
                    } else {
                        connection.cancel()
                    }
                }
                connection.start(queue: self.queue)
            }
            listener.start(queue: queue)
        } catch {
            send(control, "425 Can't open data connection\r\n")
        }
    }

    private func deliverData(_ payload: Data, deadline: Date, completion: @escaping (Bool) -> Void) {
        guard !stopped else { return }
        guard let connection = pendingDataConnection else {
            guard Date() < deadline else { completion(false); return }
            queue.asyncAfter(deadline: .now() + 0.01) { [weak self] in
                self?.deliverData(payload, deadline: deadline, completion: completion)
            }
            return
        }
        // Mark the final stream message explicitly, including for a zero-byte file.
        connection.send(content: payload, contentContext: .finalMessage, isComplete: true,
                        completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            self.dataListener?.cancel()
            self.dataListener = nil
            completion(error == nil)
        })
    }

    private func normalizePath(_ raw: String) -> String {
        let path = raw.trimmingCharacters(in: .whitespaces)
        return path.hasPrefix("/") ? path : "/" + path
    }

    private func send(_ connection: NWConnection, _ text: String) {
        connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }
}
