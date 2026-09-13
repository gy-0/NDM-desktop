import XCTest
import Darwin
@testable import NDMEngine
@testable import NDMCore

final class FTPCrossVolumeTests: XCTestCase {
    func testVerifiedFTPDownloadAndExplicitReplacementAcrossRealVolumes() async throws {
        guard let mountPath = ProcessInfo.processInfo.environment["NDM_QA_FTP_VOLUME"] else {
            throw XCTSkip("Set NDM_QA_FTP_VOLUME to an isolated mounted test volume")
        }
        let destination = URL(fileURLWithPath: mountPath).appendingPathComponent("ftp-\(UUID())")
        let support = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-ftp-volume-\(UUID())")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: destination); try? FileManager.default.removeItem(at: support) }
        var sourceInfo = stat(), targetInfo = stat()
        XCTAssertEqual(stat(support.path, &sourceInfo), 0)
        XCTAssertEqual(stat(destination.path, &targetInfo), 0)
        XCTAssertNotEqual(sourceInfo.st_dev, targetInfo.st_dev, "Must actually enter the EXDEV publication path")
        let payload = Data((0..<(2 * 1024 * 1024)).map { UInt8($0 % 239) })
        let server = LocalFTPServer(files: ["file.bin": payload], username: "anonymous", password: "ndm@localhost")
        try server.start()
        defer { XCTAssertTrue(server.stop(), "Owned FTP sockets must close") }
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: destination,
            maxConnections: 1, downloadAllAtOnce: false, useCategoryFolders: false), supportRoot: support)
        let old = Data("Keep this existing file".utf8)
        try old.write(to: destination.appendingPathComponent("file.bin"))
        let task = try await manager.addURL(server.url(path: "file.bin").absoluteString)
        try await manager.startAndWait(taskID: task.id)
        let rows = try await manager.listTasks()
        let complete = try XCTUnwrap(rows.first { $0.id == task.id })
        XCTAssertEqual(complete.status, .complete)
        XCTAssertNotEqual(complete.filename, "file.bin")
        let published = destination.appendingPathComponent(complete.filename)
        XCTAssertEqual(try Data(contentsOf: published), payload)
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent("file.bin")), old)
        // Different bytes make replacement observable; retaining the previous
        // download without performing the second transfer must not pass.
        try Data("Previous download to replace".utf8).write(to: published)
        try await manager.restart(taskID: task.id)
        try await manager.startAndWait(taskID: task.id)
        let replacedRows = try await manager.listTasks()
        let replaced = try XCTUnwrap(replacedRows.first { $0.id == task.id })
        XCTAssertEqual(replaced.status, .complete)
        XCTAssertEqual(replaced.filename, complete.filename, "Explicit redownload must replace the same published path")
        XCTAssertEqual(try Data(contentsOf: published), payload)
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent("file.bin")), old)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: destination.path).contains { $0.hasPrefix(".ndm-") })
    }
}
