import XCTest
@testable import NDMCore

final class DownloadFilenameTests: XCTestCase {
    func testGitHubCodeloadBecomesRepoRefZip() {
        let url = URL(string: "https://codeload.github.com/warpdotdev/warp/zip/refs/heads/master")!
        let name = DownloadFilename.resolve(url: url, mimeType: "application/zip")
        XCTAssertEqual(name, "warp-master.zip")
    }

    func testOpaqueUUIDGetsPageTitleAndMimeExtension() {
        let url = URL(string: "https://release-assets.githubusercontent.com/github-production-release-asset/1/f210a451-ab07-489d-bfe7-8b3464399fc7")!
        let name = DownloadFilename.resolve(
            preferred: "f210a451-ab07-489d-bfe7-8b3464399fc7",
            url: url,
            mimeType: "application/zip",
            pageTitle: "GitHub Copilot app"
        )
        XCTAssertEqual(name, "GitHub Copilot app.zip")
    }

    func testContentDispositionWins() {
        let url = URL(string: "https://example.com/download")!
        let name = DownloadFilename.resolve(
            preferred: "download",
            contentDispositionName: "Report Final.pdf",
            url: url,
            mimeType: "application/pdf"
        )
        XCTAssertEqual(name, "Report Final.pdf")
    }

    func testContentDispositionOverridesURLDerivedScriptFilename() {
        let url = URL(string: "https://example.com/download.php")!
        let name = DownloadFilename.resolve(
            preferred: "download.php",
            contentDispositionName: "Report Final.pdf",
            url: url,
            mimeType: "application/pdf"
        )
        XCTAssertEqual(name, "Report Final.pdf")
    }

    func testExtensionlessContentDispositionUsesMIMEInsteadOfScriptExtension() {
        let url = URL(string: "https://example.com/download.php")!
        let name = DownloadFilename.resolve(
            preferred: "download.php",
            contentDispositionName: "Report Final",
            url: url,
            mimeType: "application/pdf"
        )
        XCTAssertEqual(name, "Report Final.pdf")
    }

    func testExplicitPreferredFilenameStillWinsOverContentDisposition() {
        let url = URL(string: "https://example.com/download.php")!
        let name = DownloadFilename.resolve(
            preferred: "My Chosen Report.pdf",
            contentDispositionName: "Server Report.pdf",
            url: url,
            mimeType: "application/pdf"
        )
        XCTAssertEqual(name, "My Chosen Report.pdf")
    }

    func testUselessNamesAreRejected() {
        XCTAssertFalse(DownloadFilename.isUseful("master"))
        XCTAssertFalse(DownloadFilename.isUseful("f210a451-ab07-489d-bfe7-8b3464399fc7"))
        XCTAssertTrue(DownloadFilename.isUseful("warp-master.zip"))
    }

    func testEnsureExtensionFromMIME() {
        XCTAssertEqual(
            DownloadFilename.ensureExtension("installer", mimeType: "application/x-apple-diskimage"),
            "installer.dmg"
        )
    }
}

final class UniqueURLTests: XCTestCase {
    private let base = URL(fileURLWithPath: "/Downloads/Report.pdf")

    func testAFreeNameIsReturnedUnchanged() {
        XCTAssertEqual(DownloadFilename.uniqueURL(base) { _ in false }, base)
    }

    /// Finder-style: the second copy is "(2)", not "(1)".
    func testCollisionsNumberFromTwo() {
        let taken: Set<String> = ["/Downloads/Report.pdf"]
        XCTAssertEqual(
            DownloadFilename.uniqueURL(base) { taken.contains($0.path) }.lastPathComponent,
            "Report (2).pdf"
        )
    }

    func testNumberingKeepsClimbingPastExistingCopies() {
        let taken: Set<String> = [
            "/Downloads/Report.pdf",
            "/Downloads/Report (2).pdf",
            "/Downloads/Report (3).pdf",
        ]
        XCTAssertEqual(
            DownloadFilename.uniqueURL(base) { taken.contains($0.path) }.lastPathComponent,
            "Report (4).pdf"
        )
    }

    func testExtensionlessNamesAreNumberedToo() {
        let url = URL(fileURLWithPath: "/Downloads/archive")
        let taken: Set<String> = ["/Downloads/archive"]
        XCTAssertEqual(
            DownloadFilename.uniqueURL(url) { taken.contains($0.path) }.lastPathComponent,
            "archive (2)"
        )
    }

    /// A multi-part extension must not be mangled: the numbering belongs before the
    /// final extension, and the stem keeps its dots.
    func testDottedStemsSurvive() {
        let url = URL(fileURLWithPath: "/Downloads/Talk.zh-Hans.srt")
        let taken: Set<String> = ["/Downloads/Talk.zh-Hans.srt"]
        XCTAssertEqual(
            DownloadFilename.uniqueURL(url) { taken.contains($0.path) }.lastPathComponent,
            "Talk.zh-Hans (2).srt"
        )
    }
}
