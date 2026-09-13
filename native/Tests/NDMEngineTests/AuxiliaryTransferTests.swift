import Foundation
import XCTest
@testable import NDMEngine

final class AuxiliaryTransferTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-aux-unit-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return root
    }
    private func unavailableDaemon(_ root: URL) -> AuxiliaryDaemon {
        AuxiliaryDaemon(configuration: .init(executableURL: root.appendingPathComponent("missing-tool"), stateDirectory: root.appendingPathComponent("state"), expectedSHA256: String(repeating: "0", count: 64)))
    }
    private func snapshot(root: URL, status: String = "paused", bt: AuxiliaryJSON? = nil, complete: Bool = false, path: String = "file.bin") -> AuxiliaryJSON {
        var raw: [String: AuxiliaryJSON] = ["gid": .string("0123456789abcdef"), "status": .string(status), "totalLength": .string("3"), "completedLength": .string(complete ? "3" : "0"), "downloadSpeed": .string("0"), "uploadSpeed": .string("0"),
            "files": .array([.object(["index": .string("1"), "path": .string(path), "length": .string("3"), "completedLength": .string(complete ? "3" : "0"), "selected": .string("true")])])]
        if let bt { raw["bittorrent"] = bt }
        return .object(raw)
    }
    func testSFTPRequiresCanonicalSHA256PinAndRejectsURLCredentials() throws {
        let root = try directory(); let daemon = unavailableDaemon(root)
        for (uri, pin) in [("sftp://host/file", ""), ("sftp://host/file", "SHA256:invalid"), ("sftp://user:pass@host/file", Data(repeating: 1, count: 32).base64EncodedString()), ("sftp:host/file", Data(repeating: 1, count: 32).base64EncodedString())] {
            XCTAssertThrowsError(try AuxiliaryTransfer(taskID: 1, generation: 0, source: .sftp(url: uri, hostKeySHA256: pin), workDirectory: root.appendingPathComponent(UUID().uuidString), daemon: daemon))
        }
        XCTAssertNoThrow(try AuxiliaryTransfer(taskID: 1, generation: 0, source: .sftp(url: "sftp://host/file", hostKeySHA256: "SHA256:" + Data(repeating: 1, count: 32).base64EncodedString().replacingOccurrences(of: "=", with: "")), workDirectory: root.appendingPathComponent("valid"), daemon: daemon))
    }
    func testED2KInlineSourcesAcceptOnlyBoundedPeerAddresses() throws {
        let prefix = "ed2k://|file|payload.bin|1048576|" + String(repeating: "a", count: 32)
        for suffix in ["|/", "|sources,127.0.0.1:4662,example.test:4663|/", "|/|sources,192.168.1.2:4662|/"] {
            XCTAssertNoThrow(try AuxiliaryTransfer.validateSource(.ed2k(url: prefix + suffix, serverList: nil, nodeList: nil)))
        }
        for suffix in ["|sources,127.0.0.1:0|/", "|sources,user@host:4662|/", "|sources,host:65536|/", "|sources," + Array(repeating: "host:4662", count: 33).joined(separator: ",") + "|/"] {
            XCTAssertThrowsError(try AuxiliaryTransfer.validateSource(.ed2k(url: prefix + suffix, serverList: nil, nodeList: nil)))
        }
    }
    func testJournalPrecedesSubmissionContainsNoCredentialsAndBindsGeneration() async throws {
        let root = try directory(); let work = root.appendingPathComponent("work"); let daemon = unavailableDaemon(root)
        let source = AuxiliarySource.sftp(url: "sftp://host/private?signature=private-token", hostKeySHA256: Data(repeating: 2, count: 32).base64EncodedString())
        let first = try AuxiliaryTransfer(taskID: 7, generation: 0, source: source, workDirectory: work, daemon: daemon, credentials: .init(username: "private-user", password: "private-password"))
        do { _ = try await first.prepare(); XCTFail("Missing tool must fail") } catch {}
        let data = try Data(contentsOf: work.appendingPathComponent("auxiliary-task.json"))
        let text = String(decoding: data, as: UTF8.self)
        for secret in ["private-user", "private-password", "signature", "sftp://", "private-token"] { XCTAssertFalse(text.contains(secret)) }
        let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(raw["taskID"] as? Int, 7)
        XCTAssertEqual((raw["gid"] as? String)?.count, 16)
        let changed = try AuxiliaryTransfer(taskID: 7, generation: 1, source: source, workDirectory: work, daemon: daemon)
        do { _ = try await changed.prepare(); XCTFail("Generation change must not adopt journal") }
        catch let error as AuxiliaryTransferError { guard case .bindingMismatch = error else { XCTFail("Wrong error"); return } }
    }
    func testRelativeArtifactsRejectTraversalAbsolutePathsAndSymlinkComponents() throws {
        let root = try directory()
        for path in ["../escape", "/tmp/escape", "a/../b", "a//b", "./file", "C:/file", "a\\file", "bad\u{0}file"] {
            XCTAssertThrowsError(try AuxiliaryTransfer.validateRelativePath(path, filesDirectory: root))
        }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("link"), withDestinationURL: root.deletingLastPathComponent())
        XCTAssertThrowsError(try AuxiliaryTransfer.validateRelativePath("link/elsewhere.bin", filesDirectory: root))
        XCTAssertEqual(try AuxiliaryTransfer.validateRelativePath("folder/中文.bin", filesDirectory: root), "folder/中文.bin")
    }
    func testMetadataSelectionPayloadAndSeedingRemainDistinct() throws {
        let root = try directory()
        let awaiting = try AuxiliaryTransfer.decodeSnapshot(snapshot(root: root, bt: .object(["state": .string("paused"), "fileSelectionState": .string("awaiting")])), taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: true)
        XCTAssertEqual(awaiting.phase, .awaitingSelection); XCTAssertFalse(awaiting.payloadCompleted)
        try Data([1, 2, 3]).write(to: root.appendingPathComponent("file.bin"))
        let seeding = try AuxiliaryTransfer.decodeSnapshot(snapshot(root: root, status: "active", bt: .object(["state": .string("seeding"), "fileSelectionState": .string("ready")]), complete: true), taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: false)
        XCTAssertEqual(seeding.phase, .seeding); XCTAssertTrue(seeding.payloadCompleted)
        let finished = try AuxiliaryTransfer.decodeSnapshot(snapshot(root: root, status: "complete", complete: true), taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: false)
        XCTAssertEqual(finished.phase, .complete); XCTAssertTrue(finished.payloadCompleted)
    }
    func testCompletedMissingFilesAndOutsidePathsNeverBecomeDeliverable() throws {
        let root = try directory()
        for raw in [snapshot(root: root, status: "complete", complete: true), snapshot(root: root, path: root.deletingLastPathComponent().appendingPathComponent("outside.bin").path), snapshot(root: root, path: root.path + "/../outside.bin")] {
            XCTAssertThrowsError(try AuxiliaryTransfer.decodeSnapshot(raw, taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: false))
        }
    }
    func testCurlProgressUsesKnownTaskLengthWhileTheFileEntryStillReportsZero() throws {
        let root = try directory()
        var values = snapshot(root: root, status: "active").object!
        var file = values["files"]!.array![0].object!
        file["length"] = .string("0"); file["completedLength"] = .string("2")
        values["completedLength"] = .string("2"); values["files"] = .array([.object(file)])
        let progress = try AuxiliaryTransfer.decodeSnapshot(.object(values), taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: false)
        XCTAssertEqual(progress.files.first?.length, 3)
        XCTAssertEqual(progress.files.first?.completedLength, 2)
        XCTAssertFalse(progress.payloadCompleted)
        values["totalLength"] = .string("0")
        let unknown = try AuxiliaryTransfer.decodeSnapshot(.object(values), taskID: 1, generation: 0, expectedGID: "0123456789abcdef", filesDirectory: root, requiresSelection: false)
        XCTAssertEqual(unknown.files.first?.length, 0)
        XCTAssertFalse(unknown.payloadCompleted)
    }
    func testEmptyFileSelectionCannotTurnIntoDownloadEverything() async throws {
        let root = try directory()
        let transfer = try AuxiliaryTransfer(taskID: 1, generation: 0, source: .magnet("magnet:?xt=urn:btih:" + String(repeating: "a", count: 40)), workDirectory: root.appendingPathComponent("work"), daemon: unavailableDaemon(root))
        do { _ = try await transfer.selectFiles([]); XCTFail("Empty selection must fail before RPC") }
        catch let error as AuxiliaryTransferError { guard case .emptySelection = error else { XCTFail("Wrong error"); return } }
    }
    func testAnUnownedExistingFileCannotBeAdoptedByANewJournal() async throws {
        let root = try directory(); let work = root.appendingPathComponent("work")
        let transfer = try AuxiliaryTransfer(taskID: 1, generation: 0, source: .loopbackHTTPFixture("http://127.0.0.1:1111/file"), workDirectory: work, daemon: unavailableDaemon(root))
        let existing = work.appendingPathComponent("auxiliary-files/keep.bin")
        try Data([8, 8]).write(to: existing)
        do { _ = try await transfer.prepare(); XCTFail("Must not adopt existing files") }
        catch let error as AuxiliaryTransferError { guard case .unownedFiles = error else { XCTFail("Wrong error"); return } }
        XCTAssertEqual(try Data(contentsOf: existing), Data([8, 8]))
    }
}
