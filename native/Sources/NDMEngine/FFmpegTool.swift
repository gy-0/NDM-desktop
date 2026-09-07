import Foundation
import Darwin

/// Locates and runs the system ffmpeg for lossless finalize steps
/// (TS → MP4 remux, split A/V track mux). All operations are `-c copy` —
/// no re-encode, so they finish in seconds even for long videos.
public enum FFmpegTool {
    struct ProcessResult: Sendable {
        let terminationStatus: Int32
        let standardError: String
    }

    struct StreamPresence: Sendable, Equatable {
        let hasVideo: Bool
        let hasAudio: Bool
    }

    public static func find() -> String? {
        BundledToolLocator.find(
            ["ffmpeg"],
            developerFallbacks: ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]
        )
    }

    /// Read the container's declared streams without decoding the whole file.
    /// The bundled tool intentionally omits ffprobe, so use ffmpeg's input
    /// inspection output and keep the parser separately testable.
    static func streamPresence(
        ffmpeg: String,
        input: URL,
        cancelToken: CancelToken? = nil
    ) throws -> StreamPresence {
        let result = try runProcess(
            executable: ffmpeg,
            arguments: ["-hide_banner", "-nostdin", "-i", input.path],
            // A header read finishes in well under a second; cap it so a wedged
            // probe can never hold the whole finalize open, and let a pause /
            // cancel interrupt it immediately.
            timeout: 30,
            isCancelled: cancelToken.map { token in { @Sendable in token.isCancelled } }
        )
        let presence = parseStreamPresence(result.standardError)
        guard presence.hasVideo || presence.hasAudio else {
            throw EngineError.mergeFailed("Could not inspect downloaded media tracks")
        }
        return presence
    }

    static func parseStreamPresence(_ output: String) -> StreamPresence {
        var hasVideo = false
        var hasAudio = false
        for line in output.split(whereSeparator: \.isNewline) {
            guard line.contains("Stream #") else { continue }
            if line.range(of: #":\s*Video:"#, options: .regularExpression) != nil {
                hasVideo = true
            }
            if line.range(of: #":\s*Audio:"#, options: .regularExpression) != nil {
                hasAudio = true
            }
        }
        return StreamPresence(hasVideo: hasVideo, hasAudio: hasAudio)
    }

    /// Repackage a finished stream (usually MPEG-TS) into MP4 without re-encoding.
    /// `+faststart` moves the moov atom up front so the file streams/previews instantly.
    /// Throws `EngineError.mergeFailed` when the source codecs don't fit MP4 —
    /// callers fall back to keeping the original container.
    public static func remuxToMP4(ffmpeg: String, input: URL, output: URL) throws {
        try run(ffmpeg, [
            "-y", "-i", input.path,
            "-c", "copy",
            "-movflags", "+faststart",
            output.path,
        ], cleanupOnFailure: output)
    }

    /// Merge separate video + audio downloads into one container (stream copy).
    public static func muxAV(ffmpeg: String, video: URL, audio: URL, output: URL) throws {
        var args = [
            "-y", "-i", video.path, "-i", audio.path,
            "-c", "copy", "-map", "0:v:0", "-map", "1:a:0?",
        ]
        if output.pathExtension.lowercased() == "mp4" {
            args += ["-movflags", "+faststart"]
        }
        args.append(output.path)
        try run(ffmpeg, args, cleanupOnFailure: output)
    }

    /// Chat-friendly re-encode (H.264 + AAC). Used by Smart Finalize share presets.
    public static func transcodeShare(
        ffmpeg: String,
        input: URL,
        output: URL,
        crf _: String,
        maxrate: String
    ) throws {
        try run(ffmpeg, [
            "-y", "-i", input.path,
            "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", maxrate,
            "-maxrate", maxrate, "-bufsize", maxrate,
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            output.path,
        ], cleanupOnFailure: output)
    }

    /// A predictable H.264/AAC MP4 that plays in QuickTime, iPhone apps and
    /// mainstream chat clients. The source is never touched and smaller video
    /// is not intentionally enlarged beyond the 1080p delivery canvas.
    public static func transcodeMobileCompatible(ffmpeg: String, input: URL, output: URL) throws {
        try run(ffmpeg, mobileCompatibleArguments(input: input, output: output), cleanupOnFailure: output)
    }

    /// Extract the primary audio track as a broadly compatible AAC/M4A copy.
    public static func extractAudio(ffmpeg: String, input: URL, output: URL) throws {
        try run(ffmpeg, audioOnlyArguments(input: input, output: output), cleanupOnFailure: output)
    }

    /// Produce a chat-sized H.264 copy. Average bitrate is derived from the
    /// desired file size so a long video is not treated like a short clip.
    public static func transcodeChatFriendly(
        ffmpeg: String,
        input: URL,
        output: URL,
        targetBytes: Int64 = 25 * 1_024 * 1_024
    ) throws {
        let duration = try probeDuration(ffmpeg: ffmpeg, input: input)
        let videoKbps = targetVideoBitrateKbps(duration: duration, targetBytes: targetBytes)
        try run(
            ffmpeg,
            chatFriendlyArguments(input: input, output: output, videoKbps: videoKbps),
            cleanupOnFailure: output
        )
    }

    static func mobileCompatibleArguments(input: URL, output: URL) -> [String] {
        [
            "-n", "-i", input.path,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=min(1920\\,iw):min(1080\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
            "-c:v", "h264_videotoolbox", "-allow_sw", "1",
            "-b:v", "5M", "-maxrate", "8M", "-bufsize", "10M",
            "-c:a", "aac", "-b:a", "160k",
            "-movflags", "+faststart",
            output.path,
        ]
    }

    static func audioOnlyArguments(input: URL, output: URL) -> [String] {
        [
            "-n", "-i", input.path,
            "-map", "0:a:0", "-vn",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            output.path,
        ]
    }

    static func chatFriendlyArguments(input: URL, output: URL, videoKbps: Int) -> [String] {
        let rate = "\(videoKbps)k"
        return [
            "-n", "-i", input.path,
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", "scale=min(1280\\,iw):min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
            "-c:v", "h264_videotoolbox", "-allow_sw", "1", "-b:v", rate,
            "-maxrate", rate, "-bufsize", "\(videoKbps * 2)k",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            output.path,
        ]
    }

    static func targetVideoBitrateKbps(
        duration: Double,
        targetBytes: Int64,
        audioKbps: Int = 96
    ) -> Int {
        guard duration.isFinite, duration > 0, targetBytes > 0 else { return 1_200 }
        let totalKbps = Double(targetBytes) * 8 / duration / 1_000
        // Leave room for audio and container overhead. Extremely long videos
        // keep a minimum watchable bitrate even if that means exceeding 25 MB.
        return min(2_500, max(220, Int(totalKbps - Double(audioKbps) - 24)))
    }

    private static func probeDuration(ffmpeg: String, input: URL) throws -> Double {
        let result = try runProcess(
            executable: ffmpeg,
            arguments: ["-hide_banner", "-nostdin", "-i", input.path],
            timeout: 30
        )
        let text = result.standardError
        let pattern = #"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges == 4,
              let hoursRange = Range(match.range(at: 1), in: text),
              let minutesRange = Range(match.range(at: 2), in: text),
              let secondsRange = Range(match.range(at: 3), in: text),
              let hours = Double(text[hoursRange]),
              let minutes = Double(text[minutesRange]),
              let seconds = Double(text[secondsRange]) else {
            throw EngineError.mergeFailed("Could not read media duration")
        }
        return hours * 3_600 + minutes * 60 + seconds
    }

    /// Whether a delivered file actually carries audio.
    ///
    /// `muxAV` maps audio as `1:a:0?` — optional — so a broken or misrouted audio
    /// rendition produces a silent video and no error. Asking the finished file is
    /// the only truthful answer: it describes what was delivered rather than what
    /// was attempted. Returns nil when the file cannot be inspected at all, so a
    /// probe failure is never mistaken for confirmed silence.
    static func deliveredAudioPresence(ffmpeg: String, output: URL) -> Bool? {
        guard FileManager.default.fileExists(atPath: output.path) else { return nil }
        guard let presence = try? streamPresence(ffmpeg: ffmpeg, input: output) else {
            return nil
        }
        return presence.hasAudio
    }

    private static func run(_ ffmpeg: String, _ args: [String], cleanupOnFailure: URL?) throws {
        if let output = cleanupOnFailure, FileManager.default.fileExists(atPath: output.path) {
            try FileManager.default.removeItem(at: output)
        }
        let result: ProcessResult
        do {
            result = try runProcess(executable: ffmpeg, arguments: args)
        } catch {
            if let output = cleanupOnFailure {
                try? FileManager.default.removeItem(at: output)
            }
            throw error
        }
        guard result.terminationStatus == 0 else {
            // A failed run may leave a truncated output file behind.
            if let output = cleanupOnFailure {
                try? FileManager.default.removeItem(at: output)
            }
            let message = result.standardError
                .split(separator: "\n").last.map(String.init) ?? "ffmpeg failed"
            throw EngineError.mergeFailed(message)
        }
    }

    /// Run a media subprocess without a bounded pipe. FFmpeg continuously
    /// writes progress to stderr; waiting before reading can otherwise fill the
    /// pipe and deadlock a long export. A temporary file keeps output bounded by
    /// disk instead, while polling lets Swift task cancellation stop the child.
    static func runProcess(
        executable: String,
        arguments: [String],
        timeout: TimeInterval? = nil,
        isCancelled: (@Sendable () -> Bool)? = nil
    ) throws -> ProcessResult {
        let errorURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ffmpeg-\(UUID().uuidString).log")
        guard FileManager.default.createFile(atPath: errorURL.path, contents: nil) else {
            throw EngineError.mergeFailed("Could not create the media process log")
        }
        let errorHandle = try FileHandle(forWritingTo: errorURL)
        defer {
            try? errorHandle.close()
            try? FileManager.default.removeItem(at: errorURL)
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardError = errorHandle
        process.standardOutput = FileHandle.nullDevice
        // Detach stdin from any inherited controlling terminal. When NDM is
        // launched from a shell (`swift run`), an ffmpeg child that reads the
        // TTY lands in a background process group and the kernel stops it with
        // SIGTTIN/SIGTTOU (state "T") — `runProcess` then waits forever on a
        // process that will never exit. A null stdin gives ffmpeg an immediate
        // EOF and no terminal to touch. See `-nostdin` on probe calls too.
        process.standardInput = FileHandle.nullDevice
        try process.run()

        let startedAt = Date()
        func stop() {
            // SIGCONT first: a process stopped by the terminal (SIGTTIN/SIGTTOU,
            // state "T") ignores SIGTERM until resumed. Continue it, ask it to
            // terminate, then hard-kill if it lingers.
            _ = Darwin.kill(process.processIdentifier, SIGCONT)
            process.terminate()
            let deadline = Date().addingTimeInterval(1)
            while process.isRunning, Date() < deadline {
                Thread.sleep(forTimeInterval: 0.02)
            }
            if process.isRunning {
                _ = Darwin.kill(process.processIdentifier, SIGKILL)
            }
            process.waitUntilExit()
        }

        while process.isRunning {
            let taskCancelled = withUnsafeCurrentTask { $0?.isCancelled ?? false }
            let externallyCancelled = isCancelled?() ?? false
            if taskCancelled || externallyCancelled {
                stop()
                throw CancellationError()
            }
            if let timeout, Date().timeIntervalSince(startedAt) > timeout {
                stop()
                throw EngineError.mergeFailed(
                    "The media component did not respond in time and was stopped."
                )
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        process.waitUntilExit()
        try? errorHandle.synchronize()
        let data = (try? Data(contentsOf: errorURL)) ?? Data()
        return ProcessResult(
            terminationStatus: process.terminationStatus,
            standardError: String(data: data, encoding: .utf8) ?? ""
        )
    }
}
