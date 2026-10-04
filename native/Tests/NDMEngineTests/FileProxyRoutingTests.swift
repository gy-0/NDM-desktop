import XCTest
@testable import NDMCore
@testable import NDMEngine

final class FileProxyRoutingTests: XCTestCase {
    func testSOCKSRedirectCannotEscapeToLoopbackInProbeOrStream() async throws {
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
            let request = DownloadRequest(url: server.url, connections: 1,
                destinationDirectory: root, suggestedFilename: "payload.bin")
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work,
                socksProxy: .init(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
            do { _ = try await engine.start(); XCTFail("Redirect must not escape the SOCKS proxy") }
            catch ProxyURLPolicy.Failure.loopbackDestination { }
            XCTAssertFalse(server.requests.isEmpty)
            XCTAssertTrue(server.requests.allSatisfy { $0.stage == 0 })
            XCTAssertEqual(server.requests.first?.method, "GET")
            XCTAssertEqual(server.requests.first?.headers["range"], legacy ? "bytes=0-0" : "bytes=0-")
            XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.host == "redirect-proxy.ndm.invalid" })
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
            catch ProxyURLPolicy.Failure.loopbackDestination { }
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
