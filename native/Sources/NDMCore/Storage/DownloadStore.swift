import Foundation
import SQLite3

/// SQLite-backed store compatible with original NDM schema field names.
public final class DownloadStore: @unchecked Sendable {
    private var db: OpaquePointer?
    private let path: URL
    private let lock = NSLock()

    public init(directory: URL) throws {
        self.path = directory.appendingPathComponent("NeatDB.db")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try open()
        try migrate()
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    public static var defaultSupportDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        // App Support container for this host
        return base.appendingPathComponent("dev.ndm.open", isDirectory: true)
    }

    private func open() throws {
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(path.path, &db, flags, nil) != SQLITE_OK {
            throw StoreError.openFailed(path.path)
        }
    }

    private func migrate() throws {
        let sql = """
        CREATE TABLE IF NOT EXISTS downloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT,
            method TEXT,
            filename TEXT,
            ltype TEXT,
            filesize NUMERIC,
            category TEXT,
            status TEXT,
            bandwidthlimit NUMERIC,
            connections NUMERIC,
            lasttry NUMERIC,
            firsttry NUMERIC,
            completedat NUMERIC,
            useragent TEXT,
            resumable NUMERIC,
            pageurl TEXT,
            pagetitle TEXT,
            hittitle TEXT,
            mimetype TEXT,
            errortext TEXT,
            urla TEXT,
            postdata TEXT,
            folderpath TEXT,
            thumbnailurl TEXT,
            awaitingdestination INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS download_creation_receipts (
            creation_key TEXT PRIMARY KEY NOT NULL,
            payload_hash TEXT NOT NULL,
            task_id INTEGER,
            created_at NUMERIC NOT NULL
        );
        CREATE TABLE IF NOT EXISTS relay_handoff_receipts (
            request_id TEXT PRIMARY KEY NOT NULL,
            payload_hash TEXT NOT NULL,
            task_id INTEGER NOT NULL,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS auths (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            target TEXT,
            protocol TEXT,
            user TEXT,
            pass TEXT
        );
        CREATE TABLE IF NOT EXISTS headers (
            id NUMERIC,
            header TEXT
        );
        """
        try exec(sql)
        if !hasColumn("payload_hash", in: "relay_handoff_receipts") {
            try exec("ALTER TABLE relay_handoff_receipts ADD COLUMN payload_hash TEXT NOT NULL DEFAULT ''; ")
        }
        if !hasColumn("completedat", in: "downloads") {
            try exec("ALTER TABLE downloads ADD COLUMN completedat NUMERIC;")
        }
        if !hasColumn("deliverynote", in: "downloads") {
            try exec("ALTER TABLE downloads ADD COLUMN deliverynote TEXT;")
        }
        // Scheduled start. A `.waiting` row with a non-null `startat` is waiting on
        // a clock rather than on a free slot.
        if !hasColumn("startat", in: "downloads") {
            try exec("ALTER TABLE downloads ADD COLUMN startat NUMERIC;")
        }
        if !hasColumn("awaitingdestination", in: "downloads") {
            try exec("ALTER TABLE downloads ADD COLUMN awaitingdestination INTEGER DEFAULT 0;")
        }
        if !hasColumn("thumbnailurl", in: "downloads") {
            try exec("ALTER TABLE downloads ADD COLUMN thumbnailurl TEXT;")
        }
    }

