import XCTest
@testable import NDMEngine

final class SmartFinalizeCompletionStackTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-completion-stack-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    func testDiscoversMatchingPlayerReadyArtifacts() throws {
        let video = folder.appendingPathComponent("Trip to Shanghai.mp4")
        let subtitle = folder.appendingPathComponent("Trip to Shanghai.srt")
        let localizedSubtitle = folder.appendingPathComponent("Trip to Shanghai.en.vtt")
        let cover = folder.appendingPathComponent("Trip to Shanghai.webp")
        let metadata = folder.appendingPathComponent("Trip to Shanghai.info.json")
        for url in [video, subtitle, localizedSubtitle, cover, metadata] {
            try Data(url.lastPathComponent.utf8).write(to: url)
        }

        let stack = try XCTUnwrap(SmartFinalize.completionStack(primary: video))
        XCTAssertEqual(stack.artifacts.map(\.kind), [
            .primary, .subtitle, .subtitle, .cover, .metadata,
        ])
        XCTAssertEqual(stack.sidecars.count, 4)
        XCTAssertTrue(stack.artifacts.allSatisfy { $0.byteCount > 0 })
    }

    func testDoesNotPullInUnrelatedOrTemporaryFiles() throws {
        let video = folder.appendingPathComponent("Movie.mp4")
        try Data("video".utf8).write(to: video)
        try Data("other".utf8).write(to: folder.appendingPathComponent("Movie trailer.srt"))
        try Data("partial".utf8).write(to: folder.appendingPathComponent("Movie.part"))
        try Data("other".utf8).write(to: folder.appendingPathComponent("Another Movie.srt"))

        let stack = try XCTUnwrap(SmartFinalize.completionStack(primary: video))
        XCTAssertEqual(stack.artifacts.map(\.kind), [.primary])
    }

    func testDiscoversLocalizedSidecarsWithLanguageSuffixes() throws {
        let video = folder.appendingPathComponent("大模型中转站，怎么便宜？.mp4")
        let files = [
            video,
            folder.appendingPathComponent("大模型中转站，怎么便宜？.zh-Hans.srt"),
            folder.appendingPathComponent("大模型中转站，怎么便宜？.en.vtt"),
            folder.appendingPathComponent("大模型中转站，怎么便宜？.webp"),
            folder.appendingPathComponent("大模型中转站，怎么便宜？.info.json"),
        ]
        for url in files { try Data(url.lastPathComponent.utf8).write(to: url) }

        let stack = try XCTUnwrap(SmartFinalize.completionStack(primary: video))
        XCTAssertEqual(stack.artifacts.map(\.kind), [
            .primary, .subtitle, .subtitle, .cover, .metadata,
        ])
        XCTAssertEqual(stack.sidecars.count, 4)
    }

    func testMissingPrimaryProducesNoResult() {
        let missing = folder.appendingPathComponent("Missing.mp4")
        XCTAssertNil(SmartFinalize.completionStack(primary: missing))
    }

    func testSuggestedFilenameRemovesSiteChromeAndDuplicateExtension() {
        XCTAssertEqual(
            SmartFinalize.suggestedFilename(
                pageTitle: "A Better Download.mp4 - YouTube",
                fallback: "videoplayback-9f31.mp4",
                ext: ".MP4"
            ),
            "A Better Download.mp4"
        )
        XCTAssertEqual(
            SmartFinalize.suggestedFilename(
                pageTitle: "设计课_哔哩哔哩_bilibili",
                fallback: "02 - BV1abc.mp4",
                ext: "mp4"
            ),
            "02 - 设计课.mp4"
        )
    }

    func testSmartNamingMovesPrimaryAndEveryMatchingSidecar() throws {
        let video = folder.appendingPathComponent("03 - BV1abc.mp4")
        let subtitle = folder.appendingPathComponent("03 - BV1abc.en.srt")
        let cover = folder.appendingPathComponent("03 - BV1abc.webp")
        for url in [video, subtitle, cover] {
            try Data(url.lastPathComponent.utf8).write(to: url)
        }

        let result = try SmartFinalize.applySmartNaming(
            primary: video,
            pageTitle: "Design Lesson - YouTube"
        )

        XCTAssertTrue(result.renamed)
        XCTAssertEqual(result.primaryURL.lastPathComponent, "03 - Design Lesson.mp4")
        XCTAssertEqual(Set(result.sidecarURLs.map(\.lastPathComponent)), [
            "03 - Design Lesson.en.srt",
            "03 - Design Lesson.webp",
        ])
        XCTAssertFalse(FileManager.default.fileExists(atPath: video.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.primaryURL.path))
    }

    func testSmartNamingNeverOverwritesAndTruthfulCopyFollowsDiskName() throws {
        let video = folder.appendingPathComponent("tokenized.mp4")
        let subtitle = folder.appendingPathComponent("tokenized.srt")
        let existing = folder.appendingPathComponent("Clean Title.mp4")
        for url in [video, subtitle, existing] {
            try Data(url.lastPathComponent.utf8).write(to: url)
        }

        let result = try SmartFinalize.applySmartNaming(
            primary: video,
            pageTitle: "Clean Title"
        )

        XCTAssertEqual(result.primaryURL.lastPathComponent, "Clean Title (2).mp4")
        XCTAssertEqual(result.sidecarURLs.map(\.lastPathComponent), ["Clean Title (2).srt"])
        XCTAssertTrue(SmartFinalize.filenameReflectsPageTitle(
            result.primaryURL.lastPathComponent,
            pageTitle: "Clean Title"
        ))
        XCTAssertFalse(SmartFinalize.filenameReflectsPageTitle(
            "tokenized.mp4",
            pageTitle: "Clean Title"
        ))
        XCTAssertEqual(try Data(contentsOf: existing), Data("Clean Title.mp4".utf8))
    }
}
