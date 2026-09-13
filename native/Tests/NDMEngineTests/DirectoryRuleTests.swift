import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DirectoryRuleTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-directory-rules-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return root
    }

    private func data(_ directory: String, host: String = "*.example.test", paths: [String] = [], extensions: [String] = ["zip"]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["version": 1, "revision": 1, "enabled": true, "rules": [
            ["id": "archives", "name": "Archives", "enabled": true, "directory": directory,
             "hosts": [host], "pathGlobs": paths, "extensions": extensions]
        ]])
    }

    func testBoundedGlobHasLiteralSyntaxAndUnicodeScalarQuestionMark() {
        XCTAssertTrue(DownloadDirectoryRules.glob("/release/file?.zip", matches: "/release/file1.zip"))
        XCTAssertTrue(DownloadDirectoryRules.glob("/?.zip", matches: "/🙂.zip"))
        XCTAssertFalse(DownloadDirectoryRules.glob("/?.zip", matches: "/ab.zip"))
        XCTAssertTrue(DownloadDirectoryRules.glob("/a+b[1].zip", matches: "/a+b[1].zip"))
        XCTAssertFalse(DownloadDirectoryRules.glob("*", matches: String(repeating: "x", count: 4097)))
    }

    func testPathHostExtensionConditionsAndExplicitDirectoryHaveSharedSemantics() throws {
        let config = try DownloadDirectoryRules.decode(data("/rules", paths: ["/release/file?.*"]))
        let fallback = URL(fileURLWithPath: "/default")
        XCTAssertEqual(config.directory(url: "https://CDN.EXAMPLE.TEST./release/file1.bin?name=.exe", filename: "archive.zip", explicit: nil, fallback: fallback).path, "/rules")
        XCTAssertEqual(config.directory(url: "https://cdn.example.test/release/file10.zip", filename: nil, explicit: nil, fallback: fallback).path, "/default")
        XCTAssertEqual(config.directory(url: "https://cdn.example.test/release/file1.zip", filename: nil, explicit: URL(fileURLWithPath: "/chosen"), fallback: fallback).path, "/chosen")
        let incompatible = try DownloadDirectoryRules.decode(data("\\\\server\\share"))
        XCTAssertEqual(incompatible.directory(url: "https://cdn.example.test/a.zip", filename: nil, explicit: nil, fallback: fallback).path, "/default")
        let encoded = try DownloadDirectoryRules.decode(data("/rules"))
        XCTAssertEqual(encoded.directory(url: "https://cdn.example.test/archive%2Ezip", filename: nil, explicit: nil, fallback: fallback).path, "/rules")
    }

    func testCreationPersistsRuleDirectoryAndReloadDoesNotMoveExistingTasks() async throws {
        let root = try directory(), ruleFile = root.appendingPathComponent("directory-rules.json")
        try data(root.appendingPathComponent("rules").path).write(to: ruleFile)
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root.appendingPathComponent("default"), useCategoryFolders: true), supportRoot: root)
        let created = try await manager.createURL("https://cdn.example.test/a.bin", filename: "archive.zip", autoStart: false)
        let task = try XCTUnwrap(created)
        XCTAssertEqual(task.folderPath, root.appendingPathComponent("rules").path)
        let explicit = try await manager.createURL("https://cdn.example.test/b.zip", destinationDirectory: root.appendingPathComponent("chosen"), autoStart: false)
        XCTAssertEqual(explicit?.folderPath, root.appendingPathComponent("chosen").path)
        try data(root.appendingPathComponent("new-rules").path).write(to: ruleFile)
        try await manager.reloadDirectoryRules()
        let next = try await manager.createURL("https://cdn.example.test/c.zip", autoStart: false)
        XCTAssertEqual(next?.folderPath, root.appendingPathComponent("new-rules").path)
        XCTAssertEqual(try store.allDownloads().first { $0.id == task.id }?.folderPath, task.folderPath)
    }

    func testActualHTTPArtifactUsesRuleDestination() async throws {
        let root = try directory()
        try data(root.appendingPathComponent("artifacts").path, host: "127.0.0.1").write(to: root.appendingPathComponent("directory-rules.json"))
        let payload = Data(repeating: 0x5e, count: 32768)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root.appendingPathComponent("default")), supportRoot: root)
        let created = try await manager.createURL(server.baseURL.absoluteString, filename: "fixture.zip")
        let task = try XCTUnwrap(created)
        let deadline = Date().addingTimeInterval(10)
        while try store.allDownloads().first(where: { $0.id == task.id })?.status != .complete {
            guard Date() < deadline else { await manager.pause(taskID: task.id); XCTFail("Rule download did not finish"); return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("artifacts/fixture.zip")), payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("default/fixture.zip").path))
    }

    func testInvalidConfigPreservesFileAndRejectsOnlyImplicitNewDestinations() async throws {
        let root = try directory(), file = root.appendingPathComponent("directory-rules.json")
        let damaged = Data("{\"version\":99,\"enabled\":true,\"rules\":[]}".utf8)
        try damaged.write(to: file)
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        do { _ = try await manager.createURL("https://cdn.example.test/a.zip", autoStart: false); XCTFail("Corrupt rules were silently ignored") }
        catch {}
        XCTAssertTrue(try store.allDownloads().isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), damaged)
        let explicit = try await manager.createURL("https://cdn.example.test/a.zip", destinationDirectory: root.appendingPathComponent("explicit"), autoStart: false)
        XCTAssertNotNil(explicit)
    }
}
