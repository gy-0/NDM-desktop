import XCTest
@testable import NDMCore
@testable import NDMEngine

final class URLRenewalTests: XCTestCase {
    func testChangedURLPreservesLegacyArtifactsAndOriginalRowAcrossReopen() async throws {
        // Even an empty checkpoint or a hidden/unknown artifact can own progress;
        // byte counts and a short allowlist cannot authorize throwing it away.
        for artifact in ["seg.x0", "segments.bin", ".checkpoint", "unknown-recovery-state"] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            let original = try insertExpired(in: f)
            let work = try workDirectory(for: original, in: f)
            let path = work.appendingPathComponent(artifact)
            let bytes = artifact == "seg.x0" ? Data(repeating: 0x73, count: 257) : Data()
            try bytes.write(to: path)
            await assertNewTaskRequired(f.manager, taskID: original.id, newURL: original.url + "&token=fresh")
            XCTAssertEqual(try f.store.allDownloads().first, original, artifact)
            XCTAssertEqual(try Data(contentsOf: path), bytes, artifact)

            let reopened = try DownloadStore(directory: f.support)
            let reconstructed = DownloadManager(store: reopened, settings: f.settings, supportRoot: f.support)
            await assertNewTaskRequired(reconstructed, taskID: original.id, newURL: original.url + "&token=again")
            XCTAssertEqual(try reopened.allDownloads().first, original, artifact)
            XCTAssertEqual(try Data(contentsOf: path), bytes, artifact)
        }
    }

    func testRejectedRenewalPreservesV2OwnershipAndRemovalCleansOnlyOwnedPartial() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let original = try insertExpired(in: f)
        let work = try workDirectory(for: original, in: f)
        let target = f.downloads.appendingPathComponent(original.filename)
        let partial: URL
        do {
            let storage = try OffsetDownloadStorage.create(taskID: original.id, workDirectory: work,
                destinationURL: target, totalBytes: 8, resourceContextHash: "original-request-fixture",
                ranges: [.init(id: 0, start: 0, end: 7, durablePrefix: 0)])
            partial = storage.partialURL
            try storage.write(segmentID: 0, data: Data([1, 2, 3, 4]))
            try storage.checkpoint()
        }
        let receipt = work.appendingPathComponent("offset-storage-v2.json")
        let receiptBefore = try Data(contentsOf: receipt)
        let bytesBefore = try Data(contentsOf: partial)
        let unrelated = f.downloads.appendingPathComponent("unrelated.bin")
        try Data([99]).write(to: unrelated)
        let reopened = try DownloadStore(directory: f.support)
        let reconstructed = DownloadManager(store: reopened, settings: f.settings, supportRoot: f.support)
        await assertNewTaskRequired(reconstructed, taskID: original.id, newURL: original.url + "&token=fresh")
        XCTAssertEqual(try reopened.allDownloads().first, original)
        XCTAssertEqual(try Data(contentsOf: receipt), receiptBefore)
        XCTAssertEqual(try Data(contentsOf: partial), bytesBefore)
        do {
            let recovered = try OffsetDownloadStorage.recover(taskID: original.id, workDirectory: work,
                resourceContextHash: "original-request-fixture")
            XCTAssertEqual(recovered.snapshot().first?.durablePrefix, 4)
        }
        try await reconstructed.remove(taskID: original.id, deleteFile: false)
        XCTAssertTrue(try reopened.allDownloads().isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path))
        XCTAssertEqual(try Data(contentsOf: unrelated), Data([99]))
    }

    func testCrossOriginAndEmbeddedCredentialsCannotInheritRequestEvenWithoutProgress() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let original = try insertExpired(in: f)
        for replacement in [
            "https://another.example.com/file.bin",
            "http://cdn.example.com/file.bin",
            "https://cdn.example.com:8443/file.bin",
            "ftp://cdn.example.com/file.bin",
            "https://user:secret@cdn.example.com/file.bin",
            "https://user@cdn.example.com/file.bin",
        ] {
            await assertNewTaskRequired(f.manager, taskID: original.id, newURL: replacement)
            XCTAssertEqual(try f.store.allDownloads().first, original, replacement)
        }
    }

    func testMalformedAndUnsupportedURLsAreRejectedWithoutMutation() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let original = try insertExpired(in: f)
        for replacement in ["relative/file.bin", "https://", "file:///tmp/fixture.bin", "data:text/plain,fixture"] {
            do {
                try await f.manager.renewURL(taskID: original.id, newURL: replacement)
                XCTFail("Invalid URL accepted: \(replacement)")
            } catch ManagerError.invalidURL {} catch { XCTFail("Unexpected \(error)") }
            XCTAssertEqual(try f.store.allDownloads().first, original)
        }
    }

    func testSameOriginChangeWithNoRecoveryArtifactsCanReplaceURL() async throws {
        for logsOnly in [false, true] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            let original = try insertExpired(in: f)
            var log: URL?
            if logsOnly {
                log = try workDirectory(for: original, in: f).appendingPathComponent("LogFile.txt")
                try Data("fixture diagnostic".utf8).write(to: log!)
            }
            let replacement = "https://cdn.example.com/file.bin?token=fresh"
            try await f.manager.renewURL(taskID: original.id, newURL: replacement)
            var expected = original
            expected.url = replacement
            expected.errorText = nil
            expected.status = .incomplete
            XCTAssertEqual(try f.store.allDownloads().first, expected)
            if let log { XCTAssertEqual(try Data(contentsOf: log), Data("fixture diagnostic".utf8)) }
        }
    }

    func testSameURLKeepsPartialBytesAndPausedIntent() async throws {
        for status in [DownloadStatus.error, .paused, .incomplete] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            var original = try insertExpired(in: f)
            original.status = status
            try f.store.update(original)
            let partial = try workDirectory(for: original, in: f).appendingPathComponent("seg.x0")
            let bytes = Data([1, 4, 9, 16])
            try bytes.write(to: partial)
            try await f.manager.renewURL(taskID: original.id, newURL: original.url)
            var expected = original
            expected.errorText = nil
            if status == .error { expected.status = .incomplete }
            XCTAssertEqual(try f.store.allDownloads().first, expected)
            XCTAssertEqual(try Data(contentsOf: partial), bytes)
            let active = await f.manager.hasActiveDownloads()
            XCTAssertFalse(active, "URL renewal does not start network work on its own")
        }
    }

    func testRunningAndCompletedRowsCannotBeRenewed() async throws {
        for status in [DownloadStatus.downloading, .complete] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            var original = try insertExpired(in: f)
            original.status = status
            try f.store.update(original)
            do {
                try await f.manager.renewURL(taskID: original.id, newURL: original.url)
                XCTFail("Cannot renew \(status)")
            } catch ManagerError.renewalUnavailable {} catch { XCTFail("Unexpected \(error)") }
            XCTAssertEqual(try f.store.allDownloads().first, original)
        }
    }

    func testRenewalWaitsForRemovalAndBridgeCaptureCannotRescueItsLockedRow() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let entered = expectation(description: "Removal entered recycler while holding task lock")
        let gate = RenewalRemovalGate(entered: entered)
        let manager = DownloadManager(store: f.store, settings: f.settings, supportRoot: f.support,
            fileRecycler: { _ in await gate.wait() })
        let original = try f.store.insert(DownloadTask(url: "https://cdn.example.com/file.bin", filename: "fixture.bin",
            status: .error, pageURL: "https://example.com/source",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString, folderPath: f.downloads.path))
        try Data([1]).write(to: f.downloads.appendingPathComponent(original.filename))
        let removal = Task { try await manager.remove(taskID: original.id, deleteFile: true) }
        await fulfillment(of: [entered], timeout: 2)
        var capture = ParsedBridgeMessage()
        capture.url = original.url
        capture.pageURL = original.pageURL!
        let admitted = try await manager.addFromBridge(capture, awaitingDestination: true)
        XCTAssertNotEqual(admitted.id, original.id, "An in-flight removal owns the original row")
        let finished = expectation(description: "Renewal must wait for the lifecycle lock")
        finished.isInverted = true
        let renewal = Task {
            defer { finished.fulfill() }
            do {
                try await manager.renewURL(taskID: original.id, newURL: original.url)
                return false
            } catch ManagerError.taskNotFound { return true } catch { return false }
        }
        await fulfillment(of: [finished], timeout: 0.05)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == original.id }, original)
        await gate.release()
        try await removal.value
        let sawRemovedTask = await renewal.value
        XCTAssertTrue(sawRemovedTask, "Renewal must re-read the row after removal releases its lock")
        XCTAssertEqual(try f.store.allDownloads().map(\.id), [admitted.id])
    }

    private func assertNewTaskRequired(_ manager: DownloadManager, taskID: Int64, newURL: String,
                                       file: StaticString = #filePath, line: UInt = #line) async {
        do {
            try await manager.renewURL(taskID: taskID, newURL: newURL)
            XCTFail("Unbound replacement must require a new task", file: file, line: line)
        } catch ManagerError.renewalRequiresNewTask {} catch {
            XCTFail("Unexpected \(error)", file: file, line: line)
        }
    }

    private func insertExpired(in f: Fixture) throws -> DownloadTask {
        try f.store.insert(DownloadTask(url: "https://cdn.example.com/file.bin?token=original", method: "POST",
            filename: "fixture.bin", fileSize: 8, status: .error,
            lastTry: Date(timeIntervalSince1970: 10), firstTry: Date(timeIntervalSince1970: 1),
            userAgent: "Fixture Browser", resumable: true, pageURL: "https://example.com/source",
            pageTitle: "Original source", mimeType: "application/octet-stream",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            postData: Data("fixture=original".utf8), folderPath: f.downloads.path,
            headers: ["Cookie: session=original-fixture", "Authorization: Bearer original-fixture"]))
    }

    private func workDirectory(for task: DownloadTask, in f: Fixture) throws -> URL {
        let work = f.support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        return work
    }

    private struct Fixture {
        let root: URL
        let support: URL
        let downloads: URL
        let store: DownloadStore
        let settings: AppSettings
        let manager: DownloadManager
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-renewal-\(UUID())")
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: downloads, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        return Fixture(root: root, support: support, downloads: downloads, store: store, settings: settings, manager: manager)
    }
}

private actor RenewalRemovalGate {
    let entered: XCTestExpectation
    private var continuation: CheckedContinuation<Void, Never>?
    init(entered: XCTestExpectation) { self.entered = entered }
    func wait() async {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            entered.fulfill()
        }
    }
    func release() { continuation?.resume(); continuation = nil }
}
