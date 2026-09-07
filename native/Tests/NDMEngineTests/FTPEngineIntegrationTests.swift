import XCTest
@testable import NDMEngine
@testable import NDMCore

final class FTPEngineIntegrationTests: XCTestCase {
    func testParsePASV() {
        let parsed = FTPEngine.parsePASV("227 Entering Passive Mode (127,0,0,1,20,45)")
        XCTAssertEqual(parsed?.host, "127.0.0.1")
        XCTAssertEqual(parsed?.port, 20 * 256 + 45)
    }

    func testFTPDownload() async throws {
        let payload = Data("hello-ftp-world-\(UUID().uuidString)".utf8)
        let server = LocalFTPServer(files: ["/file.bin": payload], username: "u", password: "p")
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ftp-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var url = server.url(path: "file.bin")
        // Embed credentials
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.user = "u"
        comps.password = "p"
        url = comps.url!

        let task = try await manager.addURL(url.absoluteString)
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        let fileURL = dest.appendingPathComponent(done.filename)
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)
    }

    func testFTPResumeWithREST() async throws {
        var payload = Data(count: 32 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8(i % 251) }

        let server = LocalFTPServer(files: ["/big.bin": payload], username: "u", password: "p")
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ftp-resume-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var comps = URLComponents(url: server.url(path: "big.bin"), resolvingAgainstBaseURL: false)!
        comps.user = "u"
        comps.password = "p"
        let task = try await manager.addURL(comps.url!.absoluteString)

        // Pre-seed partial file (first 8 KiB)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try payload.subdata(in: 0..<8192).write(to: work.appendingPathComponent("ftp.partial"))

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }
}
