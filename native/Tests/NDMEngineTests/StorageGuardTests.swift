import XCTest
@testable import NDMEngine
@testable import NDMCore

final class StorageGuardTests: XCTestCase {
    func testSingleMediaIsRejectedBeforeTaskInsertionWhenPeakWillNotFit() async throws {
        let fixture = try makeFixture(availableBytes: 1_000)
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        do {
            _ = try await fixture.manager.startYtDlp(
                url: "https://example.com/watch/1",
                formatID: "best",
                pageTitle: "Sample",
                estimatedBytes: 800,
                estimatedComponentBytes: [600, 200],
                preferredFilename: "Sample"
            )
            XCTFail("expected storage guard")
        } catch ManagerError.insufficientStorage(let required, let available) {
            XCTAssertEqual(required, 1_600)
            XCTAssertEqual(available, 1_000)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        let tasks = try await fixture.manager.listTasks()
        XCTAssertTrue(tasks.isEmpty)
    }

    func testCollectionBudgetIncludesAllFinalItemsButOneMergeWorkspace() async throws {
        let fixture = try makeFixture(availableBytes: 2_000)
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let items = [
            YtDlpCollectionItem(id: "1", title: "One", url: "https://example.com/1", durationSeconds: 60),
            YtDlpCollectionItem(id: "2", title: "Two", url: "https://example.com/2", durationSeconds: 60),
        ]

        do {
            _ = try await fixture.manager.enqueueYtDlpCollection(
                items,
                formatID: "best",
                collectionURL: "https://example.com/list/1",
                collectionTitle: "List",
                estimatedSampleBytes: 800,
                estimatedSampleComponentBytes: [600, 200],
                sampleDurationSeconds: 60
            )
            XCTFail("expected storage guard")
        } catch ManagerError.insufficientStorage(let required, let available) {
            XCTAssertEqual(required, 2_400)
            XCTAssertEqual(available, 2_000)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        let tasks = try await fixture.manager.listTasks()
        XCTAssertTrue(tasks.isEmpty)
    }

    func testDirectDownloadStopsAfterProbeBeforeAnyPayloadWhenAssemblyWillNotFit() async throws {
        let payload = Data(repeating: 0x5A, count: 256 * 1024)
        let server = LocalRangeServer(payload: payload)
        try server.start()
        defer { server.stop() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-direct-space-\(UUID().uuidString)", isDirectory: true)
        let work = root.appendingPathComponent("work", isDirectory: true)
        let destination = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let request = DownloadRequest(
            url: server.baseURL,
            connections: 4,
            destinationDirectory: destination,
            suggestedFilename: "file.bin"
        )
        let engine = DownloadEngine(
            taskID: 71,
            request: request,
            workDirectory: work,
            capacityProvider: { _ in 300 * 1024 },
            sameVolumeProvider: { _, _ in true }
        )

        do {
            _ = try await engine.start()
            XCTFail("expected storage guard")
        } catch EngineError.insufficientStorage(let required, let available) {
            XCTAssertEqual(required, Int64(payload.count * 2))
            XCTAssertEqual(available, 300 * 1024)
        } catch {
            XCTFail("unexpected error: \(error)")
        }

        XCTAssertTrue(server.recordedRanges.isEmpty, "payload transfer must not start")
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: destination.appendingPathComponent("file.bin").path
        ))
    }

    private func makeFixture(
        availableBytes: Int64
    ) throws -> (root: URL, manager: DownloadManager) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-space-guard-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(downloadDirectory: downloads),
            supportRoot: support,
            capacityProvider: { _ in availableBytes }
        )
        return (root, manager)
    }
}
