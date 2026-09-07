import XCTest
@testable import NDMEngine
@testable import NDMCore

final class DownloadDestinationOverrideTests: XCTestCase {
    func testDirectTaskPersistsExactPerDownloadDestination() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-direct-destination-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        let chosen = root.appendingPathComponent("Client Project", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let manager = DownloadManager(
            store: try DownloadStore(directory: support),
            settings: AppSettings(
                downloadDirectory: downloads,
                useCategoryFolders: true
            ),
            supportRoot: support
        )

        let task = try await manager.addURL(
            "https://example.com/file.zip",
            destinationDirectory: chosen
        )

        XCTAssertEqual(task.folderPath, chosen.path)
    }

    func testDirectDownloadActuallyLandsInChosenDirectory() async throws {
        let payload = Data(repeating: 0x4E, count: 96 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-direct-destination-delivery-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        let chosen = root.appendingPathComponent("Client Project", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: chosen, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let manager = DownloadManager(
            store: try DownloadStore(directory: support),
            settings: AppSettings(
                downloadDirectory: downloads,
                maxConnections: 2,
                useCategoryFolders: true
            ),
            supportRoot: support
        )
        let task = try await manager.addURL(
            server.baseURL.absoluteString,
            connections: 2,
            destinationDirectory: chosen
        )

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.folderPath, chosen.path)
        XCTAssertEqual(try Data(contentsOf: chosen.appendingPathComponent(done.filename)), payload)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: downloads.appendingPathComponent(done.filename).path
        ))
    }
}
