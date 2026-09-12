import XCTest
import SQLite3
@testable import NDMCore

final class DownloadCreationStoreTests: XCTestCase {
    private func fixture(_ body: (URL, DownloadStore) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root, DownloadStore(directory: root))
    }
    private func sql(_ root: URL, _ sql: String) throws {
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open(root.appendingPathComponent("NeatDB.db").path, &db), SQLITE_OK)
        defer { sqlite3_close(db) }
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw StoreError.stepFailed }
    }
    private func intent(_ key: String = UUID().uuidString, url: String = "https://fixture.invalid/a") throws -> DownloadCreationIntent {
        try DownloadCreationIntent(key: key, payload: ["op": "add", "url": url])
    }
    func testCompleteTaskAndReceiptSurviveReopenAndRemovalWithoutReviving() throws {
        try fixture { root, store in
            let intent = try intent()
            let task = DownloadTask(url: "https://fixture.invalid/a", filename: "chosen.pdf", connections: 7,
                pageTitle: "Fixture", thumbnailURL: "https://fixture.invalid/icon", hitTitle: "format",
                postData: Data("fixture-body".utf8), folderPath: root.path, headers: ["X-Fixture: value"])
            guard case .committed(let saved) = try store.commitCreation(intent, task: task) else { return XCTFail("No commit") }
            let reopened = try DownloadStore(directory: root)
            XCTAssertEqual(try reopened.allDownloads().first, saved)
            XCTAssertEqual(try reopened.creationReceipt(key: intent.key)?.taskID, saved.id)
            guard case .replayed(let receipt) = try reopened.commitCreation(intent, task: task) else { return XCTFail("No replay") }
            XCTAssertTrue(receipt.taskExists)
            try reopened.delete(id: saved.id)
            let restarted = try DownloadStore(directory: root)
            guard case .replayed(let removed) = try restarted.commitCreation(intent, task: task) else { return XCTFail("Revived deleted task") }
            XCTAssertFalse(removed.taskExists)
            XCTAssertEqual(removed.taskID, saved.id)
            XCTAssertTrue(try restarted.allDownloads().isEmpty)
            let changed = try self.intent(intent.key, url: "https://fixture.invalid/changed")
            XCTAssertThrowsError(try restarted.commitCreation(changed, task: task))
        }
    }
    func testReceiptWriteFailureRollsBackTaskAndHeaders() throws {
        try fixture { root, store in
            let intent = try intent()
            XCTAssertNil(try store.reserveCreation(intent))
            try sql(root, "CREATE TRIGGER fail_creation BEFORE UPDATE OF task_id ON download_creation_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
            let task = DownloadTask(url: "https://fixture.invalid/a", headers: ["X-Fixture: value"])
            XCTAssertThrowsError(try store.commitCreation(intent, task: task))
            XCTAssertTrue(try store.allDownloads().isEmpty)
            XCTAssertNil(try store.creationReceipt(key: intent.key))
            try sql(root, "DROP TRIGGER fail_creation;")
            guard case .committed = try store.commitCreation(intent, task: task) else { return XCTFail("Retry must commit") }
            XCTAssertEqual(try store.allDownloads().count, 1)
        }
    }
    func testBoundIntentSurvivesPreparationFailureAndRejectsChangesAfterRestart() throws {
        try fixture { root, store in
            let intent = try intent()
            _ = try store.reserveCreation(intent)
            let reopened = try DownloadStore(directory: root)
            XCTAssertNil(try reopened.creationReceipt(key: intent.key))
            let changed = try self.intent(intent.key, url: "https://fixture.invalid/b")
            XCTAssertThrowsError(try reopened.reserveCreation(changed)) {
                guard case DownloadCreationError.intentMismatch = $0 else { return XCTFail("Wrong error") }
            }
            _ = try reopened.commitCreation(intent, task: DownloadTask(url: "https://fixture.invalid/a"))
            XCTAssertThrowsError(try reopened.commitCreation(changed, task: DownloadTask(url: "https://fixture.invalid/b")))
        }
    }
    func testConcurrentCommitCreatesOneTaskAndDifferentIntentAtSameURLCanCreateAnother() throws {
        try fixture { _, store in
            let intent = try intent()
            let lock = NSLock()
            var ids: [Int64] = [], commits = 0, failures = 0
            DispatchQueue.concurrentPerform(iterations: 20) { _ in
                do {
                    let result = try store.commitCreation(intent, task: DownloadTask(url: "https://fixture.invalid/a"))
                    lock.lock(); defer { lock.unlock() }
                    switch result {
                    case .committed(let task): ids.append(task.id); commits += 1
                    case .replayed(let receipt): ids.append(receipt.taskID)
                    }
                } catch { lock.lock(); failures += 1; lock.unlock() }
            }
            XCTAssertEqual(failures, 0)
            XCTAssertEqual(commits, 1)
            XCTAssertEqual(Set(ids).count, 1)
            _ = try store.commitCreation(self.intent(), task: DownloadTask(url: "https://fixture.invalid/a"))
            XCTAssertEqual(try store.allDownloads().count, 2)
        }
    }
    func testMigrationAndInvalidKeysLeaveExistingDownloadsUntouched() throws {
        try fixture { root, store in
            let original = try store.insert(DownloadTask(url: "https://fixture.invalid/old"))
            try sql(root, "DROP TABLE download_creation_receipts;")
            let migrated = try DownloadStore(directory: root)
            XCTAssertEqual(try migrated.allDownloads(), [original])
            for key in ["", "short", UUID().uuidString + " ", "00000000-0000-0000-0000-invalid00000"] {
                XCTAssertThrowsError(try intent(key))
                XCTAssertThrowsError(try migrated.creationReceipt(key: key))
            }
        }
    }
}
