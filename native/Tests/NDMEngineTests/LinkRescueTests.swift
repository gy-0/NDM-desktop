import XCTest
@testable import NDMCore
@testable import NDMEngine

final class LinkRescueTests: XCTestCase {
    func testExactRequestRescuesUniqueFailureWithoutReplacingProvenance() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        var message = matchingCapture()
        let expired = try insertExpired(in: f, matching: message)
        let partial = try writePartial(for: expired, in: f)
        let bytes = try Data(contentsOf: partial)
        // Capture hints do not authorize replacing the original file metadata.
        message.filename = "different.pdf"
        message.pageURL = "https://example.com/download?id=42&utm_campaign=new"
        message.pageTitle = "New page title"
        message.fileSize = 90_000
        message.contentType = "application/pdf"

        let rescued = try await f.manager.addFromBridge(message, awaitingDestination: true)
        XCTAssertEqual(rescued.id, expired.id)
        XCTAssertEqual(rescued.status, .incomplete)
        XCTAssertNil(rescued.errorText)
        XCTAssertNil(rescued.completedAt)
        XCTAssertNotNil(rescued.lastTry)
        var expected = expired
        expected.status = .incomplete
        expected.errorText = nil
        expected.completedAt = nil
        expected.lastTry = rescued.lastTry
        XCTAssertEqual(rescued, expected, "Retry preserves all original request, file and page fields")
        XCTAssertEqual(try Data(contentsOf: partial), bytes)

