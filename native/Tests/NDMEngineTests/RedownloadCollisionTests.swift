import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class RedownloadCollisionTests: XCTestCase {
    func testRedownloadAtomicallyReplacesCompletedFileAtSamePath() async throws {
        try await verifyRedownload(retryCollision: false)
        try await verifyRedownload(retryCollision: true)
        try await verifyRedownload(retryCollision: false, sendsValidator: false)
    }

    func testRedownloadSurvivesPauseAndManagerRelaunch() async throws {
        try await verifyRedownload(retryCollision: false, pauseAndRelaunch: true)
    }

    func testFailedRedownloadPreservesOriginalFile() async throws {
        try await verifyRedownload(retryCollision: false, fail: true)
    }

    private func verifyRedownload(retryCollision: Bool, sendsValidator: Bool = true, pauseAndRelaunch: Bool = false, fail: Bool = false) async throws {
        let payload = Data(repeating: 0x56, count: 1024 * 1024)
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 16 * 1024,
                                      bodyChunkDelay: { _ in 0.01 }, responseDelay: 0.05,
                                      injectedRangeFailureStatus: fail ? 403 : nil,
                                      injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max,
                                      sendsValidator: sendsValidator)
        try server.start()
        defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-redownload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let output = root.appendingPathComponent("downloads")
        let support = root.appendingPathComponent("support")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        var manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: output, useCategoryFolders: false), supportRoot: support)
        var task = try await manager.addURL(server.baseURL.absoluteString, connections: 1)
        task.filename = "fixture.bin"
        task.folderPath = output.path
        task.status = retryCollision ? .error : .complete
        task.errorText = retryCollision ? "#diag:generic|The operation couldn’t be completed. File exists" : nil
        try store.update(task)
        let original = output.appendingPathComponent(task.filename)
        let oldBytes = Data("previous complete download".utf8)
        try oldBytes.write(to: original)
        if retryCollision { try await manager.start(taskID: task.id) }
        else { try await manager.restart(taskID: task.id) }
        XCTAssertEqual(try Data(contentsOf: original), oldBytes, "Starting a redownload must preserve the complete file")
        if pauseAndRelaunch {
            try await Task.sleep(for: .milliseconds(200))
            await manager.pause(taskID: task.id)
            XCTAssertEqual(try Data(contentsOf: original), oldBytes)
            manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: output, useCategoryFolders: false), supportRoot: support)
            try await manager.start(taskID: task.id)
        }
        var result = task
        for _ in 0..<200 {
            try await Task.sleep(for: .milliseconds(50))
            result = try XCTUnwrap(store.allDownloads().first { $0.id == task.id })
            if result.status == .complete || result.status == .error { break }
        }
        await manager.pause(taskID: task.id)
        XCTAssertEqual(result.status, fail ? .error : .complete, result.errorText ?? "")
        XCTAssertEqual(result.filename, task.filename)
        XCTAssertEqual(try Data(contentsOf: original), fail ? oldBytes : payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("fixture (2).bin").path))
    }

    func testFileCollisionIsLocalizedAndLegacyErrorMigrates() {
        let diagnostic = DownloadDiagnostic.classify(POSIXError(.EEXIST))
        XCTAssertEqual(diagnostic, .fileAlreadyExists)
        XCTAssertEqual(DownloadDiagnostic.fromStoredErrorText(diagnostic.storageString), diagnostic)
        XCTAssertEqual(DownloadDiagnostic.fromStoredErrorText("#diag:generic|The operation couldn’t be completed. File exists"), diagnostic)
        XCTAssertEqual(diagnostic.primaryAction, .retry)
    }
}
