import XCTest
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

final class AdmissionRecoveryRegressionTests: XCTestCase {
    private func rangeStart(_ header: String) -> Int? {
        let value = header.split(separator: ":", maxSplits: 1).last?
            .trimmingCharacters(in: .whitespaces) ?? ""
        guard value.hasPrefix("bytes=") else { return nil }
        return Int(value.dropFirst(6).split(separator: "-", maxSplits: 1).first ?? "")
    }

    private func payload() -> Data {
        let block = Data((0..<65536).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 8)) })
        return (0..<128).reduce(into: Data()) { data, _ in data.append(block) }
    }

    func testFiveTemporary503ResponsesPreserveHealthyRequestAndCompleteSHA() async throws {
        for legacy in [false, true] {
            let data = payload(), count = 8
            let server = LocalRangeServer(payload: data, bodyChunkSize: 16384,
                bodyChunkDelay: { start in start == 0 ? 0.03 : 0 },
                injectedRangeFailureStatus: 503, injectRangeFailureAfterCount: 0,
                injectedRangeFailureLimit: 5, injectedRangeFailureStartAtOrAbove: data.count * 7 / 8,
                retryAfter: "0")
            try server.start(); defer { server.stop() }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            if legacy {
                let plan = SegmentFileFormat.planDynamicConnections(totalBytes: Int64(data.count), connections: count, completedPrefixBytes: 0)
                try SegmentFileFormat.serialize(plan).write(to: work.appendingPathComponent("segments.bin"))
            }
            let request = DownloadRequest(url: server.baseURL, connections: count, destinationDirectory: output, suggestedFilename: "fixture.bin")
            let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
            let final = try await engine.start()
            XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: data))
            // Live tail splitting may shorten a retry's end. The fixture rejects
            // the first five requests in this byte region regardless of end.
            let rejectedRegionRequests = server.recordedRanges.filter {
                rangeStart($0).map { $0 >= data.count * 7 / 8 } ?? false
            }
            XCTAssertGreaterThanOrEqual(rejectedRegionRequests.count, 6,
                "Five refused attempts must be followed by successful work in the same region")
            XCTAssertEqual(server.recordedRanges.filter { $0 == "Range: bytes=0-\(data.count / 8 - 1)" }.count, 1,
                           "Healthy original request must not be cancelled and retried")
            let progress = await engine.currentProgress()
            XCTAssertEqual(progress.requestLimit, count, "503 alone is not evidence of a server connection ceiling")
        }
    }

    func testPersistent503CanBePausedAfterMoreThanFourResponses() async throws {
        let data = payload()
        let server = LocalRangeServer(payload: data, bodyChunkSize: 16384,
            bodyChunkDelay: { start in start == 0 ? 0.05 : 0 },
            injectedRangeFailureStatus: 503,
            injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: .max,
            injectedRangeFailureStartAtOrAbove: data.count / 2, retryAfter: "0")
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 2,
            destinationDirectory: output, suggestedFilename: "fixture.bin"), workDirectory: work)
        let running = Task { try await engine.start() }
        let deadline = Date().addingTimeInterval(4)
        while server.recordedRanges.count < 6 && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertGreaterThanOrEqual(server.recordedRanges.count, 6, "Temporary service refusal must not hit a four-attempt terminal limit")
        let before = Date()
        await engine.pause()
        do { _ = try await running.value; XCTFail("Expected user pause") }
        catch EngineError.paused {} catch EngineError.cancelled {} catch is CancellationError {}
        catch { XCTFail("Unexpected terminal error: \(error)") }
        XCTAssertLessThan(Date().timeIntervalSince(before), 0.6)
        // Progress emission is coalesced; after writer drain, the checkpoint is
        // authoritative evidence that this exercised post-body recovery.
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
            work.appendingPathComponent("offset-storage-v2.json"))) as? [String: Any])
        let ranges = try XCTUnwrap(manifest["ranges"] as? [[String: Any]])
        let durableBytes = ranges.reduce(Int64(0)) { total, range in
            total + ((range["durablePrefix"] as? NSNumber)?.int64Value ?? 0)
        }
        XCTAssertGreaterThan(durableBytes, 0, "Must have real checkpointed body bytes before pause")
        let requestCount = server.recordedRanges.count
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(server.recordedRanges.count, requestCount)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.appendingPathComponent("fixture.bin").path))
    }
    func testTemporary429CeilingRecoversWhileHealthyRequestRemainsActive() async throws {
        let data = payload()
        let server = LocalRangeServer(payload: data, bodyChunkSize: 65536,
            bodyChunkDelay: { start in start == 0 ? 0.12 : 0 },
            injectedRangeFailureStatus: 429, injectRangeFailureAfterCount: 0,
            injectedRangeFailureLimit: 1, injectedRangeFailureStartAtOrAbove: data.count / 2,
            retryAfter: "0")
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: DownloadRequest(url: server.baseURL, connections: 2,
            destinationDirectory: output, suggestedFilename: "fixture.bin"), workDirectory: work)
        let running = Task { try await engine.start() }
        var sawReduced = false, sawRecoveredBeforeCompletion = false
        let deadline = Date().addingTimeInterval(10)
        while Date() < deadline {
            let progress = await engine.currentProgress()
            if progress.requestLimit == 1 { sawReduced = true }
            if sawReduced && progress.requestLimit == 2 && progress.completedBytes < Int64(data.count) {
                sawRecoveredBeforeCompletion = true
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(sawReduced, "429 must temporarily lower admission")
        XCTAssertTrue(sawRecoveredBeforeCompletion, "After a quiet interval, queued work should try capacity again")
        let final = try await running.value
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: data))
        XCTAssertEqual(server.recordedRanges.filter { $0 == "Range: bytes=0-\(data.count / 2 - 1)" }.count, 1)
    }

}
