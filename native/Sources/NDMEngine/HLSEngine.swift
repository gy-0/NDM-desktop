import Foundation
import CommonCrypto
import NDMCore

/// HLS path: fetch master/media m3u8 → download TS segments → concat to one `.ts` file.
/// Aligns with original `hlsMode` / `NeatSocketHlsMaster` behaviour (download all TS then merge).
public actor HLSEngine {
    public private(set) var progress: DownloadProgress

    private let request: DownloadRequest
    private let taskID: Int64
    private let workDirectory: URL
    private let session: URLSession
    private let token = CancelToken()
    private var logHandle: FileHandle?
    private var liveLimits = LiveLimits.default

    public init(
        taskID: Int64,
        request: DownloadRequest,
        workDirectory: URL,
        httpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil
    ) {
        self.taskID = taskID
        self.request = request
        self.workDirectory = workDirectory
        self.progress = DownloadProgress(taskID: taskID, status: .waiting)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        if let socks = socksProxy, socks.enabled, !socks.host.isEmpty {
            var dict: [AnyHashable: Any] = [
                kCFStreamPropertySOCKSProxyHost as String: socks.host,
                kCFStreamPropertySOCKSProxyPort as String: NSNumber(value: socks.port),
                kCFStreamPropertySOCKSVersion as String: socks.version == .v4
                    ? kCFStreamSocketSOCKSVersion4 : kCFStreamSocketSOCKSVersion5,
            ]
            if let u = socks.username { dict[kCFStreamPropertySOCKSUser as String] = u }
            if let p = socks.password { dict[kCFStreamPropertySOCKSPassword as String] = p }
            config.connectionProxyDictionary = dict
        } else if let proxy = httpProxy, proxy.enabled, !proxy.host.isEmpty {
            config.connectionProxyDictionary = [
                kCFNetworkProxiesHTTPEnable as String: true,
                kCFNetworkProxiesHTTPProxy as String: proxy.host,
                kCFNetworkProxiesHTTPPort as String: NSNumber(value: proxy.port),
                kCFNetworkProxiesHTTPSEnable as String: true,
                kCFNetworkProxiesHTTPSProxy as String: proxy.host,
                kCFNetworkProxiesHTTPSPort as String: NSNumber(value: proxy.port),
            ]
        }
        self.session = URLSession(configuration: config)
    }

    public func pause() {
        token.pause()
        progress.status = .paused
        log("HLS engine paused")
    }

    public func cancel() {
        token.cancel()
        session.invalidateAndCancel()
        progress.status = .incomplete
        log("HLS Download Canceled By User.")
    }

    public func currentProgress() -> DownloadProgress { progress }

    @discardableResult
    public func start() async throws -> URL {
        guard !Task.isCancelled else { throw EngineError.cancelled }
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        token.reset()
        openLog()
        progress.status = .downloading
        progress.phase = .preparing
        progress.currentConnections = 1
        log("DownloadID = \(taskID) , Protocol = HLS , OS = MAC")
        log("Trying to Start HLS Download for -> \(request.url.absoluteString)")

        let streams = try await resolveMediaPlaylist(startingAt: request.url)
        let media = streams.video
        log("TS-Mode Sockets Created. hlsSegmentsCount = \(media.segments.count)")

        let audioCount = streams.audio?.segments.count ?? 0
        let totalSegmentCount = media.segments.count + audioCount
        var videoTransferSizes = Array<Int64?>(repeating: nil, count: media.segments.count)
        var audioTransferSizes = Array<Int64?>(repeating: nil, count: audioCount)

        if media.endList {
            // A VOD playlist rarely declares its aggregate byte size. Ask each
            // segment for Content-Length so `totalBytes` stays a byte count instead
            // of abusing the field for a segment count. Origins that reject HEAD
            // simply keep an unknown total; completed bytes remain truthful.
            let segmentsRequiringProbe = media.segments.filter { $0.byteRange == nil }.count
                + (streams.audio?.segments.filter { $0.byteRange == nil }.count ?? 0)
            if segmentsRequiringProbe <= 256 {
                videoTransferSizes = await probeTransferSizes(for: media)
                if let audio = streams.audio {
                    audioTransferSizes = await probeTransferSizes(for: audio)
                }
            } else {
                log("Skipping HLS size preflight for \(segmentsRequiringProbe) segment URLs; total size remains unknown")
            }
            let allSizes = videoTransferSizes + audioTransferSizes
            progress.totalBytes = Self.knownTotal(of: allSizes) ?? 0
            progress.completedBytes = 0
            progress.journeyFraction = progress.totalBytes > 0 ? nil : 0
            progress.segmentStates = (0..<totalSegmentCount).map {
                SegmentState(id: $0, start: 0, end: 0, completed: 0, isFinished: false)
            }
        } else {
            progress.totalBytes = 0
            progress.completedBytes = 0
            progress.journeyFraction = nil
            progress.segmentStates = []
        }
        progress.phase = .transferring

        let tsDir = workDirectory.appendingPathComponent("ts", isDirectory: true)
        try FileManager.default.createDirectory(at: tsDir, withIntermediateDirectories: true)

        var completedSegments = 0
        var completedBytes: Int64 = 0
        // A playlist without #EXT-X-ENDLIST is a live stream: what we just fetched is a
        // sliding window, not the whole thing. Downloading it once would hand the user
        // the last thirty seconds and call it done — which is what this engine did until
        // now, silently.
        var capturedSegmentCount: Int?
        if !media.endList {
            capturedSegmentCount = try await captureLive(startingFrom: media, into: tsDir)
        } else {
            try await downloadSegments(
                media,
                into: tsDir,
                label: "TS",
                expectedSizes: videoTransferSizes,
                stateOffset: 0,
                totalSegmentCount: totalSegmentCount,
                completedSegments: &completedSegments,
                completedBytes: &completedBytes
            )
        }

        // Separate audio rendition: download its segments too.
        var audioMergedURL: URL?
        if capturedSegmentCount == nil, let audio = streams.audio, !audio.segments.isEmpty {
            let audioDir = workDirectory.appendingPathComponent("audio", isDirectory: true)
            try FileManager.default.createDirectory(at: audioDir, withIntermediateDirectories: true)
            try await downloadSegments(
                audio,
                into: audioDir,
                label: "Audio",
                expectedSizes: audioTransferSizes,
                stateOffset: media.segments.count,
                totalSegmentCount: totalSegmentCount,
                completedSegments: &completedSegments,
                completedBytes: &completedBytes
            )
            let merged = workDirectory.appendingPathComponent("audio.ts")
            try mergeTS(count: audio.segments.count, from: audioDir, to: merged)
            audioMergedURL = merged
        }

        log("DownloadEngine State Changed : Downloading... -> Merging...")
        progress.phase = .merging
        let filename = outputFilename()
        try FileManager.default.createDirectory(
            at: request.destinationDirectory,
            withIntermediateDirectories: true
        )

        // Merge in the work directory first, then finalize into the destination.
        let mergedURL = workDirectory.appendingPathComponent("merged.ts")
        try mergeTS(count: capturedSegmentCount ?? media.segments.count, from: tsDir, to: mergedURL)

        // "下完就是能播的 MP4": lossless remux by default when ffmpeg is present.
        // Fake/broken streams (or exotic codecs) fail fast → keep the TS as-is.
        var finalURL = request.destinationDirectory.appendingPathComponent(filename)
        if let ffmpeg = FFmpegTool.find() {
            let mp4URL = request.destinationDirectory
                .appendingPathComponent((filename as NSString).deletingPathExtension)
                .appendingPathExtension("mp4")
            do {
                if let audioMergedURL {
                    // Mux the separate video + audio streams into one MP4.
                    try FFmpegTool.muxAV(ffmpeg: ffmpeg, video: mergedURL, audio: audioMergedURL, output: mp4URL)
                    try? FileManager.default.removeItem(at: audioMergedURL)
                    log("Muxed HLS video + separate audio -> MP4 (stream copy)")
                    // An audio rendition was fetched on purpose, so a silent result
                    // is not a clean success. Keep the video — it is what the site
                    // offered — but record the fact so the user is told rather than
                    // left to discover it on playback.
                    if FFmpegTool.deliveredAudioPresence(ffmpeg: ffmpeg, output: mp4URL) == false {
                        progress.deliveryNote = .audioTrackMissing
                        log("Separate audio rendition produced no audio track; delivering video only")
                    }
                } else {
                    try FFmpegTool.remuxToMP4(ffmpeg: ffmpeg, input: mergedURL, output: mp4URL)
                    log("Remuxed TS -> MP4 (stream copy, faststart)")
                }
                finalURL = mp4URL
                try? FileManager.default.removeItem(at: mergedURL)
            } catch {
                log("MP4 remux/mux unavailable for this stream; keeping TS. \(error.localizedDescription)")
                finalURL = Self.tsFallbackURL(for: finalURL)
                try Self.replaceItem(at: finalURL, with: mergedURL)
            }
        } else {
            // Without ffmpeg a separate audio track can't be muxed; the video
            // TS is at least playable (silent). Logged so it's diagnosable.
            log("ffmpeg not found; keeping TS output\(audioMergedURL != nil ? " (audio track could not be muxed)" : "")")
            finalURL = Self.tsFallbackURL(for: finalURL)
            try Self.replaceItem(at: finalURL, with: mergedURL)
        }

        progress.status = .complete
        let size = (try? FileManager.default.attributesOfItem(atPath: finalURL.path)[.size] as? NSNumber)?.int64Value ?? 0
        progress.totalBytes = size
        progress.completedBytes = size
        progress.journeyFraction = 1
        log("DownloadEngine State Changed : Merging... -> Completed")
        closeLog()
        return finalURL
    }

    // MARK: - Live capture

    /// Ceilings on an inherently unbounded recording.
    ///
    /// A live stream has no end, so something has to stop it. These are safety rails,
    /// not a feature: without them a forgotten capture fills the disk.
    public struct LiveLimits: Sendable, Equatable {
        public var maximumDuration: TimeInterval
        public var maximumBytes: Int64

        public init(
            maximumDuration: TimeInterval = 4 * 3600,
            maximumBytes: Int64 = 8 * 1024 * 1024 * 1024
        ) {
            self.maximumDuration = maximumDuration
            self.maximumBytes = maximumBytes
        }

        public static let `default` = LiveLimits()
    }

    public func setLiveLimits(_ limits: LiveLimits) {
        liveLimits = limits
    }

    /// Follow a rolling playlist until it ends, the user stops it, or a limit is hit.
    ///
    /// Returns the number of segments written, which is what the merge needs — the
    /// playlist's own count is meaningless here, since it only ever describes the
    /// current window.
    private func captureLive(
        startingFrom first: HLSPlaylist.Media,
        into dir: URL
    ) async throws -> Int {
        log("Playlist has no #EXT-X-ENDLIST: capturing a live stream.")
        var tracker = LiveSegmentTracker()
        var media = first
        var bytesWritten: Int64 = 0
        let startedAt = Date()
        var keyCache: [String: Data] = [:]

        while true {
            if token.isCancelled {
                // Stopping a live capture is the normal way it ends, not a failure —
                // but pausing one is meaningless, since the missed span can never be
                // recovered. Both keep what was captured.
                log("Live capture stopped by user after \(tracker.takenCount) segment(s).")
                break
            }

            for pending in tracker.absorb(media) {
                if token.isCancelled { break }
                guard let segmentURL = HLSPlaylist.resolveURL(
                    pending.segment.uri,
                    against: request.url
                ) else {
                    throw HLSError.unresolvedURL(pending.segment.uri)
                }
                var data = try await fetchData(segmentURL, byteRange: pending.segment.byteRange)
                if let key = pending.segment.key, key.isAES128 {
                    data = try Self.decryptAES128(
                        data,
                        key: try await liveKeyData(for: key, cache: &keyCache),
                        iv: Self.ivData(hex: key.ivHex, mediaSequence: pending.sequence)
                    )
                }
                let partURL = dir.appendingPathComponent(
                    String(format: "seg_%05d.ts", pending.outputIndex)
                )
                try data.write(to: partURL, options: .atomic)
                tracker.commit(pending)
                bytesWritten += Int64(data.count)
                // Bytes are the honest measure while recording: there is no total to be
                // a fraction of, so reporting a percentage would mean inventing one.
                progress.completedBytes = bytesWritten
                progress.totalBytes = bytesWritten
            }

            if media.endList {
                log("Stream ended (#EXT-X-ENDLIST) after \(tracker.takenCount) segment(s).")
                break
            }
            if Date().timeIntervalSince(startedAt) >= liveLimits.maximumDuration {
                log("Live capture reached its time limit after \(tracker.takenCount) segment(s).")
                break
            }
            if bytesWritten >= liveLimits.maximumBytes {
                log("Live capture reached its size limit at \(bytesWritten) bytes.")
                break
            }
            if token.isCancelled { break }

            let delay = LiveSegmentTracker.refreshDelay(targetDuration: media.targetDuration)
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if token.isCancelled { break }

            // Refetch the playlist. A refresh that fails is not fatal: a live stream
            // hiccups, and giving up on one bad response would throw away the rest of
            // the recording.
            do {
                let text = try await fetchText(request.url)
                if case .media(let refreshed) = try HLSPlaylist.parse(text) {
                    media = absolutize(refreshed, base: request.url)
                }
            } catch {
                log("Playlist refresh failed, retrying: \(error.localizedDescription)")
            }
        }

        if tracker.missedSegmentCount > 0 {
            // Said out loud rather than hidden: the recording has holes because the
            // window slid past while we were behind.
            log("Live capture missed \(tracker.missedSegmentCount) segment(s); the recording has gaps.")
        }
        guard tracker.takenCount > 0 else {
            throw EngineError.invalidResponse
        }
        return tracker.takenCount
    }

    /// Key fetch with a cache shared across refreshes, since a live stream rotates keys
    /// over hours and re-fetching the same one every few seconds would be wasteful.
    private func liveKeyData(
        for key: HLSPlaylist.EncryptionKey,
        cache: inout [String: Data]
    ) async throws -> Data {
        guard let uri = key.uri,
              let keyURL = HLSPlaylist.resolveURL(uri, against: request.url) else {
            throw HLSError.missingKey
        }
        if let cached = cache[keyURL.absoluteString] { return cached }
        let data = try await fetchData(keyURL)
        cache[keyURL.absoluteString] = data
        return data
    }

    /// Download every segment of one media playlist into `dir` (seg_%05d.ts),
    /// decrypting AES-128 when present, advancing shared progress.
    private func downloadSegments(
        _ media: HLSPlaylist.Media,
        into dir: URL,
        label: String,
        expectedSizes: [Int64?],
        stateOffset: Int,
        totalSegmentCount: Int,
        completedSegments: inout Int,
        completedBytes: inout Int64
    ) async throws {
        // Keys are per segment because playlists rotate them, but the same URI is
        // usually shared by a long run of segments — fetch each one once.
        var keyCache: [String: Data] = [:]
        func keyData(for key: HLSPlaylist.EncryptionKey) async throws -> Data {
            guard let uri = key.uri,
                  let keyURL = HLSPlaylist.resolveURL(uri, against: request.url) else {
                throw HLSError.missingKey
            }
            if let cached = keyCache[keyURL.absoluteString] { return cached }
            let data = try await fetchData(keyURL)
            keyCache[keyURL.absoluteString] = data
            log("Loaded AES-128 key for \(label) (\(data.count) bytes)")
            return data
        }

        for (index, seg) in media.segments.enumerated() {
            if token.isCancelled {
                if token.isPaused { throw EngineError.paused }
                throw EngineError.cancelled
            }
            let partURL = dir.appendingPathComponent(String(format: "seg_%05d.ts", index))
            if FileManager.default.fileExists(atPath: partURL.path),
               let attrs = try? FileManager.default.attributesOfItem(atPath: partURL.path),
               let size = (attrs[.size] as? NSNumber)?.intValue, size > 0 {
                completedSegments += 1
                let expectedSize = expectedSizes.indices.contains(index) ? expectedSizes[index] : nil
                completedBytes += expectedSize ?? Int64(size)
                updateVODProgress(
                    stateIndex: stateOffset + index,
                    completedSegments: completedSegments,
                    totalSegmentCount: totalSegmentCount,
                    completedBytes: completedBytes
                )
                continue
            }
            guard let segURL = HLSPlaylist.resolveURL(seg.uri, against: request.url) else {
                throw HLSError.unresolvedURL(seg.uri)
            }
            var data = try await fetchData(segURL, byteRange: seg.byteRange)
            let transferredBytes = Int64(data.count)
            if let key = seg.key, key.isAES128 {
                let iv = Self.ivData(hex: key.ivHex, mediaSequence: seg.id)
                data = try Self.decryptAES128(data, key: try await keyData(for: key), iv: iv)
            }
            try data.write(to: partURL, options: .atomic)
            completedSegments += 1
            completedBytes += transferredBytes
            updateVODProgress(
                stateIndex: stateOffset + index,
                completedSegments: completedSegments,
                totalSegmentCount: totalSegmentCount,
                completedBytes: completedBytes
            )
            log("\(label)-Segment \(index + 1)/\(media.segments.count) ok (\(data.count) bytes)")
        }
    }

    private func updateVODProgress(
        stateIndex: Int,
        completedSegments: Int,
        totalSegmentCount: Int,
        completedBytes: Int64
    ) {
        progress.completedBytes = completedBytes
        if progress.segmentStates.indices.contains(stateIndex) {
            progress.segmentStates[stateIndex].completed = 1
            progress.segmentStates[stateIndex].isFinished = true
        }
        progress.journeyFraction = progress.totalBytes > 0
            ? nil
            : min(1, Double(completedSegments) / Double(max(1, totalSegmentCount)))
    }

    // MARK: - Playlist

    private struct ResolvedStreams {
        var video: HLSPlaylist.Media
        /// Present when the video variant references a separate audio rendition
        /// (X/Twitter and many CDNs) — must be downloaded and muxed, or the
        /// result is silent.
        var audio: HLSPlaylist.Media?
    }

    private func probeTransferSizes(for media: HLSPlaylist.Media) async -> [Int64?] {
        var sizes = Array<Int64?>(repeating: nil, count: media.segments.count)
        let batchSize = 12

        for lowerBound in stride(from: 0, to: media.segments.count, by: batchSize) {
            let upperBound = min(media.segments.count, lowerBound + batchSize)
            let batch = await withTaskGroup(of: (Int, Int64?).self) { group in
                for index in lowerBound..<upperBound {
                    let segment = media.segments[index]
                    group.addTask {
                        (index, await self.probeTransferSize(for: segment))
                    }
                }
                var values: [(Int, Int64?)] = []
                for await value in group { values.append(value) }
                return values
            }
            for (index, size) in batch { sizes[index] = size }

            // HEAD support is normally uniform across a media origin. Stop at
            // the first unsupported batch instead of delaying the real download
            // with more probes that cannot produce an aggregate total anyway.
            if batch.contains(where: { $0.1 == nil }) { break }
        }
        return sizes
    }

    private func probeTransferSize(for segment: HLSPlaylist.Segment) async -> Int64? {
        if let byteRange = segment.byteRange, byteRange.length > 0 {
            return byteRange.length
        }
        guard let url = HLSPlaylist.resolveURL(segment.uri, against: request.url) else {
            return nil
        }

        var req = configuredRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 4
        req.setValue(nil, forHTTPHeaderField: "Range")
        do {
            let (_, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                return nil
            }
            let declared = Int64(http.value(forHTTPHeaderField: "Content-Length") ?? "")
            let length = declared ?? http.expectedContentLength
            return length > 0 ? length : nil
        } catch {
            return nil
        }
    }

    private static func knownTotal(of sizes: [Int64?]) -> Int64? {
        guard !sizes.isEmpty else { return nil }
        var total: Int64 = 0
        for candidate in sizes {
            guard let size = candidate, size > 0, total <= Int64.max - size else {
                return nil
            }
            total += size
        }
        return total
    }

    private func resolveMediaPlaylist(startingAt url: URL) async throws -> ResolvedStreams {
        let text = try await fetchText(url)
        switch try HLSPlaylist.parse(text) {
        case .media(let media):
            return ResolvedStreams(video: media, audio: nil)
        case .master(let master):
            guard let variant = master.preferredVariant,
                  let mediaURL = HLSPlaylist.resolveURL(variant.uri, against: url) else {
                throw HLSError.emptyMaster
            }
            log("Selected HLS variant bandwidth=\(variant.bandwidth) -> \(mediaURL.absoluteString)")
            let mediaText = try await fetchText(mediaURL)
            guard case .media(let media) = try HLSPlaylist.parse(mediaText) else {
                throw HLSError.emptyMedia
            }
            let video = absolutize(media, base: mediaURL)

            // Separate audio rendition → resolve its media playlist too.
            var audio: HLSPlaylist.Media?
            if let audioURIString = master.audioURI(for: variant),
               let audioURL = HLSPlaylist.resolveURL(audioURIString, against: url) {
                log("Variant has a separate audio rendition -> \(audioURL.absoluteString)")
                let audioText = try await fetchText(audioURL)
                if case .media(let audioMedia) = try HLSPlaylist.parse(audioText) {
                    audio = absolutize(audioMedia, base: audioURL)
                }
            }
            return ResolvedStreams(video: video, audio: audio)
        }
    }

    private func absolutize(_ media: HLSPlaylist.Media, base: URL) -> HLSPlaylist.Media {
        var copy = media
        copy.segments = media.segments.map { seg in
            var s = seg
            if let abs = HLSPlaylist.resolveURL(seg.uri, against: base) {
                s.uri = abs.absoluteString
            }
            // Each segment carries its own key, so every key URI needs resolving
            // against the media playlist — not just the first one.
            if var key = s.key, let uri = key.uri,
               let abs = HLSPlaylist.resolveURL(uri, against: base) {
                key.uri = abs.absoluteString
                s.key = key
            }
            return s
        }
        return copy
    }

    // MARK: - Network

    private func fetchText(_ url: URL) async throws -> String {
        let data = try await fetchData(url)
        guard let text = String(data: data, encoding: .utf8) else {
            throw EngineError.invalidResponse
        }
        return text
    }

    private func fetchData(_ url: URL, byteRange: HLSPlaylist.ByteRange? = nil) async throws -> Data {
        var req = configuredRequest(url: url)
        req.httpMethod = "GET"
        if let br = byteRange {
            if let off = br.offset {
                req.setValue("bytes=\(off)-\(off + br.length - 1)", forHTTPHeaderField: "Range")
            } else {
                req.setValue("bytes=0-\(br.length - 1)", forHTTPHeaderField: "Range")
            }
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) || http.statusCode == 206 else {
            throw EngineError.httpStatus((response as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return data
    }

    private func configuredRequest(url: URL) -> URLRequest {
        var req = URLRequest(url: url)
        if let ua = request.userAgent {
            req.setValue(ua, forHTTPHeaderField: "User-Agent")
        }
        for (key, value) in request.headers {
            req.setValue(value, forHTTPHeaderField: key)
        }
        return req
    }

    // MARK: - Merge / crypto

    private func mergeTS(count: Int, from dir: URL, to finalURL: URL) throws {
        if FileManager.default.fileExists(atPath: finalURL.path) {
            try FileManager.default.removeItem(at: finalURL)
        }
        FileManager.default.createFile(atPath: finalURL.path, contents: nil)
        let out = try FileHandle(forWritingTo: finalURL)
        defer { try? out.close() }
        for i in 0..<count {
            let part = dir.appendingPathComponent(String(format: "seg_%05d.ts", i))
            let data = try Data(contentsOf: part)
            try out.write(contentsOf: data)
        }
    }

    /// A requested `.mp4` name must not end up holding raw TS bytes when the
    /// remux couldn't run — relabel the fallback file honestly.
    private static func tsFallbackURL(for url: URL) -> URL {
        guard url.pathExtension.lowercased() == "mp4" else { return url }
        return url.deletingPathExtension().appendingPathExtension("ts")
    }

    /// Move (or copy across volumes) the merged file into its destination.
    private static func replaceItem(at destination: URL, with source: URL) throws {
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        do {
            try FileManager.default.moveItem(at: source, to: destination)
        } catch {
            try FileManager.default.copyItem(at: source, to: destination)
            try? FileManager.default.removeItem(at: source)
        }
    }

    private func outputFilename() -> String {
        if let suggested = request.suggestedFilename, !suggested.isEmpty {
            if suggested.lowercased().hasSuffix(".m3u8") {
                return String(suggested.dropLast(5)) + ".ts"
            }
            if suggested.lowercased().hasSuffix(".ts") { return suggested }
            return suggested
        }
        let base = request.url.deletingPathExtension().lastPathComponent
        return (base.isEmpty ? "stream" : base) + ".ts"
    }

    static func ivData(hex: String?, mediaSequence: Int) -> Data {
        if let hex, let data = Data(hexString: hex), data.count == 16 {
            return data
        }
        // Default IV = media sequence as 16-byte big-endian
        var bytes = [UInt8](repeating: 0, count: 16)
        var seq = UInt64(mediaSequence).bigEndian
        withUnsafeBytes(of: &seq) { raw in
            for i in 0..<8 {
                bytes[8 + i] = raw[i]
            }
        }
        return Data(bytes)
    }

    static func decryptAES128(_ data: Data, key: Data, iv: Data) throws -> Data {
        guard key.count == 16, iv.count == 16 else { throw HLSError.decryptFailed }
        var outLength = data.count + kCCBlockSizeAES128
        var out = Data(count: outLength)
        let status = out.withUnsafeMutableBytes { outBytes in
            data.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(
                            CCOperation(kCCDecrypt),
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, key.count,
                            ivBytes.baseAddress,
                            inBytes.baseAddress, data.count,
                            outBytes.baseAddress, outLength,
                            &outLength
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { throw HLSError.decryptFailed }
        out.count = outLength
        return out
    }

    // MARK: - Log

    private func openLog() {
        let url = workDirectory.appendingPathComponent("LogFile.txt")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: url)
        _ = try? logHandle?.seekToEnd()
        log("Opening LogFile...")
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }

    private func log(_ line: String) {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        let formatted = "INFO   \(f.string(from: Date())) ( \(Int(Date().timeIntervalSince1970)) )   \(line)\n"
        if let data = formatted.data(using: .utf8) {
            try? logHandle?.write(contentsOf: data)
        }
    }
}

private extension Data {
    init?(hexString: String) {
        let cleaned = hexString.replacingOccurrences(of: " ", with: "")
        guard cleaned.count % 2 == 0 else { return nil }
        var data = Data(capacity: cleaned.count / 2)
        var idx = cleaned.startIndex
        while idx < cleaned.endIndex {
            let next = cleaned.index(idx, offsetBy: 2)
            guard let b = UInt8(cleaned[idx..<next], radix: 16) else { return nil }
            data.append(b)
            idx = next
        }
        self = data
    }
}
