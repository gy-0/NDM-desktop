import XCTest
@testable import NDMEngine
@testable import NDMCore

final class SmartConnectionTunerTests: XCTestCase {
    private func step(_ connections: Int, _ mbps: Double) -> ConnectionTuning.Step {
        ConnectionTuning.Step(connections: connections, bytesPerSecond: mbps * 1_000_000)
    }

    // MARK: - Decision logic

    func testConnectionSetupEstimateUsesConservativeRecentPercentile() {
        XCTAssertEqual(
            SmartConnectionTuner.connectionSetupSeconds(samples: []),
            0.75,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            SmartConnectionTuner.connectionSetupSeconds(
                samples: [0.20, 0.30, 0.40, 3.0]
            ),
            0.40,
            accuracy: 0.0001
        )
        XCTAssertEqual(
            SmartConnectionTuner.connectionSetupSeconds(
                samples: [.nan, -1, 0.001, 42]
            ),
            10,
            accuracy: 0.0001
        )
    }

    func testDoublesWhileGaining() {
        XCTAssertEqual(SmartConnectionTuner.nextConnections(cap: 16, steps: [step(2, 8)]), 4)
        XCTAssertEqual(
            SmartConnectionTuner.nextConnections(cap: 16, steps: [step(2, 8), step(4, 15)]),
            8
        )
    }

    func testStopsAtCap() {
        XCTAssertNil(SmartConnectionTuner.nextConnections(cap: 4, steps: [step(2, 8), step(4, 15)]))
        // Never exceeds the cap even mid-doubling.
        XCTAssertEqual(SmartConnectionTuner.nextConnections(cap: 6, steps: [step(2, 8), step(4, 15)]), 6)
    }

    func testStopsWhenGainTooSmall() {
        // ×1.1 < minGain (×1.25) → stop probing.
        XCTAssertNil(SmartConnectionTuner.nextConnections(cap: 32, steps: [step(2, 10), step(4, 11)]))
    }

    func testRevertTargetOnFlatDoubling() {
        XCTAssertEqual(SmartConnectionTuner.revertTarget(steps: [step(2, 10), step(4, 10.5)]), 2)
        XCTAssertNil(SmartConnectionTuner.revertTarget(steps: [step(2, 10), step(4, 19)]))
        XCTAssertNil(SmartConnectionTuner.revertTarget(steps: [step(2, 10)]))
    }

    func testOutcomes() {
        // All gains under threshold → the server pools connections.
        XCTAssertEqual(
            SmartConnectionTuner.outcome(cap: 32, steps: [step(2, 10), step(4, 10.2)]),
            .noBenefit
        )
        // Gains then a flat step → settled at the ceiling.
        XCTAssertEqual(
            SmartConnectionTuner.outcome(cap: 32, steps: [step(2, 8), step(4, 15), step(8, 15.5)]),
            .settled
        )
        // Still gaining at the configured max → invite raising the cap.
        XCTAssertEqual(
            SmartConnectionTuner.outcome(cap: 8, steps: [step(2, 8), step(4, 15), step(8, 27)]),
            .cappedByLimit
        )
    }

    // MARK: - Human rendering

    func testSummaryLineChinese() {
        L10n.apply(.simplifiedChinese)
        defer { L10n.apply(.system) }
        let tuning = ConnectionTuning(
            steps: [step(2, 8), step(4, 15.2), step(8, 27.4), step(16, 28.0)],
            currentConnections: 8,
            outcome: .settled
        )
        let line = tuning.summaryLine
        XCTAssertTrue(line.hasPrefix("智能连接数："), line)
        XCTAssertTrue(line.contains("2 → 4 ×1.9"), line)
        XCTAssertTrue(line.contains("8 → 16 无收益"), line)
        XCTAssertTrue(line.contains("已停在 8"), line)
        XCTAssertTrue(line.contains("不是你的网络"), line)
    }

