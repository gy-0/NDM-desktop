import XCTest
@testable import NDMEngine
@testable import NDMCore

final class DownloadEngineIntegrationTests: XCTestCase {
    func testErrorBodyAfterRangeFallbackNeverBecomesCompletedFile() async throws {
        let body = Data("请求失败, 请重试".utf8)
        let server = LocalRangeServer(payload: body, headContentLength: 65_536, ignoresRangeRequests: true)
        try server.start()
        defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-error-body-\(UUID())")
        let support = root.appendingPathComponent("support")
        let dest = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 1)
        do {
            try await manager.startAndWait(taskID: task.id)
            XCTFail("Expected the short server error body to fail")
        } catch { /* Manager reports the failed transfer; inspect persisted diagnostics below. */ }
        let tasks = try await manager.listTasks()
        let failed = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(failed.status, .error)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appendingPathComponent(failed.filename).path))
        XCTAssertTrue(failed.errorText?.contains("65536") == true)
        XCTAssertTrue(failed.errorText?.contains("23") == true)
        let work = support.appendingPathComponent("\(task.id)")
        let artifacts = try FileManager.default.contentsOfDirectory(atPath: work.path)
        XCTAssertFalse(artifacts.contains { $0.hasPrefix("seg.x") })
        let payload = Data(repeating: 0x7F, count: 65_536)
        let healthy = LocalRangeServer(payload: payload)
        try healthy.start()
        defer { healthy.stop() }
        var retry = failed
        retry.url = healthy.baseURL.absoluteString
        try store.update(retry)
        try await manager.startAndWait(taskID: task.id)
        let resumed = try await manager.listTasks()
        XCTAssertEqual(resumed.first { $0.id == task.id }?.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(failed.filename)), payload)

    }

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
        // Explicit legacy fixture: this test injects/inspects segments.bin.
        let legacyWork = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: legacyWork, withIntermediateDirectories: true)
        try SegmentFileFormat.serialize(SegmentFileFormat.planDynamicConnections(totalBytes: Int64(payload.count), connections: 2, completedPrefixBytes: 0))
            .write(to: legacyWork.appendingPathComponent("segments.bin"))

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
        XCTAssertTrue(log.contains("TailHandoff: split segment"))
        XCTAssertFalse(log.contains("Replanned active transfers"))

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }

    func testThirtyTwoWorkersHandOffAfterFirstCompletionWithoutPause() async throws {
        let total = 16 * 1024 * 1024
        var payload = Data(count: total)
        for index in 0..<total { payload[index] = UInt8(index % 251) }
        let server = LocalRangeServer(payload: payload, rangeResponseDelay: { start in
            start == 0 ? 0.01 : 0.3
        })
        try server.start()
        defer { server.stop() }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-32-handoff-\(UUID())")
        let support = tmp.appendingPathComponent("support")
        let dest = tmp.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(
            downloadDirectory: dest, maxConnections: 32, useCategoryFolders: false,
            smartConnections: false
        ), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 32)
        try await manager.startAndWait(taskID: task.id)
        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        let log = try String(contentsOf: support.appendingPathComponent("\(task.id)/LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("ActiveSockets = 32"))
        XCTAssertTrue(log.contains("TailHandoff: split segment"))
        XCTAssertTrue(log.contains("child 32,"), "First automatic child extends the original 32-segment plan")
        XCTAssertFalse(log.contains("Replanned active transfers"))
        XCTAssertGreaterThan(server.recordedRanges.count, 32)
    }

    func testTailHandoffKeepsUnrelatedRangeRequestAlive() async throws {
        let mib = 1024 * 1024
        var payload = Data(count: 15 * mib)
        for index in 0..<payload.count { payload[index] = UInt8(index % 251) }
        let server = LocalRangeServer(payload: payload, bodyChunkSize: 65537,
            bodyChunkDelay: { $0 >= 3 * mib ? 0.008 : 0 }, rangeResponseDelay: { start in
                if start == 0 { return 0.15 }
                if start == mib { return 0.3 }
                return 0
            })
        try server.start()
        defer { server.stop() }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-handoff-\(UUID())")
        let support = tmp.appendingPathComponent("support")
        let dest = tmp.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store, settings: AppSettings(
            downloadDirectory: dest, maxConnections: 3, useCategoryFolders: false,
            smartConnections: false
        ), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 3)
        let work = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let ranges = [
            SegmentRecord(order: 0, segmentId: 0, nextId: 1, start: 0, end: Int64(mib - 1)),
            SegmentRecord(order: 1, segmentId: 1, nextId: 2, start: Int64(mib), end: Int64(3 * mib - 1)),
            SegmentRecord(order: 2, segmentId: 2, nextId: -1, start: Int64(3 * mib), end: Int64(payload.count - 1))
        ]
        try SegmentFileFormat.serialize(ranges).write(to: work.appendingPathComponent("segments.bin"))
        try await manager.startAndWait(taskID: task.id)
        // The first worker finishes while the middle request is still receiving.
        // A whole-round replan would request its start again; donor-only handoff must not.
        XCTAssertEqual(server.recordedRanges.filter { $0.contains("bytes=\(mib)-") }.count, 1)
        XCTAssertEqual(server.recordedRanges.filter { $0.contains("bytes=\(3 * mib)-") }.count, 1,
                       "Splitting a donor must preserve its original HTTP request")
        let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("1 other workers preserved"), log)
        let all = try await manager.listTasks()
        let done = try XCTUnwrap(all.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }

    func testThrottledWorkerRetriesWithoutRestartingHealthyRanges() async throws {
        for status in [429, 503] {
            var payload = Data(count: 4 * 1024 * 1024)
            for index in 0..<payload.count { payload[index] = UInt8(index % 251) }
            let server = LocalRangeServer(
                payload: payload, responseDelay: 0.1,
                injectedRangeFailureStatus: status, injectRangeFailureAfterCount: 0,
                injectedRangeFailureLimit: 1,
                injectedRangeFailureStartAtOrAbove: 3 * 1024 * 1024,
                retryAfter: "1"
            )
            try server.start()
            defer { server.stop() }
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-retry-\(UUID())")
            let support = tmp.appendingPathComponent("support")
            let dest = tmp.appendingPathComponent("Downloads")
            try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
            let store = try DownloadStore(directory: support)
            let manager = DownloadManager(store: store, settings: AppSettings(
                downloadDirectory: dest, maxConnections: 4, useCategoryFolders: false,
                smartConnections: false
            ), supportRoot: support)
            let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)
            let began = Date()
            try await manager.startAndWait(taskID: task.id)
            XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(began), 1)
            XCTAssertEqual(server.recordedRanges.filter { $0.contains("bytes=0-") }.count, 1)
            let tasks = try await manager.listTasks()
            let done = try XCTUnwrap(tasks.first { $0.id == task.id })
            XCTAssertEqual(done.status, .complete)
            XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
            let log = try String(contentsOf: support.appendingPathComponent("\(task.id)/LogFile.txt"), encoding: .utf8)
            XCTAssertTrue(log.contains("HTTP \(status), attempt 1, waiting 1.0s"), log)
        }
    }

    func testPauseInterruptsServerRetryAfterWithoutWaitingForDeadline() async throws {
        let server = LocalRangeServer(
            payload: Data(repeating: 0x41, count: 1024 * 1024),
            injectedRangeFailureStatus: 429, injectRangeFailureAfterCount: 0,
            injectedRangeFailureLimit: .max, retryAfter: "60"
        )
        try server.start()
        defer { server.stop() }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-retry-pause-\(UUID())")
        let support = tmp.appendingPathComponent("support")
        let dest = tmp.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let manager = DownloadManager(store: try DownloadStore(directory: support), settings: AppSettings(
            downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false,
            smartConnections: false
        ), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 1)
        try await manager.start(taskID: task.id)
        let logURL = support.appendingPathComponent("\(task.id)/LogFile.txt")
        try await waitUntil(timeout: 5) {
            (try? String(contentsOf: logURL, encoding: .utf8).contains("waiting 60.0s")) == true
        }
        let began = Date()
        await manager.pause(taskID: task.id)
        XCTAssertLessThan(Date().timeIntervalSince(began), 2)
        let tasks = try await manager.listTasks()
        XCTAssertEqual(tasks.first { $0.id == task.id }?.status, .paused)
        XCTAssertEqual(server.recordedRanges.count, 1)
    }

    func testTailPlanWriteFailureStopsOutstandingWritersPromptly() async throws {
        let server = LocalRangeServer(
            payload: Data(repeating: 0x41, count: 16 * 1024 * 1024),
            bodyChunkSize: 65537, bodyChunkDelay: { $0 == 0 ? 0 : 0.02 },
            rangeResponseDelay: { $0 == 0 ? 0.5 : 0 }
        )
        try server.start()
        defer { server.stop() }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-plan-write-\(UUID())")
        let support = tmp.appendingPathComponent("support")
        let dest = tmp.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let manager = DownloadManager(store: try DownloadStore(directory: support), settings: AppSettings(
            downloadDirectory: dest, maxConnections: 4, useCategoryFolders: false,
            smartConnections: false
        ), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 4)
        // Explicit legacy fixture: this test injects/inspects segments.bin.
        let legacyWork = support.appendingPathComponent("\(task.id)")
        try FileManager.default.createDirectory(at: legacyWork, withIntermediateDirectories: true)
        try SegmentFileFormat.serialize(SegmentFileFormat.planDynamicConnections(totalBytes: 16 * 1024 * 1024, connections: 4, completedPrefixBytes: 0))
            .write(to: legacyWork.appendingPathComponent("segments.bin"))
        let run = Task { try await manager.startAndWait(taskID: task.id) }
        try await waitUntil(timeout: 3) { server.recordedRanges.count == 4 }
        let livePart = SegmentFileFormat.segmentFileURL(id: 1, in: support.appendingPathComponent("\(task.id)"))
        try await waitUntil(timeout: 2) { (try? Data(contentsOf: livePart).count) ?? 0 > 0 }
        // Make the next atomic metadata write fail while donor callbacks write a real prefix.
        let metadata = support.appendingPathComponent("\(task.id)/segments.bin")
        try FileManager.default.removeItem(at: metadata)
        try FileManager.default.createDirectory(at: metadata, withIntermediateDirectories: false)
        let began = Date()
        do {
            try await run.value
            XCTFail("An unwritable plan must fail the task")
        } catch {}
        XCTAssertLessThan(Date().timeIntervalSince(began), 3)
        let tasks = try await manager.listTasks()
        XCTAssertEqual(tasks.first { $0.id == task.id }?.status, .error)
    }

    func testThirtyTwoConfiguredRequestsConvergeWhenServerAcceptsFour() async throws {
        let payload = Data((0..<(8 * 1024 * 1024)).map { UInt8($0 % 251) })
        let server = LocalRangeServer(
            payload: payload, responseDelay: 0.2, retryAfter: "1",
            maximumActiveRangeRequests: 4
        )
        try server.start()
        defer { server.stop() }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-server-cap-\(UUID())")
        let support = tmp.appendingPathComponent("support")
        let dest = tmp.appendingPathComponent("Downloads")
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let manager = DownloadManager(store: try DownloadStore(directory: support), settings: AppSettings(
            downloadDirectory: dest, maxConnections: 32, useCategoryFolders: false,
            smartConnections: false
        ), supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 32)
        try await manager.startAndWait(taskID: task.id)
        XCTAssertEqual(server.peakAcceptedRangeRequests, 4)
        XCTAssertGreaterThan(server.rejectedRangeRequests, 0)
        // One initial wave may be rejected; subsequent work must queue instead
        // of every rejected range exhausting its retries in parallel.
        XCTAssertLessThanOrEqual(server.rejectedRangeRequests, 32)
        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first { $0.id == task.id })
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(done.connections, 32, "Server feedback must not overwrite the user's configured cap")
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
        let log = try String(contentsOf: support.appendingPathComponent("\(task.id)/LogFile.txt"), encoding: .utf8)
        XCTAssertTrue(log.contains("ActiveSockets = 32"), log)
        XCTAssertTrue(log.contains("ServerAdmission"), log)
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
            maxConnections: 1,
            useCategoryFolders: false,
            smartConnections: false
        )
        // No competing completion may cancel the one-shot bootstrap error.
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: 1)

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
        // One fast range and one stalled range make the first tail split
        // unambiguous. With four workers, another fast completion can cancel
        // the injected 416 before the client receives it and consume the only
        // failure without ever exercising rollback.
        let connections = 2
        let total = 32 * 1024 * 1024
        var payload = Data(count: total)
        for index in 0..<payload.count {
            payload[index] = UInt8((index * 23) % 251)
        }

        let initialPlan = SegmentFileFormat.planDynamicConnections(
            totalBytes: Int64(total),
            connections: connections,
            completedPrefixBytes: 0
        )
        let stalled = try XCTUnwrap(initialPlan.max(by: { $0.start < $1.start }))
        let completed = Dictionary(uniqueKeysWithValues: initialPlan.map {
            ($0.segmentId, $0.segmentId == stalled.segmentId ? 0 : $0.length)
        })
        let expectedTailPlan = SegmentFileFormat.replanConnections(
            existing: initialPlan,
            totalBytes: Int64(total),
            newConnections: connections,
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
            injectRangeFailureAfterCount: connections,
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
            maxConnections: connections,
            useCategoryFolders: false,
            smartConnections: false
        )
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let task = try await manager.addURL(server.baseURL.absoluteString, connections: connections)

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
