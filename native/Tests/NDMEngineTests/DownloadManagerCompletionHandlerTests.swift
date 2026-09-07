import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadManagerCompletionHandlerTests: XCTestCase {
    func testCompletionHandlerExistsFromManagerConstruction() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-completion-handler-\(UUID().uuidString)", isDirectory: true)
        let downloads = root.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let file = downloads.appendingPathComponent("instant-result.bin")
        try Data("finished".utf8).write(to: file)
        let recorder = CompletionHandlerRecorder()
        let manager = DownloadManager(
            store: try DownloadStore(directory: root),
            settings: AppSettings(downloadDirectory: downloads),
            supportRoot: root,
            onTaskCompleted: { task in
                recorder.record(task)
            }
        )

        let task = try await manager.recordCompletedFile(
            url: "https://example.com/instant-result.bin",
            fileURL: file,
            linkType: "normal"
        )

        XCTAssertEqual(recorder.taskIDs, [task.id])
    }
}

private final class CompletionHandlerRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedTaskIDs: [Int64] = []

    var taskIDs: [Int64] {
        lock.lock()
        defer { lock.unlock() }
        return storedTaskIDs
    }

    func record(_ task: DownloadTask) {
        lock.lock()
        storedTaskIDs.append(task.id)
        lock.unlock()
    }
}
