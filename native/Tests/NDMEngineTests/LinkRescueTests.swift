import XCTest
@testable import NDMCore
@testable import NDMEngine

final class LinkRescueTests: XCTestCase {
    func testFreshBrowserCaptureRescuesExpiredTaskWithoutCreatingDuplicate() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        var expired = DownloadTask(
            url: "https://cdn.example.com/file.bin?token=old",
            filename: "Project.zip",
            linkType: "normal",
            status: .error,
            pageURL: "https://example.com/download?id=42&utm_source=old",
            pageTitle: "Project",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            postData: Data("stale".utf8),
            folderPath: fixture.downloads.path
        )
        expired = try fixture.store.insert(expired)

        let work = fixture.support.appendingPathComponent("\(expired.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let partial = work.appendingPathComponent("seg.x0")
        try Data(repeating: 0x7A, count: 128).write(to: partial)

        var message = ParsedBridgeMessage()
        message.url = "https://cdn.example.com/file.bin?token=fresh"
        message.filename = "tokenized-name.bin"
        message.pageURL = "https://example.com/download?id=42&utm_campaign=new"
        message.pageTitle = "Project refreshed"
        message.cookies = "session=fresh"
        message.userAgent = "Fresh Browser"
        message.contentType = "application/zip"
        message.fileSize = 9_000

        let rescued = try await fixture.manager.addFromBridge(message)
        let tasks = try await fixture.manager.listTasks()

        XCTAssertEqual(rescued.id, expired.id)
        XCTAssertEqual(tasks.count, 1)
        XCTAssertEqual(rescued.url, message.url)
        XCTAssertEqual(rescued.filename, "Project.zip", "resume keeps the original destination")
        XCTAssertEqual(rescued.status, .incomplete)
        XCTAssertNil(rescued.errorText)
        XCTAssertNil(rescued.postData, "a fresh GET must not inherit stale POST data")
        XCTAssertEqual(rescued.userAgent, "Fresh Browser")
        XCTAssertTrue(rescued.headers.contains("Cookie: session=fresh"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: partial.path), "partial segments are preserved")
    }

    func testUnrelatedFailureDoesNotGetSilentlyRescued() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        _ = try fixture.store.insert(DownloadTask(
            url: "https://cdn.example.com/file.bin",
            filename: "file.bin",
            status: .error,
            pageURL: "https://example.com/download?id=42",
            errorText: DownloadDiagnostic.diskFull.storageString,
            folderPath: fixture.downloads.path
        ))

        var message = ParsedBridgeMessage()
        message.url = "https://cdn.example.com/file.bin?token=fresh"
        message.filename = "file.bin"
        message.pageURL = "https://example.com/download?id=42"

        let added = try await fixture.manager.addFromBridge(message)
        let tasks = try await fixture.manager.listTasks()
        XCTAssertEqual(tasks.count, 2)
        XCTAssertEqual(added.url, message.url)
    }

    func testDualTrackRescueRequiresFreshVideoAndAudioPair() async throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }

        let expired = try fixture.store.insert(DownloadTask(
            url: "https://cdn.example.com/video?old",
            filename: "video.mkv",
            linkType: "media",
            status: .error,
            pageURL: "https://example.com/watch/42",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            alternateURL: "https://cdn.example.com/audio?old",
            folderPath: fixture.downloads.path
        ))

        var incompleteCapture = ParsedBridgeMessage()
        incompleteCapture.url = "https://cdn.example.com/video?fresh"
        incompleteCapture.filename = "video.mkv"
        incompleteCapture.pageURL = "https://example.com/watch/42"
        incompleteCapture.ltype = "media"

        let added = try await fixture.manager.addFromBridge(incompleteCapture)
        XCTAssertNotEqual(added.id, expired.id)

        var completeCapture = incompleteCapture
        completeCapture.alternateURL = "https://cdn.example.com/audio?fresh"
        let rescued = try await fixture.manager.addFromBridge(completeCapture)
        XCTAssertEqual(rescued.id, expired.id)
        XCTAssertEqual(rescued.alternateURL, completeCapture.alternateURL)
    }

    private func makeFixture() throws -> (
        root: URL,
        support: URL,
        downloads: URL,
        store: DownloadStore,
        manager: DownloadManager
    ) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-link-rescue-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(
            store: store,
            settings: AppSettings(downloadDirectory: downloads, useCategoryFolders: false),
            supportRoot: support
        )
        return (root, support, downloads, store, manager)
    }
}
