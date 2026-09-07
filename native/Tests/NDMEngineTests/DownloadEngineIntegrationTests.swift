import XCTest
@testable import NDMEngine
@testable import NDMCore

final class DownloadEngineIntegrationTests: XCTestCase {
    func testCompletedMediaIsSmartNamedBeforePersistenceAndCallback() async throws {
        let payload = Data(repeating: 0x5A, count: 96 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-smart-name-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let mediaURL = URL(string: "http://127.0.0.1:\(server.port)/videoplayback-9f31.mp4")!
        var task = DownloadTask(
            url: mediaURL.absoluteString,
            filename: "videoplayback-9f31.mp4",
            category: .video,
            status: .incomplete,
            connections: 2,
            pageTitle: "A Better Download - YouTube",
            mimeType: "video/mp4",
            folderPath: dest.path
        )
        task = try store.insert(task)

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.filename, "A Better Download.mp4")
        XCTAssertTrue(SmartFinalize.filenameReflectsPageTitle(done.filename, pageTitle: done.pageTitle))
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: dest.appendingPathComponent("videoplayback-9f31.mp4").path
        ))
    }

    func testMultiConnectionDownloadAndMerge() async throws {
        // ~256 KiB patterned payload
        var payload = Data(count: 256 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8(i % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-integ-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 4, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)

        let fileURL = dest.appendingPathComponent(done.filename)
        let data = try Data(contentsOf: fileURL)
        XCTAssertEqual(data, payload)

        let workDir = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: workDir.path)) ?? []
        XCTAssertFalse(
            leftovers.contains(where: { $0.hasPrefix("seg.x") }),
            "Successful merge must discard physical segment files"
        )
    }

    func testResumeAfterPartialSegment() async throws {
        var payload = Data(count: 128 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 7) % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-resume-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 2)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

        // Pre-seed segments.bin + partial seg.x0 (first half incomplete)
        let segs = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 2)
        try SegmentFileFormat.serialize(segs).write(to: work.appendingPathComponent("segments.bin"))
        let half = segs[0].length / 2
        let partial = payload.subdata(in: Int(segs[0].start)..<Int(segs[0].start + half))
        try partial.write(to: SegmentFileFormat.segmentFileURL(id: 0, in: work))

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        let fileURL = dest.appendingPathComponent(done.filename)
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)
    }

    func testMalformedResumeMetadataIsDiscardedBeforeFreshDownload() async throws {
        var payload = Data(count: 768 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 11) % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-malformed-resume-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 4, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try Data([0x4E, 0x44, 0x4D]).write(to: work.appendingPathComponent("segments.bin"))
        try Data(repeating: 0xEE, count: 32 * 1024).write(
            to: work.appendingPathComponent("seg.x19")
        )

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: work.appendingPathComponent("seg.x19").path
        ))
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("segments.bin is malformed"))
        XCTAssertTrue(log.contains("malformed segments.bin"))
    }

    func testOversizedPartialSegmentIsDiscardedInsteadOfMerged() async throws {
        var payload = Data(count: 1024 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 29) % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-oversized-part-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 2)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)

        let plan = SegmentFileFormat.planEqualSegments(
            totalBytes: Int64(payload.count),
            connections: 2
        )
        try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
        try Data(repeating: 0xCC, count: Int(plan[0].length + 1)).write(
            to: SegmentFileFormat.segmentFileURL(id: plan[0].segmentId, in: work)
        )

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("partial segment is larger than its assigned Range"))
        XCTAssertTrue(log.contains("oversized partial segment"))
    }

    func testServerIgnoringRangeFallsBackToOneCleanFullRequest() async throws {
        var payload = Data(count: 2 * 1024 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 23) % 251) }

        // Some CDNs advertise Accept-Ranges on HEAD but return 200 + the full
        // object to every ranged GET. That must never be appended to seg.xN.
        let server = LocalRangeServer(payload: payload, ignoresRangeRequests: true)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-range-ignored-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 4,
            useCategoryFolders: false,
            smartConnections: true
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        // All four workers start immediately. Rejected ranged responses must
        // converge on exactly one full GET, without a second ranged round.
        XCTAssertLessThanOrEqual(server.recordedRanges.count, 4)
        XCTAssertGreaterThan(server.recordedRanges.count, 0)
        XCTAssertEqual(server.recordedMethods.filter { $0 == "GET" }.count - server.recordedRanges.count, 1)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("Server ignored a byte Range"))
        XCTAssertTrue(log.contains("without Range"))
    }

    func testRemoteSizeChangingAfterProbeNeverProducesMixedFile() async throws {
        let payload = Data(repeating: 0x7D, count: 1024 * 1024)
        // HEAD reports the real size, while each subsequent Content-Range claims
        // a different generation. The engine must stop before merge.
        let server = LocalRangeServer(payload: payload, contentRangeTotalOffset: 1)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-changing-resource-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 4, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)
        let settled = expectation(description: "terminal failure is reported")
        await manager.setTaskSettledHandler { terminal in
            if terminal.id == task.id, terminal.status == .error {
                settled.fulfill()
            }
        }

        do {
            try await manager.startAndWait(taskID: task.id)
            XCTFail("A changed remote generation must fail before merge")
        } catch {
            // Expected: the task persists a structured failure for retry/rescue.
        }

        let tasks = try await manager.listTasks()
        let failed = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(failed.status, .error)
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: dest.appendingPathComponent(failed.filename).path
        ))
    }

    func testApplyConnectionsReplansActiveRangeTransfers() async throws {
        var payload = Data(count: 2 * 1024 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 13) % 251) }

        // Delay bodies so Apply lands after the two-connection round issued its
        // actual Range requests, but before those transfers finish.
        let server = LocalRangeServer(payload: payload, responseDelay: 0.35)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-live-replan-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 2,
            useCategoryFolders: false,
            smartConnections: true
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 2)

        try await manager.start(taskID: task.id)
        try await waitUntil(timeout: 5) { server.recordedRanges.count >= 2 }
        let rangesBeforeApply = server.recordedRanges
        XCTAssertTrue(rangesBeforeApply.contains { $0.contains("bytes=0-1048575") })

        try await manager.applyConnections(taskID: task.id, count: 4)
        try await manager.startAndWait(taskID: task.id)

        let rangesAfterApply = server.recordedRanges
        XCTAssertGreaterThan(rangesAfterApply.count, rangesBeforeApply.count)
        XCTAssertGreaterThanOrEqual(Set(rangesAfterApply).count, 5)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(done.connections, 4)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)

        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let persisted = try XCTUnwrap(try SegmentFileFormat.loadSegmentsBin(from: work))
        XCTAssertGreaterThanOrEqual(persisted.count, 4)
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("cancelling active Range round for live replan"))
        XCTAssertTrue(log.contains("Replanned active transfers: MaxAllowedConnection = 4"))
    }

    func testTailRebalanceDoesNotReconnectForAShortFinalRange() async throws {
        var payload = Data(count: 8 * 1024 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8((i * 17) % 251) }

        // The initial four-way plan puts its last range above 6 MiB. It is only
        // 2 MiB, though: reconnecting and re-splitting after the other workers
        // finish would cost more than letting this already-open request land.
        let server = LocalRangeServer(
            payload: payload,
            rangeResponseDelay: { start in
                start >= 6 * 1024 * 1024 ? 0.45 : 0.01
            }
        )
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tail-rebalance-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 4,
            useCategoryFolders: false,
            smartConnections: true
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)

        try await manager.startAndWait(taskID: task.id)

        // The four initial ranges are sufficient; no speculative reconnect.
        XCTAssertEqual(server.recordedRanges.count, 4)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("finishing without new sockets because reconnect payback is too small"))

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }

    func testTailRebalanceStillSplitsALargeStalledRange() async throws {
        let total = 32 * 1024 * 1024
        var payload = Data(count: total)
        for i in 0..<payload.count { payload[i] = UInt8((i * 19) % 251) }

        let initialPlan = SegmentFileFormat.planDynamicConnections(
            totalBytes: Int64(total),
            connections: 4,
            completedPrefixBytes: 0
        )
        let stalledStart = Int(try XCTUnwrap(initialPlan.max(by: { $0.start < $1.start })?.start))
        let server = LocalRangeServer(
            payload: payload,
            rangeResponseDelay: { start in
                start == stalledStart ? 1.2 : 0.01
            }
        )
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tail-large-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 4,
            useCategoryFolders: false,
            smartConnections: false
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)

        try await manager.startAndWait(taskID: task.id)

        XCTAssertGreaterThan(server.recordedRanges.count, 4)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("active of 4; targeting 4"))
        XCTAssertTrue(log.contains("ActiveTarget = 4"))

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }

    func testAutomaticTailSplitRollsBackAfterOne416() async throws {
        try await assertAutomaticTail416Recovery(
            failureLimit: 1,
            minimumRollbackCount: 1
        )
    }

    func testAutomaticTailSplitStopsAfterFirstRejectedChildWithoutLooping() async throws {
        try await assertAutomaticTail416Recovery(
            failureLimit: .max,
            minimumRollbackCount: 1
        )
    }

    func testInitialRange416RemainsFatalAndIsNeverMisclassifiedAsTailRollback() async throws {
        let payload = Data(repeating: 0x41, count: 2 * 1024 * 1024)
        let server = LocalRangeServer(
            payload: payload,
            injectedRangeFailureStatus: 416,
            injectRangeFailureAfterCount: 0,
            injectedRangeFailureLimit: 1
        )
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-initial-416-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 4,
            useCategoryFolders: false,
            smartConnections: false
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)

        do {
            try await manager.startAndWait(taskID: task.id)
            XCTFail("An initial 416 must remain a real task failure")
        } catch {
            // Expected: no automatic-tail lineage exists for the bootstrap range.
        }

        let failedTasks = try await manager.listTasks()
        let failed = try XCTUnwrap(failedTasks.first { $0.id == task.id })
        XCTAssertEqual(failed.status, .error)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let log = try String(
            contentsOf: work.appendingPathComponent("LogFile.txt"),
            encoding: .utf8
        )
        XCTAssertFalse(log.contains("Segment Rolled Back To Socket"))
    }

    private func assertAutomaticTail416Recovery(
        failureLimit: Int,
        minimumRollbackCount: Int
    ) async throws {
        let total = 32 * 1024 * 1024
        var payload = Data(count: total)
        for index in 0..<payload.count {
            payload[index] = UInt8((index * 23) % 251)
        }

        let initialPlan = SegmentFileFormat.planDynamicConnections(
            totalBytes: Int64(total),
            connections: 4,
            completedPrefixBytes: 0
        )
        let stalled = try XCTUnwrap(initialPlan.max(by: { $0.start < $1.start }))
        let completed = Dictionary(uniqueKeysWithValues: initialPlan.map {
            ($0.segmentId, $0.segmentId == stalled.segmentId ? 0 : $0.length)
        })
        let expectedTailPlan = SegmentFileFormat.replanConnections(
            existing: initialPlan,
            totalBytes: Int64(total),
            newConnections: 4,
            completedByID: completed
        )
        let originalIDs = Set(initialPlan.map(\.segmentId))
        let firstTemporaryChildStart = Int(try XCTUnwrap(
            expectedTailPlan
                .filter { !originalIDs.contains($0.segmentId) }
                .map(\.start)
                .min()
        ))

        let server = LocalRangeServer(
            payload: payload,
            rangeResponseDelay: { start in
                start == Int(stalled.start) ? 1.2 : 0.01
            },
            injectedRangeFailureStatus: 416,
            injectRangeFailureAfterCount: 4,
            injectedRangeFailureLimit: failureLimit,
            injectedRangeFailureStartAtOrAbove: firstTemporaryChildStart
        )
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tail-416-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 4,
            useCategoryFolders: false,
            smartConnections: false
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)

        try await manager.startAndWait(taskID: task.id)

        let completedTasks = try await manager.listTasks()
        let done = try XCTUnwrap(completedTasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(
            try Data(contentsOf: dest.appendingPathComponent(done.filename)),
            payload
        )

        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        let log = try String(
            contentsOf: work.appendingPathComponent("LogFile.txt"),
            encoding: .utf8
        )
        let rollbackCount = log.components(
            separatedBy: "Segment Rolled Back To Socket"
        ).count - 1
        XCTAssertGreaterThanOrEqual(rollbackCount, minimumRollbackCount, log)
        XCTAssertTrue(log.contains("disabled further automatic tail stealing"), log)
    }

    private func waitUntil(
        timeout: TimeInterval,
        condition: @escaping @Sendable () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        throw NSError(domain: "DownloadEngineIntegrationTests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for live Range requests",
        ])
    }
}
