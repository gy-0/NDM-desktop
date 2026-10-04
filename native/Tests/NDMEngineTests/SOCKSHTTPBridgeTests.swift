import XCTest
import CFNetwork
@testable import NDMCore
@testable import NDMEngine

final class SOCKSHTTPBridgeTests: XCTestCase {
    func testBridgeRejectsMissingLocalCredentialBeforeSOCKSConnect() async throws {
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let bridge = SOCKSHTTPBridge(socks: .init(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
        defer { bridge.close() }
        let endpoint = try await bridge.start()
        let config = URLSessionConfiguration.ephemeral
        config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [kCFNetworkProxiesHTTPEnable as String: true,
            kCFNetworkProxiesHTTPProxy as String: endpoint.host,
            kCFNetworkProxiesHTTPPort as String: Int(endpoint.port)]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        do {
            let (_, response) = try await session.data(from: URL(string: "http://127.0.0.1:1/fixture.bin")!)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 407)
        } catch let error as URLError {
            XCTAssertEqual(error.code, .userAuthenticationRequired)
        }
        XCTAssertTrue(proxy.recordedRoutes.isEmpty)
        bridge.close() // Explicit and deferred close must both be safe.
    }

    func testAuthenticatedSOCKSBridgeTransfersLoopbackWithoutForwardingLocalCredential() async throws {
        for version in [SocksVersion.v4, .v5] {
            let data = Data(repeating: 17, count: 65536)
            let server = LocalRedirectServer(payload: data, hosts: ["127.0.0.1", "127.0.0.1"])
            try server.start(); defer { server.stop() }
            let proxy = LocalProtocolProxy(credentials: ("fixture", "password"))
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let bridge = SOCKSHTTPBridge(socks: .init(host: "127.0.0.1", port: proxy.port,
                version: version, username: "fixture", password: "password", enabled: true))
            defer { bridge.close() }
            let endpoint = try await bridge.start()
            let config = URLSessionConfiguration.ephemeral
            config.connectionProxyDictionary = [kCFNetworkProxiesHTTPEnable as String: true,
                kCFNetworkProxiesHTTPProxy as String: endpoint.host,
                kCFNetworkProxiesHTTPPort as String: Int(endpoint.port)]
            let session = URLSession(configuration: config)
            defer { session.invalidateAndCancel() }
            var request = URLRequest(url: server.url(at: 1))
            request.setValue("Basic " + Data("\(bridge.username):\(bridge.password)".utf8).base64EncodedString(), forHTTPHeaderField: "Proxy-Authorization")
            let (body, response) = try await session.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            XCTAssertEqual(body, data)
            XCTAssertFalse(proxy.recordedRoutes.isEmpty)
            XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.host == "127.0.0.1" })
            XCTAssertTrue(server.requests.allSatisfy { $0.headers["proxy-authorization"] == nil })
        }
    }
}
