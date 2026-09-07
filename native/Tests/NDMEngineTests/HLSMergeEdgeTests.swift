import AVFoundation
import XCTest
@testable import NDMEngine
@testable import NDMCore

/// Edge behaviour of the HLS merge and mux path, verified against real media
/// rather than reasoned about. Playability is checked with AVFoundation because
/// that is what "it opens on a Mac" actually means, and it needs no third-party
/// probe binary.
final class HLSMergeEdgeTests: XCTestCase {
    // MARK: - Real media helpers

    /// A genuine H.264+AAC MPEG-TS clip. `startSeconds` shifts the timestamp base
    /// so two clips can be concatenated into a stream with a real discontinuity.
    private func makeTS(
        ffmpeg: String,
        seconds: Double,
        startSeconds: Double = 0,
        frequency: Int = 440,
        withAudio: Bool = true
    ) throws -> Data {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-edge-\(UUID().uuidString).ts")
        defer { try? FileManager.default.removeItem(at: url) }

        var args = [
            "-y",
            "-f", "lavfi", "-i", "testsrc=duration=\(seconds):size=128x72:rate=10",
        ]
        if withAudio {
            args += ["-f", "lavfi", "-i", "sine=frequency=\(frequency):duration=\(seconds)"]
        }
        args += ["-c:v", "h264_videotoolbox", "-allow_sw", "1"]
        if withAudio { args += ["-c:a", "aac"] }
        if startSeconds > 0 {
            args += ["-output_ts_offset", "\(startSeconds)"]
        }
        args += ["-f", "mpegts", url.path]

        let process = Process()
        process.executableURL = URL(fileURLWithPath: ffmpeg)
        process.arguments = args
        process.standardError = Pipe()
        process.standardOutput = Pipe()
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0,
              let data = try? Data(contentsOf: url), !data.isEmpty else {
            throw XCTSkip("local ffmpeg cannot encode the test stream (VideoToolbox H.264/AAC)")
        }
        return data
    }

    private struct MediaInfo {
        var seconds: Double
        var hasVideo: Bool
        var hasAudio: Bool
        /// Set when AVFoundation refused the file. Note AVFoundation cannot open
        /// raw MPEG-TS at all, so a `.ts` fallback lands here legitimately — the
        /// ffmpeg probe below distinguishes "unplayable on a Mac" from "broken".
        var avError: String?
    }

