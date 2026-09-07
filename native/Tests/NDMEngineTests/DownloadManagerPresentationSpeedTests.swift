import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadManagerPresentationSpeedTests: XCTestCase {
    func testEveryObserverReceivesTheSameCachedOneSecondTaskRate() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-presentation-speed-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(),
            supportRoot: root
        )

        let first = await manager.progressForPresentation(
            DownloadProgress(
                taskID: 7,
                totalBytes: 10_000,
                completedBytes: 1_000,
                bytesPerSecond: 99_999,
                status: .downloading
            ),
            taskID: 7,
            now: 100
        )
        XCTAssertEqual(first.bytesPerSecond, 0)

        let sampled = await manager.progressForPresentation(
            DownloadProgress(
                taskID: 7,
                totalBytes: 10_000,
                completedBytes: 3_000,
                bytesPerSecond: 1,
                status: .downloading
            ),
            taskID: 7,
            now: 101
        )
        XCTAssertEqual(sampled.bytesPerSecond, 2_000, accuracy: 0.001)

        // A second surface reading later in the same sample window must see
        // the identical cached value, not start its own clock.
        let secondObserver = await manager.progressForPresentation(
            DownloadProgress(
                taskID: 7,
                totalBytes: 10_000,
                completedBytes: 3_400,
                bytesPerSecond: 500_000,
                status: .downloading
            ),
            taskID: 7,
            now: 101.2
        )
        XCTAssertEqual(secondObserver.bytesPerSecond, sampled.bytesPerSecond)
        XCTAssertEqual(secondObserver.completedBytes, 3_400)
        XCTAssertEqual(secondObserver.totalBytes, 10_000)
    }

    func testTaskSpeedWindowsRemainIndependent() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-presentation-speed-tasks-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let manager = DownloadManager(
            store: try DownloadStore(directory: root),
            settings: AppSettings(),
            supportRoot: root
        )

        _ = await manager.progressForPresentation(
            DownloadProgress(taskID: 1, completedBytes: 100, status: .downloading),
            taskID: 1,
            now: 20
        )
        _ = await manager.progressForPresentation(
            DownloadProgress(taskID: 2, completedBytes: 1_000, status: .downloading),
            taskID: 2,
            now: 20
        )

        let one = await manager.progressForPresentation(
            DownloadProgress(taskID: 1, completedBytes: 2_100, status: .downloading),
            taskID: 1,
            now: 21
        )
        let two = await manager.progressForPresentation(
            DownloadProgress(taskID: 2, completedBytes: 5_000, status: .downloading),
            taskID: 2,
            now: 21
        )

        XCTAssertEqual(one.bytesPerSecond, 2_000, accuracy: 0.001)
        XCTAssertEqual(two.bytesPerSecond, 4_000, accuracy: 0.001)
    }
}
