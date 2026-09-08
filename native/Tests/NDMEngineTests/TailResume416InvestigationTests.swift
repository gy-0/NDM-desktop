import XCTest
@testable import NDMCore
@testable import NDMEngine

/// Characterizes a compatibility gap, not the desired recovery policy. The
/// fixture deliberately rejects otherwise valid speculative ranges (nonstandard HTTP).
final class TailResume416InvestigationTests: XCTestCase {
    func testContinuousAndReopenedTail416ForBothStorageFormats() async throws {
        for legacy in [false, true] {
            for reopen in [false, true] { try await investigate(legacy: legacy, reopen: reopen) }
        }
    }

    private func investigate(legacy: Bool, reopen: Bool) async throws {
        let payload = Data(repeating: 71, count: 32 * 1024 * 1024)
        let plan = SegmentFileFormat.planDynamicConnections(totalBytes: Int64(payload.count), connections: 2, completedPrefixBytes: 0)
        let donor = try XCTUnwrap(plan.max { $0.start < $1.start })
        let childThreshold = Int(donor.start + donor.length / 2)
        // The pre-pause delayed rejection is consumed when its response is built,
        // then cancelled. Allow a second rejection so reopen sees one too.
        let server = LocalRangeServer(payload: payload,
            rangeResponseDelay: { start in start >= Int(donor.start) ? 1.2 : 0.01 },
            injectedRangeFailureStatus: 416, injectRangeFailureAfterCount: 2,
            injectedRangeFailureLimit: reopen ? 2 : 1, injectedRangeFailureStartAtOrAbove: childThreshold)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-tail-resume-416-\(UUID().uuidString)")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        if legacy { try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin")) }
        let request = DownloadRequest(url: server.baseURL, connections: 2, destinationDirectory: output, suggestedFilename: "result.bin")
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let running = Task { try await engine.start() }
        if reopen {
            let deadline = Date().addingTimeInterval(5)
            while server.recordedRanges.count < 3 && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
            XCTAssertGreaterThanOrEqual(server.recordedRanges.count, 3, "A speculative child must actually be requested before pause")
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
            XCTAssertGreaterThan(persistedCount, 2, "Split must survive on disk, not only in a callback")
            let before = server.recordedRanges.count
            do {
                _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
                XCTFail("Current implementation loses tail provenance on reopen; update characterization when repaired")
            } catch EngineError.httpStatus(416) {} catch { XCTFail("Unexpected resumed error: \(error)") }
            XCTAssertGreaterThan(server.recordedRanges.count, before)
            XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("result.bin").path))
        } else {
            let final = try await running.value
            XCTAssertEqual(try Data(contentsOf: final), payload)
            let log = try String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8)
            XCTAssertTrue(log.contains("Segment Rolled Back To Socket"))
        }
        print("TAIL416_EVIDENCE storage=\(legacy ? "legacy" : "v2") reopened=\(reopen) ranges=\(server.recordedRanges.count) outcome=\(reopen ? "safe-416-failure" : "rollback-complete")")
    }
}
