import XCTest
@testable import NDMCore
@testable import NDMEngine

final class BrowserDestinationTests: XCTestCase {
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
