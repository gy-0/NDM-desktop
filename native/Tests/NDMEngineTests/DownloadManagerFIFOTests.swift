import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadManagerFIFOTests: XCTestCase {
    func testServerSuggestedFilenameIsNotRecordedAsUserChoice() async throws {
        let fixture = try fixture()
        let created = try await fixture.manager.createURL("https://example.test/download?filename=server.mp4",
            pageTitle: "Original source title", filename: "server.mp4", filenameIsExplicit: false, autoStart: false)
        let saved = try XCTUnwrap(created)
        XCTAssertEqual(saved.filename, "server.mp4")
        XCTAssertNil(saved.requestedFilename)
        XCTAssertEqual(saved.pageTitle, "Original source title")
    }

    func testReviewedMediaFilenameSurvivesStoreReopenAndRealHTTPCompletion() async throws {
        let fixture = try fixture()
        let payload = Data(repeating: 73, count: 4096)
        let server = LocalRangeServer(payload: payload, responseHeaders: { _, _ in ["Content-Type": "video/mp4"] })
        try server.start()
        defer { server.stop() }
        let created = try await fixture.manager.createURL(server.baseURL.absoluteString,
            pageURL: "https://example.test/video/123", pageTitle: "Original source title",
            filename: "reviewed.mp4", autoStart: false)
        let task = try XCTUnwrap(created)
        let reopened = try DownloadStore(directory: fixture.support)
        let saved = try XCTUnwrap(reopened.download(id: task.id))
        XCTAssertEqual(saved.requestedFilename, "reviewed.mp4")
        XCTAssertEqual(saved.pageTitle, "Original source title")
        try await fixture.manager.start(taskID: task.id)
        try await waitUntil("Reviewed media did not complete") { try reopened.download(id: task.id)?.status == .complete }
        let done = try XCTUnwrap(reopened.download(id: task.id))
        XCTAssertEqual(done.filename, "reviewed.mp4")
        XCTAssertEqual(done.pageTitle, "Original source title")
        XCTAssertEqual(done.pageURL, "https://example.test/video/123")
        XCTAssertEqual(done.requestedFilename, "reviewed.mp4")
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(done.destinationFileURL)), payload)
    }

    /// Holds the actual HTTP response, so admission/order checks do not depend on
    /// a fast machine finishing a small payload before the next task is added.
    private final class ResponseGate: @unchecked Sendable {
        private let condition = NSCondition()
        private var open = false

        func wait() {
            condition.lock()
            defer { condition.unlock() }
            while !open { condition.wait() }
        }

        func release() {
            condition.lock()
            open = true
            condition.broadcast()
            condition.unlock()
        }
    }

    private struct Fixture {
        let support: URL
        let downloads: URL
        let store: DownloadStore
        let manager: DownloadManager
    }

    private struct Transfer {
        let name: String
        let payload: Data
        let server: LocalRangeServer
        let gate: ResponseGate
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-fifo-\(UUID())")
        let support = root.appendingPathComponent("support")
        let downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store,
            settings: AppSettings(downloadDirectory: downloads, maxConnections: 1,
                downloadAllAtOnce: false, useCategoryFolders: false), supportRoot: support)
        addTeardownBlock {
            // Pausing waiting rows first prevents cleanup from advancing the queue.
            for task in try store.allDownloads() where task.status == .waiting {
                await manager.pause(taskID: task.id)
            }
            for task in try store.allDownloads() {
                await manager.pause(taskID: task.id)
            }
            try FileManager.default.removeItem(at: root)
        }
        return Fixture(support: support, downloads: downloads, store: store, manager: manager)
    }

    private func transfer(_ name: String, byte: UInt8) throws -> Transfer {
        let payload = Data(repeating: byte, count: 4096)
        let gate = ResponseGate()
        let server = LocalRangeServer(payload: payload, responseHeaders: { _, _ in
            gate.wait()
            return [:]
        })
        try server.start()
        addTeardownBlock {
            gate.release()
            server.stop()
        }
        return Transfer(name: name, payload: payload, server: server, gate: gate)
    }

    private func create(_ transfer: Transfer, in fixture: Fixture) async throws -> DownloadTask {
        let task = try await fixture.manager.createURL(transfer.server.baseURL.absoluteString,
            filename: transfer.name, autoStart: true)
        return try XCTUnwrap(task)
    }

    private func insert(_ transfer: Transfer, in fixture: Fixture,
                        status: DownloadStatus = .waiting) throws -> DownloadTask {
        try fixture.store.insert(DownloadTask(url: transfer.server.baseURL.absoluteString,
            filename: transfer.name, status: status, connections: 1,
            folderPath: fixture.downloads.path))
    }

    private func waitUntil(_ message: String, condition: () throws -> Bool) async throws {
        let deadline = Date().addingTimeInterval(10)
        while !(try condition()) {
            if Date() >= deadline {
                XCTFail(message)
                throw NSError(domain: "DownloadManagerFIFOTests", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: message])
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func finish(_ transfer: Transfer, task: DownloadTask, in fixture: Fixture) async throws {
        transfer.gate.release()
        try await waitUntil("\(transfer.name) did not complete") {
            try fixture.store.allDownloads().first { $0.id == task.id }?.status == .complete
        }
        let completed = try XCTUnwrap(fixture.store.allDownloads().first { $0.id == task.id })
        XCTAssertEqual(try Data(contentsOf: fixture.downloads.appendingPathComponent(completed.filename)),
            transfer.payload)
    }

    func testThreeAutomaticHTTPDownloadsRunInCreationOrder() async throws {
        let fixture = try fixture()
        let a = try transfer("a.bin", byte: 1)
        let b = try transfer("b.bin", byte: 2)
        let c = try transfer("c.bin", byte: 3)
        let first = try await create(a, in: fixture)
        let second = try await create(b, in: fixture)
        let third = try await create(c, in: fixture)
        XCTAssertEqual(second.status, .waiting)
        XCTAssertEqual(third.status, .waiting)

        try await finish(a, task: first, in: fixture)
        try await waitUntil("B was not the next HTTP transfer") { !b.server.recordedMethods.isEmpty }
        XCTAssertTrue(c.server.recordedMethods.isEmpty)
        try await finish(b, task: second, in: fixture)
        try await waitUntil("C did not start after B") { !c.server.recordedMethods.isEmpty }
        try await finish(c, task: third, in: fixture)
    }

    func testManualQueueOrderSurvivesStoreReopenAndControlsActualHTTPAdmission() async throws {
        let fixture = try fixture()
        let a = try transfer("running.bin", byte: 21)
        let b = try transfer("earlier.bin", byte: 22)
        let c = try transfer("moved-first.bin", byte: 23)
        let first = try await create(a, in: fixture)
        let second = try await create(b, in: fixture)
        let third = try await create(c, in: fixture)
        try await fixture.manager.moveQueuedTask(taskID: third.id, beforeTaskID: second.id, expectedIDs: [second.id, third.id])
        let reopened = try DownloadStore(directory: fixture.support)
        XCTAssertEqual(try reopened.queueOrder(), [third.id, second.id])
        let queue = try await fixture.manager.waitingQueue()
        XCTAssertEqual(queue.map(\.id), [third.id, second.id])
        do {
            try await fixture.manager.moveQueuedTask(taskID: second.id, beforeTaskID: nil, expectedIDs: [second.id, third.id])
            XCTFail("A stale displayed order must be rejected")
        } catch ManagerError.queueChanged {}
        XCTAssertTrue(b.server.recordedMethods.isEmpty)
        XCTAssertTrue(c.server.recordedMethods.isEmpty)
        try await finish(a, task: first, in: fixture)
        try await waitUntil("Manually promoted HTTP task did not start") { !c.server.recordedMethods.isEmpty }
        XCTAssertTrue(b.server.recordedMethods.isEmpty)
        try await finish(c, task: third, in: fixture)
        try await waitUntil("Remaining HTTP task did not advance") { !b.server.recordedMethods.isEmpty }
        try await finish(b, task: second, in: fixture)
    }

    func testNewAutomaticTaskCannotTakeTheIdleSlotAheadOfOlderWaitingTasks() async throws {
        let fixture = try fixture()
        let a = try transfer("older-a.bin", byte: 4)
        let b = try transfer("older-b.bin", byte: 5)
        let c = try transfer("new-c.bin", byte: 6)
        // This is the persisted queue during the actor turn after the previous
        // writer exits but before its scheduled queue callback obtains a lock.
        let first = try insert(a, in: fixture)
        let second = try insert(b, in: fixture)
        let third = try await create(c, in: fixture)
        XCTAssertEqual(third.status, .waiting)
        try await waitUntil("The oldest queued task was not admitted") { !a.server.recordedMethods.isEmpty }
        XCTAssertTrue(b.server.recordedMethods.isEmpty)
        XCTAssertTrue(c.server.recordedMethods.isEmpty)

        try await finish(a, task: first, in: fixture)
        try await waitUntil("The second old task was overtaken") { !b.server.recordedMethods.isEmpty }
        XCTAssertTrue(c.server.recordedMethods.isEmpty)
        try await finish(b, task: second, in: fixture)
        try await waitUntil("The new task did not advance after older tasks") { !c.server.recordedMethods.isEmpty }
        try await finish(c, task: third, in: fixture)
    }

    func testRelayAutomaticAdmissionAlsoRespectsAnOlderWaitingTask() async throws {
        let fixture = try fixture()
        let a = try transfer("older.bin", byte: 7)
        let b = try transfer("relay.bin", byte: 8)
        let older = try insert(a, in: fixture)
        let relay = try insert(b, in: fixture, status: .incomplete)
        try await fixture.manager.startAcceptedRelayHandoff(taskID: relay.id)
        try await waitUntil("The older task did not start before the handoff") { !a.server.recordedMethods.isEmpty }
        XCTAssertTrue(b.server.recordedMethods.isEmpty)
        try await finish(a, task: older, in: fixture)
        try await waitUntil("The relay task did not advance") { !b.server.recordedMethods.isEmpty }
        try await finish(b, task: relay, in: fixture)
    }

    func testExplicitStartCanChooseANewerTaskWhileAutomaticCallbacksCannot() async throws {
        let fixture = try fixture()
        let a = try transfer("older.bin", byte: 9)
        let b = try transfer("chosen.bin", byte: 10)
        let older = try insert(a, in: fixture)
        let chosen = try insert(b, in: fixture)
        let automaticStarted = try await fixture.manager.startWaitingTaskIfEligible(taskID: chosen.id)
        XCTAssertFalse(automaticStarted)
        XCTAssertTrue(a.server.recordedMethods.isEmpty)
        XCTAssertTrue(b.server.recordedMethods.isEmpty)

        // Explicit start/resume keeps its existing semantics: when the engine is
        // idle the user may choose any task without changing automatic FIFO.
        try await fixture.manager.start(taskID: chosen.id)
        try await waitUntil("Explicit start did not select the requested task") { !b.server.recordedMethods.isEmpty }
        XCTAssertTrue(a.server.recordedMethods.isEmpty)
        try await finish(b, task: chosen, in: fixture)
        try await waitUntil("The old task did not advance after the explicit choice") { !a.server.recordedMethods.isEmpty }
        try await finish(a, task: older, in: fixture)
    }

    func testOrdinaryAutomaticCallbackDoesNotBypassAReadyCollection() async throws {
        let fixture = try fixture()
        let ordinary = try transfer("ordinary.bin", byte: 11)
        let row = try insert(ordinary, in: fixture)
        let collection = try fixture.store.insert(DownloadTask(url: "https://example.com/watch/1",
            linkType: "ytdlp", status: .waiting, pageURL: "https://example.com/playlist/1"))
        XCTAssertEqual(DownloadManager.queuedCollectionCandidate(in: try fixture.store.allDownloads())?.id,
            collection.id)
        let started = try await fixture.manager.startWaitingTaskIfEligible(taskID: row.id)
        XCTAssertFalse(started)
        XCTAssertTrue(ordinary.server.recordedMethods.isEmpty)
    }

    func testAQueueHeadThatCannotStartFailsVisiblyAndDoesNotStrandTheNextTask() async throws {
        let fixture = try fixture()
        let a = try transfer("blocked.bin", byte: 12)
        let b = try transfer("next.bin", byte: 13)
        let blocked = try insert(a, in: fixture)
        // An existing file where a task's work directory belongs makes startup
        // fail before a writer is registered, rather than inside runEngine.
        try Data("occupied".utf8).write(to: fixture.support.appendingPathComponent(String(blocked.id)))
        let next = try await create(b, in: fixture)
        let failed = try XCTUnwrap(fixture.store.allDownloads().first { $0.id == blocked.id })
        XCTAssertEqual(failed.status, .error)
        XCTAssertNotNil(failed.errorText)
        XCTAssertTrue(a.server.recordedMethods.isEmpty)
        try await waitUntil("Startup failure stranded the following task") { !b.server.recordedMethods.isEmpty }
        try await finish(b, task: next, in: fixture)
    }
}