    public func allDownloads() throws -> [DownloadTask] {
        lock.lock()
        defer { lock.unlock() }
        let sql = """
        SELECT
            id, url, method, filename, ltype, filesize, category, status,
            bandwidthlimit, connections, lasttry, firsttry, completedat,
            useragent, resumable, pageurl, pagetitle, hittitle, mimetype,
            errortext, urla, postdata, folderpath, deliverynote, startat, thumbnailurl, awaitingdestination
        FROM downloads
        ORDER BY
            MAX(
                COALESCE(lasttry, 0),
                COALESCE(completedat, 0),
                COALESCE(firsttry, 0)
            ) DESC,
            id DESC;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }

        var items: [DownloadTask] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            items.append(rowToTask(stmt))
        }
        let headersByTask = try allHeadersUnlocked()
        for i in items.indices {
            items[i].headers = headersByTask[items[i].id] ?? []
        }
        return items
    }

    public func insert(_ task: DownloadTask) throws -> DownloadTask {
        lock.lock()
        defer { lock.unlock() }
        return try insertUnlocked(task)
    }

    private func insertUnlocked(_ task: DownloadTask) throws -> DownloadTask {
        let sql = """
        INSERT INTO downloads (
            url, method, filename, ltype, filesize, category, status,
            bandwidthlimit, connections, lasttry, firsttry, completedat,
            useragent, resumable, pageurl, pagetitle, hittitle, mimetype,
            errortext, urla, postdata, folderpath, deliverynote, startat, thumbnailurl, awaitingdestination
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }

        bind(task, to: stmt, includingID: false)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.stepFailed }
        var saved = task
        saved.id = sqlite3_last_insert_rowid(db)
        try replaceHeadersUnlocked(id: saved.id, headers: saved.headers)
        return saved
    }

    public func update(_ task: DownloadTask) throws {
        lock.lock()
        defer { lock.unlock() }
        try updateUnlocked(task)
    }

    private func updateUnlocked(_ task: DownloadTask) throws {
        let sql = """
        UPDATE downloads SET
            url=?, method=?, filename=?, ltype=?, filesize=?, category=?, status=?,
            bandwidthlimit=?, connections=?, lasttry=?, firsttry=?, completedat=?,
            useragent=?, resumable=?, pageurl=?, pagetitle=?, hittitle=?, mimetype=?,
            errortext=?, urla=?, postdata=?, folderpath=?, deliverynote=?, startat=?, thumbnailurl=?, awaitingdestination=?
        WHERE id=?;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }
        bind(task, to: stmt, includingID: false)
        sqlite3_bind_int64(stmt, 27, task.id)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.stepFailed }
        try replaceHeadersUnlocked(id: task.id, headers: task.headers)
    }

    /// Receipts intentionally have no cascading foreign key: removing a task must
    /// not turn an acknowledged browser intent into a new download on replay.
    private struct RelayHandoffReceipt: Equatable, Sendable {
        public let taskID: Int64
        public let taskExists: Bool
    }

    public enum RelayHandoffCommit: Sendable {
        case committed(DownloadTask)
        case replayed(taskID: Int64)
        case deleted(taskID: Int64)
    }

    public func relayHandoffReceipt(requestID: String, payloadHash: String) throws -> RelayHandoffCommit? {
        try Self.validateRelayRequestID(requestID)
        try Self.validateRelayPayloadHash(payloadHash)
        lock.lock(); defer { lock.unlock() }
        guard let receipt = try relayReceiptUnlocked(requestID, payloadHash: payloadHash) else { return nil }
        return receipt.taskExists ? .replayed(taskID: receipt.taskID) : .deleted(taskID: receipt.taskID)
    }

    /// The caller prepares the new task or LinkRescue update. Only `.committed`
    /// authorizes a new start; replays never mutate the task or its credentials.
    public func commitRelayHandoff(requestID: String, payloadHash: String, task: DownloadTask,
                                   updatingExisting: Bool = false) throws -> RelayHandoffCommit {
        try Self.validateRelayRequestID(requestID)
        try Self.validateRelayPayloadHash(payloadHash)
        lock.lock(); defer { lock.unlock() }
        try exec("BEGIN IMMEDIATE;")
        do {
            if let receipt = try relayReceiptUnlocked(requestID, payloadHash: payloadHash) {
                try exec("COMMIT;")
                return receipt.taskExists ? .replayed(taskID: receipt.taskID) : .deleted(taskID: receipt.taskID)
            }
            let saved: DownloadTask
            if updatingExisting {
                guard try taskExistsUnlocked(task.id) else { throw StoreError.handoffTaskMissing }
                try updateUnlocked(task)
                saved = task
            } else {
                saved = try insertUnlocked(task)
            }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO relay_handoff_receipts(request_id,task_id,created_at,payload_hash) VALUES(?,?,?,?);", -1, &statement, nil) == SQLITE_OK else {
                throw StoreError.prepareFailed
            }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, requestID, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            sqlite3_bind_int64(statement, 2, saved.id)
            sqlite3_bind_double(statement, 3, Date().timeIntervalSince1970)
            sqlite3_bind_text(statement, 4, payloadHash, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            guard sqlite3_step(statement) == SQLITE_DONE else { throw StoreError.stepFailed }
            try exec("COMMIT;")
            return .committed(saved)
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    private static func validateRelayRequestID(_ value: String) throws {
        let bytes = value.utf8
        guard (16...128).contains(bytes.count), bytes.allSatisfy({
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }) else { throw StoreError.invalidRelayRequestID }
    }

    private static func validateRelayPayloadHash(_ value: String) throws {
        guard value.utf8.count == 64, value.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else { throw StoreError.invalidRelayPayloadHash }
    }

    private func taskExistsUnlocked(_ id: Int64) throws -> Bool {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT 1 FROM downloads WHERE id=?;", -1, &statement, nil) == SQLITE_OK else { throw StoreError.prepareFailed }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, id)
        switch sqlite3_step(statement) {
        case SQLITE_ROW: return true
        case SQLITE_DONE: return false
        default: throw StoreError.stepFailed
        }
    }

    private func relayReceiptUnlocked(_ requestID: String, payloadHash: String) throws -> RelayHandoffReceipt? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT task_id,payload_hash FROM relay_handoff_receipts WHERE request_id=?;", -1, &statement, nil) == SQLITE_OK else { throw StoreError.prepareFailed }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, requestID, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            guard let rawHash = sqlite3_column_text(statement, 1), String(cString: rawHash) == payloadHash else { throw StoreError.relayPayloadMismatch }
            let id = sqlite3_column_int64(statement, 0)
            return RelayHandoffReceipt(taskID: id, taskExists: try taskExistsUnlocked(id))
        case SQLITE_DONE: return nil
        default: throw StoreError.stepFailed
        }
    }

    /// Bind the key before asynchronous media preparation. A failed preparation
    /// can be retried, but cannot silently reuse the key for different content.
    public func reserveCreation(_ intent: DownloadCreationIntent) throws -> DownloadCreationReceipt? {
        lock.lock(); defer { lock.unlock() }
        try exec("BEGIN IMMEDIATE;")
        do {
            try reserveCreationUnlocked(intent)
            let receipt = try creationReceiptUnlocked(key: intent.key, payloadHash: intent.payloadHash)
            try exec("COMMIT;")
            return receipt
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    public func creationReceipt(key: String) throws -> DownloadCreationReceipt? {
        let key = try DownloadCreationIntent.normalizeKey(key)
        lock.lock(); defer { lock.unlock() }
        return try creationReceiptUnlocked(key: key)
    }

    /// The complete initial row (including headers and media options) and its
    /// receipt commit together. Receipts survive task removal deliberately.
    public func commitCreation(_ intent: DownloadCreationIntent, task: DownloadTask) throws -> DownloadCreationCommit {
        lock.lock(); defer { lock.unlock() }
        try exec("BEGIN IMMEDIATE;")
        do {
            try reserveCreationUnlocked(intent)
            if let receipt = try creationReceiptUnlocked(key: intent.key, payloadHash: intent.payloadHash) {
                try exec("COMMIT;")
                return .replayed(receipt)
            }
            let saved = try insertUnlocked(task)
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "UPDATE download_creation_receipts SET task_id=? WHERE creation_key=? AND task_id IS NULL;", -1, &statement, nil) == SQLITE_OK else { throw StoreError.prepareFailed }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_int64(statement, 1, saved.id)
            sqlite3_bind_text(statement, 2, intent.key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            guard sqlite3_step(statement) == SQLITE_DONE, sqlite3_changes(db) == 1 else { throw StoreError.stepFailed }
            try exec("COMMIT;")
            return .committed(saved)
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    private func reserveCreationUnlocked(_ intent: DownloadCreationIntent) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "INSERT OR IGNORE INTO download_creation_receipts(creation_key,payload_hash,created_at) VALUES(?,?,?);", -1, &statement, nil) == SQLITE_OK else { throw StoreError.prepareFailed }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, intent.key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        sqlite3_bind_text(statement, 2, intent.payloadHash, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        sqlite3_bind_double(statement, 3, Date().timeIntervalSince1970)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw StoreError.stepFailed }
        _ = try creationReceiptUnlocked(key: intent.key, payloadHash: intent.payloadHash)
    }

    private func creationReceiptUnlocked(key: String, payloadHash: String? = nil) throws -> DownloadCreationReceipt? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT task_id,payload_hash FROM download_creation_receipts WHERE creation_key=?;", -1, &statement, nil) == SQLITE_OK else { throw StoreError.prepareFailed }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_text(statement, 1, key, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
            if let payloadHash {
                guard let raw = sqlite3_column_text(statement, 1), String(cString: raw) == payloadHash else { throw DownloadCreationError.intentMismatch }
            }
            guard sqlite3_column_type(statement, 0) != SQLITE_NULL else { return nil }
            let id = sqlite3_column_int64(statement, 0)
            return DownloadCreationReceipt(taskID: id, taskExists: try taskExistsUnlocked(id))
        case SQLITE_DONE: return nil
        default: throw StoreError.stepFailed
        }
    }

    public func delete(id: Int64) throws {
        lock.lock()
        defer { lock.unlock() }
        try exec("DELETE FROM headers WHERE id=\(id);")
        try exec("DELETE FROM downloads WHERE id=\(id);")
    }

    /// Reconcile process-local runtime states after a relaunch.
    ///
    /// Download engines do not survive the app process, so a persisted
    /// `downloading` row can never still be running when a new process starts.
    /// Ordinary `waiting` rows are equally stale. The one intentional exception
    /// is a yt-dlp collection entry: those rows form a durable playlist queue
    /// and `DownloadManager.resumeQueuedCollectionIfIdle()` consumes them after
    /// the main window has been restored.
    @discardableResult
    public func recoverInterruptedTasks() throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        // A row waiting on a *clock* is not an interrupted download, and the whole
        // point of scheduling for 3am is that the app may well be restarted before
        // then. Without the `startat` exclusion this sweep silently cancels every
        // appointment on launch.
        let sql = """
        UPDATE downloads
        SET status='incomplete'
        WHERE lower(coalesce(status, ''))='downloading'
           OR (
                lower(coalesce(status, ''))='waiting'
                AND startat IS NULL
                AND NOT (
                    lower(coalesce(ltype, ''))='ytdlp'
                    AND length(trim(coalesce(pageurl, ''))) > 0
                )
           );
        """
        try exec(sql)
        return Int(sqlite3_changes(db))
    }

    // MARK: - Auths (original credentials table)

    public func allAuths() throws -> [AuthCredential] {
        lock.lock()
        defer { lock.unlock() }
        let sql = "SELECT id, target, protocol, user, pass FROM auths ORDER BY id;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }
        var items: [AuthCredential] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            func t(_ i: Int32) -> String {
                guard let c = sqlite3_column_text(stmt, i) else { return "" }
                return String(cString: c)
            }
            items.append(AuthCredential(
                id: sqlite3_column_int64(stmt, 0),
                target: t(1),
                protocolName: t(2),
                username: t(3),
                password: t(4)
            ))
        }
        return items
    }

    public func insertAuth(_ auth: AuthCredential) throws -> AuthCredential {
        lock.lock()
        defer { lock.unlock() }
        let sql = "INSERT INTO auths (target, protocol, user, pass) VALUES (?,?,?,?);"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }
        func bind(_ i: Int32, _ s: String) {
            sqlite3_bind_text(stmt, i, s, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
        }
        bind(1, auth.target)
        bind(2, auth.protocolName)
        bind(3, auth.username)
        bind(4, auth.password)
        guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.stepFailed }
        var saved = auth
        saved.id = sqlite3_last_insert_rowid(db)
        return saved
    }

    public func deleteAuth(id: Int64) throws {
        lock.lock()
        defer { lock.unlock() }
        try exec("DELETE FROM auths WHERE id=\(id);")
    }

    /// Match by host/target substring (original looks up by download host).
    public func auth(forHost host: String) throws -> AuthCredential? {
        let all = try allAuths()
        let h = host.lowercased()
        return all.first { cred in
            let t = cred.target.lowercased()
            return t == h || h.contains(t) || t.contains(h)
        }
    }

    // MARK: - Private

    private func allHeadersUnlocked() throws -> [Int64: [String]] {
        let sql = "SELECT id, header FROM headers ORDER BY id, rowid;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed
        }
        defer { sqlite3_finalize(stmt) }

        var headersByTask: [Int64: [String]] = [:]
        while sqlite3_step(stmt) == SQLITE_ROW {
            let id = sqlite3_column_int64(stmt, 0)
            if let c = sqlite3_column_text(stmt, 1) {
                headersByTask[id, default: []].append(String(cString: c))
            }
        }
        return headersByTask
    }

    private func replaceHeadersUnlocked(id: Int64, headers: [String]) throws {
        try exec("DELETE FROM headers WHERE id=\(id);")
        let sql = "INSERT INTO headers (id, header) VALUES (?, ?);"
        for header in headers {
            var stmt: OpaquePointer?
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreError.prepareFailed
            }
            defer { sqlite3_finalize(stmt) }
            sqlite3_bind_int64(stmt, 1, id)
            sqlite3_bind_text(stmt, 2, header, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            guard sqlite3_step(stmt) == SQLITE_DONE else { throw StoreError.stepFailed }
        }
    }

    private func bind(_ task: DownloadTask, to stmt: OpaquePointer?, includingID: Bool) {
        func text(_ i: Int32, _ s: String?) {
            if let s {
                sqlite3_bind_text(stmt, i, s, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
            } else {
                sqlite3_bind_null(stmt, i)
            }
        }
        text(1, task.url)
        text(2, task.method)
        text(3, task.filename)
        text(4, task.linkType)
        sqlite3_bind_int64(stmt, 5, task.fileSize)
        text(6, task.category.rawValue)
        text(7, task.status.rawValue)
        sqlite3_bind_int64(stmt, 8, task.bandwidthLimit)
        sqlite3_bind_int(stmt, 9, Int32(task.connections))
        if let d = task.lastTry { sqlite3_bind_double(stmt, 10, d.timeIntervalSince1970) } else { sqlite3_bind_null(stmt, 10) }
        if let d = task.firstTry { sqlite3_bind_double(stmt, 11, d.timeIntervalSince1970) } else { sqlite3_bind_null(stmt, 11) }
        if let d = task.completedAt { sqlite3_bind_double(stmt, 12, d.timeIntervalSince1970) } else { sqlite3_bind_null(stmt, 12) }
        text(13, task.userAgent)
        sqlite3_bind_int(stmt, 14, task.resumable ? 1 : 0)
        text(15, task.pageURL)
        text(16, task.pageTitle)
        text(17, task.hitTitle)
        text(18, task.mimeType)
        text(19, task.errorText)
        text(20, task.alternateURL)
        if let data = task.postData, let s = String(data: data, encoding: .utf8) {
            text(21, s)
        } else {
            sqlite3_bind_null(stmt, 21)
        }
        text(22, task.folderPath)
        text(23, task.deliveryNote)
        if let d = task.startAt { sqlite3_bind_double(stmt, 24, d.timeIntervalSince1970) } else { sqlite3_bind_null(stmt, 24) }
        text(25, task.thumbnailURL)
        if let awaiting = task.awaitingDestination { sqlite3_bind_int(stmt, 26, awaiting ? 1 : 0) } else { sqlite3_bind_null(stmt, 26) }
        _ = includingID
    }

    private func rowToTask(_ stmt: OpaquePointer?) -> DownloadTask {
        func colText(_ i: Int32) -> String? {
            guard let c = sqlite3_column_text(stmt, i) else { return nil }
            return String(cString: c)
        }
        func colDate(_ i: Int32) -> Date? {
            if sqlite3_column_type(stmt, i) == SQLITE_NULL { return nil }
            return Date(timeIntervalSince1970: sqlite3_column_double(stmt, i))
        }
        let category = DownloadCategory(rawValue: colText(6) ?? "misc") ?? .misc
        let status = DownloadStatus(rawValue: colText(7) ?? "incomplete") ?? .incomplete
        let post: Data? = colText(21).flatMap { $0.data(using: .utf8) }
        return DownloadTask(
            id: sqlite3_column_int64(stmt, 0),
            url: colText(1) ?? "",
            method: colText(2) ?? "GET",
            filename: colText(3) ?? "",
            linkType: colText(4) ?? "normal",
            fileSize: sqlite3_column_int64(stmt, 5),
            category: category,
            status: status,
            bandwidthLimit: sqlite3_column_int64(stmt, 8),
            connections: Int(sqlite3_column_int(stmt, 9)),
            lastTry: colDate(10),
            firstTry: colDate(11),
            completedAt: colDate(12),
            startAt: colDate(24),
            userAgent: colText(13),
            resumable: sqlite3_column_int(stmt, 14) != 0,
            pageURL: colText(15),
            pageTitle: colText(16),
            thumbnailURL: colText(25),
            hitTitle: colText(17),
            mimeType: colText(18),
            errorText: colText(19),
            alternateURL: colText(20),
            postData: post,
            folderPath: colText(22),
            headers: [],
            deliveryNote: colText(23),
            awaitingDestination: sqlite3_column_type(stmt, 26) == SQLITE_NULL ? nil : sqlite3_column_int(stmt, 26) == 1
        )
    }

    private func hasColumn(_ column: String, in table: String) -> Bool {
        let sql = "PRAGMA table_info(\(table));"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            return false
        }
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let raw = sqlite3_column_text(stmt, 1) else { continue }
            if String(cString: raw).caseInsensitiveCompare(column) == .orderedSame {
                return true
            }
        }
        return false
    }

    private func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        if sqlite3_exec(db, sql, nil, nil, &err) != SQLITE_OK {
            let message = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw StoreError.execFailed(message)
        }
    }
}

public enum StoreError: Error, CustomStringConvertible {
    case openFailed(String)
    case prepareFailed
    case stepFailed
    case invalidRelayPayloadHash
    case relayPayloadMismatch
    case invalidRelayRequestID
    case handoffTaskMissing
    case execFailed(String)

    public var description: String {
        switch self {
        case .openFailed(let p): return "Failed to open DB at \(p)"
        case .prepareFailed: return "Failed to prepare statement"
        case .stepFailed: return "Failed to step statement"
        case .invalidRelayPayloadHash: return "Invalid Relay payload hash"
        case .relayPayloadMismatch: return "Relay request identifier was reused for different content"
        case .invalidRelayRequestID: return "Invalid Relay request identifier"
        case .handoffTaskMissing: return "Relay target task no longer exists"
        case .execFailed(let m): return "SQL error: \(m)"
        }
    }
}
