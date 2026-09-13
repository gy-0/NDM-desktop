import Foundation
import CryptoKit
import XCTest
import Darwin
@testable import NDMCore
@testable import NDMEngine

final class AuxiliaryProductIntegrationTests: XCTestCase {
    private func required<T>(_ value: T?) throws -> T { try XCTUnwrap(value) }
    private func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String = "") { XCTAssertEqual(actual, expected, message) }
    private func expectNil<T>(_ value: T?) { XCTAssertNil(value) }
    private struct Fixture {
        let root: URL, support: URL, downloads: URL
        let store: DownloadStore
        let daemon: AuxiliaryDaemon
        let manager: DownloadManager
        let settings: AppSettings
    }
    private func fixture(loopbackOnly: Bool = true) throws -> Fixture {
        guard let binary = ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"] else { throw XCTSkip("Set NDM_AUXILIARY_BINARY for isolated product integration") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-aux-product-\(UUID())")
        let support = root.appendingPathComponent("support"), downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        var settings = AppSettings(); settings.downloadDirectory = downloads; settings.downloadAllAtOnce = false; settings.useCategoryFolders = false
        let daemon = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: root.appendingPathComponent("helper-state"), expectedSHA256: AuxiliaryBundledEngine.digest, loopbackTransfersOnly: loopbackOnly))
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support,
            fileRecycler: { source in
                let trash = root.appendingPathComponent("trash"); try FileManager.default.createDirectory(at: trash, withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: source, to: trash.appendingPathComponent(source.lastPathComponent))
            }, auxiliaryDaemon: daemon)
        addTeardownBlock {
            for task in try await manager.listTasks() { await manager.pause(taskID: task.id) }
            await daemon.stop()
            try FileManager.default.removeItem(at: root)
        }
        return Fixture(root: root, support: support, downloads: downloads, store: store, daemon: daemon, manager: manager, settings: settings)
    }
    private func wait(_ manager: DownloadManager, taskID: Int64, timeout: TimeInterval = 20,
                      until condition: (AuxiliaryTaskStatus) -> Bool) async throws -> AuxiliaryTaskStatus {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let status = try await manager.auxiliaryStatus(taskID: taskID)
            if condition(status) { return status }
            if status.phase == "error" {
                let failed = try await manager.task(id: taskID)
                XCTFail(failed?.errorText ?? "Missing auxiliary diagnostic")
                throw AuxiliaryProductError.storage
            }
            guard Date() < deadline else { throw AuxiliaryRPCError.timeout }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
    private func intent(_ key: String = UUID().uuidString, source: [String: Any]) throws -> DownloadCreationIntent {
        try XCTUnwrap(DownloadCreationRequest.intent(from: ["op": "auxiliaryCreate", "creationKey": key, "source": source, "autoStart": false]))
    }
    private func gid(support: URL, taskID: Int64, generation: Int64 = 0) throws -> String {
        let data = try Data(contentsOf: support.appendingPathComponent("\(taskID)/auxiliary-\(generation)/auxiliary-task.json"))
        return try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["gid"] as? String)
    }
    func testUnifiedReceiptPublishingCollisionAndRemovalKeepExistingFile() async throws {
        let fixture = try fixture(), payload = Data((0..<32768).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: payload); try server.start(); addTeardownBlock { server.stop() }
        let source = AuxiliarySource.loopbackHTTPFixture(server.baseURL.absoluteString)
        let creation = try intent(source: ["kind": "fixture", "url": server.baseURL.absoluteString])
        let existing = fixture.downloads.appendingPathComponent(server.baseURL.lastPathComponent)
        try Data("keep-existing".utf8).write(to: existing)
        let created = try required(try await fixture.manager.createAuxiliary(source: source, autoStart: true, creationIntent: creation))
        _ = try await wait(fixture.manager, taskID: created.id) { $0.phase == "complete" }
        let done = try required(try await fixture.manager.task(id: created.id))
        let output = try XCTUnwrap(done.destinationFileURL)
        XCTAssertNotEqual(output, existing)
        XCTAssertEqual(try Data(contentsOf: existing), Data("keep-existing".utf8))
        XCTAssertEqual(try Data(contentsOf: output), payload)
        XCTAssertTrue(done.auxiliary?.published == true)
        let replay = try await fixture.manager.createAuxiliary(source: source, autoStart: true, creationIntent: creation)
        XCTAssertEqual(replay?.id, done.id)
        XCTAssertEqual(try fixture.store.allDownloads().count, 1)
        let reopened = try DownloadStore(directory: fixture.support)
        XCTAssertEqual(try reopened.allDownloads().first?.auxiliary, done.auxiliary)
        try await fixture.manager.remove(taskID: done.id, deleteFile: true)
        XCTAssertEqual(try Data(contentsOf: fixture.root.appendingPathComponent("trash").appendingPathComponent(output.lastPathComponent)), payload)
        XCTAssertEqual(try Data(contentsOf: existing), Data("keep-existing".utf8))
        XCTAssertEqual(try fixture.store.creationReceipt(key: creation.key)?.taskID, done.id)
        expectNil(try await fixture.manager.createAuxiliary(source: source, creationIntent: creation))
    }
    func testDifferentAuxiliarySourceCannotReuseACreationReceipt() throws {
        let key = UUID().uuidString
        let first = try intent(key, source: ["kind": "sftp", "url": "sftp://host/file", "hostKeySHA256": "pin-a"])
        let changed = try intent(key, source: ["kind": "sftp", "url": "sftp://host/file", "hostKeySHA256": "pin-b"])
        XCTAssertNotEqual(first.payloadHash, changed.payloadHash)
    }
    func testSFTPPartialRestartRequiresAuthenticationForTheSameTaskAndPin() async throws {
        guard let python = ProcessInfo.processInfo.environment["NDM_SFTP_FIXTURE_PYTHON"] else { throw XCTSkip("Set isolated Paramiko fixture Python") }
        let fixture = try fixture()
        let process = Process(), pipe = Pipe()
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        process.executableURL = URL(fileURLWithPath: python)
        process.arguments = [repository.appendingPathComponent("scripts/qa-sftp-fixture.py").path, "--bytes", "2097152", "--delay", "0.015"]
        process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run()
        // read(upToCount:) can wait for a full buffer on a long-lived pipe.
        // availableData returns the fixture's single readiness line promptly.
        let line = pipe.fileHandleForReading.availableData
        guard !line.isEmpty else { throw AuxiliaryProductError.storage }
        let envelope = try XCTUnwrap(try JSONSerialization.jsonObject(with: line) as? [String: String])
        let metadataPath = try XCTUnwrap(envelope["metadataPath"])
        let metadataURL = URL(fileURLWithPath: metadataPath), root = metadataURL.deletingLastPathComponent()
        addTeardownBlock { if process.isRunning { process.terminate(); process.waitUntilExit() }; try FileManager.default.removeItem(at: root) }
        let metadata = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: metadataURL)) as? [String: Any])
        let url = try XCTUnwrap(metadata["url"] as? String), pin = try XCTUnwrap(metadata["hostKeySHA256"] as? String)
        let username = try XCTUnwrap(metadata["username"] as? String), password = try XCTUnwrap(metadata["password"] as? String)
        let created = try required(try await fixture.manager.createAuxiliary(source: .sftp(url: url, hostKeySHA256: pin), credentials: .init(username: username, password: password), autoStart: true))
        _ = try await wait(fixture.manager, taskID: created.id) { $0.completedBytes > 0 && $0.completedBytes < 2097152 }
        await fixture.manager.pause(taskID: created.id)
        let originalGID = try gid(support: fixture.support, taskID: created.id)
        let saved = try XCTUnwrap(try fixture.store.allDownloads().first?.auxiliary)
        XCTAssertEqual(saved.phase, "paused")
        await fixture.daemon.stop()
        let reopened = try DownloadStore(directory: fixture.support)
        _ = try reopened.recoverInterruptedTasks()
        let recovered = DownloadManager(store: reopened, settings: fixture.settings, supportRoot: fixture.support, auxiliaryDaemon: fixture.daemon)
        addTeardownBlock { await recovered.pause(taskID: created.id) }
        do { try await recovered.start(taskID: created.id); XCTFail("Credentials must not survive process recreation") }
        catch let error as AuxiliaryProductError { XCTAssertEqual(error.code, "credentialsRequired") }
        do { try await recovered.auxiliaryAuthenticate(taskID: created.id, generation: 1, credentials: .init(username: username, password: password), autoStart: true); XCTFail("Stale generation") }
        catch let error as AuxiliaryProductError { XCTAssertEqual(error.code, "staleGeneration") }
        let eventsURL = root.appendingPathComponent("events.jsonl")
        let previousEvents = try String(contentsOf: eventsURL).split(separator: "\n").count
        try await recovered.auxiliaryAuthenticate(taskID: created.id, generation: 0, credentials: .init(username: username, password: password), autoStart: true)
        _ = try await wait(recovered, taskID: created.id) { $0.phase == "complete" }
        let done = try required(try await recovered.task(id: created.id))
        let output = try XCTUnwrap(done.destinationFileURL)
        let bytes = try Data(contentsOf: output)
        XCTAssertEqual(bytes.count, 2097152)
        XCTAssertEqual(SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(), metadata["sha256"] as? String)
        XCTAssertEqual(try gid(support: fixture.support, taskID: created.id), originalGID)
        XCTAssertEqual(done.auxiliary?.hostKeySHA256, saved.hostKeySHA256)
        let newEvents = try String(contentsOf: eventsURL).split(separator: "\n").dropFirst(previousEvents).compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
        let firstRead = newEvents.first { $0["event"] as? String == "read" }
        XCTAssertGreaterThan(firstRead?["offset"] as? Int ?? 0, 0, "SFTP replay must seek past persisted bytes")
        let database = try Data(contentsOf: fixture.support.appendingPathComponent("NeatDB.db"))
        XCTAssertNil(database.range(of: Data(password.utf8)))
        let journal = try Data(contentsOf: fixture.support.appendingPathComponent("\(created.id)/auxiliary-0/auxiliary-task.json"))
        XCTAssertNil(journal.range(of: Data(password.utf8)))
    }
    private func bencode(_ value: Any) -> Data {
        if let data = value as? Data { return Data("\(data.count):".utf8) + data }
        if let string = value as? String { return bencode(Data(string.utf8)) }
        if let number = value as? Int { return Data("i\(number)e".utf8) }
        if let list = value as? [Any] { return Data("l".utf8) + list.reduce(Data()) { $0 + bencode($1) } + Data("e".utf8) }
        let dictionary = value as! [String: Any]
        return Data("d".utf8) + dictionary.keys.sorted().reduce(Data()) { $0 + bencode($1) + bencode(dictionary[$1]!) } + Data("e".utf8)
    }
    func testBTSelectionLocalPeerPayloadSeedingAndSafeStopPublish() async throws {
        let fixture = try fixture()
        let first = Data(repeating: 13, count: 32768), second = Data((0..<262144).map { UInt8($0 % 251) }), joined = first + second
        var pieces = Data()
        for offset in stride(from: 0, to: joined.count, by: 16384) { pieces += Data(Insecure.SHA1.hash(data: joined.subdata(in: offset..<min(offset + 16384, joined.count)))) }
        let info: [String: Any] = ["name": "bundle", "private": 1, "piece length": 16384, "pieces": pieces,
            "files": [["length": first.count, "path": ["one.bin"]], ["length": second.count, "path": ["two.bin"]]]]
        let torrent = bencode(["info": info])
        let created = try required(try await fixture.manager.createAuxiliary(source: .torrent(torrent)))
        let preview = try await wait(fixture.manager, taskID: created.id) { $0.phase == "awaitingSelection" }
        XCTAssertEqual(preview.files.count, 2)
        let ordinaryServer = LocalRangeServer(payload: Data([1, 2, 3])); try ordinaryServer.start(); addTeardownBlock { ordinaryServer.stop() }
        let ordinary = try required(try await fixture.manager.createURL(ordinaryServer.baseURL.absoluteString))
        let ordinaryDeadline = Date().addingTimeInterval(10)
        while (try await fixture.manager.task(id: ordinary.id))?.status != .complete && Date() < ordinaryDeadline { try await Task.sleep(nanoseconds: 50_000_000) }
        expectEqual(try await fixture.manager.task(id: ordinary.id)?.status, .complete, "Metadata selection must not block ordinary downloads")
        let binary = try XCTUnwrap(ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"])
        let seeder = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: fixture.root.appendingPathComponent("seeder-state"), expectedSHA256: AuxiliaryBundledEngine.digest, loopbackTransfersOnly: true))
        addTeardownBlock { await seeder.stop() }
        let seedDirectory = fixture.root.appendingPathComponent("seeder-files")
        try FileManager.default.createDirectory(at: seedDirectory.appendingPathComponent("bundle"), withIntermediateDirectories: true)
        try first.write(to: seedDirectory.appendingPathComponent("bundle/one.bin")); try second.write(to: seedDirectory.appendingPathComponent("bundle/two.bin"))
        let capability = try await seeder.start(), seedRPC = try await seeder.rpcClient()
        let seedGID = try await seedRPC.call("aria2.addTorrent", parameters: [.string(torrent.base64EncodedString()), .array([]), .object(["dir": .string(seedDirectory.path), "seed-ratio": .string("0"), "max-upload-limit": .string("32768"), "check-integrity": .string("true")])])
        let seedDeadline = Date().addingTimeInterval(15)
        while true {
            let status = try await seedRPC.call("aria2.tellStatus", parameters: [seedGID])
            if status["bittorrent"]?["state"]?.string == "seeding" { break }
            guard Date() < seedDeadline else { throw AuxiliaryRPCError.timeout }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        try await fixture.manager.auxiliarySelectFiles(taskID: created.id, generation: preview.generation, indices: [2], autoStart: false)
        let added = try await fixture.manager.auxiliaryBTAddPeers(taskID: created.id, generation: preview.generation, peers: ["127.0.0.1:\(capability.bittorrentPort)"])
        XCTAssertEqual(added.added, 1); XCTAssertEqual(added.failed, 0)
        try await fixture.manager.start(taskID: created.id)
        let peerDeadline = Date().addingTimeInterval(15)
        var observedPeer: AuxiliaryBTPeer?
        while Date() < peerDeadline {
            let controls = try await fixture.manager.auxiliaryBTStatus(taskID: created.id, generation: preview.generation)
            observedPeer = controls.peers.first { $0.ip == "127.0.0.1" && $0.downloadSpeed > 0 }
            if observedPeer != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertNotNil(observedPeer, "Product peer telemetry must include the connected local seeder and live speed")
        XCTAssertTrue(observedPeer?.seeder == true)
        let seeded = try await wait(fixture.manager, taskID: created.id, timeout: 30) { $0.phase == "seeding" && $0.payloadCompleted }
        XCTAssertTrue(seeded.files.first { $0.index == 2 }?.selected == true)
        XCTAssertTrue(seeded.files.first { $0.index == 1 }?.selected == false)
        expectEqual(try await fixture.manager.task(id: created.id)?.status, .downloading)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.downloads.appendingPathComponent("two.bin").path))
        try await fixture.manager.auxiliaryStopSeeding(taskID: created.id, generation: seeded.generation)
        let done = try required(try await fixture.manager.task(id: created.id))
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(done.destinationFileURL)), second)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.downloads.appendingPathComponent("one.bin").path))
        try await fixture.manager.auxiliaryStopSeeding(taskID: created.id, generation: seeded.generation)
    }

    func testED2KLocalInlinePeerSharingStopsBeforePublishing() async throws {
        let fixture = try fixture(loopbackOnly: false)
        let openssl = "/opt/homebrew/opt/openssl@3/bin/openssl"
        guard FileManager.default.isExecutableFile(atPath: openssl) else { throw XCTSkip("Local ED2K fixture requires OpenSSL legacy MD4") }
        var addresses: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addresses) == 0 else { throw AuxiliaryProductError.storage }
        defer { freeifaddrs(addresses) }
        var cursor = addresses, localIP: String?
        while let value = cursor {
            defer { cursor = value.pointee.ifa_next }
            guard let address = value.pointee.ifa_addr, address.pointee.sa_family == sa_family_t(AF_INET),
                  value.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0, value.pointee.ifa_flags & UInt32(IFF_UP) != 0 else { continue }
            var numeric = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(address, socklen_t(address.pointee.sa_len), &numeric, socklen_t(numeric.count), nil, 0, NI_NUMERICHOST) == 0 {
                let candidate = String(cString: numeric)
                if candidate.hasPrefix("192.168.") || candidate.hasPrefix("10.") || candidate.hasPrefix("172.") { localIP = candidate; break }
            }
        }
        guard let localIP else { throw XCTSkip("ED2K peer fixture needs this machine's private IPv4") }
        let payload = Data(repeating: 0x41, count: 1024 * 1024)
        let seedDirectory = fixture.root.appendingPathComponent("ed2k-seed")
        try FileManager.default.createDirectory(at: seedDirectory, withIntermediateDirectories: true)
        let file = seedDirectory.appendingPathComponent("payload.bin"); try payload.write(to: file)
        let hashProcess = Process(), hashPipe = Pipe()
        hashProcess.executableURL = URL(fileURLWithPath: openssl); hashProcess.arguments = ["dgst", "-provider", "legacy", "-md4", "-r", file.path]
        hashProcess.standardOutput = hashPipe; hashProcess.standardError = FileHandle.nullDevice
        try hashProcess.run(); hashProcess.waitUntilExit()
        guard hashProcess.terminationStatus == 0 else { throw AuxiliaryProductError.storage }
        let md4 = String(decoding: hashPipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
        guard md4.count == 32 else { throw AuxiliaryProductError.storage }
        let binary = try XCTUnwrap(ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"])
        let seed = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: fixture.root.appendingPathComponent("ed2k-seed-state"), expectedSHA256: AuxiliaryBundledEngine.digest))
        addTeardownBlock { await seed.stop() }
        let capabilities = try await seed.start(), rpc = try await seed.rpcClient()
        let source = "ed2k://|file|payload.bin|\(payload.count)|\(md4)|sources,\(localIP):\(capabilities.ed2kTCPPort)|/"
        let seedGID = try await rpc.call("aria2.addUri", parameters: [.array([.string(source)]), .object(["dir": .string(seedDirectory.path), "allow-overwrite": .string("true"), "seed-time": .string("10")])])
        let seedDeadline = Date().addingTimeInterval(20)
        while true {
            let status = try await rpc.call("aria2.tellStatus", parameters: [seedGID])
            if status["seeder"]?.boolean == true { break }
            guard Date() < seedDeadline else { throw AuxiliaryRPCError.timeout }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let created = try required(try await fixture.manager.createAuxiliary(source: .ed2k(url: source, serverList: nil, nodeList: nil), autoStart: true))
        let shared = try await wait(fixture.manager, taskID: created.id) { $0.phase == "seeding" && $0.payloadCompleted }
        expectEqual(try await fixture.manager.task(id: created.id)?.status, .downloading)
        try await fixture.manager.auxiliaryStopSeeding(taskID: created.id, generation: shared.generation)
        let done = try required(try await fixture.manager.task(id: created.id))
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(done.destinationFileURL)), payload)
    }
}
