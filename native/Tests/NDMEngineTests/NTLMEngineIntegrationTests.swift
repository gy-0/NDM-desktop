import XCTest
@testable import NDMEngine
@testable import NDMCore

final class NTLMEngineIntegrationTests: XCTestCase {
    func testLocalNTLMServerHandshake() async throws {
        let payload = Data("ntlm-ok".utf8)
        let server = LocalNTLMServer(payload: payload)
        try server.start()
        defer { server.stop() }

        // Round 0: no auth
        let url = server.baseURL
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        let (_, r0) = try await URLSession.shared.data(for: req)
        let h0 = r0 as! HTTPURLResponse
        XCTAssertEqual(h0.statusCode, 401)
        let www0 = try XCTUnwrap(h0.value(forHTTPHeaderField: "WWW-Authenticate"))
        XCTAssertTrue(NTLMAuth.isNTLMChallenge(www0))

        // Round 1: Type1
        req.setValue(NTLMAuth.type1AuthorizationHeader(), forHTTPHeaderField: "Authorization")
        let (_, r1) = try await URLSession.shared.data(for: req)
        let h1 = r1 as! HTTPURLResponse
        XCTAssertEqual(h1.statusCode, 401)
        let www1 = try XCTUnwrap(h1.value(forHTTPHeaderField: "WWW-Authenticate"))
        let type2 = try XCTUnwrap(NTLMAuth.parseType2(from: www1))

        // Round 2: Type3
        req.setValue(
            NTLMAuth.type3AuthorizationHeader(type2: type2, username: "User", password: "Password"),
            forHTTPHeaderField: "Authorization"
        )
        let (data, r2) = try await URLSession.shared.data(for: req)
        let h2 = r2 as! HTTPURLResponse
        XCTAssertEqual(h2.statusCode, 200, "body=\(String(data: data, encoding: .utf8) ?? "")")
        XCTAssertEqual(data, payload)
    }

    func testNTLMDownload() async throws {
        var payload = Data(count: 32 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8(i % 251) }

        let server = LocalNTLMServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ntlm-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        _ = try store.insertAuth(AuthCredential(
            target: "127.0.0.1",
            protocolName: "http",
            username: "User",
            password: "Password"
        ))
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 1)
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete, done.errorText ?? "")
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }
}
