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

    func testNewDownloadPreservesExtensionAndBoundsUTF16WithoutSplittingEmoji() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for raw in [String(repeating: "Project notes ", count: 20) + ".pdf",
                    String(repeating: "📁", count: 170) + ".zip",
                    String(repeating: "👨‍👩‍👧‍👦", count: 60) + ".mp4"] {
            let name = DownloadFilename.sanitizeNewDownload(raw)
            XCTAssertLessThanOrEqual(name.utf16.count, 172)
            XCTAssertEqual((name as NSString).pathExtension, (raw as NSString).pathExtension)
            XCTAssertFalse(name.contains("�"))
            XCTAssertFalse(name.contains(" ."))
            let data = Data("fixture".utf8)
            let url = root.appendingPathComponent(name)
            try data.write(to: url)
            XCTAssertEqual(try Data(contentsOf: url), data)
        }
    }

    func testNewDownloadMetadataKeepsLongExtensionButLegacyResolutionIsUnchanged() {
        let raw = String(repeating: "Project notes ", count: 20) + ".pdf"
        let url = URL(string: "https://example.com/download")!
        let fresh = DownloadFilename.resolve(contentDispositionName: raw, url: url, newDownload: true)
        XCTAssertTrue(fresh.hasSuffix(".pdf"))
        let legacy = DownloadFilename.resolve(contentDispositionName: raw, url: url)
        XCTAssertEqual(legacy, String(raw.prefix(180)))
        XCTAssertEqual(DownloadFilename.sanitize(raw), String(raw.prefix(180)))
    }

    func testLongestNumberedNewNameSurvivesLegacyCheckpointResolution() {
        let raw = String(repeating: "Archive notes ", count: 30) + ".pdf"
        let name = DownloadFilename.sanitizeNewDownload(raw)
        let numbered = DownloadFilename.uniqueURL(URL(fileURLWithPath: "/fixture/\(name)")) {
            !$0.lastPathComponent.hasSuffix(" (10000).pdf")
        }.lastPathComponent
        XCTAssertLessThanOrEqual(numbered.utf16.count, 180)
        XCTAssertEqual(DownloadFilename.resolve(preferred: numbered,
            contentDispositionName: "server-name.bin", url: URL(string: "https://example.com/a.bin")!), numbered)
    }

    func testNewLongSynthesizedArchiveKeepsZipWithoutMIME() {
        let repo = String(repeating: "example-project-", count: 20)
        let url = URL(string: "https://codeload.github.com/owner/\(repo)/zip/refs/heads/main")!
        let name = DownloadFilename.resolve(url: url, newDownload: true)
        XCTAssertTrue(name.hasSuffix(".zip"))
        XCTAssertLessThanOrEqual(name.utf16.count, 172)
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
