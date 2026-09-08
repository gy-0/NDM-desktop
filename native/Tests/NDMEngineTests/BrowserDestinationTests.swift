import XCTest
@testable import NDMCore
@testable import NDMEngine

final class BrowserDestinationTests: XCTestCase {
    func testConfirmedDestinationStartFailureIsVisibleAndRetryRecovers() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let output = root.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let workRoot = root.appendingPathComponent("blocked-work-root")
        try Data("fixture blocker".utf8).write(to: workRoot)
        let payload = Data((0..<65536).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: root.appendingPathComponent("store"))
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: output), supportRoot: workRoot)
        let pending = try await manager.addURL(server.baseURL.absoluteString, connections: 1, awaitingDestination: true)
        let failed = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: output)
        XCTAssertEqual(failed.status, .error)
        XCTAssertEqual(failed.awaitingDestination, false)
        XCTAssertEqual(failed.folderPath, output.path)
        XCTAssertNotNil(DownloadDiagnostic.fromStoredErrorText(failed.errorText))
        XCTAssertTrue(server.recordedMethods.isEmpty)
        try FileManager.default.removeItem(at: workRoot)
        let duplicate = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: root)
        XCTAssertEqual(duplicate.status, .error)
        XCTAssertEqual(duplicate.folderPath, output.path)
        XCTAssertTrue(server.recordedMethods.isEmpty, "Duplicate confirmation must not retry a failed start")
        try await manager.restart(taskID: pending.id)
        let deadline = Date().addingTimeInterval(5)
        while try store.allDownloads().first?.status != .complete && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        let completed = try XCTUnwrap(store.allDownloads().first)
        XCTAssertEqual(completed.status, .complete)
        XCTAssertNil(completed.errorText)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(completed.destinationFileURL)), payload)
    }

    func testRecordedCategoryDirectoryCanBeCreatedForFirstDownload() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data(repeating: 31, count: 16384)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root, useCategoryFolders: true), supportRoot: root)
        var message = ParsedBridgeMessage()
        message.url = server.baseURL.absoluteString
        message.filename = "first.pdf"
        let pending = try await manager.addFromBridge(message, awaitingDestination: true)
        let directory = URL(fileURLWithPath: try XCTUnwrap(pending.folderPath))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        _ = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: directory)
        let deadline = Date().addingTimeInterval(5)
        while try store.allDownloads().first?.status != .complete && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(try store.allDownloads().first?.status, .complete)
        XCTAssertEqual(try Data(contentsOf: directory.appendingPathComponent("first.pdf")), payload)
    }

    func testMissingDownloadRootIsNotRecreatedForCategoryConfirmation() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let absentVolume = root.appendingPathComponent("absent-volume")
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: absentVolume, useCategoryFolders: true), supportRoot: root)
        let pending = try await manager.addURL("http://127.0.0.1:1/first.pdf", awaitingDestination: true)
        do {
            _ = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: URL(fileURLWithPath: try XCTUnwrap(pending.folderPath)))
            XCTFail("An absent root must not be recreated")
        } catch ManagerError.unsafeFileLocation {} catch { XCTFail("Unexpected \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: absentVolume.path))
        XCTAssertEqual(try store.allDownloads().first?.awaitingDestination, true)
        XCTAssertEqual(try store.allDownloads().first?.status, .paused)
    }

    func testNewBridgeFilenameDeterminesCategoryDirectory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = DownloadManager(store: try DownloadStore(directory: root), settings: AppSettings(downloadDirectory: root, useCategoryFolders: true), supportRoot: root)
        var message = ParsedBridgeMessage()
        message.url = "http://127.0.0.1:1/opaque"
        message.filename = "document.pdf"
        let task = try await manager.addFromBridge(message, awaitingDestination: true)
        XCTAssertEqual(task.filename, DownloadFilename.sanitize(message.filename))
        XCTAssertEqual(task.category, DownloadCategory.infer(filename: "document.pdf", mimeType: nil))
        XCTAssertEqual(task.folderPath, DownloadDestinationPolicy.directory(defaultDirectory: root, override: nil, category: task.category, organizeByCategory: true).path)
    }

    func testConcurrentConfirmationStartsOnceAndCompletedDuplicateDoesNotRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let first = root.appendingPathComponent("first"), second = root.appendingPathComponent("second")
        try FileManager.default.createDirectory(at: first, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data(repeating: 18, count: 65536)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        let pending = try await manager.addURL(server.baseURL.absoluteString, connections: 1, awaitingDestination: true)
        async let a = manager.confirmDestinationAndStart(taskID: pending.id, directory: first)
        async let b = manager.confirmDestinationAndStart(taskID: pending.id, directory: second)
        let (one, two) = try await (a, b)
        XCTAssertEqual(one.folderPath, two.folderPath)
        let deadline = Date().addingTimeInterval(5)
        while try store.allDownloads().first?.status != .complete && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        let completed = try XCTUnwrap(store.allDownloads().first)
        XCTAssertEqual(completed.status, .complete)
        let count = server.recordedMethods.count
        let duplicate = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: root)
        XCTAssertEqual(duplicate.status, .complete)
        XCTAssertEqual(duplicate.folderPath, completed.folderPath)
        XCTAssertEqual(server.recordedMethods.count, count)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(completed.destinationFileURL)), payload)
    }

    func testBusyConfirmationQueuesAfterPersistingDirectory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let server = LocalRangeServer(payload: Data(repeating: 2, count: 65536), responseDelay: 0.3)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root, downloadAllAtOnce: false), supportRoot: root)
        let active = try await manager.addURL(server.baseURL.absoluteString)
        try await manager.start(taskID: active.id)
        let pending = try await manager.addURL(server.baseURL.absoluteString, awaitingDestination: true)
        let project = root.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: project, withIntermediateDirectories: true)
        let queued = try await manager.confirmDestinationAndStart(taskID: pending.id, directory: project)
        XCTAssertEqual(queued.status, .waiting)
        XCTAssertEqual(queued.awaitingDestination, false)
        XCTAssertEqual(queued.folderPath, project.path)
        let deadline = Date().addingTimeInterval(8)
        while try store.allDownloads().first(where: { $0.id == pending.id })?.status != .complete && Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(try store.allDownloads().first(where: { $0.id == pending.id })?.status, .complete)
        await manager.pause(taskID: active.id)
        await manager.pause(taskID: pending.id)
    }

    func testPendingHandoffSurvivesReopenAndCannotStartUntilConfirmed() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let support = root.appendingPathComponent("support"), output = root.appendingPathComponent("project")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let payload = Data(repeating: 83, count: 65536)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: root, useCategoryFolders: false)
        var manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        var message = ParsedBridgeMessage()
        message.url = server.baseURL.absoluteString
        message.filename = "handoff.bin"
        message.cookies = "fixture=retained"
        let task = try await manager.addFromBridge(message, awaitingDestination: true)
        XCTAssertEqual(task.awaitingDestination, true)
        XCTAssertEqual(task.status, .paused)
        for restart in [false, true] {
            do {
                if restart { try await manager.restart(taskID: task.id) } else { try await manager.start(taskID: task.id) }
                XCTFail("Unconfirmed task must not start")
            } catch ManagerError.destinationConfirmationRequired {} catch { XCTFail("Unexpected \(error)") }
        }
        do { try await manager.schedule(taskID: task.id, at: Date()); XCTFail("Pending task must not be scheduled") }
        catch ManagerError.destinationConfirmationRequired {} catch { XCTFail("Unexpected \(error)") }
        XCTAssertTrue(server.recordedMethods.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: support.appendingPathComponent(String(task.id)).path))
        manager = DownloadManager(store: try DownloadStore(directory: support), settings: settings, supportRoot: support)
        let reopened = try await manager.listTasks().first { $0.id == task.id }
        XCTAssertEqual(reopened?.awaitingDestination, true)
        XCTAssertEqual(reopened?.headers, task.headers)
        let confirmed = try await manager.confirmDestination(taskID: task.id, directory: output)
        XCTAssertEqual(confirmed.awaitingDestination, false)
        XCTAssertEqual(confirmed.folderPath, output.path)
        // A delayed duplicate response cannot replace the confirmed directory.
        let repeated = try await manager.confirmDestination(taskID: task.id, directory: root)
        XCTAssertEqual(repeated.folderPath, output.path)
        try await manager.startAndWait(taskID: task.id)
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("handoff.bin")), payload)
        XCTAssertTrue(server.recordedHeaders.contains { $0["cookie"] == "fixture=retained" })
    }

    func testConfirmationCannotMoveAnExistingPartialOrForgetAnUnavailableDirectory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        let task = try await manager.addURL("http://127.0.0.1:1/file.bin", awaitingDestination: true)
        do { _ = try await manager.confirmDestination(taskID: task.id, directory: root.appendingPathComponent("offline")); XCTFail("Missing destination") }
        catch ManagerError.unsafeFileLocation {} catch { XCTFail("Unexpected \(error)") }
        let work = root.appendingPathComponent(String(task.id))
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let partial = work.appendingPathComponent("seg.x0")
        try Data([1, 2, 3]).write(to: partial)
        do { _ = try await manager.confirmDestination(taskID: task.id, directory: root); XCTFail("Existing bytes must prevent path reassignment") }
        catch ManagerError.unsafeFileLocation {} catch { XCTFail("Unexpected \(error)") }
        XCTAssertEqual(try Data(contentsOf: partial), Data([1, 2, 3]))
        XCTAssertEqual(try store.allDownloads().first?.awaitingDestination, true)
    }
}
