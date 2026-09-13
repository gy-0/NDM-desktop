import Foundation
import CryptoKit
import XCTest
import SQLite3
@testable import NDMCore
@testable import NDMEngine

final class AuxiliaryProxyTests: XCTestCase {
    private func required<T>(_ value: T?) throws -> T { try XCTUnwrap(value) }
    private func eq<T: Equatable>(_ actual: T, _ expected: T) { XCTAssertEqual(actual, expected) }
    private struct Fixture {
        let root: URL, support: URL, downloads: URL
        let store: DownloadStore; let daemon: AuxiliaryDaemon; let manager: DownloadManager; var settings: AppSettings
    }
    private func fixture() throws -> Fixture {
        guard let binary = ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"] else { throw XCTSkip("Set the digest-pinned local helper") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-aux-proxy-\(UUID())")
        let support = root.appendingPathComponent("support"), downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        var settings = AppSettings(); settings.downloadDirectory = downloads; settings.useCategoryFolders = false
        let daemon = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: root.appendingPathComponent("helper-state"), expectedSHA256: AuxiliaryBundledEngine.digest,
            peerDiscoveryEnabled: true, loopbackTransfersOnly: true))
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support, auxiliaryDaemon: daemon)
        addTeardownBlock { for task in try await manager.listTasks() { await manager.pause(taskID: task.id) }; await daemon.stop(); try FileManager.default.removeItem(at: root) }
        return .init(root: root, support: support, downloads: downloads, store: store, daemon: daemon, manager: manager, settings: settings)
    }
    private func wait(_ manager: DownloadManager, id: Int64, until condition: (AuxiliaryTaskStatus) -> Bool) async throws -> AuxiliaryTaskStatus {
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline {
            let state = try await manager.auxiliaryStatus(taskID: id)
            if condition(state) { return state }
            if state.phase == "error" || state.errorCode == "proxyUnavailable" {
                XCTFail((try await manager.task(id: id))?.errorText ?? "Unknown proxy transfer error"); throw AuxiliaryProxyError.proxyUnavailable
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw AuxiliaryRPCError.timeout
    }
    private func gid(_ f: Fixture, id: Int64) throws -> String {
        let data = try Data(contentsOf: f.support.appendingPathComponent("\(id)/auxiliary-0/auxiliary-task.json"))
        return try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["gid"] as? String)
    }
    func testProxyPriorityCredentialsEnvironmentAndUnsupportedConfigurations() throws {
        var settings = AppSettings()
        settings.httpProxy = .init(host: "proxy.test", port: 8080, enabled: true)
        settings.socksProxy = .init(host: "::1", port: 1080, username: "fixture-user", password: "p@ss/%", enabled: true)
        let plan = AuxiliaryProxyPlan(settings: settings)
        XCTAssertEqual(plan.mode, .socks5); XCTAssertTrue(plan.uri.hasPrefix("socks5://fixture-user:p%40ss%2F%25@[::1]:1080/"))
        let environment = plan.environment(from: ["HTTP_PROXY": "old", "https_proxy": "old", "Sftp_Proxy": "old", "ALL_PROXY": "old", "NO_PROXY": "*", "PATH": "/usr/bin"])
        XCTAssertEqual(environment.count, 2); XCTAssertEqual(environment["PATH"], "/usr/bin")
        XCTAssertTrue(environment["ALL_PROXY"]?.hasPrefix("socks5h://") == true)
        XCTAssertThrowsError(try plan.validate(kind: "ed2k"))
        settings.socksProxy?.version = .v4
        let v4 = AuxiliaryProxyPlan(settings: settings)
        XCTAssertThrowsError(try v4.validate(kind: "sftp"))
        XCTAssertThrowsError(try v4.validateBTEndpoints(.init(trackers: [.init(url: "http://tracker.invalid/a", tier: 0)])))
        XCTAssertNoThrow(try v4.validateBTEndpoints(.init(webSeeds: ["http://127.0.0.1/file"])))
        settings.socksProxy = nil; settings.httpProxy = nil; settings.ftpProxy = .init(host: "legacy", port: 8080, enabled: true)
        XCTAssertThrowsError(try AuxiliaryProxyPlan(settings: settings).validate(kind: "bittorrent"))
        settings.httpProxy = .init(host: "bad@host", port: 8080, enabled: true)
        XCTAssertThrowsError(try AuxiliaryProxyPlan(settings: settings).validate(kind: "sftp"))
    }
    func testED2KChecksumMatchesIndependentVectorsAcrossPartBoundaries() {
        // OpenSSL legacy MD4 and hash-wasm independently agree on these roots.
        let vectors: [(Int, String)] = [
            (0, "31d6cfe0d16ae931b73c59d7e0c089c0"),
            (1, "bde52cb31de33e46245e05fbdbd6fb24"),
            (9_727_999, "5461275e76837a313a0b2f67811c1023"),
            (9_728_000, "ee15063dd1e9c5bd5c0e4205c0b8e698"),
            (9_728_001, "748c0171a2d42d28afb644ef3e17f4e7"),
            (19_456_000, "fcca57f6ae31dcfa2ce0e41119738eb1")]
        for (length, expected) in vectors {
            var hash = AuxiliaryED2KChecksum(), remaining = length
            while remaining > 0 {
                let count = min(remaining, 1_000_000)
                hash.update(Data(repeating: 0x61, count: count)); remaining -= count
            }
            XCTAssertEqual(hash.finish(), expected, "Length \(length)")
        }
    }
    func testProxyLedgerFailureStopsHelperAndRequiresDurableRetryBeforeRelease() async throws {
        for failRead in [false, true] {
            var f = try fixture()
            _ = try await f.manager.createAuxiliary(source: .ed2k(url: "ed2k://|file|fixture.bin|1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|/", serverList: nil, nodeList: nil))
            _ = try await f.manager.auxiliaryCapabilities()
            eq(await f.daemon.isRunning, true)
            var database: OpaquePointer?
            XCTAssertEqual(sqlite3_open(f.support.appendingPathComponent("NeatDB.db").path, &database), SQLITE_OK)
            defer { sqlite3_close(database) }
            let breakSQL = failRead ? "ALTER TABLE downloads RENAME TO unavailable_downloads" : "CREATE TRIGGER block_proxy_update BEFORE UPDATE ON downloads BEGIN SELECT RAISE(ABORT, 'fixture'); END"
            let recoverSQL = failRead ? "ALTER TABLE unavailable_downloads RENAME TO downloads" : "DROP TRIGGER block_proxy_update"
            XCTAssertEqual(sqlite3_exec(database, breakSQL, nil, nil, nil), SQLITE_OK)
            f.settings.httpProxy = .init(host: "127.0.0.1", port: 9, enabled: true)
            let failure = await f.manager.updateSettings(f.settings)
            XCTAssertEqual(failure, .proxyUnavailable, "Ledger failure at \(failRead ? "read" : "write")")
            eq(await f.daemon.isRunning, false)
            do { _ = try await f.manager.auxiliaryCapabilities(); XCTFail("A failed ledger must retain the launch gate") }
            catch let error as AuxiliaryProxyError { XCTAssertEqual(error, .proxyUnavailable) }
            XCTAssertEqual(sqlite3_exec(database, recoverSQL, nil, nil, nil), SQLITE_OK)
            eq(await f.manager.updateSettings(f.settings), nil)
            XCTAssertEqual(try f.store.allDownloads().first?.auxiliary?.errorCode, "proxyUnsupported")
            _ = try await f.manager.auxiliaryCapabilities()
            eq(await f.daemon.isRunning, true)
            await f.daemon.stop()
        }
    }
    func testED2KProxyPersistsBlockedCreationReceiptAndRefusesResumeWithoutHelper() async throws {
        var f = try fixture()
        let source = AuxiliarySource.ed2k(url: "ed2k://|file|fixture.bin|1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|/", serverList: nil, nodeList: nil)
        let existing = try required(try await f.manager.createAuxiliary(source: source))
        f.settings.httpProxy = .init(host: "127.0.0.1", port: 9, enabled: true)
        await f.manager.updateSettings(f.settings)
        let paused = try await f.manager.auxiliaryStatus(taskID: existing.id)
        XCTAssertEqual(paused.phase, "paused"); XCTAssertEqual(paused.errorCode, "proxyUnsupported")
        let coordinator = DownloadCreationCoordinator(store: f.store)
        let intent = try required(DownloadCreationRequest.intent(from: ["op": "auxiliaryCreate", "creationKey": UUID().uuidString,
            "source": ["kind": "ed2k", "url": "ed2k://|file|fixture.bin|1|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|/"], "autoStart": true]))
        let manager = f.manager
        let accepted = try await coordinator.create(intent) { intent in
            _ = try await manager.createAuxiliary(source: source, autoStart: true, creationIntent: intent)
        }
        XCTAssertNotNil(accepted.receipt); XCTAssertFalse(accepted.pending)
        XCTAssertEqual(accepted.task?.status, .paused); XCTAssertEqual(accepted.task?.auxiliary?.errorCode, "proxyUnsupported")
        let replay = try await coordinator.create(intent) { _ in XCTFail("A blocked but accepted task must not be duplicated") }
        XCTAssertEqual(replay.task?.id, accepted.task?.id); XCTAssertFalse(replay.pending)
        do { try await f.manager.start(taskID: existing.id); XCTFail("No direct ED2K resume") }
        catch let error as AuxiliaryProxyError { XCTAssertEqual(error, .proxyUnsupported) }
        do { try await f.manager.auxiliaryStopSeeding(taskID: existing.id, generation: 0); XCTFail("Incomplete ED2K bytes cannot publish offline") }
        catch let error as AuxiliaryProductError { XCTAssertEqual(error, .notSeeding) }
        eq(await f.daemon.isRunning, false); XCTAssertEqual(try f.store.allDownloads().count, 2)
        XCTAssertFalse(FileManager.default.fileExists(atPath: f.support.appendingPathComponent("\(existing.id)/auxiliary-0/auxiliary-task.json").path))
    }
    func testRealSFTPHTTPToSOCKS5SwitchStopsOldProxyAndKeepsPartialGIDAndCredentialsVolatile() async throws {
        guard let python = ProcessInfo.processInfo.environment["NDM_SFTP_FIXTURE_PYTHON"] else { throw XCTSkip("Set isolated Paramiko fixture Python") }
        var f = try fixture()
        let child = Process(), pipe = Pipe()
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        child.executableURL = URL(fileURLWithPath: python); child.arguments = [repo.appendingPathComponent("scripts/qa-sftp-fixture.py").path, "--bytes", "2097152", "--delay", "0.02"]
        child.standardOutput = pipe; child.standardError = FileHandle.nullDevice; try child.run()
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: pipe.fileHandleForReading.availableData) as? [String: String])
        let file = URL(fileURLWithPath: try XCTUnwrap(envelope["metadataPath"])), sourceRoot = file.deletingLastPathComponent()
        addTeardownBlock { if child.isRunning { child.terminate(); child.waitUntilExit() }; try FileManager.default.removeItem(at: sourceRoot) }
        let metadata = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let pin = try XCTUnwrap(metadata["hostKeySHA256"] as? String), username = try XCTUnwrap(metadata["username"] as? String), password = try XCTUnwrap(metadata["password"] as? String)
        var url = try XCTUnwrap(URLComponents(string: try XCTUnwrap(metadata["url"] as? String))); url.host = "sftp-fixture.invalid"
        let proxyUser = "proxy-fixture-user", proxyPassword = "NDM-proxy-test-p@ss:%/secret"
        let http = LocalProtocolProxy(credentials: (proxyUser, proxyPassword)), socks = LocalProtocolProxy(credentials: (proxyUser, proxyPassword))
        try http.start(); try socks.start(); addTeardownBlock { XCTAssertTrue(http.stop()); XCTAssertTrue(socks.stop()) }
        f.settings.httpProxy = .init(host: "127.0.0.1", port: http.port, username: proxyUser, password: proxyPassword, enabled: true)
        await f.manager.updateSettings(f.settings)
        let created = try required(try await f.manager.createAuxiliary(source: .sftp(url: required(url.string), hostKeySHA256: pin), credentials: .init(username: username, password: password), autoStart: true))
        _ = try await wait(f.manager, id: created.id) { $0.completedBytes > 0 && $0.completedBytes < 2097152 }
        let originalGID = try gid(f, id: created.id)
        f.settings.socksProxy = .init(host: "127.0.0.1", port: socks.port, username: proxyUser, password: proxyPassword, enabled: true)
        await f.manager.updateSettings(f.settings)
        eq(await f.daemon.isRunning, false)
        let paused = try await f.manager.auxiliaryStatus(taskID: created.id)
        XCTAssertEqual(paused.phase, "paused"); XCTAssertEqual(paused.errorCode, "proxyChanged")
        XCTAssertEqual(try gid(f, id: created.id), originalGID)
        let httpRoutes = http.recordedRoutes.count
        try await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertEqual(http.recordedRoutes.count, httpRoutes)
        try await f.manager.start(taskID: created.id)
        _ = try await wait(f.manager, id: created.id) { $0.phase == "complete" }
        let done = try required(try await f.manager.task(id: created.id)), bytes = try Data(contentsOf: required(done.destinationFileURL))
        XCTAssertEqual(bytes.count, 2097152)
        XCTAssertEqual(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), metadata["sha256"] as? String)
        XCTAssertEqual(try gid(f, id: created.id), originalGID)
        XCTAssertTrue(http.recordedRoutes.contains { $0.kind == "connect" && $0.host == "sftp-fixture.invalid" })
        XCTAssertTrue(socks.recordedRoutes.contains { $0.kind == "socks5" && $0.host == "sftp-fixture.invalid" })
        XCTAssertGreaterThan(socks.authenticatedConnections, 0)
        let encodedPassword = proxyPassword.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))!
        let patterns = [password, proxyPassword, encodedPassword].map { Data($0.utf8) }
        let entries = try XCTUnwrap(FileManager.default.enumerator(at: f.root, includingPropertiesForKeys: [.isRegularFileKey]))
        for case let file as URL in entries where (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
            let data = try Data(contentsOf: file)
            for pattern in patterns { XCTAssertNil(data.range(of: pattern), "Credentials must not enter helper state or native ledger") }
        }
    }
    private func encode(_ value: Any) -> Data {
        if let bytes = value as? Data { return Data("\(bytes.count):".utf8) + bytes }
        if let text = value as? String { return encode(Data(text.utf8)) }
        if let number = value as? Int { return Data("i\(number)e".utf8) }
        if let list = value as? [Any] { return Data([108]) + list.reduce(Data()) { $0 + encode($1) } + Data([101]) }
        let dict = value as! [String: Any]
        return Data([100]) + dict.keys.sorted().reduce(Data()) { $0 + encode($1) + encode(dict[$1]!) } + Data([101])
    }
    func testRealBTWebSeedUsesSessionHTTPProxyAndDisablesDiscovery() async throws {
        var f = try fixture(), payload = Data((0..<131072).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload); try server.start(); addTeardownBlock { server.stop() }
        let proxy = LocalProtocolProxy(); try proxy.start(); addTeardownBlock { XCTAssertTrue(proxy.stop()) }
        f.settings.httpProxy = .init(host: "127.0.0.1", port: proxy.port, enabled: true)
        await f.manager.updateSettings(f.settings)
        var endpoint = try XCTUnwrap(URLComponents(url: server.baseURL, resolvingAgainstBaseURL: false)); endpoint.host = "webseed-fixture.invalid"
        var pieces = Data()
        for offset in stride(from: 0, to: payload.count, by: 16384) { pieces += Data(Insecure.SHA1.hash(data: payload.subdata(in: offset..<offset + 16384))) }
        let torrent = encode(["info": ["name": "file.bin", "private": 1, "length": payload.count, "piece length": 16384, "pieces": pieces]])
        let created = try required(try await f.manager.createAuxiliary(source: .torrent(torrent)))
        _ = try await wait(f.manager, id: created.id) { $0.phase == "awaitingSelection" }
        _ = try await f.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0, config: .init(webSeeds: [required(endpoint.string)], seedRatio: 0, seedMinutes: 0))
        try await f.manager.auxiliarySelectFiles(taskID: created.id, generation: 0, indices: [1], autoStart: true)
        _ = try await wait(f.manager, id: created.id) { $0.phase == "complete" }
        let done = try required(try await f.manager.task(id: created.id))
        XCTAssertEqual(try Data(contentsOf: required(done.destinationFileURL)), payload)
        XCTAssertTrue(proxy.recordedRoutes.contains { $0.host == "webseed-fixture.invalid" })
        let options = try await f.daemon.rpcClient().call("aria2.getGlobalOption")
        XCTAssertEqual(options["enable-dht"]?.boolean, false); XCTAssertEqual(options["bt-enable-lpd"]?.boolean, false); XCTAssertEqual(options["bt-port-mapping"]?.boolean, false)
        XCTAssertEqual(options["bt-proxy"]?.string, "http://127.0.0.1:\(proxy.port)/")
    }
}