    func testSummaryLineEnglishOutcomes() {
        L10n.apply(.english)
        defer { L10n.apply(.system) }
        let noBenefit = ConnectionTuning(steps: [step(2, 10), step(4, 10.1)], currentConnections: 2, outcome: .noBenefit)
        XCTAssertTrue(noBenefit.summaryLine.contains("didn't help"), noBenefit.summaryLine)

        let capped = ConnectionTuning(steps: [step(2, 8), step(4, 16)], currentConnections: 4, outcome: .cappedByLimit)
        XCTAssertTrue(capped.summaryLine.contains("raise the cap"), capped.summaryLine)

        let unsupported = ConnectionTuning(steps: [], currentConnections: 1, outcome: .rangeUnsupported)
        XCTAssertTrue(unsupported.summaryLine.contains("single connection"), unsupported.summaryLine)

        let override = ConnectionTuning(steps: [], currentConnections: 12, outcome: .userOverride)
        XCTAssertTrue(override.summaryLine.contains("manually"), override.summaryLine)
    }

    func testInspectorNoteNeedsRealGain() {
        L10n.apply(.english)
        defer { L10n.apply(.system) }
        let gained = ConnectionTuning(
            steps: [step(2, 8), step(8, 27.4)],
            currentConnections: 8,
            outcome: .settled
        )
        let note = gained.inspectorNote
        XCTAssertNotNil(note)
        XCTAssertTrue(note?.contains("×3.4") == true, note ?? "nil")

        let flat = ConnectionTuning(steps: [step(2, 10), step(4, 10.1)], currentConnections: 2, outcome: .noBenefit)
        XCTAssertNil(flat.inspectorNote)
    }

    // MARK: - Engine integration (throttled local server, injected timings)

    func testEngineAutoTuneRecordsStepsAndCompletes() async throws {
        var payload = Data(count: 6 * 1024 * 1024)
        for i in stride(from: 0, to: payload.count, by: 4096) { payload[i] = UInt8(i % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tune-\(UUID().uuidString)", isDirectory: true)
        let work = tmp.appendingPathComponent("work", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        var request = DownloadRequest(url: server.baseURL, destinationDirectory: dest)
        request.connections = 8

        let engine = DownloadEngine(
            taskID: 42,
            request: request,
            workDirectory: work,
            globalBandwidthLimit: 3_000_000, // ~3 MB/s so the probe has time to sample
            autoTuneConnections: true,
            tuneConfig: AutoTuneConfig(
                startConnections: 2,
                settleNanos: 150_000_000,
                windowNanos: 700_000_000, // longer than the limiter's 1s refill granularity w/ retries
                minTotalBytes: 1 << 20,
                minRemainingBytes: 256 << 10
            )
        )

        let fileURL = try await engine.start()
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)

        let progress = await engine.currentProgress()
        let tuning = try XCTUnwrap(progress.tuning, "auto-tune should record a trace")
        XCTAssertFalse(tuning.steps.isEmpty)
        XCTAssertNotEqual(tuning.outcome, .tuning, "probing should reach a conclusion")
        XCTAssertFalse(tuning.summaryLine.isEmpty)
    }

    func testManualApplyOverridesTuning() async throws {
        var payload = Data(count: 4 * 1024 * 1024)
        for i in stride(from: 0, to: payload.count, by: 4096) { payload[i] = UInt8((i * 3) % 251) }

        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tune-ovr-\(UUID().uuidString)", isDirectory: true)
        let work = tmp.appendingPathComponent("work", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        var request = DownloadRequest(url: server.baseURL, destinationDirectory: dest)
        request.connections = 8

        let engine = DownloadEngine(
            taskID: 43,
            request: request,
            workDirectory: work,
            globalBandwidthLimit: 3_000_000,
            autoTuneConnections: true,
            tuneConfig: AutoTuneConfig(
                startConnections: 2,
                settleNanos: 150_000_000,
                windowNanos: 700_000_000,
                minTotalBytes: 1 << 20,
                minRemainingBytes: 128 << 10
            )
        )

        let download = Task { try await engine.start() }
        try await Task.sleep(nanoseconds: 250_000_000)
        try await engine.applyConnectionsCount(6)

        let fileURL = try await download.value
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)

        let progress = await engine.currentProgress()
        if let tuning = progress.tuning {
            XCTAssertEqual(tuning.outcome, .userOverride)
            XCTAssertEqual(tuning.currentConnections, 6)
        }
    }
}
