import XCTest
@testable import NDMEngine
@testable import NDMCore

final class MediaSessionSelectionTests: XCTestCase {
    func testAbsentBrowserIsAnonymousButExplicitInvalidValuesFail() throws {
        XCTAssertNil(try MediaSessionSelection.browser(from: nil))
        for value: Any in ["", "opera", "whale", "Chrome", "chrome:Profile 2", 17, NSNull(), ["chrome"]] {
            XCTAssertThrowsError(try MediaSessionSelection.browser(from: value))
        }
    }
    func testSixSupportedBrowsersArePreservedExactly() throws {
        for browser in ["chrome", "firefox", "safari", "edge", "brave", "chromium"] {
            XCTAssertEqual(try MediaSessionSelection.browser(from: browser), browser)
        }
    }
    func testAbsentLegacyOptionsStillUseContainerDefault() throws {
        XCTAssertEqual(try MediaSessionSelection.resumeOptions(data: nil, filename: "old.mkv").container, .compactMKV)
        XCTAssertEqual(try MediaSessionSelection.resumeOptions(data: nil, filename: "old.mp4").container, .compatibleMP4)
        XCTAssertNil(try MediaSessionSelection.resumeOptions(data: nil, filename: "old.mp4").cookieSource)
    }
    func testPresentCorruptOptionsNeverBecomeAnonymousDefaults() {
        for data in [Data(), Data("{broken".utf8), Data("{\"container\":\"bad\",\"cookieSource\":{\"browser\":{\"_0\":\"firefox\"}}}".utf8)] {
            XCTAssertThrowsError(try MediaSessionSelection.resumeOptions(data: data, filename: "video.mp4"))
        }
    }
    func testValidCookieSourcesSurviveResumeRoundtrip() throws {
        for source in [YtDlpCookieSource.browser("firefox"), .browser("chrome"), .file("/tmp/explicit-cookies.txt")] {
            let original = YtDlpDownloadOptions(container: .compactMKV, subtitleLanguage: "en", cookieSource: source)
            let restored = try MediaSessionSelection.resumeOptions(data: JSONEncoder().encode(original), filename: "video.mp4")
            XCTAssertEqual(restored, original)
        }
    }

    func testManagerResumeRejectsCorruptPersistedOptionsBeforeStartingTool() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = try DownloadStore(directory: root)
        let options = Data("invalid saved media options".utf8)
        let task = try store.insert(DownloadTask(url: "http://127.0.0.1:1/media", filename: "media.mp4", linkType: "ytdlp", category: .video, status: .paused, postData: options))
        let manager = DownloadManager(store: store, settings: AppSettings(downloadDirectory: root, useCategoryFolders: false), supportRoot: root)
        do {
            try await manager.start(taskID: task.id)
            XCTFail("Corrupt explicit options must not start anonymously")
        } catch MediaSessionSelection.Failure.invalidSavedOptions { }
        let saved = try await manager.listTasks().first { $0.id == task.id }
        XCTAssertEqual(saved?.postData, options)
        XCTAssertNotEqual(saved?.status, .downloading)
    }
}
