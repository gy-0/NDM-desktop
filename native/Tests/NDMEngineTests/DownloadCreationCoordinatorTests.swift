import XCTest
@testable import NDMCore
@testable import NDMEngine

private actor CreationPreparationGate {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

final class DownloadCreationCoordinatorTests: XCTestCase {
    private func intent(_ key: String = UUID().uuidString, op: String = "add") throws -> DownloadCreationIntent {
        try DownloadCreationIntent(key: key, payload: ["op": op, "url": "https://fixture.invalid/a"])
    }
    func testAsynchronousPreparationReportsPendingAndConcurrentReplayRunsPreparationOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let coordinator = DownloadCreationCoordinator(store: store)
        let intent = try intent(op: "addMedia"), gate = CreationPreparationGate()
        let first = Task {
            try await coordinator.create(intent) { intent in
                await gate.wait()
                _ = try store.commitCreation(intent, task: DownloadTask(url: "https://fixture.invalid/resolved", linkType: "ytdlp"))
            }
        }
        var pending = false
        for _ in 0..<100 {
            if try await coordinator.lookup(key: intent.key).pending { pending = true; break }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertTrue(pending)
        let during = try await coordinator.lookup(key: intent.key)
        XCTAssertNil(during.receipt)
        XCTAssertNil(during.task)
        let replay = Task {
            try await coordinator.create(intent) { _ in XCTFail("Preparation ran twice") }
        }
        let changed = try self.intent(intent.key, op: "add")
        do {
            _ = try await coordinator.create(changed) { _ in XCTFail("Mismatched intent ran") }
            XCTFail("Accepted mismatched pending intent")
        } catch DownloadCreationError.intentMismatch {}
        await gate.release()
        let accepted = try await first.value
        let repeated = try await replay.value
        XCTAssertEqual(accepted.receipt, repeated.receipt)
        XCTAssertFalse(accepted.pending)
        XCTAssertEqual(try store.allDownloads().count, 1)
    }
    func testPreparationFailureDoesNotMasqueradeAsCommitAndCanRetrySameIntent() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root), intent = try intent(op: "addMedia")
        let coordinator = DownloadCreationCoordinator(store: store)
        do {
            _ = try await coordinator.create(intent) { _ in throw ManagerError.invalidURL }
            XCTFail("Failed preparation was accepted")
        } catch ManagerError.invalidURL {}
        let result = try await coordinator.lookup(key: intent.key)
        XCTAssertNil(result.receipt)
        XCTAssertFalse(result.pending)
        let accepted = try await coordinator.create(intent) { intent in
            _ = try store.commitCreation(intent, task: DownloadTask(url: "https://fixture.invalid/a"))
        }
        XCTAssertTrue(accepted.receipt?.taskExists == true)
        XCTAssertEqual(try store.allDownloads().count, 1)
    }
    func testPostCommitFailureAndProcessRestartRecoverOriginalTaskWithoutExecutingAgain() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root), intent = try intent()
        let coordinator = DownloadCreationCoordinator(store: store)
        let accepted = try await coordinator.create(intent) { intent in
            _ = try store.commitCreation(intent, task: DownloadTask(url: "https://fixture.invalid/a", status: .error, errorText: "fixture startup failure"))
            throw ManagerError.invalidURL
        }
        XCTAssertEqual(accepted.task?.status, .error)
        let reopened = try DownloadStore(directory: root)
        let next = DownloadCreationCoordinator(store: reopened)
        let recovered = try await next.lookup(key: intent.key)
        XCTAssertEqual(accepted.receipt, recovered.receipt)
        let replay = try await next.create(intent) { _ in XCTFail("Restarted accepted task") }
        XCTAssertEqual(replay.task?.id, accepted.task?.id)
        try reopened.delete(id: try XCTUnwrap(accepted.task?.id))
        let deleted = try await next.create(intent) { _ in XCTFail("Revived deleted task") }
        XCTAssertFalse(deleted.receipt!.taskExists)
        XCTAssertNil(deleted.task)
    }
    func testOrdinaryCreationPersistsMetadataAndStartupFailureIsAccepted() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root), intent = try intent()
        let blocked = root.appendingPathComponent("blocked")
        try Data("fixture".utf8).write(to: blocked)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: blocked)
        let created = try await manager.createURL("https://fixture.invalid/opaque", connections: 7,
            pageURL: "https://fixture.invalid/page", pageTitle: "Fixture", headers: ["X-Fixture: 1"],
            method: "POST", postData: Data("synthetic".utf8), destinationDirectory: root,
            thumbnailURL: "https://fixture.invalid/icon", formatID: "format", filename: "Report.pdf",
            creationIntent: intent)
        let task = try XCTUnwrap(created)
        XCTAssertEqual(task.status, .error)
        XCTAssertNotNil(task.errorText)
        XCTAssertEqual(task.filename, "Report.pdf")
        XCTAssertEqual(task.connections, 7)
        XCTAssertEqual(task.folderPath, root.path)
        XCTAssertEqual(task.headers, ["X-Fixture: 1"])
        XCTAssertEqual(task.hitTitle, "format")
        XCTAssertEqual(try store.creationReceipt(key: intent.key)?.taskID, task.id)
        var paused = task; paused.status = .paused; try store.update(paused)
        let replay = try await manager.createURL("https://fixture.invalid/opaque", creationIntent: intent)
        XCTAssertEqual(replay?.status, .paused)
        XCTAssertEqual(try store.allDownloads().count, 1)
    }
    func testMediaInitialOptionsCommitWithReceiptAndReplayDoesNotStartPausedTask() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root), intent = try intent(op: "addMedia")
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        let options = YtDlpDownloadOptions(container: .compactMKV, subtitleLanguage: "en")
        let task = try await manager.startYtDlp(url: "http://127.0.0.1:9/fixture", formatID: "v+a", options: options,
            pageTitle: "Fixture", pageURL: "https://fixture.invalid/page", thumbnailURL: "https://fixture.invalid/icon",
            estimatedBytes: 128, preferredFilename: "Chosen", destinationDirectory: root, connections: 7, creationIntent: intent)
        await manager.pause(taskID: task.id)
        let persisted = try XCTUnwrap(store.allDownloads().first)
        XCTAssertEqual(persisted.filename, "Chosen.mkv")
        XCTAssertEqual(persisted.connections, 7)
        XCTAssertEqual(persisted.hitTitle, "v+a")
        XCTAssertEqual(try JSONDecoder().decode(YtDlpDownloadOptions.self, from: XCTUnwrap(persisted.postData)).subtitleLanguage, "en")
        XCTAssertEqual(try store.creationReceipt(key: intent.key)?.taskID, task.id)
        let replay = try await manager.startYtDlp(url: "http://127.0.0.1:9/fixture", formatID: "v+a", options: options,
            pageTitle: "Fixture", estimatedBytes: 128, preferredFilename: "Chosen", creationIntent: intent)
        XCTAssertEqual(replay.id, task.id)
        XCTAssertEqual(replay.status, persisted.status)
        XCTAssertNotEqual(replay.status, .downloading)
        XCTAssertEqual(try store.allDownloads().count, 1)
        try await manager.remove(taskID: task.id, deleteFile: false)
    }
    func testRequestFingerprintBindsControlsButAllowsAuthenticationRefresh() throws {
        let key = UUID().uuidString
        var request: [String: Any] = ["op": "add", "creationKey": key, "url": "https://fixture.invalid/a",
                                     "filename": "a.bin", "headers": ["Cookie: old=1", "Authorization: old", "X-Fixture: stable"]]
        let first = try XCTUnwrap(DownloadCreationRequest.intent(from: request))
        request["id"] = 14
        request["headers"] = ["Cookie: fresh=1", "Authorization: fresh", "X-Fixture: stable"]
        XCTAssertEqual(first, try DownloadCreationRequest.intent(from: request))
        request["filename"] = "b.bin"
        XCTAssertNotEqual(first, try DownloadCreationRequest.intent(from: request))
        request["op"] = "addMedia"; request["collectionScope"] = "all"
        XCTAssertThrowsError(try DownloadCreationRequest.intent(from: request))
    }
    func testIsolatedMediaPreparationDoesNotPruneProductionCache() {
        XCTAssertEqual(YtDlpTool.infoJSONCacheDirectory(supportDirectory: "/tmp/ndm-fixture").path,
                       "/tmp/ndm-fixture/Preflight")
    }
}
