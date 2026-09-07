import Foundation
import SQLite3

/// Import downloads from original Neat Download Manager SQLite DB into our schema.
public enum LegacyDBImporter {
    public enum ImportError: Error, LocalizedError {
        case openFailed
        case noDownloadsTable

        public var errorDescription: String? {
            switch self {
            case .openFailed: return "Could not open legacy database"
            case .noDownloadsTable: return "Legacy DB has no downloads table"
            }
        }
    }

    /// Default original support path (do not write here).
    public static var defaultOriginalDB: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/com.neat.download.manager/neatdb.sqlite")
    }

    @discardableResult
    public static func importDownloads(from legacyURL: URL, into store: DownloadStore) throws -> Int {
        var db: OpaquePointer?
        guard sqlite3_open_v2(legacyURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            throw ImportError.openFailed
        }
        defer { sqlite3_close(db) }

        let sql = """
        SELECT url, method, filename, ltype, filesize, category, status,
               bandwidthlimit, connections, useragent, resumable,
               pageurl, pagetitle, mimetype, errortext, urla, postdata, folderpath
        FROM downloads;
        """
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ImportError.noDownloadsTable
        }
        defer { sqlite3_finalize(stmt) }

        var count = 0
        while sqlite3_step(stmt) == SQLITE_ROW {
            func text(_ i: Int32) -> String? {
                guard let c = sqlite3_column_text(stmt, i) else { return nil }
                return String(cString: c)
            }
            let url = text(0) ?? ""
            guard !url.isEmpty else { continue }
            var task = DownloadTask(
                url: url,
                method: text(1) ?? "GET",
                filename: text(2) ?? "download.bin",
                linkType: text(3) ?? "normal",
                fileSize: sqlite3_column_int64(stmt, 4),
                status: DownloadStatus(rawValue: text(6) ?? "") ?? .incomplete,
                connections: Int(sqlite3_column_int(stmt, 8)),
                userAgent: text(9),
                resumable: sqlite3_column_int(stmt, 10) != 0,
                pageURL: text(11),
                pageTitle: text(12),
                mimeType: text(13),
                errorText: text(14),
                alternateURL: text(15),
                folderPath: text(17)
            )
            if let cat = text(5), let c = DownloadCategory(rawValue: cat.lowercased()) {
                task.category = c
            } else {
                task.category = DownloadCategory.infer(filename: task.filename, mimeType: task.mimeType)
            }
            if let post = text(16), !post.isEmpty {
                task.postData = Data(post.utf8)
            }
            task.bandwidthLimit = sqlite3_column_int64(stmt, 7)
            _ = try store.insert(task)
            count += 1
        }
        return count
    }
}
