import XCTest
@testable import NDMEngine

final class DeliveryRecipeTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-delivery-recipes-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    func testRecipeArgumentsUseCompatibleCodecsAndNeverOverwrite() {
        let input = URL(fileURLWithPath: "/tmp/source.mkv")
        let mobile = URL(fileURLWithPath: "/tmp/mobile.mp4")
        let audio = URL(fileURLWithPath: "/tmp/audio.m4a")

        let mobileArgs = FFmpegTool.mobileCompatibleArguments(input: input, output: mobile)
        XCTAssertEqual(mobileArgs.first, "-n")
        XCTAssertTrue(mobileArgs.contains("h264_videotoolbox"))
        XCTAssertTrue(mobileArgs.contains("-allow_sw"))
        XCTAssertTrue(mobileArgs.contains("aac"))
        XCTAssertTrue(mobileArgs.contains("format=yuv420p") || mobileArgs.contains { $0.contains("format=yuv420p") })
        XCTAssertEqual(mobileArgs.last, mobile.path)

        let audioArgs = FFmpegTool.audioOnlyArguments(input: input, output: audio)
        XCTAssertEqual(audioArgs.first, "-n")
        XCTAssertTrue(audioArgs.contains("-vn"))
        XCTAssertTrue(audioArgs.contains("192k"))
        XCTAssertEqual(audioArgs.last, audio.path)
    }

    func testChatBitrateRespondsToDurationAndStaysWithinQualityBounds() {
        let short = FFmpegTool.targetVideoBitrateKbps(duration: 30, targetBytes: 25 * 1_024 * 1_024)
        let medium = FFmpegTool.targetVideoBitrateKbps(duration: 180, targetBytes: 25 * 1_024 * 1_024)
        let veryLong = FFmpegTool.targetVideoBitrateKbps(duration: 10_000, targetBytes: 25 * 1_024 * 1_024)

        XCTAssertEqual(short, 2_500)
        XCTAssertLessThan(medium, short)
        XCTAssertEqual(veryLong, 220)
    }

    func testMediaProcessDrainsLargeStandardErrorWithoutDeadlocking() throws {
        let script = #"i=0; while [ $i -lt 12000 ]; do printf 'ffmpeg progress line 012345678901234567890123456789\n' >&2; i=$((i+1)); done; exit 7"#
        let result = try FFmpegTool.runProcess(
            executable: "/bin/sh",
            arguments: ["-c", script]
        )

        XCTAssertEqual(result.terminationStatus, 7)
        XCTAssertTrue(result.standardError.contains("ffmpeg progress line"))
        XCTAssertGreaterThan(result.standardError.utf8.count, 64 * 1_024)
    }

    func testCancellingMediaProcessStopsChildPromptly() async throws {
        let processTask = Task.detached {
            try FFmpegTool.runProcess(executable: "/bin/sleep", arguments: ["30"])
        }
        try await Task.sleep(nanoseconds: 150_000_000)
        let cancelledAt = Date()
        processTask.cancel()

        do {
            _ = try await processTask.value
            XCTFail("Expected media process cancellation")
        } catch is CancellationError {
            // Expected.
        }
        XCTAssertLessThan(Date().timeIntervalSince(cancelledAt), 2)
    }

    func testOutputNamingNeverReplacesAnExistingExport() throws {
        let first = SmartFinalize.availableOutputURL(in: folder, stem: "My Video", extension: "mp4")
        XCTAssertEqual(first.lastPathComponent, "My Video.mp4")
        try Data("one".utf8).write(to: first)

        let second = SmartFinalize.availableOutputURL(in: folder, stem: "My Video", extension: "mp4")
        XCTAssertEqual(second.lastPathComponent, "My Video (2).mp4")
        try Data("two".utf8).write(to: second)

        let third = SmartFinalize.availableOutputURL(in: folder, stem: "My Video", extension: "mp4")
        XCTAssertEqual(third.lastPathComponent, "My Video (3).mp4")
    }

    func testCopiedSubtitlesKeepGeneratedVideoStemAndLanguageSuffix() throws {
        let source = folder.appendingPathComponent("Lecture.mp4")
        let subtitle = folder.appendingPathComponent("Lecture.srt")
        let chinese = folder.appendingPathComponent("Lecture.zh-Hans.vtt")
        try Data("video".utf8).write(to: source)
        try Data("subtitle".utf8).write(to: subtitle)
        try Data("chinese".utf8).write(to: chinese)

        let exportFolder = folder.appendingPathComponent("Exports", isDirectory: true)
        try FileManager.default.createDirectory(at: exportFolder, withIntermediateDirectories: true)
        let output = exportFolder.appendingPathComponent("Lecture (2).mp4")
        try Data("copy".utf8).write(to: output)

        let copied = try SmartFinalize.copyMatchingSubtitles(from: source, to: output)
        XCTAssertEqual(Set(copied.map(\.lastPathComponent)), [
            "Lecture (2).srt",
            "Lecture (2).zh-Hans.vtt",
        ])
        XCTAssertTrue(copied.allSatisfy { FileManager.default.fileExists(atPath: $0.path) })
    }

    func testOriginalRecipeReturnsExistingFileWithoutCreatingCopy() async throws {
        let source = folder.appendingPathComponent("Original.mp4")
        try Data("video".utf8).write(to: source)

        let result = try await SmartFinalize.deliver(input: source, recipe: .originalQuality)
        XCTAssertEqual(result.primaryURL, source.standardizedFileURL)
        XCTAssertFalse(result.createdCopy)
        XCTAssertTrue(result.sidecarURLs.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appendingPathComponent("NDM Exports").path))
    }

    func testGeneratedMobileAndAudioVersionsAreRealAndPreserveSource() async throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg unavailable")
        }
        let source = folder.appendingPathComponent("Tiny Clip.mp4")
        let generator = Process()
        generator.executableURL = URL(fileURLWithPath: ffmpeg)
        generator.arguments = [
            "-y",
            "-f", "lavfi", "-i", "testsrc=duration=0.5:size=160x90:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5",
            "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest",
            source.path,
        ]
        generator.standardError = Pipe()
        generator.standardOutput = Pipe()
        try generator.run()
        generator.waitUntilExit()
        guard generator.terminationStatus == 0 else {
            throw XCTSkip("local ffmpeg cannot create the fixture")
        }
        try Data("1\n00:00:00,000 --> 00:00:00,400\nHello\n".utf8)
            .write(to: folder.appendingPathComponent("Tiny Clip.srt"))

        let mobile = try await SmartFinalize.deliver(input: source, recipe: .mobileCompatible)
        XCTAssertTrue(FileManager.default.fileExists(atPath: mobile.primaryURL.path))
        XCTAssertEqual(mobile.primaryURL.pathExtension, "mp4")
        XCTAssertEqual(mobile.sidecarURLs.map(\.lastPathComponent), ["Tiny Clip.srt"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))

        let secondMobile = try await SmartFinalize.deliver(input: source, recipe: .mobileCompatible)
        XCTAssertEqual(secondMobile.primaryURL.lastPathComponent, "Tiny Clip (2).mp4")
        XCTAssertEqual(secondMobile.sidecarURLs.map(\.lastPathComponent), ["Tiny Clip (2).srt"])

        let audio = try await SmartFinalize.deliver(input: source, recipe: .audioOnly)
        XCTAssertTrue(FileManager.default.fileExists(atPath: audio.primaryURL.path))
        XCTAssertEqual(audio.primaryURL.pathExtension, "m4a")
        XCTAssertTrue(audio.sidecarURLs.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
    }
}
