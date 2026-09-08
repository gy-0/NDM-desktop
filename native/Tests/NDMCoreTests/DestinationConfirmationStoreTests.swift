import XCTest
import SQLite3
@testable import NDMCore

final class DestinationConfirmationStoreTests: XCTestCase {
    func testJSONWithoutDestinationFlagRemainsCompatible() throws {
        let old = DownloadTask(url: "https://fixture.invalid/file")
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(old)) as? [String: Any])
        object.removeValue(forKey: "awaitingDestination")
        let decoded = try JSONDecoder().decode(DownloadTask.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(decoded.awaitingDestination)
        var pending = decoded
        pending.awaitingDestination = true
        XCTAssertEqual(try JSONDecoder().decode(DownloadTask.self, from: JSONEncoder().encode(pending)).awaitingDestination, true)
    }

    func testInsertUpdateAndReopenPreserveFlagAndHostRequest() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: DownloadStore? = try DownloadStore(directory: directory)
        var saved = try store!.insert(DownloadTask(url: "https://fixture.invalid/file", method: "POST",
            postData: Data("fixture body".utf8), folderPath: "/tmp/project", headers: ["Cookie: fixture=value"], awaitingDestination: true))
        let other = try store!.insert(DownloadTask(url: "https://fixture.invalid/other"))
        store = nil
        store = try DownloadStore(directory: directory)
        let read = try XCTUnwrap(store!.allDownloads().first { $0.id == saved.id })
        XCTAssertEqual(read.awaitingDestination, true)
        XCTAssertEqual(read.headers, saved.headers)
        XCTAssertEqual(read.postData, saved.postData)
        XCTAssertEqual(read.folderPath, saved.folderPath)
        for value: Bool? in [false, nil, true] {
            saved.awaitingDestination = value
            try store!.update(saved)
            let tasks = try store!.allDownloads()
            XCTAssertEqual(tasks.first { $0.id == saved.id }?.awaitingDestination, value)
            XCTAssertNil(tasks.first { $0.id == other.id }?.awaitingDestination)
        }
    }

    func testExistingSchemaMigratesWithRunnableDefaultWithoutChangingRequest() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: DownloadStore? = try DownloadStore(directory: directory)
        let old = try store!.insert(DownloadTask(url: "https://fixture.invalid/legacy", headers: ["X-Fixture: preserved"]))
        store = nil
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(directory.appendingPathComponent("NeatDB.db").path, &database), SQLITE_OK)
        // Recreate the immediately preceding schema, which had no confirmation column.
        XCTAssertEqual(sqlite3_exec(database, "ALTER TABLE downloads DROP COLUMN awaitingdestination;", nil, nil, nil), SQLITE_OK)
        sqlite3_close(database)
        store = try DownloadStore(directory: directory)
        let migrated = try XCTUnwrap(store!.allDownloads().first)
        XCTAssertEqual(migrated.id, old.id)
        XCTAssertEqual(migrated.awaitingDestination, false)
        XCTAssertEqual(migrated.headers, old.headers)
        var pending = migrated
        pending.awaitingDestination = true
        try store!.update(pending)
        store = nil
        store = try DownloadStore(directory: directory)
        XCTAssertEqual(try store!.allDownloads().first?.awaitingDestination, true)
    }
}
