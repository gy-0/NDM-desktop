import XCTest
@testable import NDMEngine

final class MediaStreamValidationTests: XCTestCase {
    func testParsesSeparateVideoAndAudioStreams() {
        let output = """
          Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080
          Stream #0:1[0x2](und): Audio: aac (LC), 48000 Hz, stereo
        """

        XCTAssertEqual(
            FFmpegTool.parseStreamPresence(output),
            .init(hasVideo: true, hasAudio: true)
        )
    }

    func testDetectsSilentVideo() {
        let output = """
          Stream #0:0: Video: h264 (Main), yuv420p, 1280x720
        """

        XCTAssertEqual(
            FFmpegTool.parseStreamPresence(output),
            .init(hasVideo: true, hasAudio: false)
        )
    }

    func testSelectorAudioExpectation() {
        XCTAssertTrue(YtDlpTool.selectorExpectsAudio("bestvideo[height<=1080]+bestaudio/best"))
        XCTAssertTrue(YtDlpTool.selectorExpectsAudio("401+140"))
        XCTAssertFalse(YtDlpTool.selectorExpectsAudio("best"))
        XCTAssertFalse(YtDlpTool.selectorExpectsAudio("hls-817"))
    }

    func testOnlyExplicitBundledPluginDirectoryIsEnabled() throws {
        let resources = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-plugin-args-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: resources) }

        XCTAssertEqual(
            YtDlpTool.pluginArguments(resourceURL: resources),
            ["--no-plugin-dirs"]
        )

        let plugins = resources.appendingPathComponent("yt-dlp-plugins", isDirectory: true)
        try FileManager.default.createDirectory(at: plugins, withIntermediateDirectories: true)
        XCTAssertEqual(
            YtDlpTool.pluginArguments(resourceURL: resources),
            ["--no-plugin-dirs", "--plugin-dirs", plugins.path]
        )
    }

    func testBundledFFmpegDistinguishesAudibleAndSilentFiles() throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg unavailable")
        }
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-stream-validation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        let audible = folder.appendingPathComponent("audible.mp4")
        let silent = folder.appendingPathComponent("silent.mp4")
        let audibleResult = try FFmpegTool.runProcess(executable: ffmpeg, arguments: [
            "-y",
            "-f", "lavfi", "-i", "color=black:size=32x32:duration=0.1",
            "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
            "-t", "0.1", "-c:v", "mpeg4", "-c:a", "aac", audible.path,
        ])
        let silentResult = try FFmpegTool.runProcess(executable: ffmpeg, arguments: [
            "-y", "-f", "lavfi", "-i", "color=black:size=32x32:duration=0.1",
            "-c:v", "mpeg4", silent.path,
        ])
        guard audibleResult.terminationStatus == 0, silentResult.terminationStatus == 0 else {
            throw XCTSkip("local ffmpeg cannot create media fixtures")
        }

        XCTAssertEqual(
            try FFmpegTool.streamPresence(ffmpeg: ffmpeg, input: audible),
            .init(hasVideo: true, hasAudio: true)
        )
        XCTAssertEqual(
            try FFmpegTool.streamPresence(ffmpeg: ffmpeg, input: silent),
            .init(hasVideo: true, hasAudio: false)
        )
    }
}
