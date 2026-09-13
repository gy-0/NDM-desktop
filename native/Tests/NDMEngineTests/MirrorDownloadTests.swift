import Foundation
import XCTest
import SQLite3
@testable import NDMCore
@testable import NDMEngine

final class MirrorDownloadTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-mirrors-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return root
    }

    private func server(_ payload: Data, headStatus: Int = 200, slow: Bool = false,
                        truncate: Bool = false) throws -> LocalRangeServer {
        let server = LocalRangeServer(payload: payload, bodyChunkSize: slow ? 16384 : nil,
            truncateRangeBody: { _, ordinal in truncate && ordinal >= 1 ? 32768 : nil },
            bodyChunkDelay: { _ in slow ? 0.004 : 0 },
            injectedRangeFailureStatus: headStatus == 404 ? 404 : truncate ? 410 : nil,
            injectRangeFailureAfterCount: headStatus == 404 ? 0 : truncate ? 1 : .max,
            injectedRangeFailureLimit: headStatus == 404 || truncate ? 100 : 0, headStatus: headStatus)
        try server.start()
        addTeardownBlock { server.stop() }
        return server
    }

    private func engine(root: URL, primary: LocalRangeServer, secondary: LocalRangeServer,
                        headers: [String: String] = [:]) throws -> MirrorDownloadEngine {
        try MirrorDownloadEngine(taskID: 1,
            request: DownloadRequest(url: primary.baseURL, headers: headers, connections: 1,
                destinationDirectory: root.appendingPathComponent("downloads"), suggestedFilename: "mirror-result.bin"),
            mirrors: [secondary.baseURL.absoluteString], workDirectory: root.appendingPathComponent("1"))
    }

    func testFirstHTTPSourceFailsAndSecondProducesExactBytes() async throws {
        let root = try directory()
        let bytes = Data((0..<32768).map { UInt8($0 % 251) })
        let primary = try server(Data(repeating: 0xee, count: bytes.count), headStatus: 404)
        let secondary = try server(bytes)
        let engine = try engine(root: root, primary: primary, secondary: secondary)
        let final = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: final), bytes)
        XCTAssertFalse(primary.recordedMethods.isEmpty)
        XCTAssertFalse(secondary.recordedMethods.isEmpty)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("downloads").path).filter { !$0.hasPrefix(".") }, ["mirror-result.bin"])
    }

    func testPauseResumeUsesSelectedSourceAndForwardsLiveControls() async throws {
        let root = try directory()
        let bytes = Data(repeating: 0x27, count: 2 * 1024 * 1024)
        let primary = try server(Data(repeating: 0x81, count: bytes.count), headStatus: 404)
        let secondary = try server(bytes, slow: true)
        let first = try engine(root: root, primary: primary, secondary: secondary)
        let running = Task { try await first.start() }
        let deadline = Date().addingTimeInterval(10)
        while await first.currentProgress().completedBytes < 32768 {
            guard Date() < deadline else { await first.cancel(); _ = try? await running.value; XCTFail("No partial HTTP bytes"); return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        try await first.applyConnectionsCount(2)
        await first.applyBandwidthLimit(128 * 1024)
        let live = await first.currentProgress()
        XCTAssertEqual(live.currentConnections, 2)
        XCTAssertEqual(live.effectiveBandwidthLimitBytesPerSecond, 128 * 1024)
        await first.pause()
        do { _ = try await running.value; XCTFail("Paused source unexpectedly completed") } catch {}
        let primaryRequests = primary.recordedMethods.count
        let secondaryRangesBeforeResume = secondary.recordedRanges.count
        let resumed = try engine(root: root, primary: primary, secondary: secondary)
        let final = try await resumed.start()
        XCTAssertEqual(primary.recordedMethods.count, primaryRequests, "Resume must not return to the first source")
        XCTAssertEqual(try Data(contentsOf: final), bytes)
        XCTAssertTrue(secondary.recordedRanges.dropFirst(secondaryRangesBeforeResume).contains {
            $0.range(of: "bytes=[1-9][0-9]*-", options: .regularExpression) != nil
        }, "The resumed source must continue from a saved byte offset")
    }

    func testPartialHTTPFailurePreservesItsSourceInsteadOfMixingMirrorBytes() async throws {
        let root = try directory()
        let primary = try server(Data(repeating: 0x41, count: 65536), slow: true, truncate: true)
        let secondary = try server(Data(repeating: 0x62, count: 65536))
        let engine = try engine(root: root, primary: primary, secondary: secondary)
        do { _ = try await engine.start(); XCTFail("Truncated source should fail") }
        catch let error as MirrorDownloadError {
            guard case .partialPreserved = error else { XCTFail("Wrong mirror failure: \(error)"); return }
        }
        XCTAssertTrue(secondary.recordedMethods.isEmpty)
        if case .incomplete = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root.appendingPathComponent("1")) {} else { XCTFail("Partial ownership receipt must survive") }
        let partial = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root.appendingPathComponent("downloads"), includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix(".ndm-offset-") })
        XCTAssertEqual(try Data(contentsOf: partial).prefix(1024), Data(repeating: 0x41, count: 1024), "The preserved artifact must contain actual bytes from only the first source")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("downloads/mirror-result.bin").path))
        try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root.appendingPathComponent("1"))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("downloads").path).contains { $0.hasPrefix(".ndm") })
    }

    func testChangedMirrorListCannotAdoptAnExistingSourceMarker() async throws {
        let root = try directory()
        let primary = try server(Data(), headStatus: 404)
        let secondary = try server(Data(), headStatus: 404)
        let first = try engine(root: root, primary: primary, secondary: secondary)
        do { _ = try await first.start(); XCTFail("Both sources must fail") } catch {}
        let changed = try MirrorDownloadEngine(taskID: 1,
            request: DownloadRequest(url: primary.baseURL, destinationDirectory: root.appendingPathComponent("downloads")),
            mirrors: [secondary.baseURL.appendingPathComponent("changed").absoluteString], workDirectory: root.appendingPathComponent("1"))
        do { _ = try await changed.start(); XCTFail("Changed list must fail") }
        catch let error as MirrorDownloadError { guard case .sourceChanged = error else { XCTFail("Wrong error"); return } }
    }

    func testMirrorsPreserveAnExistingDestination() async throws {
        let root = try directory()
        let downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let existing = Data("keep-existing-file".utf8)
        try existing.write(to: downloads.appendingPathComponent("mirror-result.bin"))
        let primary = try server(Data(repeating: 2, count: 4096), headStatus: 404)
        let secondary = try server(Data(repeating: 3, count: 4096))
        do { _ = try await engine(root: root, primary: primary, secondary: secondary).start(); XCTFail("Existing file must not be replaced") } catch {}
        XCTAssertEqual(try Data(contentsOf: downloads.appendingPathComponent("mirror-result.bin")), existing)
    }

    func testSourcePolicyRejectsCrossOriginCredentialsAndMalformedSources() throws {
        for headers in [["Cookie: test=1"], ["Authorization: token"], ["Referer: https://site.test"], ["Origin: https://site.test"]] {
            XCTAssertThrowsError(try MirrorDownloadPolicy.validate(primary: "https://a.test/file", mirrors: ["https://b.test/file"], headers: headers))
        }
        XCTAssertThrowsError(try MirrorDownloadPolicy.validate(primary: "https://user:pass@a.test/file", mirrors: ["https://b.test/file"]))
        XCTAssertThrowsError(try MirrorDownloadPolicy.validate(primary: "https://a.test/file", mirrors: ["https://b.test/file"], pageURL: "https://page.test"))
        for mirror in ["https:b.test/file", "ftp://b.test/file", "file:///tmp/a", "https://b.test/ bad"] {
            XCTAssertThrowsError(try MirrorDownloadPolicy.validate(primary: "https://a.test/file", mirrors: [mirror]))
        }
        XCTAssertNoThrow(try MirrorDownloadPolicy.validate(primary: "https://a.test/file", mirrors: ["https://a.test/other"], headers: ["Cookie: fixture=1"]))
    }

    func testTaskCodableAndSQLiteMirrorRoundTripAndLegacyMigration() throws {
        let root = try directory()
        let original = DownloadTask(url: "https://a.test/file", mirrorURLs: ["https://b.test/file", "https://c.test/file"])
        XCTAssertEqual(try JSONDecoder().decode(DownloadTask.self, from: JSONEncoder().encode(original)), original)
        var legacy = try JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as! [String: Any]
        legacy.removeValue(forKey: "mirrorURLs")
        XCTAssertNil(try JSONDecoder().decode(DownloadTask.self, from: JSONSerialization.data(withJSONObject: legacy)).mirrorURLs)
        var store: DownloadStore? = try DownloadStore(directory: root)
        let saved = try store!.insert(original)
        store = nil
        store = try DownloadStore(directory: root)
        XCTAssertEqual(try store!.allDownloads().first?.mirrorURLs, original.mirrorURLs)
        var updated = saved; updated.mirrorURLs = ["https://d.test/file"]
        try store!.update(updated)
        XCTAssertEqual(try store!.allDownloads().first?.mirrorURLs, updated.mirrorURLs)
        store = nil
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(root.appendingPathComponent("NeatDB.db").path, &database), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(database, "ALTER TABLE downloads DROP COLUMN mirrorurls", nil, nil, nil), SQLITE_OK)
        sqlite3_close(database)
        store = try DownloadStore(directory: root)
        XCTAssertNil(try store!.allDownloads().first?.mirrorURLs)
    }

    func testCreationReceiptBindsMirrorOrderAndPreservesLegacyEmptyDigest() async throws {
        let root = try directory()
        let store = try DownloadStore(directory: root.appendingPathComponent("support"))
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root.appendingPathComponent("downloads")), supportRoot: root.appendingPathComponent("support"))
        let key = UUID().uuidString
        let plain: [String: Any] = ["op": "add", "url": "https://a.test/file", "creationKey": key, "autoStart": false]
        var empty = plain; empty["mirrors"] = [String]()
        XCTAssertEqual(try DownloadCreationRequest.intent(from: plain), try DownloadCreationRequest.intent(from: empty))
        var input = plain; input["mirrors"] = ["https://b.test/file", "https://c.test/file"]
        let intent = try XCTUnwrap(DownloadCreationRequest.intent(from: input))
        let created = try await manager.createURL("https://a.test/file", mirrors: ["https://b.test/file", "https://c.test/file"], autoStart: false, creationIntent: intent)
        XCTAssertEqual(created?.mirrorURLs, input["mirrors"] as? [String])
        let replay = try await manager.createURL("https://a.test/file", mirrors: ["https://b.test/file", "https://c.test/file"], autoStart: false, creationIntent: intent)
        XCTAssertEqual(created?.id, replay?.id)
        input["mirrors"] = ["https://c.test/file", "https://b.test/file"]
        let changed = try XCTUnwrap(DownloadCreationRequest.intent(from: input))
        do { _ = try await manager.createURL("https://a.test/file", mirrors: input["mirrors"] as! [String], autoStart: false, creationIntent: changed); XCTFail("Mirror intent change must fail") }
        catch let error as DownloadCreationError { XCTAssertEqual(error.kind, "creationIntentMismatch") }
        XCTAssertEqual(try store.allDownloads().count, 1)
    }

    func testManagerRoutesMirrorTaskToNativeFallbackAndKeepsSingleLedgerRow() async throws {
        let root = try directory()
        let bytes = Data(repeating: 0x33, count: 4096)
        let primary = try server(Data(), headStatus: 404)
        let secondary = try server(bytes)
        let support = root.appendingPathComponent("support")
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root.appendingPathComponent("downloads"), useCategoryFolders: false), supportRoot: support)
        let admitted = try await manager.createURL(primary.baseURL.absoluteString, mirrors: [secondary.baseURL.absoluteString], filename: "file.bin")
        let created = try XCTUnwrap(admitted)
        let deadline = Date().addingTimeInterval(10)
        while try store.allDownloads().first?.status == .downloading || store.allDownloads().first?.status == .waiting {
            guard Date() < deadline else { await manager.pause(taskID: created.id); XCTFail("Mirror manager did not settle"); return }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let tasks = try store.allDownloads()
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(tasks.first?.status, .complete, tasks.first?.errorText ?? "")
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(tasks.first?.destinationFileURL)), bytes)
        try await manager.remove(taskID: created.id, deleteFile: false)
        XCTAssertTrue(try store.allDownloads().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: support.appendingPathComponent(String(created.id)).path))
    }

    func testResumeRejectsNewCrossOriginCredentialsWithoutLeavingAnUnownedDownloadingRow() async throws {
        let root = try directory()
        let support = root.appendingPathComponent("support")
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root.appendingPathComponent("downloads")), supportRoot: support)
        let task = try store.insert(DownloadTask(url: "https://a.test/file", status: .paused,
            headers: ["Cookie: acquired-after-admission=1"], mirrorURLs: ["https://b.test/file"]))
        do { try await manager.start(taskID: task.id); XCTFail("Cross-origin credentials must block restart") }
        catch let error as MirrorDownloadError { guard case .credentialsAcrossOrigins = error else { XCTFail("Wrong error"); return } }
        XCTAssertEqual(try store.allDownloads().first?.status, .paused)
    }
}
