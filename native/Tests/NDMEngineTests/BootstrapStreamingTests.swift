import XCTest
import Foundation
import NDMCore
@testable import NDMEngine

final class BootstrapStreamingTests: XCTestCase {
    func testFullBootstrapReportsProgressAndHonoursBandwidthWithoutReplayingPOST() async throws {
        let payload = Data(repeating: 42, count: 512 * 1024)
        let server = LocalRangeServer(payload: payload, ignoresRangeRequests: true, headStatus: 405)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bootstrap-stream-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        var request = DownloadRequest(url: server.baseURL, method: "POST", body: Data("fixture=form".utf8),
            connections: 2, destinationDirectory: root.appendingPathComponent("output"), suggestedFilename: "result.bin")
        request.bandwidthLimitBytesPerSecond = 128 * 1024
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: root.appendingPathComponent("work"),
            capacityProvider: { _ in Int64(payload.count) })
        let started = ProcessInfo.processInfo.systemUptime
        let running = Task { try await engine.start() }
        defer { running.cancel() }
        var sawProgress = false
        while ProcessInfo.processInfo.systemUptime - started < 2.5 {
            let snapshot = await engine.currentProgress()
            if snapshot.completedBytes > 0 && snapshot.completedBytes < payload.count {
                sawProgress = true
                XCTAssertEqual(snapshot.totalBytes, Int64(payload.count))
                XCTAssertEqual(snapshot.activeRequests, 1)
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let file = try await running.value
        XCTAssertTrue(sawProgress, "Full response must be visible while still downloading")
        XCTAssertGreaterThanOrEqual(ProcessInfo.processInfo.systemUptime - started, 2.8)
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(server.recordedMethods, ["POST"])
        XCTAssertEqual(server.recordedBodies, ["fixture=form"])
    }

    func testPauseInterruptsBootstrapWaitingForBandwidthAndRetiresOwnedStaging() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 42, count: 512 * 1024), ignoresRangeRequests: true, headStatus: 405)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("bootstrap-pause-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let work = root.appendingPathComponent("work")
        var request = DownloadRequest(url: server.baseURL, method: "POST", body: Data("form".utf8),
            destinationDirectory: root.appendingPathComponent("output"), suggestedFilename: "result.bin")
        request.bandwidthLimitBytesPerSecond = 64 * 1024
        let engine = DownloadEngine(taskID: 1, request: request, workDirectory: work)
        let running = Task { try await engine.start() }
        defer { running.cancel() }
        for _ in 0..<100 {
            if await engine.currentProgress().completedBytes > 0 { break }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let beforePause = await engine.currentProgress()
        XCTAssertGreaterThan(beforePause.completedBytes, 0)
        let started = ProcessInfo.processInfo.systemUptime
        await engine.pause()
        do { _ = try await running.value; XCTFail("Paused bootstrap must not publish") }
        catch EngineError.paused { }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("output/result.bin").path))
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: work.path).contains { $0.hasPrefix(".ndm-merge-") })
        XCTAssertEqual(server.recordedMethods, ["POST"])
    }
}