        let reopened = try DownloadStore(directory: f.support)
        let reconstructed = DownloadManager(store: reopened, settings: f.settings, supportRoot: f.support)
        let fetched = try await reconstructed.task(id: expired.id)
        let persisted = try XCTUnwrap(fetched)
        // Date's reference-epoch conversion to SQLite's Unix-epoch Double can
        // round sub-microsecond precision; all provenance fields stay exact.
        XCTAssertEqual(try XCTUnwrap(persisted.lastTry).timeIntervalSince1970,
                       try XCTUnwrap(rescued.lastTry).timeIntervalSince1970, accuracy: 0.000_001)
        expected.lastTry = persisted.lastTry
        XCTAssertEqual(persisted, expected)
        XCTAssertEqual(try reopened.allDownloads().count, 1)
        XCTAssertEqual(try Data(contentsOf: partial), bytes)
    }

    func testChangedRequestCreatesSeparateTaskAndPreservesOriginalProgress() async throws {
        let changes: [(String, (inout ParsedBridgeMessage) -> Void)] = [
            ("URL token", { $0.url += "&token=fresh" }),
            ("HTTP method", { $0.method = "GET" }),
            ("body", { $0.postData = "different=body" }),
            ("missing body", { $0.postData = nil }),
            ("cookie", { $0.cookies = "session=fresh" }),
            ("authorization", { $0.extraHeaders["Authorization"] = "Bearer fresh-fixture" }),
            ("user agent", { $0.userAgent = "Another fixture browser" }),
            ("missing user agent", { $0.userAgent = "" }),
        ]
        for (name, change) in changes {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            var message = matchingCapture()
            let expired = try insertExpired(in: f, matching: message)
            let partial = try writePartial(for: expired, in: f)
            let bytes = try Data(contentsOf: partial)
            change(&message)
            let added = try await f.manager.addFromBridge(message, awaitingDestination: true)
            XCTAssertNotEqual(added.id, expired.id, name)
            XCTAssertEqual(added.awaitingDestination, true, "New task uses normal destination admission: \(name)")
            XCTAssertEqual(added.status, .paused, name)
            XCTAssertEqual(try f.store.allDownloads().first { $0.id == expired.id }, expired, name)
            XCTAssertEqual(try f.store.allDownloads().count, 2, name)
            XCTAssertEqual(try Data(contentsOf: partial), bytes, name)
        }
    }

    func testAmbiguousExactRequestsDoNotSelectFirstFailedTask() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        let message = matchingCapture()
        let first = try insertExpired(in: f, matching: message)
        var other = first
        other.id = 0
        other.filename = "Other destination.zip"
        let second = try f.store.insert(other)
        let firstPartial = try writePartial(for: first, in: f)
        let secondPartial = try writePartial(for: second, in: f)
        let bytes = try Data(contentsOf: firstPartial)
        let added = try await f.manager.addFromBridge(message, awaitingDestination: true)
        XCTAssertNotEqual(added.id, first.id)
        XCTAssertNotEqual(added.id, second.id)
        XCTAssertEqual(added.awaitingDestination, true)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == first.id }, first)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == second.id }, second)
        XCTAssertEqual(try f.store.allDownloads().count, 3)
        XCTAssertEqual(try Data(contentsOf: firstPartial), bytes)
        XCTAssertEqual(try Data(contentsOf: secondPartial), bytes)
    }

    func testSamePageWithDistinctFilesSelectsOnlyExactRequest() async throws {
        let f = try fixture()
        defer { try? FileManager.default.removeItem(at: f.root) }
        var otherMessage = matchingCapture()
        otherMessage.url = "https://cdn.example.com/another.zip"
        let other = try insertExpired(in: f, matching: otherMessage)
        let message = matchingCapture()
        let matching = try insertExpired(in: f, matching: message)
        let rescued = try await f.manager.addFromBridge(message)
        XCTAssertEqual(rescued.id, matching.id)
        XCTAssertEqual(try f.store.allDownloads().first { $0.id == other.id }, other)
        XCTAssertEqual(try f.store.allDownloads().count, 2)
    }

    func testNonOrdinaryCaptureNeverRescuesOrdinaryTask() async throws {
        let changes: [(String, (inout ParsedBridgeMessage) -> Void)] = [
            ("HLS type", { $0.ltype = "hls" }),
            ("HLS filename", { $0.filename = "stream.m3u8" }),
            ("media type", { $0.ltype = "media" }),
            ("audio pair", { $0.alternateURL = "https://cdn.example.com/audio" }),
            ("extractor", { $0.ltype = "ytdlp" }),
        ]
        for (name, change) in changes {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            var message = matchingCapture()
            let expired = try insertExpired(in: f, matching: message)
            change(&message)
            let added = try await f.manager.addFromBridge(message)
            XCTAssertNotEqual(added.id, expired.id, name)
            XCTAssertEqual(try f.store.allDownloads().first { $0.id == expired.id }, expired, name)
        }
    }

    func testMediaHLSAndFTPFailuresRemainSeparateEvenWithExactRequest() async throws {
        for linkType in ["media", "hls", "ytdlp", "ftp"] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            var message = matchingCapture()
            message.ltype = linkType
            if linkType == "media" { message.alternateURL = "https://cdn.example.com/audio" }
            if linkType == "hls" { message.url = "https://cdn.example.com/stream.m3u8" }
            if linkType == "ftp" { message.url = "ftp://cdn.example.com/file.zip" }
            let expired = try insertExpired(in: f, matching: message)
            let added = try await f.manager.addFromBridge(message)
            XCTAssertNotEqual(added.id, expired.id, linkType)
            XCTAssertEqual(try f.store.allDownloads().first { $0.id == expired.id }, expired, linkType)
        }
    }

    func testUnrelatedFailureDifferentSourcePageAndNonErrorRowsAreNotRescued() async throws {
        for variant in ["disk-full", "different-page", "paused", "downloading", "complete"] {
            let f = try fixture()
            defer { try? FileManager.default.removeItem(at: f.root) }
            let message = matchingCapture()
            var original = try insertExpired(in: f, matching: message)
            switch variant {
            case "disk-full": original.errorText = DownloadDiagnostic.diskFull.storageString
            case "different-page": original.pageURL = "https://example.com/download?id=other"
            case "paused": original.status = .paused
            case "downloading": original.status = .downloading
            default: original.status = .complete
            }
            try f.store.update(original)
            let added = try await f.manager.addFromBridge(message)
            XCTAssertNotEqual(added.id, original.id, variant)
            XCTAssertEqual(try f.store.allDownloads().first { $0.id == original.id }, original, variant)
        }
    }

    private func matchingCapture() -> ParsedBridgeMessage {
        var message = ParsedBridgeMessage()
        message.url = "https://cdn.example.com/file.bin?token=original"
        message.method = "POST"
        message.postData = "fixture=original"
        message.pageURL = "https://example.com/download?id=42&utm_source=old"
        message.filename = "Project.zip"
        message.userAgent = "Fixture Browser"
        message.cookies = "session=original-fixture"
        message.extraHeaders = ["Authorization": "Bearer original-fixture"]
        return message
    }

    private func insertExpired(in f: Fixture, matching message: ParsedBridgeMessage) throws -> DownloadTask {
        try f.store.insert(DownloadTask(
            url: message.url, method: message.method, filename: "Project.zip", linkType: message.ltype,
            fileSize: 9_000, category: .compressed, status: .error, bandwidthLimit: 65_536, connections: 4,
            lastTry: Date(timeIntervalSince1970: 10), firstTry: Date(timeIntervalSince1970: 1),
            userAgent: message.userAgent.isEmpty ? nil : message.userAgent, resumable: true,
            pageURL: message.pageURL, pageTitle: "Original project page",
            thumbnailURL: "https://example.com/preview.png", hitTitle: "original-title", mimeType: "application/zip",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString,
            alternateURL: message.alternateURL.isEmpty ? nil : message.alternateURL,
            postData: message.postData.map { Data($0.utf8) }, folderPath: f.downloads.path,
            headers: ["Cookie: \(message.cookies)", "Authorization: \(message.extraHeaders["Authorization"]!)"]
        ))
    }

    private func writePartial(for task: DownloadTask, in f: Fixture) throws -> URL {
        let work = f.support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        let partial = work.appendingPathComponent("seg.x0")
        try Data(repeating: 0x7A, count: 128).write(to: partial)
        return partial
    }

    private struct Fixture {
        let root: URL
        let support: URL
        let downloads: URL
        let store: DownloadStore
        let settings: AppSettings
        let manager: DownloadManager
    }

    private func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-link-rescue-\(UUID())")
        let support = root.appendingPathComponent("support", isDirectory: true)
        let downloads = root.appendingPathComponent("downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: downloads, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: downloads, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        return Fixture(root: root, support: support, downloads: downloads, store: store, settings: settings, manager: manager)
    }
}
