import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class MKVMergeBandwidthTests: XCTestCase {
    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-mkv-bandwidth-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func waitUntil(_ condition: () async throws -> Bool, timeout: TimeInterval = 2) async throws -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if try await condition() { return true }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return try await condition()
    }

    func testDefaultUpdatesBeforeAndAfterStartupRespectEachTrackOverride() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 0x27, count: 1024 * 1024))
        try server.start(); defer { server.stop() }
        for (videoOverride, audioOverride): (Int64, Int64) in [(0, 37), (53, 0), (53, 37)] {
            let root = try temporaryRoot()
            let videoRequest = DownloadRequest(url: server.baseURL, connections: 1,
                bandwidthLimitBytesPerSecond: videoOverride, destinationDirectory: root)
            let audioRequest = DownloadRequest(url: server.baseURL, connections: 1,
                bandwidthLimitBytesPerSecond: audioOverride, destinationDirectory: root)
            let engine = MKVMergeEngine(taskID: 1, videoRequest: videoRequest, audioRequest: audioRequest,
                workDirectory: root.appendingPathComponent("work"), globalBandwidthLimit: 1)
            await engine.applyDefaultBandwidthLimit(8192) // Expiry/update before children exist must survive startup.
            let transfer = Task { try? await engine.start() }
            let registered = try await waitUntil { await engine.currentTrackBandwidthLimits() != nil }
            XCTAssertTrue(registered)
            let startup = await engine.currentTrackBandwidthLimits()
            XCTAssertEqual(startup?.video, videoOverride > 0 ? videoOverride : 8192)
            XCTAssertEqual(startup?.audio, audioOverride > 0 ? audioOverride : 8192)
            for defaultLimit: Int64 in [16384, 0, 4096] {
                await engine.applyDefaultBandwidthLimit(defaultLimit)
                let current = await engine.currentTrackBandwidthLimits()
                XCTAssertEqual(current?.video, videoOverride > 0 ? videoOverride : defaultLimit)
                XCTAssertEqual(current?.audio, audioOverride > 0 ? audioOverride : defaultLimit)
            }
            await engine.cancel()
            _ = await transfer.value
        }
    }

    func testOverlappingDefaultChangesLeaveBothLiveChildrenOnTheLatestValue() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 0x27, count: 1024 * 1024))
        try server.start(); defer { server.stop() }
        let root = try temporaryRoot()
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: root)
        let engine = MKVMergeEngine(taskID: 1, videoRequest: request, audioRequest: request,
            workDirectory: root.appendingPathComponent("work"), globalBandwidthLimit: 1)
        let transfer = Task { try? await engine.start() }
        let registered = try await waitUntil { await engine.currentTrackBandwidthLimits() != nil }
        XCTAssertTrue(registered)
        await withTaskGroup(of: Void.self) { group in
            for limit in 1...30 { group.addTask { await engine.applyDefaultBandwidthLimit(Int64(limit)) } }
        }
        let settled = await engine.currentTrackBandwidthLimits()
        XCTAssertEqual(settled?.video, settled?.audio, "Actor reentrancy must not leave the two children on different defaults")
        await engine.applyDefaultBandwidthLimit(63)
        let latest = await engine.currentTrackBandwidthLimits()
        XCTAssertEqual(latest?.video, 63)
        XCTAssertEqual(latest?.audio, 63)
        await engine.cancel()
        _ = await transfer.value
    }

    func testManagerDefaultExpiryReleasesBothLiveTracksWithoutRestartingRanges() async throws {
        let root = try temporaryRoot()
        let payload = Data(repeating: 0x35, count: 16 * 1024 * 1024)
        let video = LocalRangeServer(payload: payload, bodyChunkSize: 65536, bodyChunkDelay: { _ in 0.015 })
        let audio = LocalRangeServer(payload: payload, bodyChunkSize: 65536, bodyChunkDelay: { _ in 0.015 })
        try video.start(); defer { video.stop() }
        try audio.start(); defer { audio.stop() }
        let support = root.appendingPathComponent("support")
        let downloads = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        var settings = AppSettings(downloadDirectory: downloads, maxConnections: 1,
            downloadAllAtOnce: true, useCategoryFolders: false)
        settings.bandwidthLimitBytesPerSecond = 1 // Deliberately block both writers until expiry.
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        let row = try store.insert(DownloadTask(url: video.baseURL.absoluteString, filename: "fixture.mkv",
            linkType: "media", category: .video, status: .waiting, connections: 1,
            alternateURL: audio.baseURL.absoluteString, folderPath: downloads.path))
        try await manager.start(taskID: row.id)
        let started = try await waitUntil { !video.recordedRanges.isEmpty && !audio.recordedRanges.isEmpty }
        XCTAssertTrue(started)
        let firstTry = try store.allDownloads().first?.lastTry
        settings.bandwidthLimitBytesPerSecond = 0
        await manager.updateSettings(settings)
        let bothAdvanced = try await waitUntil({
            guard let snapshot = await manager.progress(taskID: row.id) else { return false }
            return snapshot.segmentStates.contains { $0.id < 1000 && $0.completed >= 256 * 1024 }
                && snapshot.segmentStates.contains { $0.id >= 1000 && $0.completed >= 256 * 1024 }
        }, timeout: 1.5)
        let snapshot = await manager.progress(taskID: row.id)
        XCTAssertTrue(bothAdvanced, "Restoring the default must release video and audio already running under a temporary cap")
        XCTAssertEqual(snapshot?.effectiveBandwidthLimitBytesPerSecond, 0)
        XCTAssertEqual(video.recordedRanges.count, 1, "Changing the default must not restart video")
        XCTAssertEqual(audio.recordedRanges.count, 1, "Changing the default must not restart audio")
        XCTAssertEqual(try store.allDownloads().first?.lastTry, firstTry)
        try await manager.remove(taskID: row.id, deleteFile: false) // Drain only this isolated fixture.
    }
}
