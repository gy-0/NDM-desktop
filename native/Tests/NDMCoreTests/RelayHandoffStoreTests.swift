import XCTest
import SQLite3
@testable import NDMCore

final class RelayHandoffStoreTests: XCTestCase {
    private let payloadHash = String(repeating: "a", count: 64)
    private let requestID = "relay-request-00000001"
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
    private func committed(_ result: DownloadStore.RelayHandoffCommit) throws -> DownloadTask {
        guard case .committed(let task) = result else { throw StoreError.stepFailed }
        return task
    }
    func testReplayAfterReopenAndDeleteNeverRecreatesTask() throws {
        try fixture { root, store in
            let task = try committed(store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: DownloadTask(url: "https://fixture.invalid/a", headers: ["Cookie: original=1"])))
            let reopened = try DownloadStore(directory: root)
            let changed = DownloadTask(url: "https://fixture.invalid/b", headers: ["Cookie: changed=1"])
            guard case .replayed(let id) = try reopened.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: changed) else { return XCTFail("Expected replay") }
            XCTAssertEqual(id, task.id)
            XCTAssertEqual(try reopened.allDownloads().map(\.url), [task.url])
            XCTAssertEqual(try reopened.allDownloads().first?.headers, task.headers)
            try reopened.delete(id: id)
            guard case .deleted(let deletedID) = try store.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash) else { return XCTFail("Missing tombstone") }
            XCTAssertEqual(deletedID, id)
            guard case .deleted = try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: changed) else { return XCTFail("Recreated deleted intent") }
            XCTAssertTrue(try store.allDownloads().isEmpty)
        }
    }
    func testRescueUpdateAndReceiptCommitTogether() throws {
        try fixture { _, store in
            var task = try store.insert(DownloadTask(url: "https://fixture.invalid/old", headers: ["Cookie: old=1"]))
            task.url = "https://fixture.invalid/new"
            task.headers = ["Cookie: new=1"]
            let saved = try committed(store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: task, updatingExisting: true))
            XCTAssertEqual(saved.id, task.id)
            XCTAssertEqual(try store.allDownloads().count, 1)
            XCTAssertEqual(try store.allDownloads().first?.headers, task.headers)
            guard case .replayed(let id) = try store.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash) else { return XCTFail("Missing receipt") }
            XCTAssertEqual(id, task.id)
        }
    }
    func testReceiptFailureRollsBackRealInsertAndRescueIncludingHeaders() throws {
        try fixture { root, store in
            let original = try store.insert(DownloadTask(url: "https://fixture.invalid/old", headers: ["Cookie: old=1"]))
            try sql(root, "CREATE TRIGGER fail_receipt BEFORE INSERT ON relay_handoff_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END;")
            var changed = original; changed.url = "https://fixture.invalid/new"; changed.headers = ["Cookie: new=1"]
            XCTAssertThrowsError(try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: changed, updatingExisting: true))
            XCTAssertThrowsError(try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: changed))
            let tasks = try store.allDownloads()
            XCTAssertEqual(tasks.count, 1)
            XCTAssertEqual(tasks.first?.url, original.url)
            XCTAssertEqual(tasks.first?.headers, original.headers)
            XCTAssertNil(try store.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash))
            try sql(root, "DROP TRIGGER fail_receipt;")
            _ = try committed(store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: changed, updatingExisting: true))
        }
    }
    func testOldDatabaseGetsReceiptTableWithoutChangingExistingTasks() throws {
        try fixture { root, store in
            let original = try store.insert(DownloadTask(url: "https://fixture.invalid/legacy"))
            try sql(root, "DROP TABLE relay_handoff_receipts;")
            let migrated = try DownloadStore(directory: root)
            XCTAssertNil(try migrated.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash))
            XCTAssertEqual(try migrated.allDownloads().first?.id, original.id)
            _ = try committed(migrated.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: original, updatingExisting: true))
        }
    }

    func testConcurrentReplayCreatesExactlyOneTask() throws {
        try fixture { _, store in
            let resultLock = NSLock()
            var ids: [Int64] = [], failures = 0, commits = 0
            DispatchQueue.concurrentPerform(iterations: 12) { _ in
                do {
                    let result = try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: DownloadTask(url: "https://fixture.invalid/a"))
                    resultLock.lock(); defer { resultLock.unlock() }
                    switch result {
                    case .committed(let task): ids.append(task.id); commits += 1
                    case .replayed(let id): ids.append(id)
                    case .deleted: failures += 1
                    }
                } catch { resultLock.lock(); failures += 1; resultLock.unlock() }
            }
            XCTAssertEqual(failures, 0)
            XCTAssertEqual(commits, 1)
            XCTAssertEqual(Set(ids).count, 1)
            XCTAssertEqual(try store.allDownloads().count, 1)
        }
    }

    func testSameIDWithDifferentPayloadIsRejectedEvenAfterDeletion() throws {
        try fixture { _, store in
            let task = try committed(store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: DownloadTask(url: "https://fixture.invalid/a")))
            for deleted in [false, true] {
                if deleted { try store.delete(id: task.id) }
                XCTAssertThrowsError(try store.relayHandoffReceipt(requestID: requestID, payloadHash: String(repeating: "b", count: 64))) { error in
                    guard case StoreError.relayPayloadMismatch = error else { return XCTFail("Wrong error") }
                }
                XCTAssertThrowsError(try store.commitRelayHandoff(requestID: requestID, payloadHash: String(repeating: "b", count: 64), task: task))
            }
        }
    }

    func testInvalidIdentifiersAndMissingRescueDoNotCreateReceipt() throws {
        try fixture { _, store in
            let task = DownloadTask(url: "https://fixture.invalid/a")
            for id in ["", "short", String(repeating: "a", count: 129), "relay request 0001", "relay-request-0001\0", "relay-request-你好"] {
                XCTAssertThrowsError(try store.commitRelayHandoff(requestID: id, payloadHash: payloadHash, task: task))
                XCTAssertThrowsError(try store.relayHandoffReceipt(requestID: id, payloadHash: payloadHash))
            }
            XCTAssertThrowsError(try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: task, updatingExisting: true))
            XCTAssertNil(try store.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash))
            XCTAssertTrue(try store.allDownloads().isEmpty)
        }
    }
}
