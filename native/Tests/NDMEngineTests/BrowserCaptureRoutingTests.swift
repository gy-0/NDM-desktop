import XCTest
import NDMCore
@testable import NDMEngine

final class BrowserCaptureRoutingTests: XCTestCase {
    private func capture() -> ParsedBridgeMessage {
        var message = ParsedBridgeMessage()
        message.url = "https://cdn.example.test/opaque?synthetic=fixture"
        message.ltype = "media"
        message.contentType = "video/mp4; charset=binary"
        message.pageURL = "https://page.example.test/watch"
        message.pageTitle = "Captured fixture"
        message.referer = message.pageURL
        message.origin = "https://page.example.test"
        message.cookies = "fixture=yes"
        message.userAgent = "NDM test browser"
        message.extraHeaders = ["X-Fixture": "yes"]
        return message
    }

    func testOpaqueMediaMIMEPreservesWholeCapture() throws {
        let input = capture()
        let output = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(input))
        var expected = input; expected.ltype = "normal"
        XCTAssertEqual(output, expected)
        XCTAssertEqual(output.pageURL, input.pageURL)
        XCTAssertEqual(output.cookies, input.cookies)
    }

    func testPageIntentAlwaysUsesComposerEvenWithVideoMIME() throws {
        var message = capture(); message.ltype = "media-page"
        XCTAssertNil(try BrowserCaptureRouting.normalizedFileMessage(message))
        message.url = "https://cdn.example.test/fixture.mp4"
        XCTAssertNil(try BrowserCaptureRouting.normalizedFileMessage(message))
    }

    func testUnknownAndHTMLMediaLabelsNeverBypassPageRecognition() throws {
        for mime in ["", "text/html", "application/xhtml+xml", "application/octet-stream"] {
            var message = capture(); message.contentType = mime
            XCTAssertNil(try BrowserCaptureRouting.normalizedFileMessage(message), mime)
        }
    }

    func testHLSMIMEChoosesPlaylistEngineWithoutDroppingContext() throws {
        var message = capture(); message.contentType = "application/vnd.apple.mpegurl"
        let normalized = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        XCTAssertEqual(normalized.ltype, "hls")
        XCTAssertEqual(normalized.url, message.url)
        XCTAssertEqual(normalized.referer, message.referer)
        message.alternateURL = "https://cdn.example.test/audio-playlist"
        let paired = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        XCTAssertEqual(paired.ltype, "hls")
        XCTAssertEqual(paired.alternateURL, message.alternateURL)
    }

    func testLegacyAudioURLIsNeverTreatedAsFilenameOrDiscarded() throws {
        var message = capture()
        message.filename = "https://cdn.example.test/audio"
        let normalized = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        XCTAssertEqual(normalized.filename, "")
        XCTAssertEqual(normalized.alternateURL, message.filename)
        XCTAssertEqual(normalized.cookies, message.cookies)
        XCTAssertEqual(normalized.ltype, "media")
        message.alternateURL = "https://cdn.example.test/other-audio"
        XCTAssertThrowsError(try BrowserCaptureRouting.normalizedFileMessage(message)) {
            XCTAssertEqual($0 as? BrowserCaptureRouting.Failure, .conflictingAudioSource)
        }
    }

    func testPairedTracksCannotCarryCredentialsToAnotherOrigin() throws {
        var message = capture(); message.alternateURL = "https://audio.example.test/stream"
        XCTAssertThrowsError(try BrowserCaptureRouting.normalizedFileMessage(message)) {
            XCTAssertEqual($0 as? BrowserCaptureRouting.Failure, .crossOriginAudioCredentials)
        }
        message.cookies = ""; message.extraHeaders = ["Authorization": "synthetic"]
        XCTAssertThrowsError(try BrowserCaptureRouting.normalizedFileMessage(message))
        message.extraHeaders = [:]
        let safe = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        XCTAssertEqual(safe.alternateURL, message.alternateURL)
        message.alternateURL = "https://account:secret@audio.example.test/stream"
        XCTAssertThrowsError(try BrowserCaptureRouting.normalizedFileMessage(message))
    }

    func testOrdinaryFilesKeepTheirExistingRouteAndFilename() throws {
        var message = capture(); message.url = "https://page.example.test/installer"; message.contentType = ""
        let normalized = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message, fallbackFilename: "NDM.dmg"))
        XCTAssertEqual(normalized.ltype, "normal")
        XCTAssertEqual(normalized.filename, "NDM.dmg")
        XCTAssertEqual(normalized.pageURL, message.pageURL)
    }

    func testManagerPersistsBothTracksAndCapturedRequest() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root), supportRoot: root)
        var message = capture(); message.filename = "https://cdn.example.test/audio"
        let normalized = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        let task = try await manager.addFromBridge(normalized, awaitingDestination: true)
        XCTAssertEqual(task.alternateURL, message.filename)
        XCTAssertEqual(task.pageURL, message.pageURL)
        XCTAssertEqual(task.userAgent, message.userAgent)
        XCTAssertTrue(task.headers.contains("Cookie: fixture=yes"))
        XCTAssertEqual(task.linkType, "media")
        XCTAssertEqual(task.status, .paused)
        let reopened = try DownloadStore(directory: root)
        XCTAssertEqual(try reopened.download(id: task.id)?.alternateURL, message.filename)
        XCTAssertEqual(try reopened.download(id: task.id)?.headers, task.headers)
        message.filename = ""; message.contentType = "application/vnd.apple.mpegurl"
        message.alternateURL = "https://cdn.example.test/audio-playlist"
        let playlist = try XCTUnwrap(BrowserCaptureRouting.normalizedFileMessage(message))
        let playlistTask = try await manager.addFromBridge(playlist, awaitingDestination: true)
        XCTAssertEqual(playlistTask.linkType, "hls")
        XCTAssertEqual(playlistTask.alternateURL, message.alternateURL)
        XCTAssertEqual(playlistTask.headers, task.headers)
    }
}
