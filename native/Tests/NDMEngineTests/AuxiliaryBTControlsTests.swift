import Foundation
import CryptoKit
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class AuxiliaryBTControlsTests: XCTestCase {
    private func eq<T: Equatable>(_ left: T, _ right: T, _ message: String = "") { XCTAssertEqual(left, right, message) }
    private func required<T>(_ value: T?) throws -> T { try XCTUnwrap(value) }
    private struct Fixture {
        let root: URL, support: URL, downloads: URL, state: URL
        let store: DownloadStore; let daemon: AuxiliaryDaemon; let manager: DownloadManager; let settings: AppSettings
    }
    private func fixture() throws -> Fixture {
        guard let binary = ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"] else { throw XCTSkip("Set NDM_AUXILIARY_BINARY for real local BT controls") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-bt-controls-\(UUID())")
        let support = root.appendingPathComponent("support"), downloads = root.appendingPathComponent("downloads"), state = root.appendingPathComponent("helper-state")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        var settings = AppSettings(); settings.downloadDirectory = downloads; settings.useCategoryFolders = false
        let store = try DownloadStore(directory: support)
        let daemon = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: state,
            expectedSHA256: AuxiliaryBundledEngine.digest, loopbackTransfersOnly: true))
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support, auxiliaryDaemon: daemon)
        addTeardownBlock {
            for task in try await manager.listTasks() { await manager.pause(taskID: task.id) }
            await daemon.stop(); try FileManager.default.removeItem(at: root)
        }
        return .init(root: root, support: support, downloads: downloads, state: state, store: store, daemon: daemon, manager: manager, settings: settings)
    }
    private func encode(_ value: Any) -> Data {
        if let data = value as? Data { return Data("\(data.count):".utf8) + data }
        if let string = value as? String { return encode(Data(string.utf8)) }
        if let number = value as? Int { return Data("i\(number)e".utf8) }
        if let values = value as? [Any] { return Data([108]) + values.reduce(Data()) { $0 + encode($1) } + Data([101]) }
        let values = value as! [String: Any]
        return Data([100]) + values.keys.sorted().reduce(Data()) { $0 + encode($1) + encode(values[$1]!) } + Data([101])
    }
    private func metainfo(payload: Data, seeds: [String] = []) -> (Data, Data) {
        var pieces = Data()
        for offset in stride(from: 0, to: payload.count, by: 16384) { pieces += Data(Insecure.SHA1.hash(data: payload.subdata(in: offset..<min(offset + 16384, payload.count)))) }
        let info: [String: Any] = ["name": "file.bin", "private": 1, "piece length": 16384, "length": payload.count, "pieces": pieces]
        return (encode(["info": info, "url-list": seeds]), encode(info))
    }
    private func wait(_ manager: DownloadManager, id: Int64, timeout: TimeInterval = 25, until test: (AuxiliaryTaskStatus) -> Bool) async throws -> AuxiliaryTaskStatus {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let state = try await manager.auxiliaryStatus(taskID: id)
            if test(state) { return state }
            if state.phase == "error" { XCTFail((try await manager.task(id: id))?.errorText ?? "Unknown error"); throw AuxiliaryBTError.unavailable }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw AuxiliaryRPCError.timeout
    }
    private func journal(_ fixture: Fixture, id: Int64) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: fixture.support.appendingPathComponent("\(id)/auxiliary-0/auxiliary-task.json"))) as? [String: Any])
    }
    func testConfigBoundsCanonicalTiersAndExactSignedURLs() throws {
        let config = try AuxiliaryBTValidation.config(.init(trackers: [.init(url: "https://tracker.test/a?pass=xyz%2Fa", tier: 7), .init(url: "udp://tracker.test:80", tier: 2), .init(url: "udp://tracker.test:80", tier: 9)], webSeeds: ["https://seed.test/a?signature=x%2Fy"], seedRatio: 2, seedMinutes: nil))
        XCTAssertEqual(config.trackers.map(\.tier), [1, 0]); XCTAssertEqual(config.trackers.count, 2)
        XCTAssertEqual(config.webSeeds, ["https://seed.test/a?signature=x%2Fy"])
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(seedRatio: .infinity)))
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(seedMinutes: -1)))
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(seedMinutes: 35_791_395)))
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(uploadLimit: 2_147_483_648)))
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(webSeeds: ["https:seed.test/path"])))
        XCTAssertThrowsError(try AuxiliaryBTValidation.config(.init(trackers: [.init(url: "http://host/\nsecret", tier: 0)])))
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(config)) as? [String: Any])
        XCTAssertTrue(encoded["seedMinutes"] is NSNull)
        var invalid = encoded; invalid["unknown"] = true
        XCTAssertThrowsError(try AuxiliaryBTValidation.parseConfig(invalid))
    }
    func testPeerValidationIsNumericBoundedAndDeduplicated() throws {
        XCTAssertEqual(try AuxiliaryBTValidation.peers(["127.000.0.1:009", "127.0.0.1:9", "[0:0:0:0:0:0:0:1]:80"]), ["127.0.0.1:9", "[::1]:80"])
        for value in ["peer.test:80", "256.1.2.3:80", "127.0.0.1:0", "[::gg]:12", "127.0.0.1:80\n"] { XCTAssertThrowsError(try AuxiliaryBTValidation.peers([value])) }
        XCTAssertThrowsError(try AuxiliaryBTValidation.peers([]))
    }
    func testMetainfoOverridePreservesExactInfoDictionaryAndOriginalSource() throws {
        let (source, info) = metainfo(payload: Data(repeating: 9, count: 32768), seeds: ["http://old.test/file"])
        let changed = try AuxiliaryBTMetainfo.replacingWebSeeds(source, with: ["http://new.test/file?x=%2F"])
        XCTAssertNotNil(changed.range(of: info)); XCTAssertNotNil(source.range(of: Data("http://old.test/file".utf8)))
        XCTAssertNil(changed.range(of: Data("http://old.test/file".utf8)))
        XCTAssertNotNil(changed.range(of: Data("http://new.test/file?x=%2F".utf8)))
        XCTAssertThrowsError(try AuxiliaryBTMetainfo.replacingWebSeeds(Data("d4:infoi1e".utf8), with: []))
        let magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=http%3A%2F%2Ft&ws=http%3A%2F%2Fold"
        let replaced = try AuxiliaryBTMetainfo.replacingMagnetWebSeeds(magnet, with: ["http://new/a?x=%2F"])
        XCTAssertTrue(replaced.hasPrefix("magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=http%3A%2F%2Ft&ws="))
        XCTAssertFalse(replaced.contains("old"))
    }
    func testOldRecordDecodesWithoutBTControls() throws {
        let source = AuxiliaryTaskRecord(kind: "magnet", url: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789")
        let json = try JSONEncoder().encode(source)
        XCTAssertNil(try JSONDecoder().decode(AuxiliaryTaskRecord.self, from: json).bt)
    }
    func testRealPausedConfigReadbackNullClearAndRestartRetainGIDAndSelection() async throws {
        let fixture = try fixture(), (source, _) = metainfo(payload: Data(repeating: 5, count: 65536))
        let created = try required(try await fixture.manager.createAuxiliary(source: .torrent(source)))
        _ = try await wait(fixture.manager, id: created.id) { $0.phase == "awaitingSelection" }
        let originalGID = try required(try journal(fixture, id: created.id)["gid"] as? String)
        let initial = try await fixture.manager.auxiliaryBTStatus(taskID: created.id, generation: 0)
        XCTAssertEqual(initial.revision, 0)
        let config = AuxiliaryBTConfig(trackers: [.init(url: "http://127.0.0.1:9/announce?pass=fixture", tier: 7)],
            webSeeds: ["http://127.0.0.1:9/file.bin"], seedRatio: 3, seedMinutes: 12, uploadLimit: 65536, peerExchange: false)
        let applied = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0, config: config)
        XCTAssertEqual(applied.revision, 1); XCTAssertEqual(applied.config.trackers[0].tier, 0); XCTAssertEqual(applied.config.seedMinutes, 12)
        do { _ = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0, config: config); XCTFail("Stale revision") }
        catch let error as AuxiliaryBTError { XCTAssertEqual(error, .conflict) }
        do { _ = try await fixture.manager.auxiliaryBTStatus(taskID: created.id, generation: 1); XCTFail("Stale generation") }
        catch let error as AuxiliaryBTError { XCTAssertEqual(error, .staleGeneration) }
        try await fixture.manager.auxiliarySelectFiles(taskID: created.id, generation: 0, indices: [1], autoStart: false)
        var cleared = applied.config; cleared.seedMinutes = nil; cleared.webSeeds = []
        let current = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 1, config: cleared)
        XCTAssertEqual(current.config, cleared); XCTAssertEqual(current.revision, 2)
        XCTAssertEqual(try journal(fixture, id: created.id)["gid"] as? String, originalGID)
        XCTAssertEqual(try journal(fixture, id: created.id)["selectedFiles"] as? [Int], [1])
        let rpc = try await fixture.daemon.rpcClient()
        let options = try await rpc.call("aria2.getOption", parameters: [.string(originalGID)])
        XCTAssertNil(options["seed-time"]); XCTAssertEqual(options["enable-peer-exchange"]?.boolean, false)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: fixture.downloads.path).isEmpty)
        // Simulate interruption after SQLite intent commit, with a partially
        // changed helper. Reading must converge to intent before claiming ACK.
        var pendingTask = try required(try fixture.store.allDownloads().first)
        pendingTask.auxiliary?.bt?.pending = true
        try fixture.store.update(pendingTask)
        _ = try await rpc.call("aria2.changeOption", parameters: [.string(originalGID), .object(["seed-ratio": .string("99")])])
        let reconciled = try await fixture.manager.auxiliaryBTStatus(taskID: created.id, generation: 0)
        XCTAssertEqual(reconciled.config, cleared); XCTAssertEqual(reconciled.revision, 2)
        XCTAssertFalse(try required(try fixture.store.allDownloads().first?.auxiliary?.bt?.pending))
        await fixture.daemon.stop()
        let reopened = try DownloadStore(directory: fixture.support)
        let recovered = DownloadManager(store: reopened, settings: fixture.settings, supportRoot: fixture.support, auxiliaryDaemon: fixture.daemon)
        let restored = try await recovered.auxiliaryBTStatus(taskID: created.id, generation: 0)
        XCTAssertEqual(restored.config, cleared); XCTAssertEqual(restored.revision, 2)
        XCTAssertEqual(try journal(fixture, id: created.id)["gid"] as? String, originalGID)
        XCTAssertEqual(try reopened.allDownloads().first?.auxiliary?.torrentData, source)
        let added = try await recovered.auxiliaryBTAddPeers(taskID: created.id, generation: 0, peers: ["127.0.0.1:9", "127.0.0.1:9"])
        XCTAssertEqual(added.added + added.failed, 1)
        let state = try await recovered.auxiliaryBTStatus(taskID: created.id, generation: 0)
        XCTAssertTrue(state.peers.isEmpty, "Accepted peer addresses are not proof of connection")
        await recovered.pause(taskID: created.id)
    }
    func testRealSessionEncryptionReadbackPersistsAcrossNewDaemonAndRejectsActiveBT() async throws {
        let fixture = try fixture()
        let original = try await fixture.manager.auxiliaryBTGlobalStatus()
        XCTAssertEqual(original.encryption, .preferred); XCTAssertTrue(original.canConfigure)
        let applied = try await fixture.manager.auxiliaryBTGlobalConfigure(expectedRevision: 0, encryption: .required)
        XCTAssertEqual(applied.revision, 1)
        let rpc = try await fixture.daemon.rpcClient()
        eq(try await rpc.call("aria2.getGlobalOption")["bt-encryption"]?.string, "required")
        await fixture.daemon.stop()
        let binary = try required(ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"])
        let replacement = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: fixture.state, expectedSHA256: AuxiliaryBundledEngine.digest, loopbackTransfersOnly: true))
        addTeardownBlock { await replacement.stop() }
        let recovered = DownloadManager(store: fixture.store, settings: fixture.settings, supportRoot: fixture.support, auxiliaryDaemon: replacement)
        let restored = try await recovered.auxiliaryBTGlobalStatus()
        XCTAssertEqual(restored.encryption, .required); XCTAssertEqual(restored.revision, 1)
        let raw = try await replacement.rpcClient().call("aria2.getGlobalOption")
        XCTAssertEqual(raw["bt-encryption"]?.string, "required", "Fresh process must receive durable session option at launch")
        let (source, _) = metainfo(payload: Data(repeating: 6, count: 65536))
        let created = try required(try await recovered.createAuxiliary(source: .torrent(source)))
        _ = try await wait(recovered, id: created.id) { $0.phase == "awaitingSelection" }
        try await recovered.auxiliarySelectFiles(taskID: created.id, generation: 0, indices: [1], autoStart: true)
        _ = try await wait(recovered, id: created.id) { $0.phase == "downloading" }
        do { _ = try await recovered.auxiliaryBTGlobalConfigure(expectedRevision: 1, encryption: .disabled); XCTFail("Active task must block session mutation") }
        catch let error as AuxiliaryBTError { XCTAssertEqual(error, .allTasksMustPause) }
        do { _ = try await recovered.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0, config: .init()); XCTFail("Active task must block task mutation") }
        catch let error as AuxiliaryBTError { XCTAssertEqual(error, .notPaused) }
        await recovered.pause(taskID: created.id)
        let changed = try await recovered.auxiliaryBTGlobalConfigure(expectedRevision: 1, encryption: .disabled)
        XCTAssertEqual(changed.encryption, .disabled); XCTAssertEqual(changed.revision, 2)
    }
    func testRealZeroSeedTimeStopsAutomaticallyAndPublishesPayload() async throws {
        let fixture = try fixture(), payload = Data(repeating: 42, count: 131072)
        let server = LocalRangeServer(payload: payload); try server.start(); addTeardownBlock { server.stop() }
        let (source, _) = metainfo(payload: payload)
        let created = try required(try await fixture.manager.createAuxiliary(source: .torrent(source)))
        _ = try await wait(fixture.manager, id: created.id) { $0.phase == "awaitingSelection" }
        _ = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0,
            config: .init(webSeeds: [server.baseURL.absoluteString], seedRatio: 0, seedMinutes: 0))
        try await fixture.manager.auxiliarySelectFiles(taskID: created.id, generation: 0, indices: [1], autoStart: true)
        _ = try await wait(fixture.manager, id: created.id) { $0.phase == "complete" }
        let done = try required(try await fixture.manager.task(id: created.id))
        XCTAssertEqual(done.status, .complete); XCTAssertFalse(done.auxiliary?.stopSeedingRequested == true)
        XCTAssertEqual(try Data(contentsOf: required(done.destinationFileURL)), payload)
    }
    func testRealWebSeedPartialSurvivesTimeClearAndFinishesWithExactBytes() async throws {
        let fixture = try fixture(), payload = Data((0..<2 * 1024 * 1024).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 16384, bodyChunkDelay: { _ in 0.015 }); try server.start(); addTeardownBlock { server.stop() }
        let (source, _) = metainfo(payload: payload)
        let created = try required(try await fixture.manager.createAuxiliary(source: .torrent(source)))
        _ = try await wait(fixture.manager, id: created.id) { $0.phase == "awaitingSelection" }
        let applied = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 0,
            config: .init(webSeeds: [server.baseURL.absoluteString], seedRatio: 10, seedMinutes: 30, uploadLimit: 32768, peerExchange: false))
        XCTAssertTrue(server.recordedMethods.isEmpty, "Configuration must not fetch payload before selection")
        try await fixture.manager.auxiliarySelectFiles(taskID: created.id, generation: 0, indices: [1], autoStart: true)
        _ = try await wait(fixture.manager, id: created.id) { $0.completedBytes > 0 && $0.completedBytes < Int64(payload.count) }
        await fixture.manager.pause(taskID: created.id)
        let originalGID = try required(try journal(fixture, id: created.id)["gid"] as? String)
        let partial = fixture.support.appendingPathComponent("\(created.id)/auxiliary-0/auxiliary-files/file.bin")
        let identityBefore = try partial.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier as? NSObject
        var cleared = applied.config; cleared.seedMinutes = nil
        let changed = try await fixture.manager.auxiliaryBTConfigure(taskID: created.id, generation: 0, expectedRevision: 1, config: cleared)
        XCTAssertNil(changed.config.seedMinutes)
        XCTAssertEqual(try partial.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier as? NSObject, identityBefore)
        XCTAssertEqual(try journal(fixture, id: created.id)["gid"] as? String, originalGID)
        try await fixture.manager.start(taskID: created.id)
        _ = try await wait(fixture.manager, id: created.id) { $0.phase == "seeding" }
        eq((try await fixture.manager.task(id: created.id))?.status, .downloading)
        try await fixture.manager.auxiliaryStopSeeding(taskID: created.id, generation: 0)
        let done = try required(try await fixture.manager.task(id: created.id))
        XCTAssertEqual(try Data(contentsOf: required(done.destinationFileURL)), payload)
        XCTAssertFalse(server.recordedRanges.isEmpty)
    }
}
