import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadManagerQueuePauseTests: XCTestCase {
    private struct Fixture {
        let root: URL
        let support: URL
        let downloads: URL
        let store: DownloadStore
        let manager: DownloadManager
    }

    private func fixture(parallel: Bool = false) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-queue-pause-\(UUID())")
        let support = root.appendingPathComponent("support")
        let downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store,
            settings: AppSettings(downloadDirectory: downloads, maxConnections: 1,
                downloadAllAtOnce: parallel, useCategoryFolders: false), supportRoot: support)
        return Fixture(root: root, support: support, downloads: downloads, store: store, manager: manager)
    }

    private func insert(_ f: Fixture, url: String = "http://127.0.0.1:1/file.bin", status: DownloadStatus = .waiting,
                        startAt: Date? = nil, awaitingDestination: Bool = false) throws -> DownloadTask {
        try f.store.insert(DownloadTask(url: url, filename: "fixture-\(UUID()).bin", status: status, connections: 1,
            startAt: startAt, folderPath: f.downloads.path, awaitingDestination: awaitingDestination))
    }

    func testPauseWithoutEnginePersistsAndKeepsRecoveryArtifacts() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let row = try insert(f)
        let work = f.support.appendingPathComponent(String(row.id))
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let partial = work.appendingPathComponent("seg.x0")
        let bytes = Data([1, 2, 3, 4])
        try bytes.write(to: partial)

        await f.manager.pause(taskID: row.id)
        let reopened = try DownloadStore(directory: f.support)
        let parked = try XCTUnwrap(reopened.allDownloads().first { $0.id == row.id })
        XCTAssertEqual(parked.status, .paused)
        XCTAssertEqual(parked.folderPath, row.folderPath)
        XCTAssertEqual(parked.firstTry, row.firstTry)
        XCTAssertEqual(try Data(contentsOf: partial), bytes)
    }

    func testDelayedQueueAndRelayCallbacksCannotUndoPause() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 4, count: 4096))
        try server.start()
        defer { server.stop() }
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let queued = try insert(f, url: server.baseURL.absoluteString)
        let handoff = try insert(f, url: server.baseURL.absoluteString, status: .incomplete)
        await f.manager.pause(taskID: queued.id)
        await f.manager.pause(taskID: handoff.id)
        // Invoke the same callback after it captured a waiting ID, as happens
        // when clearRunning schedules work on a subsequent actor turn.
        let started = try await f.manager.startWaitingTaskIfEligible(taskID: queued.id)
        try await f.manager.startAcceptedRelayHandoff(taskID: handoff.id)
        XCTAssertFalse(started)
        XCTAssertTrue(server.recordedMethods.isEmpty)
        XCTAssertTrue(try f.store.allDownloads().allSatisfy { $0.status == .paused })
    }

    func testPauseCancelsAppointmentWithoutConfirmingDestination() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let appointment = Date().addingTimeInterval(3600)
        let scheduled = try insert(f, startAt: appointment)
        let needsDestination = try insert(f, status: .paused, awaitingDestination: true)
        await f.manager.pause(taskID: scheduled.id)
        await f.manager.pause(taskID: needsDestination.id)
        let due = await f.manager.startDueScheduledTasks(now: appointment.addingTimeInterval(1))
        let rows = try f.store.allDownloads()
        XCTAssertTrue(due.isEmpty)
        XCTAssertEqual(rows.first { $0.id == scheduled.id }?.status, .paused)
        XCTAssertNil(rows.first { $0.id == scheduled.id }?.startAt)
        XCTAssertEqual(rows.first { $0.id == needsDestination.id }?.awaitingDestination, true)
        XCTAssertEqual(rows.first { $0.id == needsDestination.id }?.folderPath, needsDestination.folderPath)
    }

    func testQueueModeChangeDoesNotBypassAppointmentOrDestinationConsent() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 5, count: 4096))
        try server.start()
        defer { server.stop() }
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let scheduled = try insert(f, url: server.baseURL.absoluteString, startAt: Date().addingTimeInterval(3600))
        let needsDestination = try insert(f, url: server.baseURL.absoluteString, awaitingDestination: true)
        var settings = await f.manager.currentSettings()
        settings.downloadAllAtOnce = true
        await f.manager.updateSettings(settings)
        XCTAssertTrue(server.recordedMethods.isEmpty)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == scheduled.id }?.status, .waiting)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == needsDestination.id }?.awaitingDestination, true)
        let active = await f.manager.hasActiveDownloads()
        XCTAssertFalse(active)
    }

    func testChangedAppointmentRejectsOldDueCallbackAndNewAppointmentStarts() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 6, count: 4096))
        try server.start()
        defer { server.stop() }
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let row = try insert(f, url: server.baseURL.absoluteString, startAt: Date().addingTimeInterval(1800))
        let original = try XCTUnwrap(f.store.allDownloads().first { $0.id == row.id }?.startAt)
        let later = Date().addingTimeInterval(3600)
        try await f.manager.schedule(taskID: row.id, at: later)
        let staleStarted = try await f.manager.startWaitingTaskIfEligible(taskID: row.id, scheduledAt: original)
        XCTAssertFalse(staleStarted)
        XCTAssertTrue(server.recordedMethods.isEmpty)
        let started = await f.manager.startDueScheduledTasks(now: later.addingTimeInterval(1))
        XCTAssertEqual(started, [row.id])
        try await f.manager.startAndWait(taskID: row.id)
        let finished = try XCTUnwrap(f.store.allDownloads().first { $0.id == row.id })
        XCTAssertEqual(finished.status, .complete)
        XCTAssertNil(finished.startAt)
        XCTAssertEqual(try Data(contentsOf: f.downloads.appendingPathComponent(finished.filename)), Data(repeating: 6, count: 4096))
    }

    func testImmediateStartThenPauseDrainsTheRegisteredWriter() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 7, count: 1024 * 1024), responseDelay: 0.2)
        try server.start()
        defer { server.stop() }
        let f = try fixture(parallel: true)
        defer { try? FileManager.default.removeItem(at: f.root) }
        for _ in 0..<6 {
            let row = try insert(f, url: server.baseURL.absoluteString)
            try await f.manager.start(taskID: row.id)
            await f.manager.pause(taskID: row.id)
            XCTAssertEqual(try f.store.allDownloads().first { $0.id == row.id }?.status, .paused)
            let active = await f.manager.hasActiveDownloads()
            XCTAssertFalse(active)
        }
    }

    func testPausedQueueEntryStaysStoppedWhenCurrentTaskCompletesAndCanResume() async throws {
        let firstServer = LocalRangeServer(payload: Data(repeating: 8, count: 4096))
        let queuedServer = LocalRangeServer(payload: Data(repeating: 9, count: 4096))
        try firstServer.start(); try queuedServer.start()
        defer { firstServer.stop(); queuedServer.stop() }
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let first = try insert(f, url: firstServer.baseURL.absoluteString)
        let queued = try insert(f, url: queuedServer.baseURL.deletingLastPathComponent().appendingPathComponent("queued.bin").absoluteString)
        await f.manager.pause(taskID: queued.id)
        try await f.manager.startAndWait(taskID: first.id)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == queued.id }?.status, .paused)
        XCTAssertTrue(queuedServer.recordedMethods.isEmpty)
        try await f.manager.startAndWait(taskID: queued.id)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == queued.id }?.status, .complete)
    }
}