    private func inspect(_ url: URL) async -> MediaInfo {
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let video = try await asset.loadTracks(withMediaType: .video)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            return MediaInfo(
                seconds: CMTimeGetSeconds(duration),
                hasVideo: !video.isEmpty,
                hasAudio: !audio.isEmpty
            )
        } catch {
            var info = ffmpegProbe(url)
            info.avError = "\(error)"
            return info
        }
    }

    /// Fallback probe via ffmpeg's own stderr report, for containers AVFoundation
    /// will not open.
    private func ffmpegProbe(_ url: URL) -> MediaInfo {
        guard let ffmpeg = FFmpegTool.find() else {
            return MediaInfo(seconds: 0, hasVideo: false, hasAudio: false)
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: ffmpeg)
        process.arguments = ["-hide_banner", "-i", url.path]
        let pipe = Pipe()
        process.standardError = pipe
        process.standardOutput = Pipe()
        guard (try? process.run()) != nil else {
            return MediaInfo(seconds: 0, hasVideo: false, hasAudio: false)
        }
        let text = String(
            data: pipe.fileHandleForReading.readDataToEndOfFile(),
            encoding: .utf8
        ) ?? ""
        process.waitUntilExit()

        var seconds = 0.0
        if let match = text.range(of: #"Duration: (\d+):(\d\d):(\d\d\.\d+)"#, options: .regularExpression) {
            let parts = text[match]
                .replacingOccurrences(of: "Duration: ", with: "")
                .split(separator: ":")
                .compactMap { Double($0) }
            if parts.count == 3 {
                seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
            }
        }
        return MediaInfo(
            seconds: seconds,
            hasVideo: text.contains("Video:"),
            hasAudio: text.contains("Audio:")
        )
    }

    private func makeManager() throws -> (DownloadManager, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hlsedge-\(UUID().uuidString)", isDirectory: true)
        let support = root.appendingPathComponent("support", isDirectory: true)
        let dest = root.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(
            downloadDirectory: dest,
            maxConnections: 2,
            useCategoryFolders: false
        )
        return (DownloadManager(store: store, settings: settings, supportRoot: support), dest)
    }

    private func deliveredURL(
        _ manager: DownloadManager,
        _ taskID: Int64,
        _ dest: URL
    ) async throws -> URL {
        let fetched = try await manager.task(id: taskID)
        let done = try XCTUnwrap(fetched)
        XCTAssertEqual(done.status, .complete)
        return dest.appendingPathComponent(done.filename)
    }

    // MARK: - EXT-X-DISCONTINUITY

    /// `#EXT-X-DISCONTINUITY` is not parsed anywhere in this repository. That is
    /// only acceptable if concatenating across the marker still yields a playable
    /// file of the right length, so this measures it instead of assuming. Two
    /// clips are encoded with different timestamp bases, which is exactly the
    /// condition the marker announces.
    func testDiscontinuityAcrossTimestampBasesStillDeliversFullLength() async throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg not installed; the remux path is not exercisable")
        }
        let first = try makeTS(ffmpeg: ffmpeg, seconds: 1, startSeconds: 0)
        let second = try makeTS(ffmpeg: ffmpeg, seconds: 1, startSeconds: 900, frequency: 880)

        let playlist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:2
        #EXTINF:1.0,
        a.ts
        #EXT-X-DISCONTINUITY
        #EXTINF:1.0,
        b.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "disc.m3u8": Data(playlist.utf8),
            "a.ts": first,
            "b.ts": second,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "disc.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)
        let output = try await deliveredURL(manager, task.id, dest)

        let info = await inspect(output)
        XCTAssertNil(
            info.avError,
            "the delivered file must open on a Mac; got \(output.lastPathComponent)"
        )
        XCTAssertFalse(
            ["m3u8", "m3u", "mpd", ""].contains(output.pathExtension.lowercased()),
            "a playlist extension (or none) hides a real container: \(output.lastPathComponent)"
        )
        XCTAssertTrue(info.hasVideo, "the delivered file must carry video")
        XCTAssertGreaterThan(
            info.seconds,
            1.5,
            "both sides of the discontinuity must survive; got \(info.seconds)s"
        )
    }

    // MARK: - Separate audio rendition

    /// The mux maps audio as `1:a:0?` — optional. If the audio rendition arrives
    /// without a decodable audio stream, an optional map means a silent video is
    /// delivered as a success. Measures what actually happens.
    func testSeparateAudioRenditionWithoutAnAudioStream() async throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg not installed; the mux path is not exercisable")
        }
        let video = try makeTS(ffmpeg: ffmpeg, seconds: 1, withAudio: false)
        // The "audio" rendition is video-only: the shape a broken or misrouted
        // audio rendition takes in the wild.
        let brokenAudio = try makeTS(ffmpeg: ffmpeg, seconds: 1, withAudio: false)

        let master = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"
        video.m3u8
        """
        let videoMedia = """
        #EXTM3U
        #EXTINF:1.0,
        v.ts
        #EXT-X-ENDLIST
        """
        let audioMedia = """
        #EXTM3U
        #EXTINF:1.0,
        a.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "master.m3u8": Data(master.utf8),
            "video.m3u8": Data(videoMedia.utf8),
            "audio.m3u8": Data(audioMedia.utf8),
            "v.ts": video,
            "a.ts": brokenAudio,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "master.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)
        let output = try await deliveredURL(manager, task.id, dest)

        let info = await inspect(output)
        XCTAssertNil(
            info.avError,
            "the delivered file must open on a Mac; got \(output.lastPathComponent)"
        )
        XCTAssertFalse(
            ["m3u8", "m3u", "mpd", ""].contains(output.pathExtension.lowercased()),
            "a playlist extension (or none) hides a real container: \(output.lastPathComponent)"
        )
        XCTAssertTrue(info.hasVideo)
        // The video is still delivered — it is what the site offered, and a hard
        // failure would leave the user with nothing. But it must not be presented
        // as a clean success, so the silence is recorded on the task.
        XCTAssertFalse(info.hasAudio)
        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertEqual(
            DeliveryNote(storageKey: done.deliveryNote),
            .audioTrackMissing,
            "a silent delivery must be recorded, not passed off as complete"
        )
    }

    /// A separate audio rendition much shorter than the video is the signature of
    /// a truncated audio download. Measures whether the delivered file is honest
    /// about its length or silently out of sync.
    func testSeparateAudioShorterThanVideoIsMeasured() async throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg not installed; the mux path is not exercisable")
        }
        let video = try makeTS(ffmpeg: ffmpeg, seconds: 3, withAudio: false)
        let shortAudio = try makeTS(ffmpeg: ffmpeg, seconds: 1)

        let master = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"
        video.m3u8
        """
        let videoMedia = """
        #EXTM3U
        #EXTINF:3.0,
        v.ts
        #EXT-X-ENDLIST
        """
        let audioMedia = """
        #EXTM3U
        #EXTINF:1.0,
        a.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "master.m3u8": Data(master.utf8),
            "video.m3u8": Data(videoMedia.utf8),
            "audio.m3u8": Data(audioMedia.utf8),
            "v.ts": video,
            "a.ts": shortAudio,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "master.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)
        let output = try await deliveredURL(manager, task.id, dest)

        let info = await inspect(output)
        XCTAssertNil(
            info.avError,
            "the delivered file must open on a Mac; got \(output.lastPathComponent)"
        )
        XCTAssertFalse(
            ["m3u8", "m3u", "mpd", ""].contains(output.pathExtension.lowercased()),
            "a playlist extension (or none) hides a real container: \(output.lastPathComponent)"
        )
        XCTAssertTrue(info.hasVideo)
        XCTAssertGreaterThan(
            info.seconds,
            2.0,
            "the video must not be truncated to the short audio track; got \(info.seconds)s"
        )
        XCTAssertTrue(info.hasAudio, "the short audio track must still be present")
        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertNil(
            done.deliveryNote,
            "audio that is merely short is not missing; no note belongs here"
        )
    }
}
