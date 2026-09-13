import Foundation
import CryptoKit
import XCTest
@testable import NDMEngine

final class AuxiliaryDaemonTests: XCTestCase {
    private let expectedDigest = "c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343"
    private func fixture() throws -> (URL, AuxiliaryDaemon) {
        guard let binary = ProcessInfo.processInfo.environment["NDM_AUXILIARY_BINARY"] else {
            throw XCTSkip("Set NDM_AUXILIARY_BINARY to the digest-pinned Aria2 Next 2.7.5 arm64 helper for isolated live QA")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-aux-live-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let daemon = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: binary), stateDirectory: root.appendingPathComponent("state"), expectedSHA256: expectedDigest, loopbackTransfersOnly: true))
        addTeardownBlock { await daemon.stop(); try FileManager.default.removeItem(at: root) }
        return (root, daemon)
    }
    func testDigestPinRejectsAnUnapprovedExecutableBeforeLaunch() async throws {
        let (root, _) = try fixture()
        let daemon = AuxiliaryDaemon(configuration: .init(executableURL: URL(fileURLWithPath: "/bin/echo"), stateDirectory: root.appendingPathComponent("rejected-state"), expectedSHA256: expectedDigest))
        do { _ = try await daemon.start(); XCTFail("Incorrect binary hash must fail") }
        catch let error as AuxiliaryDaemonError { guard case .binaryMismatch = error else { XCTFail("Wrong error"); return } }
        let running = await daemon.isRunning
        XCTAssertFalse(running)
    }
    func testSharedDaemonHandshakeFixedGIDReplayAndRealLoopbackArtifact() async throws {
        let (root, daemon) = try fixture()
        let bytes = Data((0..<32768).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: bytes)
        try server.start(); addTeardownBlock { server.stop() }
        async let one = daemon.start()
        async let two = daemon.start()
        let (first, concurrent) = try await (one, two)
        XCTAssertEqual(first, concurrent)
        XCTAssertEqual(first.version, "2.7.5")
        XCTAssertTrue(first.supportsBitTorrent)
        XCTAssertTrue(first.supportsSFTP)
        XCTAssertTrue(first.supportsED2K)
        XCTAssertEqual(Set([first.rpcPort, first.bittorrentPort, first.ed2kTCPPort, first.ed2kUDPPort]).count, 4)
        let work = root.appendingPathComponent("task-7")
        let transfer = try AuxiliaryTransfer(taskID: 7, generation: 0, source: .loopbackHTTPFixture(server.baseURL.absoluteString), workDirectory: work, daemon: daemon, filename: "fixture.bin")
        let paused = try await transfer.prepare()
        XCTAssertEqual(paused.phase, .paused)
        XCTAssertTrue(server.recordedMethods.isEmpty)
        let repeated = try await transfer.prepare()
        XCTAssertEqual(repeated.gid, paused.gid)
        await daemon.stop()
        let stopped = await daemon.isRunning
        XCTAssertFalse(stopped)
        let freshRPC = try await daemon.rpcClient()
        do { _ = try await freshRPC.call("aria2.tellStatus", parameters: [.string(paused.gid)]); XCTFail("Fork does not restore GID registry automatically") }
        catch let error as AuxiliaryRPCError { XCTAssertTrue(error.isTaskNotFound) }
        let replay = try AuxiliaryTransfer(taskID: 7, generation: 0, source: .loopbackHTTPFixture(server.baseURL.absoluteString), workDirectory: work, daemon: daemon, filename: "fixture.bin")
        let restored = try await replay.prepare()
        XCTAssertEqual(restored.gid, paused.gid); XCTAssertEqual(restored.phase, .paused)
        _ = try await replay.start()
        var completed = try await replay.currentSnapshot()
        let deadline = Date().addingTimeInterval(15)
        while completed.phase != .complete && completed.phase != .error && Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
            completed = try await replay.currentSnapshot()
        }
        XCTAssertEqual(completed.phase, .complete, completed.errorCode ?? "")
        XCTAssertTrue(completed.payloadCompleted)
        let file = try XCTUnwrap(completed.files.first)
        let final = work.appendingPathComponent("auxiliary-files").appendingPathComponent(file.relativePath)
        XCTAssertEqual(try Data(contentsOf: final), bytes)
        try await replay.cancel()
        XCTAssertEqual(try Data(contentsOf: final), bytes, "Cancel relinquishes the helper, not the user's completed artifact")
        do { _ = try await replay.prepare(); XCTFail("Removed journals must never auto-create") } catch {}
    }
    func testRealTorrentMetadataRequiresSelectionWithoutStartingPublicPeers() async throws {
        let (root, daemon) = try fixture()
        let payload = Data([1, 2, 3, 4])
        let hash = Data(Insecure.SHA1.hash(data: payload))
        // A private, trackerless torrent: metadata only, no public peer sources.
        var torrent = Data("d4:infod6:lengthi4e4:name11:fixture.bin12:piece lengthi16384e6:pieces20:".utf8)
        torrent.append(hash)
        torrent.append(Data("7:privatei1eee".utf8))
        let transfer = try AuxiliaryTransfer(taskID: 8, generation: 0, source: .torrent(torrent), workDirectory: root.appendingPathComponent("torrent-task"), daemon: daemon)
        let preview = try await transfer.prepare()
        XCTAssertEqual(preview.phase, .awaitingSelection)
        XCTAssertEqual(preview.files.map(\.relativePath), ["fixture.bin"])
        XCTAssertFalse(preview.payloadCompleted)
        let gated = try await transfer.start()
        XCTAssertEqual(gated.phase, .awaitingSelection)
        let selected = try await transfer.selectFiles([1])
        XCTAssertEqual(selected.gid, preview.gid)
        XCTAssertNotEqual(selected.phase, .awaitingSelection)
        try await transfer.cancel()
    }

    func testPartialDownloadPausesAndRestartsWithItsFixedGIDAndRange() async throws {
        let (root, daemon) = try fixture()
        let bytes = Data((0..<(2 * 1024 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(payload: bytes, bodyChunkSize: 16384, bodyChunkDelay: { _ in 0.02 })
        try server.start(); addTeardownBlock { server.stop() }
        let work = root.appendingPathComponent("partial-task")
        let source = AuxiliarySource.loopbackHTTPFixture(server.baseURL.absoluteString)
        let original = try AuxiliaryTransfer(taskID: 9, generation: 0, source: source, workDirectory: work, daemon: daemon, filename: "partial.bin")
        _ = try await original.start()
        var current = try await original.currentSnapshot()
        let progressDeadline = Date().addingTimeInterval(10)
        while current.completedBytes == 0 && Date() < progressDeadline {
            try await Task.sleep(nanoseconds: 50_000_000)
            current = try await original.currentSnapshot()
        }
        XCTAssertGreaterThan(current.completedBytes, 0)
        XCTAssertLessThan(current.completedBytes, Int64(bytes.count))
        let paused = try await original.pause()
        XCTAssertEqual(paused.engineStatus, "paused")
        let requestsBeforeRestart = server.recordedRanges.count
        await daemon.stop()
        let resumed = try AuxiliaryTransfer(taskID: 9, generation: 0, source: source, workDirectory: work, daemon: daemon, filename: "partial.bin")
        let recovered = try await resumed.prepare()
        XCTAssertEqual(recovered.gid, paused.gid)
        XCTAssertEqual(recovered.engineStatus, "paused")
        try await resumed.applyBandwidthLimit(65536)
        let rpc = try await daemon.rpcClient()
        let options = try await rpc.call("aria2.getOption", parameters: [.string(recovered.gid)])
        XCTAssertEqual(options["max-download-limit"]?.string, "65536")
        try await resumed.applyBandwidthLimit(0)
        _ = try await resumed.start()
        var completed = try await resumed.currentSnapshot()
        let deadline = Date().addingTimeInterval(15)
        while completed.phase != .complete && completed.phase != .error && Date() < deadline {
            try await Task.sleep(nanoseconds: 50_000_000)
            completed = try await resumed.currentSnapshot()
        }
        XCTAssertEqual(completed.phase, .complete, completed.errorCode ?? "")
        XCTAssertTrue(completed.payloadCompleted)
        XCTAssertTrue(server.recordedRanges.dropFirst(requestsBeforeRestart).contains { $0.lowercased().hasPrefix("range: bytes=") && !$0.lowercased().hasPrefix("range: bytes=0-") }, "Replay must resume already stored bytes")
        XCTAssertEqual(try Data(contentsOf: work.appendingPathComponent("auxiliary-files/partial.bin")), bytes)
    }
}
