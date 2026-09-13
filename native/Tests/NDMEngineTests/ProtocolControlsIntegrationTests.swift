import XCTest
@testable import NDMEngine
@testable import NDMCore

final class ProtocolControlsIntegrationTests: XCTestCase {
    private let payload = Data(repeating: 0x47, count: 196_608)
    private let playlist = Data("#EXTM3U\n#EXTINF:1,\npayload.ts\n#EXT-X-ENDLIST\n".utf8)

    func testFTPRejectsInvalidEndpointPortsWithoutIntegerTraps() async throws {
        for port in [0, 70000] {
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = ftp(URL(string: "ftp://localhost:\(port)/payload.bin")!, root: root)
            do { _ = try await engine.start(); XCTFail("Invalid FTP port must fail before transport") }
            catch EngineError.invalidResponse { }
        }
        for response in ["227 (127,0,0,1,256,1)", "227 (127,0,0,1,-1,1)", "227 (127,0,0,1,0,0)", "227 (999,0,0,1,1,1)", "227 (127,0,0,1,1,1,1)"] {
            XCTAssertNil(FTPEngine.parsePASV(response))
        }
    }

    func testFTPInitialCapAndRuntimeUnlimited() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = ftp(server.url(path: "payload.bin"), root: root, cap: 65_536, global: 1)
        let initial = await engine.currentProgress()
        XCTAssertEqual(initial.effectiveBandwidthLimitBytesPerSecond, 65_536, "Per-task cap overrides default")
        let finished = expectation(description: "FTP limit updated in flight")
        let run = Task { defer { finished.fulfill() }; return try await engine.start() }
        try await Task.sleep(nanoseconds: 1_200_000_000)
        let limited = await engine.currentProgress()
        XCTAssertEqual(limited.status, .downloading)
        XCTAssertLessThanOrEqual(limited.completedBytes, 131_072)
        XCTAssertGreaterThan(limited.completedBytes, 0)
        await engine.applyBandwidthLimit(0)
        await fulfillment(of: [finished], timeout: 2)
        let url = try await run.value
        XCTAssertEqual(try Data(contentsOf: url), payload)
        let done = await engine.currentProgress()
        XCTAssertEqual(done.effectiveBandwidthLimitBytesPerSecond, 0)
    }

    func testFTPThrottlePauseIsPromptAndPreservesPartial() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = ftp(server.url(path: "payload.bin"), root: root, global: 1)
        let finished = expectation(description: "FTP pause wakes blocked quota")
        let run = Task { () -> Bool in
            defer { finished.fulfill() }
            do { _ = try await engine.start(); return false }
            catch EngineError.paused { return true }
            catch { return false }
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        let before = Date()
        await engine.pause()
        await fulfillment(of: [finished], timeout: 0.5)
        await engine.applyBandwidthLimit(0)
        let paused = await run.value
        XCTAssertTrue(paused)
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.7)
        let partial = root.appendingPathComponent("work/ftp.partial")
        XCTAssertTrue(FileManager.default.fileExists(atPath: partial.path))
        let bytes = try Data(contentsOf: partial)
        try await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(try Data(contentsOf: partial), bytes)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("out/payload.bin").path))
    }

    func testFTPHTTPProxyTunnelsBothControlAndDataWithCredentials() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let url = replacedHost(server.url(path: "payload.bin"), "ftp-target.ndm.invalid")
        let engine = ftp(url, root: root, http: ProxySettings(host: "127.0.0.1", port: proxy.port, username: "proxy-user", password: "proxy-pass", enabled: true))
        let output = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        let routes = proxy.recordedRoutes
        XCTAssertEqual(routes.count, 2)
        XCTAssertEqual(routes.map(\.kind), ["connect", "connect"])
        XCTAssertEqual(routes.first?.host, "ftp-target.ndm.invalid")
        XCTAssertEqual(routes.first?.port, server.port)
        XCTAssertNotEqual(routes.last?.port, server.port)
        XCTAssertTrue(routes.allSatisfy { $0.authorization == "Basic " + Data("proxy-user:proxy-pass".utf8).base64EncodedString() })
    }

    func testFTPDataProxyFailureCannotBecomeDirectDownload() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let proxy = LocalProtocolProxy(rejectRoute: 2)
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = ftp(server.url(path: "payload.bin"), root: root, http: ProxySettings(host: "127.0.0.1", port: proxy.port, enabled: true))
        do { _ = try await engine.start(); XCTFail("Rejected data tunnel must not connect directly") }
        catch FTPError.proxyConnectFailed(let status) { XCTAssertEqual(status, 502) }
        XCTAssertEqual(proxy.recordedRoutes.count, 2)
        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.status, .error)
        XCTAssertEqual(progress.completedBytes, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("out/payload.bin").path))
    }

    func testFTPSOCKS5UsesProxyDNSForControlAndProxiesData() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let url = replacedHost(server.url(path: "payload.bin"), "socks-target.ndm.invalid")
        let engine = ftp(url, root: root,
            http: ProxySettings(host: "127.0.0.1", port: 1, enabled: true),
            socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
        let output = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertEqual(proxy.recordedRoutes.map(\.kind), ["socks5", "socks5"])
        XCTAssertEqual(proxy.recordedRoutes.first?.host, "socks-target.ndm.invalid", "The system SOCKS5 transport sends the name to the proxy")
    }

    func testFTPSOCKS4RemainsVersionFourAndRejectDoesNotFallBack() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        for reject in [false, true] {
            let proxy = LocalProtocolProxy(rejectRoute: reject ? 2 : nil)
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = ftp(replacedHost(server.url(path: "payload.bin"), "localhost"), root: root,
                socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v4, enabled: true))
            if reject {
                do { _ = try await engine.start(); XCTFail("Rejected SOCKS data route must fail") } catch { }
            } else {
                let output = try await engine.start()
                XCTAssertEqual(try Data(contentsOf: output), payload)
            }
            XCTAssertEqual(proxy.recordedRoutes.map(\.kind), ["socks4", "socks4"])
        }
    }

    func testFTPSOCKS5DataRejectionFailsWithoutDirectFallback() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        let proxy = LocalProtocolProxy(rejectRoute: 2)
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = ftp(server.url(path: "payload.bin"), root: root,
            socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
        do { _ = try await engine.start(); XCTFail("SOCKS5 rejected data channel must fail") }
        catch FTPError.socksConnectFailed(let status) { XCTAssertEqual(status, 5) }
        XCTAssertEqual(proxy.recordedRoutes.count, 2)
        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.completedBytes, 0)
        XCTAssertEqual(progress.status, .error)
    }

    func testFTPSOCKS5AuthenticatesBothChannelsAndAcceptsFragmentedReplies() async throws {
        let server = LocalFTPServer(files: ["payload.bin": payload])
        try server.start(); defer { XCTAssertTrue(server.stop()) }
        for validPassword in [true, false] {
            let proxy = LocalProtocolProxy(credentials: ("socks-user", "socks-pass"), fragmentReplies: true)
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = ftp(replacedHost(server.url(path: "payload.bin"), "auth-socks.ndm.invalid"), root: root,
                socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v5,
                    username: "socks-user", password: validPassword ? "socks-pass" : "wrong", enabled: true))
            if validPassword {
                let output = try await engine.start()
                XCTAssertEqual(try Data(contentsOf: output), payload)
                XCTAssertEqual(proxy.authenticatedConnections, 2)
                XCTAssertEqual(proxy.recordedRoutes.count, 2)
            } else {
                do { _ = try await engine.start(); XCTFail("Rejected SOCKS credentials cannot continue") }
                catch FTPError.socksConnectFailed { }
                XCTAssertEqual(proxy.authenticatedConnections, 0)
                XCTAssertTrue(proxy.recordedRoutes.isEmpty)
            }
        }
    }

    func testManagerPropagatesDefaultAndPerTaskCapsToFTPAndHLSWhileRunning() async throws {
        let ftpServer = LocalFTPServer(files: ["payload.bin": payload])
        try ftpServer.start(); defer { XCTAssertTrue(ftpServer.stop()) }
        let hlsServer = hlsServer()
        try hlsServer.start(); defer { hlsServer.stop() }
        for isFTP in [true, false] {
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let support = root.appendingPathComponent("support")
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            let store = try DownloadStore(directory: support)
            var settings = AppSettings(downloadDirectory: root.appendingPathComponent("out"), maxConnections: 32,
                useCategoryFolders: false, bandwidthLimitBytesPerSecond: 1)
            let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
            var url = isFTP ? ftpServer.url(path: "payload.bin") : hlsServer.url(path: "stream.m3u8")
            if isFTP {
                var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
                components.user = "user"; components.password = "pass"; url = components.url!
            }
            let task = try await manager.addURL(url.absoluteString, ltype: isFTP ? "normal" : "hls")
            try await manager.start(taskID: task.id)
            var progress = await manager.progress(taskID: task.id)
            XCTAssertEqual(progress?.effectiveBandwidthLimitBytesPerSecond, 1)
            try await manager.applyBandwidth(taskID: task.id, bytesPerSecond: 2048)
            progress = await manager.progress(taskID: task.id)
            XCTAssertEqual(progress?.effectiveBandwidthLimitBytesPerSecond, 2048)
            settings.bandwidthLimitBytesPerSecond = 4096
            await manager.updateSettings(settings)
            progress = await manager.progress(taskID: task.id)
            XCTAssertEqual(progress?.effectiveBandwidthLimitBytesPerSecond, 2048)
            try await manager.applyBandwidth(taskID: task.id, bytesPerSecond: 0)
            progress = await manager.progress(taskID: task.id)
            XCTAssertEqual(progress?.effectiveBandwidthLimitBytesPerSecond, 4096)
            settings.bandwidthLimitBytesPerSecond = 0
            await manager.updateSettings(settings)
            for _ in 0..<200 {
                if await manager.progress(taskID: task.id)?.status == .complete { break }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            progress = await manager.progress(taskID: task.id)
            await manager.pause(taskID: task.id) // Drain safely if a regression leaves the transfer active.
            XCTAssertEqual(progress?.status, .complete)
            XCTAssertEqual(progress?.effectiveBandwidthLimitBytesPerSecond, 0)
            let done = try await manager.listTasks().first { $0.id == task.id }!
            XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("out").appendingPathComponent(done.filename)), payload)
        }
    }

    func testHLSInitialCapAndRuntimeUnlimited() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(server.url(path: "stream.m3u8"), root: root, cap: 65_536, global: 1)
        let initial = await engine.currentProgress()
        XCTAssertEqual(initial.effectiveBandwidthLimitBytesPerSecond, 65_536)
        let finished = expectation(description: "HLS runtime unlimited completes")
        let run = Task { defer { finished.fulfill() }; return try await engine.start() }
        try await Task.sleep(nanoseconds: 1_200_000_000)
        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.status, .downloading)
        let files = try FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("work"), includingPropertiesForKeys: nil)
        let transfer = try XCTUnwrap(files.first { $0.lastPathComponent.hasPrefix(".hls-network-") })
        let transferred = try Data(contentsOf: transfer).count
        XCTAssertGreaterThan(transferred, 0)
        XCTAssertLessThanOrEqual(transferred, 131_072)
        await engine.applyBandwidthLimit(0)
        await fulfillment(of: [finished], timeout: 3)
        let output = try await run.value
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("work").path).contains { $0.hasPrefix(".hls-network-") })
    }

    func testHLSPauseWhileThrottledIsPromptAndTemporaryFileIsRemoved() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(server.url(path: "stream.m3u8"), root: root, global: 1024)
        let finished = expectation(description: "HLS pause wakes stream limiter")
        let run = Task { () -> Bool in
            defer { finished.fulfill() }
            do { _ = try await engine.start(); return false }
            catch EngineError.paused { return true }
            catch { return false }
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        await engine.pause()
        await fulfillment(of: [finished], timeout: 0.5)
        await engine.applyBandwidthLimit(0)
        let paused = await run.value
        XCTAssertTrue(paused)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("work").path).contains { $0.hasPrefix(".hls-network-") })
        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.status, .paused)
    }

    func testHLSLiveStopWakesQuotaAndSavesOnlyCommittedSegments() async throws {
        let captured = Data("already-captured".utf8)
        let live = Data("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfirst.ts\n#EXTINF:1,\nsecond.ts\n".utf8)
        let server = LocalHLSServer(files: ["stream.m3u8": live, "first.ts": captured, "second.ts": payload])
        try server.start(); defer { server.stop() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(server.url(path: "stream.m3u8"), root: root, global: 1024)
        let finished = expectation(description: "Live HLS stop interrupts quota and saves committed data")
        let run = Task { defer { finished.fulfill() }; return try await engine.start() }
        for _ in 0..<100 {
            if await engine.currentProgress().completedBytes > 0 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let recording = await engine.currentProgress()
        XCTAssertTrue(recording.isLiveRecording)
        XCTAssertEqual(recording.completedBytes, Int64(captured.count))
        await engine.pause()
        await fulfillment(of: [finished], timeout: 1)
        await engine.applyBandwidthLimit(0)
        let output = try await run.value
        XCTAssertEqual(try Data(contentsOf: output), captured)
        let completed = await engine.currentProgress()
        XCTAssertEqual(completed.status, .complete)
    }

    func testHLSHTTPProxyCoversPlaylistProbesAndSegment() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(replacedHost(server.url(path: "stream.m3u8"), "hls-target.ndm.invalid"), root: root,
            http: ProxySettings(host: "127.0.0.1", port: proxy.port, username: "hls-user", password: "hls-pass", enabled: true))
        let output = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertGreaterThanOrEqual(proxy.recordedRoutes.count, 3)
        XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.host == "hls-target.ndm.invalid" && $0.kind == "http" })
        XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.authorization == "Basic " + Data("hls-user:hls-pass".utf8).base64EncodedString() })
    }

    func testHLSSOCKS5UsesRemoteDomainAndProxyErrorsDoNotFallBack() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        for reject in [false, true] {
            let proxy = LocalProtocolProxy(rejectRoute: reject ? 1 : nil)
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = hls(replacedHost(server.url(path: "stream.m3u8"), "hls-socks.ndm.invalid"), root: root,
                http: ProxySettings(host: "127.0.0.1", port: 1, enabled: true),
                socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v5, enabled: true))
            if reject {
                do { _ = try await engine.start(); XCTFail("SOCKS rejection must fail HLS") } catch { }
            } else {
                let output = try await engine.start()
                XCTAssertEqual(try Data(contentsOf: output), payload)
            }
            XCTAssertFalse(proxy.recordedRoutes.isEmpty)
            XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.kind == "socks5" && $0.host == "hls-socks.ndm.invalid" })
        }
    }

    func testHLSSOCKS4ProxiesRemoteIPv4PlaylistProbeAndSegment() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        // Documentation-only TEST-NET address: only the proxy maps this to the fixture.
        let engine = hls(replacedHost(server.url(path: "stream.m3u8"), "192.0.2.1"), root: root,
            socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: .v4, enabled: true))
        let finished = expectation(description: "SOCKS4 reaches local fixture through proxy")
        let run = Task { defer { finished.fulfill() }; return try await engine.start() }
        await fulfillment(of: [finished], timeout: 3)
        if await engine.currentProgress().status != .complete { await engine.cancel() }
        let output = try await run.value
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertEqual(proxy.recordedRoutes.count, 3)
        XCTAssertTrue(proxy.recordedRoutes.allSatisfy { $0.kind == "socks4" && $0.host == "192.0.2.1" })
    }

    func testHLSProxyRejectsLoopbackBeforeAnyOriginRequest() async throws {
        let server = hlsServer()
        try server.start(); defer { server.stop() }
        for version in [SocksVersion.v4, .v5] {
            let proxy = LocalProtocolProxy()
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = hls(server.url(path: "stream.m3u8"), root: root,
                socks: SocksProxySettings(host: "127.0.0.1", port: proxy.port, version: version, enabled: true))
            do { _ = try await engine.start(); XCTFail("Proxy mode must not directly dispatch loopback HLS") }
            catch HLSProxyURLPolicy.Failure.loopbackDestination { }
            XCTAssertTrue(server.receivedRequests.isEmpty)
            XCTAssertTrue(proxy.recordedRoutes.isEmpty)
        }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(server.url(path: "stream.m3u8"), root: root,
            http: ProxySettings(host: "127.0.0.1", port: 1, enabled: true))
        do { _ = try await engine.start(); XCTFail("Unreachable HTTP proxy must not cause direct loopback request") }
        catch HLSProxyURLPolicy.Failure.loopbackDestination { }
        XCTAssertTrue(server.receivedRequests.isEmpty)
    }

    func testHLSProxyRecognizesLoopbackAliasesWithoutResolvingRemoteNames() throws {
        for host in ["127.0.0.1", "127.2.3.4", "localhost", "localhost.", "sub.localhost", "2130706433", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]"] {
            let url = try XCTUnwrap(URL(string: "http://\(host):8080/stream.m3u8"))
            XCTAssertThrowsError(try HLSProxyURLPolicy.validate(url, requiresProxy: true), host)
            XCTAssertNoThrow(try HLSProxyURLPolicy.validate(url, requiresProxy: false), host)
        }
        for host in ["hls-socks.ndm.invalid", "192.0.2.1", "[2001:db8::1]"] {
            XCTAssertNoThrow(try HLSProxyURLPolicy.validate(URL(string: "https://\(host)/stream.m3u8")!, requiresProxy: true))
        }
    }

    func testHLSProxyRejectsLoopbackDerivedSegmentAndRedirectBeforeDispatch() async throws {
        let destination = hlsServer()
        try destination.start(); defer { destination.stop() }
        let loopback = destination.url(path: "payload.ts").absoluteString
        for isRedirect in [false, true] {
            let media = Data("#EXTM3U\n#EXTINF:1,\n\(loopback)\n#EXT-X-ENDLIST\n".utf8)
            let server = LocalHLSServer(files: ["stream.m3u8": media], redirects: isRedirect ? ["stream.m3u8": loopback] : [:])
            try server.start(); defer { server.stop() }
            let proxy = LocalProtocolProxy()
            try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
            let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = hls(replacedHost(server.url(path: "stream.m3u8"), "proxy-redirect.ndm.invalid"), root: root,
                http: ProxySettings(host: "127.0.0.1", port: proxy.port, enabled: true))
            do { _ = try await engine.start(); XCTFail("Derived/redirect loopback URL must not dispatch") }
            catch HLSProxyURLPolicy.Failure.loopbackDestination { }
            XCTAssertTrue(destination.receivedRequests.isEmpty)
            XCTAssertEqual(server.receivedRequests.count, 1)
            XCTAssertEqual(proxy.recordedRoutes.count, 1)
        }
    }

    func testHLSProxyHeadRedirectCannotContactLoopbackButSegmentCanStillDownload() async throws {
        let destination = hlsServer()
        try destination.start(); defer { destination.stop() }
        let server = LocalHLSServer(files: ["stream.m3u8": playlist, "payload.ts": payload],
            redirects: ["HEAD payload.ts": destination.url(path: "payload.ts").absoluteString])
        try server.start(); defer { server.stop() }
        let proxy = LocalProtocolProxy()
        try proxy.start(); defer { XCTAssertTrue(proxy.stop()) }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let engine = hls(replacedHost(server.url(path: "stream.m3u8"), "head-proxy.ndm.invalid"), root: root,
            http: ProxySettings(host: "127.0.0.1", port: proxy.port, enabled: true))
        let output = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertTrue(destination.receivedRequests.isEmpty)
        XCTAssertEqual(proxy.recordedRoutes.count, 3)
    }

    func testInvalidEnabledSOCKSDoesNotFallBackToWorkingDirectRoute() async throws {
        let ftpServer = LocalFTPServer(files: ["payload.bin": payload])
        try ftpServer.start(); defer { XCTAssertTrue(ftpServer.stop()) }
        let hlsServer = hlsServer()
        try hlsServer.start(); defer { hlsServer.stop() }
        let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
        let bad = SocksProxySettings(host: "", port: 1080, enabled: true)
        do { _ = try await ftp(ftpServer.url(path: "payload.bin"), root: root, socks: bad).start(); XCTFail() }
        catch EngineError.invalidResponse { }
        do { _ = try await hls(hlsServer.url(path: "stream.m3u8"), root: root, socks: bad).start(); XCTFail() }
        catch EngineError.invalidResponse { }
    }

    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-protocol-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("out"), withIntermediateDirectories: true)
        return root
    }
    private func replacedHost(_ url: URL, _ host: String) -> URL {
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.host = host
        return components.url!
    }
    private func ftp(_ url: URL, root: URL, cap: Int64 = 0, global: Int64 = 0, http: ProxySettings? = nil, socks: SocksProxySettings? = nil) -> FTPEngine {
        FTPEngine(taskID: 1, request: DownloadRequest(url: url, bandwidthLimitBytesPerSecond: cap, destinationDirectory: root.appendingPathComponent("out"),
            suggestedFilename: "payload.bin", username: "user", password: "pass"),
            workDirectory: root.appendingPathComponent("work"), ftpProxy: http, socksProxy: socks, globalBandwidthLimit: global)
    }
    private func hls(_ url: URL, root: URL, cap: Int64 = 0, global: Int64 = 0, http: ProxySettings? = nil, socks: SocksProxySettings? = nil) -> HLSEngine {
        HLSEngine(taskID: 1, request: DownloadRequest(url: url, bandwidthLimitBytesPerSecond: cap, destinationDirectory: root.appendingPathComponent("out"),
            suggestedFilename: "payload.ts"), workDirectory: root.appendingPathComponent("work"),
            httpProxy: http, socksProxy: socks, globalBandwidthLimit: global)
    }
    private func hlsServer() -> LocalHLSServer { LocalHLSServer(files: ["stream.m3u8": playlist, "payload.ts": payload]) }
}
