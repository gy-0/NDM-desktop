import Foundation
import SQLite3

/// Full-text index over what a download actually says.
///
/// Deliberately its own database file, separate from `NeatDB.db`. This is derived
/// data: the transcripts on disk and the task table are the truth, so a damaged or
/// outdated index should be deleted and rebuilt without a moment's hesitation. That
/// is only a safe reflex if wiping it cannot take the one authoritative store with
/// it.
public final class SearchIndexStore: @unchecked Sendable {
    /// Bumping this discards every index and rebuilds. There is no migration path on
    /// purpose — migration code is a liability, and everything here can be
    /// regenerated from files that already exist.
    public static let schemaVersion = 1

    /// Where a hit came from, so results can say why they matched.
    public enum Source: String, Codable, Sendable, Equatable, CaseIterable {
        /// A timed line of spoken content — the only source that can jump to a second.
        case transcript
        case filename
        case title
        case site
    }

    public struct Entry: Equatable, Sendable {
        public var taskID: Int64
        public var source: Source
        /// Original text, stored verbatim so highlighting works on what the user reads
        /// rather than on tokenized fragments.
        public var text: String
        public var startSeconds: Double?
        public var endSeconds: Double?

        public init(
            taskID: Int64,
            source: Source,
            text: String,
            startSeconds: Double? = nil,
            endSeconds: Double? = nil
        ) {
            self.taskID = taskID
            self.source = source
            self.text = text
            self.startSeconds = startSeconds
            self.endSeconds = endSeconds
        }
    }

    public struct Hit: Equatable, Sendable {
        public var taskID: Int64
        public var source: Source
        public var text: String
        public var startSeconds: Double?
        public var endSeconds: Double?

        public init(
            taskID: Int64,
            source: Source,
            text: String,
            startSeconds: Double?,
            endSeconds: Double?
        ) {
            self.taskID = taskID
            self.source = source
            self.text = text
            self.startSeconds = startSeconds
            self.endSeconds = endSeconds
        }
    }

    public enum StoreError: LocalizedError, Equatable {
        case openFailed(String)
        case prepareFailed(String)
        case stepFailed(String)

        public var errorDescription: String? {
            switch self {
            case .openFailed(let detail): return "Could not open the search index: \(detail)"
            case .prepareFailed(let detail): return "Search index query failed: \(detail)"
            case .stepFailed(let detail): return "Search index write failed: \(detail)"
            }
        }
    }

    private var db: OpaquePointer?
    private let path: URL
    private let lock = NSLock()
    /// True when the existing file had to be discarded, so callers know a rebuild is
    /// owed rather than silently searching an empty index.
    public private(set) var wasRebuilt = false

    public init(directory: URL) throws {
        self.path = directory.appendingPathComponent("SearchIndex.db")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            try openAndVerify()
        } catch {
            // Unopenable, corrupt, or from another schema: start over. Losing an index
            // costs a rebuild; refusing to open costs the whole feature.
            try recreate()
        }
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // MARK: - Lifecycle

    private func openAndVerify() throws {
        try open()
        try createSchemaIfNeeded()
        guard try storedSchemaVersion() == Self.schemaVersion else {
            throw StoreError.openFailed("schema version mismatch")
        }
    }

