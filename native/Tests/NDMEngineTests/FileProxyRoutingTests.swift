import XCTest
@testable import NDMCore
@testable import NDMEngine

final class FileProxyRoutingTests: XCTestCase {
    func testHTTPSLoopbackRemainsBlockedUntilSystemTunnelBypassIsSolved() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let request = DownloadRequest(url: URL(string: "https://127.0.0.1:1/fixture.bin")!,
            destinationDirectory: root, suggestedFilename: "payload.bin")
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: root.appendingPathComponent("work"),
            socksProxy: .init(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
        do { _ = try await engine.start(); XCTFail("HTTPS loopback must not silently bypass the adapter") }
        catch ProxyURLPolicy.Failure.loopbackDestination { }
        XCTAssertTrue(proxy.recordedRoutes.isEmpty)
    }

    func testSOCKSLoopbackPauseAndResumeKeepsExactBytes() async throws {
        let payload = Data((0..<(2 * 1024 * 1024)).map { UInt8(truncatingIfNeeded: $0 &* 17 &+ ($0 >> 16)) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 16384, bodyChunkDelay: { _ in 0.01 })
        try server.start(); defer { server.stop() }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 2,
            destinationDirectory: root, suggestedFilename: "payload.bin")
        let work = root.appendingPathComponent("work")
        let settings = SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true)
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work, socksProxy: settings)
        let run = Task { try await engine.start() }
        let deadline = Date().addingTimeInterval(5)
        while await engine.currentProgress().completedBytes < 131072 && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let before = await engine.currentProgress()
        XCTAssertGreaterThan(before.completedBytes, 0)
        await engine.pause()
        do { _ = try await run.value; XCTFail("Expected pause") } catch EngineError.paused { }
        let priorRoutes = proxy.recordedRoutes.count
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(proxy.recordedRoutes.count, priorRoutes)
        let resumed = DownloadEngine(taskID: 1, request: request, workDirectory: work, socksProxy: settings)
        let output = try await resumed.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertGreaterThan(proxy.recordedRoutes.count, priorRoutes)
        XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.host == "127.0.0.1" })
    }

    func testSOCKSRedirectKeepsLoopbackProbeAndStreamOnProxy() async throws {
        for legacy in [false, true] {
            let server = LocalRedirectServer(payload: Data(repeating: 7, count: 65536),
                hosts: ["redirect-proxy.ndm.invalid", "127.0.0.1"])
            try server.start(); defer { server.stop() }
            let proxy = LocalProtocolProxy()
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let work = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            if legacy {
                let plan = SegmentFileFormat.planDynamicConnections(totalBytes: 65536, connections: 1, completedPrefixBytes: 0)
                try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            }
            var request = DownloadRequest(url: server.url, connections: 1,
                destinationDirectory: root, suggestedFilename: "payload.bin")
            request.headers = ["Cookie": "session=fixture", "Authorization": "Bearer fixture"]
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work,
                socksProxy: .init(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
            let final = try await engine.start()
            XCTAssertEqual(try Data(contentsOf: final), Data(repeating: 7, count: 65536))
            XCTAssertFalse(server.requests.isEmpty)
            XCTAssertTrue(server.requests.contains { $0.stage == 1 })
            XCTAssertTrue(server.requests.filter { $0.stage == 0 }.allSatisfy { $0.headers["cookie"] == "session=fixture" })
            XCTAssertTrue(server.requests.filter { $0.stage == 1 }.allSatisfy { $0.headers["cookie"] == nil && $0.headers["authorization"] == nil })
            XCTAssertTrue(server.requests.allSatisfy { $0.headers["proxy-authorization"] == nil })
            XCTAssertEqual(server.requests.first?.method, "GET")
            XCTAssertEqual(server.requests.first?.headers["range"], legacy ? "bytes=0-0" : "bytes=0-")
            XCTAssertEqual(Set(proxy.recordedRoutes.map { $0.host }), ["redirect-proxy.ndm.invalid", "127.0.0.1"])
        }
    }

    func testSOCKSLoopbackDoesNotSilentlyDownloadDirectly() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 7, count: 65536))
        try server.start(); defer { server.stop() }
        for version in [SocksVersion.v4, .v5] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let request = DownloadRequest(url: server.baseURL, connections: 1,
                destinationDirectory: root, suggestedFilename: "payload.bin")
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: root.appendingPathComponent("work"),
                socksProxy: .init(host: "127.0.0.1", port: 1, version: version, enabled: true))
            do { _ = try await engine.start(); XCTFail("Unavailable SOCKS proxy must not be bypassed") }
            catch { }
            XCTAssertTrue(server.recordedRanges.isEmpty)
            XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("payload.bin").path))
        }
    }

    func testSOCKSRemoteNameStillDownloadsThroughProxy() async throws {
        let payload = Data(repeating: 13, count: 65536)
        let server = LocalRangeServer(payload: payload)
        try server.start(); defer { server.stop() }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var url = URLComponents(url: server.baseURL, resolvingAgainstBaseURL: false)!
        url.host = "file-proxy.ndm.invalid"
        let request = DownloadRequest(url: url.url!, connections: 1,
            destinationDirectory: root, suggestedFilename: "payload.bin")
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: root.appendingPathComponent("work"),
            socksProxy: .init(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
        let output = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertFalse(proxy.recordedRoutes.isEmpty)
        XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.kind == "socks5" && $0.host == "file-proxy.ndm.invalid" })
    }
}
