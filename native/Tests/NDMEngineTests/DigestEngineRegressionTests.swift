import XCTest
import NDMCore
@testable import NDMEngine

final class DigestEngineRegressionTests: XCTestCase {
    func testCrossOriginChallengeNeverReceivesOriginalCredentials() async throws {
        for rangeOnly in [false, true] {
            for basic in [false, true] {
                let target = VerifyingDigestServer(basicChallenge: basic)
                try target.start(); defer { target.stop() }
                let source = VerifyingDigestServer(redirectTo: target.url, redirectOnGetOnly: rangeOnly)
                try source.start(); defer { source.stop() }
                do { _ = try await download(source); XCTFail("Cross-origin credentials must not be reused") }
                catch is HTTPAuthenticationBoundary.Failure {}
                XCTAssertFalse(target.receivedAuthorization.isEmpty, "Redirect must actually reach the second server")
                XCTAssertTrue(target.receivedAuthorization.allSatisfy(\.isEmpty), "Second origin received credentials")
            }
        }
    }

    func testSHA256OriginAndForwardProxyVerifyActualRequests() async throws {
        for proxy in [false, true] {
            let server = VerifyingDigestServer(proxy: proxy, algorithm: "SHA-256")
            try server.start(); defer { server.stop() }
            let downloaded = try await download(server, proxy: proxy)
            XCTAssertEqual(downloaded, server.payload)
            XCTAssertTrue(server.rejected.isEmpty, "\(server.rejected)")
        }
    }
    private func download(_ server: VerifyingDigestServer, proxy: Bool = false) async throws -> Data {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-digest-\(UUID())")
        let destination = root.appendingPathComponent("out")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = proxy ? URL(string: "http://digest-fixture.invalid/encoded%2Ffile%20name.bin?token=a%2Bb&part=1")! : server.url
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: url, connections: 4,
            destinationDirectory: destination, suggestedFilename: "result.bin", username: "origin-user", password: "origin-pass"),
            workDirectory: root.appendingPathComponent("work"), httpProxy: proxy ? ProxySettings(host: "127.0.0.1", port: server.port,
                username: "proxy-user", password: "proxy-pass", enabled: true) : nil)
        return try Data(contentsOf: await engine.start())
    }
    func testActualHeadAndConcurrentRangesSignTheirEncodedRequestTarget() async throws {
        let server = VerifyingDigestServer()
        try server.start(); defer { server.stop() }
        let downloaded = try await download(server)
        XCTAssertEqual(downloaded, server.payload)
        XCTAssertTrue(server.rejected.isEmpty, "\(server.rejected)")
        XCTAssertTrue(server.accepted.contains { $0.method == "HEAD" })
        XCTAssertGreaterThanOrEqual(server.accepted.filter { $0.method == "GET" }.count, 4)
        XCTAssertTrue(server.accepted.allSatisfy { $0.target.contains("%2F") && $0.target.contains("?token=a%2Bb&part=1") })
    }
    func testNonceRefreshDuringConcurrentRangesKeepsValidSignatures() async throws {
        let server = VerifyingDigestServer(rotateAfter: 2)
        try server.start(); defer { server.stop() }
        let downloaded = try await download(server)
        XCTAssertEqual(downloaded, server.payload)
        XCTAssertTrue(server.rejected.isEmpty, "\(server.rejected)")
        XCTAssertTrue(server.accepted.contains { $0.nonce == "origin-2" })
    }
    func testProxyAndOriginHaveIndependentDigestCredentials() async throws {
        let server = VerifyingDigestServer(proxy: true)
        try server.start(); defer { server.stop() }
        let downloaded: Data
        do { downloaded = try await download(server, proxy: true) }
        catch { XCTFail("Verifier: \(server.rejected), accepted=\(server.accepted)"); throw error }
        XCTAssertEqual(downloaded, server.payload)
        XCTAssertTrue(server.rejected.isEmpty, "\(server.rejected)")
        XCTAssertTrue(server.accepted.contains { $0.proxy })
        XCTAssertTrue(server.accepted.contains { !$0.proxy })
        XCTAssertTrue(server.accepted.allSatisfy { $0.target.hasPrefix("http://") })
    }
}
