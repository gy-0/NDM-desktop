import XCTest
import CommonCrypto
@testable import NDMEngine
@testable import NDMCore

final class HLSEngineIntegrationTests: XCTestCase {
    func testMediaPlaylistDownloadAndMerge() async throws {
        let seg0 = Data("AAAA-SEG0-AAAA".utf8)
        let seg1 = Data("BBBB-SEG1-BBBB".utf8)
        let playlist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:10
        #EXTINF:9.0,
        seg0.ts
        #EXTINF:9.0,
        seg1.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "stream.m3u8": Data(playlist.utf8),
            "seg0.ts": seg0,
            "seg1.ts": seg1,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "stream.m3u8").absoluteString, ltype: "hls")
        XCTAssertEqual(task.linkType, "hls")
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)

        let fileURL = dest.appendingPathComponent(done.filename)
        XCTAssertEqual(try Data(contentsOf: fileURL), seg0 + seg1)
        XCTAssertTrue(done.filename.hasSuffix(".ts"))
    }

    func testMasterPlaylistSelectsHighestBandwidth() async throws {
        let low = Data("LOW".utf8)
        let hi = Data("HIGH-QUALITY-TS".utf8)
        let master = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=500000
        low.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=3000000
        hi.m3u8
        """
        let lowMedia = """
        #EXTM3U
        #EXTINF:1.0,
        low.ts
        #EXT-X-ENDLIST
        """
        let hiMedia = """
        #EXTM3U
        #EXTINF:1.0,
        hi.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "master.m3u8": Data(master.utf8),
            "low.m3u8": Data(lowMedia.utf8),
            "hi.m3u8": Data(hiMedia.utf8),
            "low.ts": low,
            "hi.ts": hi,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "master.m3u8").absoluteString)
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        let data = try Data(contentsOf: dest.appendingPathComponent(done.filename))
        XCTAssertEqual(data, hi)
    }

    func testAES128SegmentDecrypt() async throws {
        let plain = Data("0123456789ABCDEF0123456789ABCDEF".utf8) // 32 bytes
        let key = Data((0..<16).map { UInt8($0) })
        let iv = Data(repeating: 0x11, count: 16)
        let cipher = try encryptAES128(plain, key: key, iv: iv)

        let playlist = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x11111111111111111111111111111111
        #EXTINF:1.0,
        enc.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "enc.m3u8": Data(playlist.utf8),
            "key.bin": key,
            "enc.ts": cipher,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "enc.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), plain)
    }

    /// Playlists may rotate keys, and CDNs that splice ads do it routinely. Each
    /// segment must be decrypted with the key that was in force at its position;
    /// applying one key to the whole playlist yields a file that is byte-garbage
    /// for every segment the key does not belong to, with no error raised.
    func testRotatingKeysDecryptEachSegmentWithItsOwnKey() async throws {
        let plain0 = Data("SEGMENT-ZERO----".utf8)
        let plain1 = Data("SEGMENT-ONE-----".utf8)
        let key0 = Data((0..<16).map { UInt8($0) })
        let key1 = Data((0..<16).map { UInt8(0xF0 &- $0) })
        let iv0 = Data(repeating: 0xA1, count: 16)
        let iv1 = Data(repeating: 0xB2, count: 16)

        let playlist = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="k0.bin",IV=0xA1A1A1A1A1A1A1A1A1A1A1A1A1A1A1A1
        #EXTINF:1.0,
        s0.ts
        #EXT-X-KEY:METHOD=AES-128,URI="k1.bin",IV=0xB2B2B2B2B2B2B2B2B2B2B2B2B2B2B2B2
        #EXTINF:1.0,
        s1.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "rot.m3u8": Data(playlist.utf8),
            "k0.bin": key0,
            "k1.bin": key1,
            "s0.ts": try encryptAES128(plain0, key: key0, iv: iv0),
            "s1.ts": try encryptAES128(plain1, key: key1, iv: iv1),
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "rot.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)

        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(
            try Data(contentsOf: dest.appendingPathComponent(done.filename)),
            plain0 + plain1,
            "each segment must use the key in force at its own position"
        )
    }

    /// `METHOD=NONE` mid-playlist is how ad breaks and trailing clear content are
    /// signalled. The earlier segments stay encrypted and must still be decrypted;
    /// the later ones must be left alone.
    func testMethodNoneMidPlaylistLeavesOnlyLaterSegmentsClear() async throws {
        let encryptedPlain = Data("ENCRYPTED-PART--".utf8)
        let clearPart = Data("CLEAR-PART".utf8)
        let key = Data((0..<16).map { UInt8($0 &* 3) })
        let iv = Data(repeating: 0x5C, count: 16)

        let playlist = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="k.bin",IV=0x5C5C5C5C5C5C5C5C5C5C5C5C5C5C5C5C
        #EXTINF:1.0,
        enc.ts
        #EXT-X-KEY:METHOD=NONE
        #EXTINF:1.0,
        clear.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "mix.m3u8": Data(playlist.utf8),
            "k.bin": key,
            "enc.ts": try encryptAES128(encryptedPlain, key: key, iv: iv),
            "clear.ts": clearPart,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "mix.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)

        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(
            try Data(contentsOf: dest.appendingPathComponent(done.filename)),
            encryptedPlain + clearPart
        )
    }

    /// Without an explicit IV the spec uses the segment's media sequence number,
    /// which starts from `#EXT-X-MEDIA-SEQUENCE`, not from zero. Counting from
    /// zero decrypts to garbage without complaining.
    func testAbsentIVUsesMediaSequenceNotSegmentIndex() async throws {
        let plain = Data("SEQUENCE-DERIVED".utf8)
        let key = Data((0..<16).map { UInt8(0x20 &+ $0) })
        var iv = Data(repeating: 0, count: 16)
        iv[15] = 7 // #EXT-X-MEDIA-SEQUENCE:7, first segment

        let playlist = """
        #EXTM3U
        #EXT-X-MEDIA-SEQUENCE:7
        #EXT-X-KEY:METHOD=AES-128,URI="k.bin"
        #EXTINF:1.0,
        s.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "seq.m3u8": Data(playlist.utf8),
            "k.bin": key,
            "s.ts": try encryptAES128(plain, key: key, iv: iv),
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "seq.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)

        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), plain)
    }

    /// An unreachable key must fail the download. Writing the ciphertext to disk
    /// would hand the user a file that opens in nothing and explains nothing.
    func testUnreachableKeyFailsInsteadOfWritingCiphertext() async throws {
        let playlist = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="missing-key.bin"
        #EXTINF:1.0,
        s.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "nokey.m3u8": Data(playlist.utf8),
            "s.ts": Data("ciphertext-here-".utf8),
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "nokey.m3u8").absoluteString, ltype: "hls")
        do {
            try await manager.startAndWait(taskID: task.id)
            XCTFail("a missing decryption key must not report success")
        } catch {
            // Expected.
        }
        let fetched = try await manager.task(id: task.id)
        let done = try XCTUnwrap(fetched)
        XCTAssertNotEqual(done.status, .complete)
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: dest.appendingPathComponent(done.filename).path
            ),
            "no output file may be left behind when decryption was impossible"
        )
    }

    func testVODProgressReportsRealBytesAndContentLengthTotal() async throws {
        let first = Data(repeating: 0x41, count: 128)
        let second = Data(repeating: 0x42, count: 512)
        let playlist = """
        #EXTM3U
        #EXT-X-TARGETDURATION:1
        #EXTINF:1.0,
        first.ts
        #EXTINF:1.0,
        second.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(
            files: [
                "stream.m3u8": Data(playlist.utf8),
                "first.ts": first,
                "second.ts": second,
            ],
            delayedGETs: ["second.ts": 0.5]
        )
        try server.start()
        defer { server.stop() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hls-progress-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = makeEngine(server.url(path: "stream.m3u8"), root: root)
        let run = Task { try await engine.start() }

        let progress = try await waitForProgress(engine) {
            $0.status == .downloading && $0.completedBytes == Int64(first.count)
        }
        XCTAssertEqual(progress.totalBytes, Int64(first.count + second.count))
        XCTAssertEqual(progress.completedBytes, Int64(first.count))
        XCTAssertEqual(progress.fractionCompleted, Double(first.count) / Double(first.count + second.count), accuracy: 0.001)
        XCTAssertEqual(progress.currentConnections, 1)
        XCTAssertEqual(progress.segmentStates.map(\.fractionCompleted), [1, 0])

        _ = try await run.value
    }

    func testVODProgressKeepsBytesTruthfulWhenHEADIsUnsupported() async throws {
        let first = Data(repeating: 0x41, count: 128)
        let second = Data(repeating: 0x42, count: 512)
        let playlist = """
        #EXTM3U
        #EXT-X-TARGETDURATION:1
        #EXTINF:1.0,
        first.ts
        #EXTINF:1.0,
        second.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(
            files: [
                "stream.m3u8": Data(playlist.utf8),
                "first.ts": first,
                "second.ts": second,
            ],
            supportsHEAD: false,
            delayedGETs: ["second.ts": 0.5]
        )
        try server.start()
        defer { server.stop() }

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hls-progress-unknown-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = makeEngine(server.url(path: "stream.m3u8"), root: root)
        let run = Task { try await engine.start() }

        let progress = try await waitForProgress(engine) {
            $0.status == .downloading && $0.completedBytes == Int64(first.count)
        }
        XCTAssertEqual(progress.totalBytes, 0)
        XCTAssertEqual(progress.completedBytes, Int64(first.count))
        XCTAssertEqual(progress.fractionCompleted, 0.5, accuracy: 0.001)

        _ = try await run.value
    }

    func testRealTSStreamRemuxesToMP4() async throws {
        guard let ffmpeg = FFmpegTool.find() else {
            throw XCTSkip("ffmpeg not installed; MP4 remux path not exercisable")
        }
        // Generate a genuine 1-second H.264+AAC MPEG-TS segment.
        let tsURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-real-\(UUID().uuidString).ts")
        defer { try? FileManager.default.removeItem(at: tsURL) }
        let gen = Process()
        gen.executableURL = URL(fileURLWithPath: ffmpeg)
        gen.arguments = [
            "-y",
            "-f", "lavfi", "-i", "testsrc=duration=1:size=128x72:rate=10",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-c:v", "h264_videotoolbox", "-allow_sw", "1",
            "-c:a", "aac",
            "-f", "mpegts", tsURL.path,
        ]
        gen.standardError = Pipe()
        gen.standardOutput = Pipe()
        try gen.run()
        gen.waitUntilExit()
        guard gen.terminationStatus == 0,
              let tsData = try? Data(contentsOf: tsURL), !tsData.isEmpty else {
            throw XCTSkip("local ffmpeg can't encode the test stream (missing VideoToolbox H.264/AAC)")
        }

        let playlist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:2
        #EXTINF:1.0,
        movie.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "lecture.m3u8": Data(playlist.utf8),
            "movie.ts": tsData,
        ])
        try server.start()
        defer { server.stop() }

        let (manager, dest) = try makeManager()
        let task = try await manager.addURL(server.url(path: "lecture.m3u8").absoluteString, ltype: "hls")
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        // "下完就是能播的 MP4": real streams come out as MP4, not TS.
        XCTAssertTrue(done.filename.hasSuffix(".mp4"), "expected MP4, got \(done.filename)")
        let fileURL = dest.appendingPathComponent(done.filename)
        let size = (try FileManager.default.attributesOfItem(atPath: fileURL.path)[.size] as? NSNumber)?.int64Value ?? 0
        XCTAssertGreaterThan(size, 0)
        // The moov atom is up front (faststart) — 'ftyp' marks a valid MP4.
        let head = try XCTUnwrap(FileHandle(forReadingFrom: fileURL).readData(ofLength: 12))
        XCTAssertTrue(String(data: head.subdata(in: 4..<8), encoding: .ascii) == "ftyp")
        // No stray .ts sibling in the destination.
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: dest.path)
            .filter { $0.hasSuffix(".ts") }
        XCTAssertTrue(leftovers.isEmpty, "unexpected TS leftovers: \(leftovers)")
    }

    // MARK: - Helpers

    private func makeEngine(_ url: URL, root: URL) -> HLSEngine {
        HLSEngine(
            taskID: 1,
            request: DownloadRequest(
                url: url,
                destinationDirectory: root.appendingPathComponent("Downloads", isDirectory: true),
                suggestedFilename: "stream.ts"
            ),
            workDirectory: root.appendingPathComponent("work", isDirectory: true)
        )
    }

    private func waitForProgress(
        _ engine: HLSEngine,
        matching predicate: (DownloadProgress) -> Bool
    ) async throws -> DownloadProgress {
        for _ in 0..<200 {
            let progress = await engine.currentProgress()
            if predicate(progress) { return progress }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTFail("timed out waiting for HLS progress snapshot")
        return await engine.currentProgress()
    }

    private func makeManager() throws -> (DownloadManager, URL) {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hls-\(UUID().uuidString)", isDirectory: true)
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 2, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)
        return (manager, dest)
    }

    private func encryptAES128(_ data: Data, key: Data, iv: Data) throws -> Data {
        var outLength = data.count + kCCBlockSizeAES128
        var out = Data(count: outLength)
        let status = out.withUnsafeMutableBytes { outBytes in
            data.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(
                            CCOperation(kCCEncrypt),
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
        guard status == kCCSuccess else {
            throw NSError(domain: "AES", code: Int(status))
        }
        out.count = outLength
        return out
    }
}