    private func open() throws {
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path.path, &db, flags, nil) == SQLITE_OK else {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            sqlite3_close(db)
            db = nil
            throw StoreError.openFailed(message)
        }
    }

    private func recreate() throws {
        if let db { sqlite3_close(db) }
        db = nil
        try? FileManager.default.removeItem(at: path)
        // SQLite may have left sidecar files, and a half-deleted database is worse
        // than none. Note the names are `SearchIndex.db-wal`, appended to the full
        // filename — not a replaced extension.
        for suffix in ["-wal", "-shm", "-journal"] {
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: path.path + suffix))
        }
        wasRebuilt = true
        try open()
        try createSchemaIfNeeded()
        try exec("INSERT OR REPLACE INTO meta(key, value) VALUES ('schemaVersion', '\(Self.schemaVersion)');")
    }

    private func createSchemaIfNeeded() throws {
        try exec("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(
            tokens,
            body UNINDEXED,
            taskID UNINDEXED,
            source UNINDEXED,
            startSeconds UNINDEXED,
            endSeconds UNINDEXED,
            indexedAt UNINDEXED
        );
        """)
        if try storedSchemaVersion() == nil {
            try exec(
                "INSERT OR REPLACE INTO meta(key, value) VALUES ('schemaVersion', '\(Self.schemaVersion)');"
            )
        }
    }

    private func storedSchemaVersion() throws -> Int? {
        var stmt: OpaquePointer?
        let sql = "SELECT value FROM meta WHERE key = 'schemaVersion';"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW,
              let text = sqlite3_column_text(stmt, 0) else { return nil }
        return Int(String(cString: text))
    }

    // MARK: - Writing

    /// Replace everything indexed for one task.
    ///
    /// Idempotent by clearing first: re-running a transcript must not double every
    /// line in the results.
    public func replaceEntries(taskID: Int64, entries: [Entry]) throws {
        lock.lock()
        defer { lock.unlock() }
        try exec("BEGIN IMMEDIATE;")
        do {
            try deleteAllUnlocked(taskID: taskID)
            let now = Date().timeIntervalSince1970
            for entry in entries {
                let tokens = SearchTokenizer.indexedText(entry.text)
                // Nothing searchable — an all-punctuation line would occupy a row that
                // can never be found.
                guard !tokens.isEmpty else { continue }
                try insert(entry: entry, tokens: tokens, indexedAt: now)
            }
            try exec("COMMIT;")
        } catch {
            try? exec("ROLLBACK;")
            throw error
        }
    }

    private func insert(entry: Entry, tokens: String, indexedAt: Double) throws {
        let sql = """
        INSERT INTO entries(tokens, body, taskID, source, startSeconds, endSeconds, indexedAt)
        VALUES (?,?,?,?,?,?,?);
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, tokens)
        bindText(stmt, 2, entry.text)
        sqlite3_bind_int64(stmt, 3, entry.taskID)
        bindText(stmt, 4, entry.source.rawValue)
        if let start = entry.startSeconds {
            sqlite3_bind_double(stmt, 5, start)
        } else {
            sqlite3_bind_null(stmt, 5)
        }
        if let end = entry.endSeconds {
            sqlite3_bind_double(stmt, 6, end)
        } else {
            sqlite3_bind_null(stmt, 6)
        }
        sqlite3_bind_double(stmt, 7, indexedAt)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw StoreError.stepFailed(errorMessage())
        }
    }

    /// Remove a task's content from the index.
    ///
    /// Not a nicety: a deleted download must stop being findable, or search hands back
    /// content the user believed they had erased.
    public func deleteAll(taskID: Int64) throws {
        lock.lock()
        defer { lock.unlock() }
        try deleteAllUnlocked(taskID: taskID)
    }

    private func deleteAllUnlocked(taskID: Int64) throws {
        let sql = "DELETE FROM entries WHERE taskID = ?;"
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, taskID)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw StoreError.stepFailed(errorMessage())
        }
    }

    // MARK: - Reading

    /// Search, best match first.
    ///
    /// `bm25()` returns smaller values for better matches, so ascending is correct.
    /// Ties break on how recently the entry was indexed, then chronologically inside a
    /// task — a stable order matters because an unstable one makes results jump while
    /// someone is reading them.
    public func search(_ query: String, limit: Int = 50) throws -> [Hit] {
        guard let expression = SearchTokenizer.matchExpression(for: query) else { return [] }
        lock.lock()
        defer { lock.unlock() }

        let sql = """
        SELECT body, taskID, source, startSeconds, endSeconds
        FROM entries
        WHERE entries MATCH ?
        ORDER BY bm25(entries) ASC, indexedAt DESC, startSeconds ASC
        LIMIT ?;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        bindText(stmt, 1, expression)
        sqlite3_bind_int(stmt, 2, Int32(max(1, limit)))

        var hits: [Hit] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let body = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            let taskID = sqlite3_column_int64(stmt, 1)
            let source = sqlite3_column_text(stmt, 2)
                .map { String(cString: $0) }
                .flatMap(Source.init(rawValue:)) ?? .transcript
            let start = sqlite3_column_type(stmt, 3) == SQLITE_NULL
                ? nil : sqlite3_column_double(stmt, 3)
            let end = sqlite3_column_type(stmt, 4) == SQLITE_NULL
                ? nil : sqlite3_column_double(stmt, 4)
            hits.append(Hit(
                taskID: taskID,
                source: source,
                text: body,
                startSeconds: start,
                endSeconds: end
            ))
        }
        return hits
    }

    /// Rows currently indexed. Lets a caller decide whether a rebuild is due.
    public func entryCount() throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT count(*) FROM entries;", -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
    }

    public func indexedTaskIDs() throws -> Set<Int64> {
        lock.lock()
        defer { lock.unlock() }
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT DISTINCT taskID FROM entries;", -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.prepareFailed(errorMessage())
        }
        defer { sqlite3_finalize(stmt) }
        var ids: Set<Int64> = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            ids.insert(sqlite3_column_int64(stmt, 0))
        }
        return ids
    }

    // MARK: - Plumbing

    /// SQLITE_TRANSIENT. With a nil destructor SQLite does not copy, and a Swift
    /// string's temporary UTF-8 buffer can be freed before the statement runs.
    private func bindText(_ stmt: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(
            stmt,
            index,
            value,
            -1,
            unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        )
    }

    private func exec(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? errorMessage()
            sqlite3_free(error)
            throw StoreError.stepFailed(message)
        }
    }

    private func errorMessage() -> String {
        db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
    }
}
