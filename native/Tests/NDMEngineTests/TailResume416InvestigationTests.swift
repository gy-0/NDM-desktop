import XCTest
@testable import NDMCore
@testable import NDMEngine

/// Regression for a nonstandard server that rejects speculative ranges. Both
/// storage modes must retain proven tail ancestry across pause and reopen.
final class TailResume416InvestigationTests: XCTestCase {
    func testUnknownLengthAndEmptyValidatedSingleStreamsDoNotCreateTailJournal() async throws {
        for payload in [Data(), Data(repeating: 42, count: 32768)] {
            let server = LocalRangeServer(payload: payload, omitHeadContentLength: !payload.isEmpty)
            try server.start(); defer { server.stop() }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let request = DownloadRequest(url: server.baseURL, connections: 2, destinationDirectory: output, suggestedFilename: "result.bin")
            let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
            XCTAssertEqual(try Data(contentsOf: final), payload)
            XCTAssertTrue(server.recordedRanges.isEmpty)
            XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent(TailSplitProvenance.filename).path))
        }
    }

    func testContinuousAndReopenedTail416ForBothStorageFormats() async throws {
        for legacy in [false, true] {
            for reopen in [false, true] { try await investigate(legacy: legacy, reopen: reopen) }
        }
    }

    func testReopenedTail416DiscardsWrittenChildPrefixForBothStorageFormats() async throws {
        for legacy in [false, true] { try await investigate(legacy: legacy, reopen: true, seedChildPrefix: true) }
    }

    func testLegacyRollbackCommitFailureCannotLeaveReusableChildBytes() async throws {
        try await investigate(legacy: true, reopen: true, seedChildPrefix: true, failRollbackCommit: true)
    }

    func testThirtyTwoConnectionsReopenTail416ForBothStorageFormats() async throws {
        for legacy in [false, true] { try await investigate(legacy: legacy, reopen: true, connections: 32) }
    }

    private func investigate(legacy: Bool, reopen: Bool, seedChildPrefix: Bool = false, failRollbackCommit: Bool = false, connections: Int = 2) async throws {
        let payload = Data((0..<((connections == 32 ? 64 : 32) * 1024 * 1024)).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 16)) })
        let plan = SegmentFileFormat.planDynamicConnections(totalBytes: Int64(payload.count), connections: connections, completedPrefixBytes: 0)
        XCTAssertEqual(plan.count, connections, "Fixture must establish the requested initial segment count")
        let donor = try XCTUnwrap(plan.max { $0.start < $1.start })
        let childThreshold = Int(donor.start + donor.length / 2)
        // The pre-pause delayed rejection is consumed when its response is built,
        // then cancelled. Allow a second rejection so reopen sees one too.
        let server = LocalRangeServer(payload: payload,
            rangeResponseDelay: { start in start >= Int(donor.start) ? 1.2 : 0.01 },
            // Geometry excludes initial ranges even if bootstrap admission lets
            // the speculative child request arrive before a queued original.
            injectedRangeFailureStatus: 416, injectRangeFailureAfterCount: 0,
            injectedRangeFailureLimit: reopen ? 2 : 1, injectedRangeFailureStartAtOrAbove: childThreshold)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-tail-resume-416-\(UUID().uuidString)")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        if legacy { try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin")) }
        let request = DownloadRequest(url: server.baseURL, connections: connections, destinationDirectory: output, suggestedFilename: "result.bin")
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let running = Task { try await engine.start() }
        if reopen {
            let deadline = Date().addingTimeInterval(5)
            while server.recordedRanges.count <= plan.count && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
            XCTAssertGreaterThan(server.recordedRanges.count, plan.count, "A speculative child must actually be requested before pause")
            await engine.pause()
            do { _ = try await running.value; XCTFail("Expected pause before delayed child rejection") }
            catch EngineError.paused {} catch { XCTFail("Unexpected pause error: \(error)") }
            let persistedCount: Int
            if legacy {
                persistedCount = try SegmentFileFormat.parse(Data(contentsOf: work.appendingPathComponent("segments.bin"))).count
            } else {
                let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("offset-storage-v2.json"))) as? [String: Any])
                persistedCount = try XCTUnwrap(json["ranges"] as? [Any]).count
            }
            XCTAssertGreaterThan(persistedCount, plan.count, "Split must survive on disk, not only in a callback")
            if seedChildPrefix {
                let count = 65536
                if legacy {
                    let records = try SegmentFileFormat.parse(Data(contentsOf: work.appendingPathComponent("segments.bin")))
                    let child = try XCTUnwrap(records.first { $0.start >= Int64(childThreshold) })
                    let bytes = payload.subdata(in: Int(child.start)..<(Int(child.start) + count))
                    try bytes.write(to: SegmentFileFormat.segmentFileURL(id: child.segmentId, in: work))
                } else {
                    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: work.appendingPathComponent("offset-storage-v2.json"))) as? [String: Any])
                    let context = try XCTUnwrap(json["resourceContextHash"] as? String)
                    let storage = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: work, resourceContextHash: context)
                    let child = try XCTUnwrap(storage.snapshot().first { $0.start >= Int64(childThreshold) })
                    XCTAssertEqual(child.durablePrefix, 0)
                    XCTAssertEqual(try storage.write(segmentID: child.id, data: payload.subdata(in: Int(child.start)..<(Int(child.start) + count))), count)
                    try storage.checkpoint()
                    XCTAssertEqual(storage.snapshot().first { $0.id == child.id }?.durablePrefix, Int64(count))
                }
            }
            let before = server.recordedRanges.count
            let resumed = Task { try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start() }
            if failRollbackCommit {
                let planURL = work.appendingPathComponent("segments.bin")
                let savedPlan = try Data(contentsOf: planURL)
                let child = try XCTUnwrap(SegmentFileFormat.parse(savedPlan).first { $0.start >= Int64(childThreshold) })
                let deadline = Date().addingTimeInterval(5)
                while server.recordedRanges.count <= before && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
                XCTAssertGreaterThan(server.recordedRanges.count, before)
                // The resumed plan is loaded and the delayed 416 is in flight.
                // Block its next atomic plan commit after child cleanup.
                try FileManager.default.removeItem(at: planURL)
                try FileManager.default.createDirectory(at: planURL, withIntermediateDirectories: false)
                do { _ = try await resumed.value; XCTFail("Expected blocked plan commit") } catch {}
                XCTAssertFalse(FileManager.default.fileExists(atPath: SegmentFileFormat.segmentFileURL(id: child.segmentId, in: work).path))
                try FileManager.default.removeItem(at: planURL)
                try savedPlan.write(to: planURL)
                let recovered = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
                XCTAssertEqual(try Data(contentsOf: recovered), payload)
                return
            }
            let final = try await resumed.value
            XCTAssertGreaterThan(server.recordedRanges.count, before)
            XCTAssertEqual(try Data(contentsOf: final), payload)
            let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
            XCTAssertTrue(log.contains("Segment Rolled Back To Socket"))
            if seedChildPrefix { XCTAssertTrue(log.contains("discarded 65536 speculative bytes"), log) }
        } else {
            let final = try await running.value
            XCTAssertEqual(try Data(contentsOf: final), payload)
            let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
            XCTAssertTrue(log.contains("Segment Rolled Back To Socket"))
        }
        print("TAIL416_EVIDENCE storage=\(legacy ? "legacy" : "v2") reopened=\(reopen) initial=\(plan.count) ranges=\(server.recordedRanges.count) outcome=rollback-complete")
    }
}
