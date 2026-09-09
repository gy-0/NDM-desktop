import AVFoundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class FragmentedMP4CaptureTests: XCTestCase {
    func testLiveMasterRetainsInitializationAndSeparateAudioWhenStopped() async throws {
        guard let ffmpeg = FFmpegTool.find() else { throw XCTSkip("ffmpeg unavailable") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-fmp4-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        // Real fMP4 video and audio renditions, like the Apple Event stream.
        for track in ["video", "audio"] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: ffmpeg)
            var args = ["-v", "error", "-y", "-f", "lavfi", "-i"]
            args += track == "video" ? ["color=size=128x72:rate=10", "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-g", "10"] : ["sine=frequency=440", "-c:a", "aac"]
            if track == "video" { args += ["-output_ts_offset", "6"] }
            args += ["-t", track == "video" ? "3" : "9", "-f", "hls", "-hls_time", "1", "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "\(track)-init.mp4", root.appendingPathComponent("\(track).m3u8").path]
            process.arguments = args
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
        }
        var files: [String: Data] = [:]
        for url in try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            var data = try Data(contentsOf: url)
            if url.pathExtension == "m3u8" {
                data = Data(String(decoding: data, as: UTF8.self).replacingOccurrences(of: "#EXT-X-ENDLIST", with: "").utf8)
            }
            files["nested/" + url.lastPathComponent] = data
        }
        files["master.m3u8"] = Data("""
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="nested/audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a"
        nested/video.m3u8
        """.utf8)
        let server = LocalHLSServer(files: files)
        try server.start()
        defer { server.stop() }
        let engine = HLSEngine(taskID: 1, request: DownloadRequest(url: server.url(path: "master.m3u8"), destinationDirectory: root.appendingPathComponent("out")), workDirectory: root.appendingPathComponent("work"))
        let run = Task { try await engine.start() }
        for _ in 0..<100 {
            if await engine.currentProgress().recordedDuration >= 3 { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        // Allow the separate audio rendition to finish this same window.
        try await Task.sleep(nanoseconds: 300_000_000)
        let progress = await engine.currentProgress()
        XCTAssertTrue(progress.isLiveRecording)
        XCTAssertEqual(progress.totalBytes, 0)
        XCTAssertEqual(progress.fractionCompleted, 0)
        XCTAssertGreaterThanOrEqual(progress.recordedDuration, 3)
        await engine.pause()
        let output = try await run.value
        XCTAssertEqual(output.pathExtension, "mp4")
        let asset = AVURLAsset(url: output)
        let videos = try await asset.loadTracks(withMediaType: .video)
        let audios = try await asset.loadTracks(withMediaType: .audio)
        let duration = try await asset.load(.duration)
        XCTAssertFalse(videos.isEmpty)
        XCTAssertFalse(audios.isEmpty)
        XCTAssertGreaterThan(CMTimeGetSeconds(duration), 2)
        XCTAssertLessThan(CMTimeGetSeconds(duration), 4, "Audio and video windows must be aligned before muxing")
        let final = await engine.currentProgress()
        XCTAssertEqual(final.status, .complete)
    }
}
