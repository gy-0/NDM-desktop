import Foundation
import Network

/// Minimal FTP server (PASV) for integration tests.
final class LocalFTPServer: @unchecked Sendable {
    private let files: [String: Data]
    private let username: String
    private let password: String
    private var controlListener: NWListener?
    private var dataListener: NWListener?
    private var pendingDataConnection: NWConnection?
    private let queue = DispatchQueue(label: "ndm.test.ftpserver")
    private let lock = NSLock()
    private(set) var port: UInt16 = 0

    init(files: [String: Data], username: String = "user", password: String = "pass") {
        var normalized: [String: Data] = [:]
        for (k, v) in files {
            let key = k.hasPrefix("/") ? k : "/" + k
            normalized[key] = v
        }
        self.files = normalized
        self.username = username
        self.password = password
    }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.controlListener = listener
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
            self?.handleControl(conn)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        guard port != 0 else { throw NSError(domain: "LocalFTPServer", code: 1) }
    }

    func stop() {
        controlListener?.cancel()
        dataListener?.cancel()
        pendingDataConnection?.cancel()
        controlListener = nil
        dataListener = nil
        pendingDataConnection = nil
    }

    func url(path: String) -> URL {
        let p = path.hasPrefix("/") ? path : "/" + path
        return URL(string: "ftp://127.0.0.1:\(port)\(p)")!
    }

    private func handleControl(_ connection: NWConnection) {
        connection.start(queue: queue)
        send(connection, "220 NDM Local FTP ready\r\n")

        var buffer = Data()
        var loggedIn = false
        var pendingUser: String?
        var restOffset: Int64 = 0

        func loop() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, _ in
                guard let self else { return }
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
                if !isComplete { loop() }
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
            let pass = String(line.dropFirst(5))
            if pendingUser == username, pass == password {
                loggedIn = true
                send(connection, "230 Login successful\r\n")
            } else {
                send(connection, "530 Login incorrect\r\n")
            }
        } else if upper.hasPrefix("TYPE ") {
            send(connection, "200 Type set to I\r\n")
        } else if upper.hasPrefix("SIZE ") {
            let path = normalizePath(String(line.dropFirst(5)))
            if let data = files[path] {
                send(connection, "213 \(data.count)\r\n")
            } else {
                send(connection, "550 File not found\r\n")
            }
        } else if upper.hasPrefix("REST ") {
            restOffset = Int64(String(line.dropFirst(5))) ?? 0
            send(connection, "350 Restarting at \(restOffset)\r\n")
        } else if upper.hasPrefix("PASV") {
            do {
                try beginPASV()
                guard let dataPort = dataListener?.port?.rawValue else {
                    send(connection, "425 Can't open data connection\r\n")
                    return
                }
                let p1 = Int(dataPort) / 256
                let p2 = Int(dataPort) % 256
                send(connection, "227 Entering Passive Mode (127,0,0,1,\(p1),\(p2))\r\n")
            } catch {
                send(connection, "425 Can't open data connection\r\n")
            }
        } else if upper.hasPrefix("RETR ") {
            let path = normalizePath(String(line.dropFirst(5)))
            guard loggedIn, let payload = files[path] else {
                send(connection, "550 File not found\r\n")
                return
            }
            let offset = max(0, min(restOffset, Int64(payload.count)))
            restOffset = 0
            let slice = payload.subdata(in: Int(offset)..<payload.count)
            send(connection, "150 Opening BINARY mode data connection\r\n")
            deliverData(slice) { [weak self] ok in
                guard let self else { return }
                self.send(connection, ok ? "226 Transfer complete\r\n" : "426 Transfer aborted\r\n")
            }
        } else if upper == "QUIT" {
            send(connection, "221 Goodbye\r\n")
            connection.cancel()
        } else {
            send(connection, "502 Command not implemented\r\n")
        }
    }

    private func beginPASV() throws {
        dataListener?.cancel()
        pendingDataConnection?.cancel()
        pendingDataConnection = nil

        let listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.stateUpdateHandler = { state in
                guard case .ready = state else { return }
                self.lock.lock()
                if self.pendingDataConnection == nil {
                    self.pendingDataConnection = conn
                } else {
                    conn.cancel()
                }
                self.lock.unlock()
            }
            conn.start(queue: self.queue)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 2)
        guard listener.port != nil else { throw NSError(domain: "LocalFTPServer", code: 2) }
        dataListener = listener
    }

    private func deliverData(_ payload: Data, completion: @escaping (Bool) -> Void) {
        // Wait briefly for client data connection after PASV/RETR.
        queue.async {
            let deadline = Date().addingTimeInterval(3)
            while Date() < deadline {
                self.lock.lock()
                let conn = self.pendingDataConnection
                self.lock.unlock()
                if let conn {
                    conn.send(content: payload, completion: .contentProcessed { err in
                        conn.cancel()
                        self.dataListener?.cancel()
                        self.dataListener = nil
                        self.lock.lock()
                        self.pendingDataConnection = nil
                        self.lock.unlock()
                        completion(err == nil)
                    })
                    return
                }
                Thread.sleep(forTimeInterval: 0.01)
            }
            completion(false)
        }
    }

    private func normalizePath(_ raw: String) -> String {
        var p = raw.trimmingCharacters(in: .whitespaces)
        if !p.hasPrefix("/") { p = "/" + p }
        return p
    }

    private func send(_ connection: NWConnection, _ text: String) {
        connection.send(content: Data(text.utf8), completion: .contentProcessed { _ in })
    }
}
