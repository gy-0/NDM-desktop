import XCTest
@testable import NDMCore
@testable import NDMEngine

final class RelayHandoffAdmissionTests: XCTestCase {
    private let requestID = "b8c25004-9895-40db-8840-fab2cbbd0be9"

    func testCompletePayloadSurvivesReopenAndReplayDoesNotApplyNewSettings() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root, useCategoryFolders: true), supportRoot: root)
        var message = ParsedBridgeMessage()
        message.url = "https://example.invalid/opaque"
        message.filename = "Report.pdf"
        message.contentType = "application/pdf"
        message.method = "POST"
        message.postData = "synthetic=fixture"
        message.cookies = "fixture=only"
        message.extraHeaders = ["Authorization": "Bearer synthetic", "X-Fixture": "one"]
        message.fileSize = 12345
        let result = try await manager.acceptRelayHandoff(message, requestID: requestID, awaitingDestination: true)
        guard case let .committed(task) = result else { return XCTFail("Expected new admission") }
        XCTAssertEqual(task.filename, message.filename)
        XCTAssertEqual(task.postData, Data("synthetic=fixture".utf8))
        XCTAssertTrue(task.headers.contains("Cookie: fixture=only"))
        XCTAssertTrue(task.headers.contains("Authorization: Bearer synthetic"))
        XCTAssertEqual(task.fileSize, 12345)
        XCTAssertEqual(task.status, .paused)
        XCTAssertEqual(task.awaitingDestination, true)
        XCTAssertEqual(task.folderPath, DownloadDestinationPolicy.directory(defaultDirectory: root, override: nil, category: task.category, organizeByCategory: true).path)
        let reopened = try DownloadStore(directory: root)
        let next = DownloadManager(store: reopened, settings: AppSettings(downloadDirectory: root.appendingPathComponent("new-settings")), supportRoot: root)
        // Dictionary insertion order must not affect the request fingerprint.
        message.extraHeaders = ["X-Fixture": "one", "Authorization": "Bearer synthetic"]
        let replay = try await next.acceptRelayHandoff(message, requestID: requestID, awaitingDestination: false)
        guard case let .replayed(id) = replay else { return XCTFail("Expected replay") }
        XCTAssertEqual(id, task.id)
        let persisted = try XCTUnwrap(reopened.allDownloads().first)
        XCTAssertEqual(persisted.folderPath, task.folderPath)
        XCTAssertEqual(persisted.awaitingDestination, true)
        XCTAssertEqual(persisted.status, .paused)
        XCTAssertEqual(persisted.postData, task.postData)
        XCTAssertEqual(try reopened.allDownloads().count, 1)
    }

    func testChangedPayloadIsRejectedAndDeletedTaskIsNotRecreated() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        var message = ParsedBridgeMessage(); message.url = "https://example.invalid/file.bin"
        guard case let .committed(task) = try await manager.acceptRelayHandoff(message, requestID: requestID) else { return XCTFail("Expected commit") }
        var changed = message; changed.cookies = "different=fixture"
        do {
            _ = try await manager.acceptRelayHandoff(changed, requestID: requestID)
            XCTFail("Same ID cannot authorize a different payload")
        } catch StoreError.relayPayloadMismatch {} catch { XCTFail("Unexpected \(error)") }
        try store.delete(id: task.id)
        guard case let .deleted(id) = try await manager.acceptRelayHandoff(message, requestID: requestID) else { return XCTFail("Expected deleted receipt") }
        XCTAssertEqual(id, task.id)
        XCTAssertTrue(try store.allDownloads().isEmpty)
    }

    func testStartupFailureIsVisibleAndDelayedStartPreservesUserPause() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let blocked = root.appendingPathComponent("blocked")
        try Data("fixture".utf8).write(to: blocked)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: blocked)
        var message = ParsedBridgeMessage(); message.url = "https://example.invalid/file.bin"
        guard case let .committed(task) = try await manager.acceptRelayHandoff(message, requestID: requestID) else { return XCTFail("Expected commit") }
        try await manager.startAcceptedRelayHandoff(taskID: task.id)
        XCTAssertEqual(try store.allDownloads().first?.status, .error)
        XCTAssertNotNil(try store.allDownloads().first?.errorText)
        guard case .replayed = try await manager.acceptRelayHandoff(message, requestID: requestID) else { return XCTFail("Expected replay") }
        var paused = try XCTUnwrap(store.allDownloads().first)
        paused.status = .paused; paused.errorText = nil; try store.update(paused)
        try await manager.startAcceptedRelayHandoff(taskID: task.id)
        XCTAssertEqual(try store.allDownloads().first?.status, .paused)
        XCTAssertNil(try store.allDownloads().first?.errorText)
    }

    func testIndependentUserIntentAtSameURLCreatesSeparateTask() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        var message = ParsedBridgeMessage(); message.url = "https://example.invalid/file.bin"
        _ = try await manager.acceptRelayHandoff(message, requestID: requestID)
        _ = try await manager.acceptRelayHandoff(message, requestID: UUID().uuidString)
        XCTAssertEqual(try store.allDownloads().count, 2)
    }

    func testExactRequestRescuePreservesDestinationAndReplayDoesNotResetLaterFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        var old = try store.insert(DownloadTask(url: "https://example.invalid/file?old", filename: "original.zip", status: .error,
            pageURL: "https://example.invalid/source", errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            folderPath: root.appendingPathComponent("chosen").path))
        var message = ParsedBridgeMessage(); message.url = old.url
        message.pageURL = old.pageURL!; message.filename = "different.zip"
        guard case let .committed(task) = try await manager.acceptRelayHandoff(message, requestID: requestID, awaitingDestination: true) else { return XCTFail("Expected rescue") }
        XCTAssertEqual(task.id, old.id)
        XCTAssertEqual(task.filename, old.filename)
        XCTAssertEqual(task.folderPath, old.folderPath)
        XCTAssertNotEqual(task.awaitingDestination, true)
        old = task; old.status = .error; old.errorText = "later failure"
        try store.update(old)
        guard case .replayed = try await manager.acceptRelayHandoff(message, requestID: requestID) else { return XCTFail("Expected replay") }
        XCTAssertEqual(try store.allDownloads().first?.errorText, "later failure")
        XCTAssertEqual(try store.allDownloads().first?.status, .error)
        XCTAssertEqual(try store.allDownloads().count, 1)
    }

    func testChangedURLAdmissionAndReplayPreserveOriginalFailureAndPartialBytes() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let settings = AppSettings(downloadDirectory: root)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: root)
        let original = try store.insert(DownloadTask(url: "https://example.invalid/file?old", filename: "original.zip",
            status: .error, pageURL: "https://example.invalid/source",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            folderPath: root.appendingPathComponent("chosen").path))
        let work = root.appendingPathComponent("\(original.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let partial = work.appendingPathComponent("seg.x0")
        let bytes = Data(repeating: 0x42, count: 257)
        try bytes.write(to: partial)
        var message = ParsedBridgeMessage()
        message.url = "https://example.invalid/file?fresh"
        message.pageURL = original.pageURL!
        message.filename = original.filename
        guard case let .committed(added) = try await manager.acceptRelayHandoff(message, requestID: requestID,
            awaitingDestination: true) else { return XCTFail("Expected independent admission") }
        XCTAssertNotEqual(added.id, original.id)
        XCTAssertEqual(added.awaitingDestination, true)
        XCTAssertEqual(added.status, .paused)
        XCTAssertEqual(try store.allDownloads().first { $0.id == original.id }, original)
        XCTAssertEqual(try Data(contentsOf: partial), bytes)
        // Compare durable rows so Date's sub-microsecond epoch conversion does
        // not obscure a change to request provenance or destination metadata.
        let persistedAdded = try XCTUnwrap(store.allDownloads().first { $0.id == added.id })

        let reopened = try DownloadStore(directory: root)
        let reconstructed = DownloadManager(store: reopened, settings: settings, supportRoot: root)
        guard case let .replayed(id) = try await reconstructed.acceptRelayHandoff(message, requestID: requestID)
            else { return XCTFail("Expected durable replay") }
        XCTAssertEqual(id, added.id)
        XCTAssertEqual(try reopened.allDownloads().first { $0.id == original.id }, original)
        XCTAssertEqual(try reopened.allDownloads().first { $0.id == added.id }, persistedAdded)
        XCTAssertEqual(try reopened.allDownloads().count, 2)
        XCTAssertEqual(try Data(contentsOf: partial), bytes)
    }
}
