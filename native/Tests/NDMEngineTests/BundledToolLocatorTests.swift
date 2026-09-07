import XCTest
@testable import NDMEngine

final class BundledToolLocatorTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-tool-locator-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testBundledToolAlwaysWinsOverDeveloperFallback() throws {
        let bundled = folder.appendingPathComponent("yt-dlp")
        let fallback = folder.appendingPathComponent("fallback")
        try makeExecutable(bundled)
        try makeExecutable(fallback)

        XCTAssertEqual(
            BundledToolLocator.find(
                ["yt-dlp"],
                bundledRoots: [folder],
                developerFallbacks: [fallback.path],
                allowDeveloperFallbacks: true
            ),
            bundled.path
        )
    }

    func testReleaseContractDoesNotFallBackToDeveloperMachine() throws {
        let fallback = folder.appendingPathComponent("ffmpeg")
        try makeExecutable(fallback)

        XCTAssertNil(BundledToolLocator.find(
            ["ffmpeg"],
            bundledRoots: [],
            developerFallbacks: [fallback.path],
            allowDeveloperFallbacks: false
        ))
        XCTAssertEqual(
            BundledToolLocator.find(
                ["ffmpeg"],
                bundledRoots: [],
                developerFallbacks: [fallback.path],
                allowDeveloperFallbacks: true
            ),
            fallback.path
        )
    }

    func testBundleContainmentDoesNotAcceptSiblingPrefix() {
        let root = folder.appendingPathComponent("Tools", isDirectory: true)
        XCTAssertTrue(MediaToolchain.isInside(
            path: root.appendingPathComponent("deno").path,
            roots: [root]
        ))
        XCTAssertFalse(MediaToolchain.isInside(
            path: folder.appendingPathComponent("Tools-old/deno").path,
            roots: [root]
        ))
    }

    private func makeExecutable(_ url: URL) throws {
        try Data("tool".utf8).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: url.path
        )
    }
}
