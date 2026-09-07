import XCTest
@testable import NDMEngine
@testable import NDMCore

/// `DownloadTask` has carried `method` and `postData` since the storage layer was
/// written, and `DownloadRequest` forwards both, but the transfer path used to
/// hardcode GET. A form-triggered download therefore hit the endpoint with the
/// wrong verb and no body, silently producing the wrong bytes instead of failing.
final class PostDownloadTests: XCTestCase {
    private func makeSandbox(_ label: String) throws -> (support: URL, dest: URL) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-\(label)-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        return (support, dest)
    }

    func testPostTaskSendsPostWithBodyOnEveryRequest() async throws {
        let payload = Data(repeating: 0x2B, count: 96 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let (support, dest) = try makeSandbox("post-verb")
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let body = "token=abc123&file=report.pdf"
        var task = DownloadTask(
            url: "http://127.0.0.1:\(server.port)/export",
            method: "POST",
            filename: "report.pdf",
            status: .incomplete,
            connections: 2,
            postData: Data(body.utf8),
            folderPath: dest.path
        )
        task = try store.insert(task)

        try await manager.startAndWait(taskID: task.id)

        let methods = server.recordedMethods
        XCTAssertFalse(methods.isEmpty, "the engine must have reached the server")
        XCTAssertTrue(
            methods.allSatisfy { $0 == "POST" },
            "every request must use the task's method, saw: \(methods)"
        )
        XCTAssertTrue(
            server.recordedBodies.allSatisfy { $0.contains(body) },
            "every POST must carry the task's body, saw: \(server.recordedBodies)"
        )

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(
            try Data(contentsOf: dest.appendingPathComponent(done.filename)),
            payload,
            "a POST download must still assemble to the exact remote bytes"
        )
    }

    func testBridgeDownloadPreservesAuthenticatedBrowserRequestContext() async throws {
        let payload = Data(repeating: 0x4E, count: 64 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let (support, dest) = try makeSandbox("bridge-auth-context")
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var message = ParsedBridgeMessage()
        message.method = "POST"
        message.url = "http://127.0.0.1:\(server.port)/authenticated-export"
        message.filename = "authenticated.bin"
        message.pageURL = "https://app.example.com/report/42"
        message.pageTitle = "Authenticated export"
        message.cookies = "session=live; entitlement=pro"
        message.userAgent = "Relay Test Browser"
        message.referer = "https://embed.example.com/frame/42"
        message.origin = "https://embed.example.com"
        message.reqContentType = "application/x-www-form-urlencoded"
        message.extraHeaders["Authorization"] = "Bearer test-token"
        message.extraHeaders["Accept"] = "application/octet-stream"
        message.extraHeaders["Accept-Language"] = "zh-CN,zh;q=0.9"
        message.extraHeaders["X-Download-Nonce"] = "nonce-42"
        message.postData = "export=42"

        let task = try await manager.addFromBridge(message)
        try await manager.startAndWait(taskID: task.id)

        XCTAssertFalse(server.recordedHeaders.isEmpty)
        for headers in server.recordedHeaders {
            XCTAssertEqual(headers["cookie"], "session=live; entitlement=pro")
            XCTAssertEqual(headers["authorization"], "Bearer test-token")
            XCTAssertEqual(headers["referer"], "https://embed.example.com/frame/42")
            XCTAssertEqual(headers["origin"], "https://embed.example.com")
            XCTAssertEqual(headers["user-agent"], "Relay Test Browser")
            XCTAssertEqual(headers["accept"], "application/octet-stream")
            XCTAssertEqual(headers["accept-language"], "zh-CN,zh;q=0.9")
            XCTAssertEqual(headers["x-download-nonce"], "nonce-42")
            XCTAssertEqual(headers["content-type"], "application/x-www-form-urlencoded")
        }
        XCTAssertTrue(server.recordedMethods.allSatisfy { $0 == "POST" })
        XCTAssertTrue(server.recordedBodies.allSatisfy { $0.contains("export=42") })
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent("authenticated.bin")), payload)
    }

    func testPostTaskProbesWithItsOwnMethodInsteadOfHEAD() async throws {
        let payload = Data(repeating: 0x7C, count: 64 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let (support, dest) = try makeSandbox("post-probe")
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var task = DownloadTask(
            url: "http://127.0.0.1:\(server.port)/export",
            method: "POST",
            filename: "export.bin",
            status: .incomplete,
            connections: 1,
            postData: Data("q=1".utf8),
            folderPath: dest.path
        )
        task = try store.insert(task)

        try await manager.startAndWait(taskID: task.id)

        // A body-bearing endpoint commonly 405s on HEAD, or reports the size of a
        // landing page rather than the attachment. Sizing the plan from that is how
        // POST downloads end up truncated, so the probe must use the real method.
        XCTAssertFalse(
            server.recordedMethods.contains("HEAD"),
            "a POST task must not be sized by a HEAD probe, saw: \(server.recordedMethods)"
        )
    }

    /// Regression guard for a field overload that makes the obvious fix dangerous:
    /// `DownloadManager` also stores serialized `YtDlpDownloadOptions` in
    /// `postData` for media tasks. Those tasks keep method GET, so honouring the
    /// body must stay gated on the method — otherwise media option JSON would be
    /// POSTed to the origin.
    func testGetTaskWithStoredMediaOptionsNeverSendsABody() async throws {
        let payload = Data(repeating: 0x11, count: 64 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let (support, dest) = try makeSandbox("get-no-body")
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let mediaOptions = Data(#"{"container":"compatibleMP4","height":1080}"#.utf8)
        var task = DownloadTask(
            url: "http://127.0.0.1:\(server.port)/clip.bin",
            filename: "clip.bin",
            status: .incomplete,
            connections: 2,
            postData: mediaOptions,
            folderPath: dest.path
        )
        task = try store.insert(task)

        try await manager.startAndWait(taskID: task.id)

        XCTAssertFalse(
            server.recordedMethods.contains("POST"),
            "a GET task must never be promoted to POST, saw: \(server.recordedMethods)"
        )
        XCTAssertTrue(
            server.recordedBodies.allSatisfy { $0.isEmpty },
            "stored media options must never leak into a request body, saw: \(server.recordedBodies)"
        )
        XCTAssertEqual(
            try Data(contentsOf: dest.appendingPathComponent("clip.bin")),
            payload
        )
    }
}
