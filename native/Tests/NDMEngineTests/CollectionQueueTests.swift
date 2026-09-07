import XCTest
@testable import NDMEngine
@testable import NDMCore

final class CollectionQueueTests: XCTestCase {
    func testCollectionEntriesArePersistedAsOrderedWaitingTasks() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-collection-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(downloadDirectory: downloads, maxConnections: 16),
            supportRoot: support
        )
        let items = [
            YtDlpCollectionItem(id: "a", title: "Opening / Scene", url: "https://example.com/a"),
            YtDlpCollectionItem(id: "b", title: "Second", url: "https://example.com/b"),
        ]
        let options = YtDlpDownloadOptions(
            container: .compatibleMP4,
            subtitleLanguage: "zh-Hans"
        )

        let tasks = try await manager.insertYtDlpCollection(
            items,
            formatID: "bestvideo[height<=1080]+bestaudio",
            options: options,
            collectionURL: "https://example.com/playlist/1",
            collectionTitle: "Course"
        )

        XCTAssertEqual(tasks.map(\.filename), ["01 - Opening - Scene.mp4", "02 - Second.mp4"])
        XCTAssertTrue(tasks.allSatisfy { $0.status == .waiting })
        XCTAssertTrue(tasks.allSatisfy { $0.pageURL == "https://example.com/playlist/1" })
        XCTAssertTrue(tasks.allSatisfy { $0.connections == 16 })
        let persistedOptions = tasks.compactMap { task in
            task.postData.flatMap { try? JSONDecoder().decode(YtDlpDownloadOptions.self, from: $0) }
        }
        XCTAssertEqual(persistedOptions.map(\.container), [.compatibleMP4, .compatibleMP4])
        XCTAssertEqual(persistedOptions.map(\.subtitleLanguage), ["zh-Hans", "zh-Hans"])
        XCTAssertEqual(Set(persistedOptions.compactMap(\.collectionID)).count, 1)
        XCTAssertEqual(persistedOptions.map(\.collectionTitle), ["Course", "Course"])
        XCTAssertEqual(persistedOptions.map(\.collectionIndex), [1, 2])
        XCTAssertEqual(persistedOptions.map(\.collectionCount), [2, 2])
    }

    func testQueueCandidateOnlySelectsCollectionBackedMediaTask() {
        let ordinary = DownloadTask(
            id: 1,
            url: "https://example.com/file.zip",
            linkType: "normal",
            status: .waiting
        )
        let singleVideo = DownloadTask(
            id: 2,
            url: "https://www.youtube.com/watch?v=single123",
            linkType: "ytdlp",
            status: .waiting,
            pageURL: "https://www.youtube.com/watch?v=single123&list=PL123"
        )
        let collectionVideo = DownloadTask(
            id: 3,
            url: "https://example.com/watch/2",
            linkType: "ytdlp",
            status: .waiting,
            pageURL: "https://example.com/playlist/1"
        )
        let laterCollectionVideo = DownloadTask(
            id: 4,
            url: "https://example.com/watch/3",
            linkType: "ytdlp",
            status: .waiting,
            pageURL: "https://example.com/playlist/1"
        )

        XCTAssertEqual(
            DownloadManager.queuedCollectionCandidate(
                // DownloadStore returns newest rows first; the queue must still
                // preserve the user's original playlist order.
                in: [laterCollectionVideo, collectionVideo, singleVideo, ordinary]
            )?.id,
            3
        )
    }

    func testCollectionPersistsExactPerDownloadDestination() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-collection-destination-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        let chosen = root.appendingPathComponent("Course Assets", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let manager = DownloadManager(
            store: try DownloadStore(directory: support),
            settings: AppSettings(
                downloadDirectory: downloads,
                useCategoryFolders: true
            ),
            supportRoot: support
        )
        let tasks = try await manager.insertYtDlpCollection(
            [YtDlpCollectionItem(id: "1", title: "Lesson", url: "https://example.com/1")],
            formatID: "best",
            collectionURL: "https://example.com/course",
            collectionTitle: "Course",
            destinationDirectory: chosen
        )

        XCTAssertEqual(tasks.first?.folderPath, chosen.path)
    }
}
