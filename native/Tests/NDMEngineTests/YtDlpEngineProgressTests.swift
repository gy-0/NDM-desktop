import XCTest
@testable import NDMEngine

final class YtDlpEngineProgressTests: XCTestCase {
    func testSeparateVideoAndAudioReportsStayMonotonic() async {
        let engine = YtDlpEngine(
            taskID: 1,
            estimatedBytes: 1_100,
            estimatedComponentBytes: [900, 200]
        )

        await engine.apply(report: .init(
            downloadedBytes: 900,
            totalBytes: 900,
            componentID: "video-1080",
            status: "finished"
        ))
        let videoComplete = await engine.currentProgress()
        XCTAssertEqual(videoComplete.completedBytes, 900)
        XCTAssertEqual(videoComplete.totalBytes, 1_100)
        XCTAssertEqual(videoComplete.fractionCompleted, (900.0 / 1_100.0) * 0.96, accuracy: 0.000_001)

        await engine.apply(report: .init(
            downloadedBytes: 20,
            totalBytes: 200,
            componentID: "audio-best",
            status: "downloading"
        ))
        let audioStarted = await engine.currentProgress()
        XCTAssertEqual(audioStarted.completedBytes, 920)
        XCTAssertEqual(audioStarted.totalBytes, 1_100)
        XCTAssertGreaterThan(audioStarted.fractionCompleted, videoComplete.fractionCompleted)

        await engine.apply(report: .init(
            downloadedBytes: 200,
            totalBytes: 200,
            componentID: "audio-best",
            status: "finished"
        ))
        let streamsComplete = await engine.currentProgress()
        XCTAssertEqual(streamsComplete.completedBytes, 1_100)
        XCTAssertEqual(streamsComplete.fractionCompleted, 0.96, accuracy: 0.000_001)
        XCTAssertEqual(streamsComplete.phase, .finalizing)
    }

    func testEarlySubtitlePostprocessDoesNotJumpJourney() async {
        let engine = YtDlpEngine(
            taskID: 9,
            estimatedBytes: 1_100,
            estimatedComponentBytes: [900, 200]
        )
        // yt-dlp converts subtitles as soon as they are written — before the
        // video transfer starts. The 0.985 subtitle floor must not apply yet,
        // or the journey jumps to 98% at the start and the ratchet keeps it.
        await engine.apply(report: .init(
            componentID: "SubtitlesConvertor",
            status: "started",
            phase: .subtitles
        ))
        let beforeTransfer = await engine.currentProgress()
        XCTAssertLessThan(beforeTransfer.fractionCompleted, 0.05)

        await engine.apply(report: .init(
            downloadedBytes: 90,
            totalBytes: 900,
            componentID: "video-1080",
            status: "downloading"
        ))
        let earlyTransfer = await engine.currentProgress()
        XCTAssertLessThan(earlyTransfer.fractionCompleted, 0.2)

        // Once both streams finished, the merge floor applies as designed.
        await engine.apply(report: .init(
            downloadedBytes: 900,
            totalBytes: 900,
            componentID: "video-1080",
            status: "finished"
        ))
        await engine.apply(report: .init(
            downloadedBytes: 200,
            totalBytes: 200,
            componentID: "audio-best",
            status: "finished"
        ))
        await engine.apply(report: .init(
            componentID: "Merger",
            status: "started",
            phase: .merging
        ))
        let merging = await engine.currentProgress()
        XCTAssertGreaterThanOrEqual(merging.fractionCompleted, 0.972)
    }

    func testSingleStreamReportKeepsKnownCombinedEstimate() async {
        let engine = YtDlpEngine(taskID: 2, estimatedBytes: 1_000)
        await engine.apply(report: .init(downloadedBytes: 500, totalBytes: 800))

        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.completedBytes, 500)
        XCTAssertEqual(progress.totalBytes, 1_000)
        XCTAssertEqual(progress.fractionCompleted, 0.48, accuracy: 0.000_001)
    }

    func testActualComponentTotalsReplaceInflatedProbeEstimateEarly() async {
        let engine = YtDlpEngine(
            taskID: 3,
            estimatedBytes: 2_000,
            estimatedComponentBytes: [1_800, 200]
        )
        await engine.apply(report: .init(
            downloadedBytes: 450,
            totalBytes: 900,
            componentID: "site-video",
            status: "downloading"
        ))

        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.totalBytes, 1_100)
        XCTAssertEqual(progress.completedBytes, 450)
        XCTAssertEqual(progress.fractionCompleted, (450.0 / 1_100.0) * 0.96, accuracy: 0.000_001)
    }

    func testPostprocessStagesAdvanceJourneyWithoutChangingTruthfulBytes() async {
        let engine = YtDlpEngine(taskID: 4, estimatedBytes: 1_000)
        await engine.apply(report: .init(
            downloadedBytes: 1_000,
            totalBytes: 1_000,
            componentID: "video",
            status: "finished"
        ))
        await engine.apply(report: .init(status: "started", phase: .merging))
        let merging = await engine.currentProgress()
        XCTAssertEqual(merging.completedBytes, 1_000)
        XCTAssertEqual(merging.totalBytes, 1_000)
        XCTAssertEqual(merging.phase, .merging)
        XCTAssertEqual(merging.fractionCompleted, 0.972, accuracy: 0.000_001)

        await engine.apply(report: .init(status: "started", phase: .subtitles))
        let subtitles = await engine.currentProgress()
        XCTAssertEqual(subtitles.completedBytes, 1_000)
        XCTAssertEqual(subtitles.phase, .subtitles)
        XCTAssertEqual(subtitles.fractionCompleted, 0.985, accuracy: 0.000_001)

        await engine.apply(report: .init(status: "started", phase: .finalizing))
        let finalizing = await engine.currentProgress()
        XCTAssertEqual(finalizing.completedBytes, 1_000)
        XCTAssertEqual(finalizing.phase, .finalizing)
        XCTAssertEqual(finalizing.fractionCompleted, 0.992, accuracy: 0.000_001)
    }

    func testProgressTemplateCarriesComponentIdentity() {
        let report = YtDlpTool.parseProgressLine(
            "NDM|25|100|0|12.5|6|video-720|downloading"
        )
        XCTAssertEqual(report?.componentID, "video-720")
        XCTAssertEqual(report?.status, "downloading")
    }

    func testDecimalHLSProgressEstimateDoesNotBecomeInstantCompletion() async {
        let report = try! XCTUnwrap(YtDlpTool.parseProgressLine(
            "NDM|903|NA|1257879.0|940.05|NA|hls-5346|downloading"
        ))
        XCTAssertEqual(report.totalBytes, 1_257_879)

        let engine = YtDlpEngine(
            taskID: 10,
            estimatedBytes: 2_792_307_870,
            estimatedComponentBytes: [2_792_307_870]
        )
        await engine.apply(report: report)

        let progress = await engine.currentProgress()
        XCTAssertEqual(progress.completedBytes, 903)
        XCTAssertEqual(progress.totalBytes, 1_257_879)
        XCTAssertLessThan(progress.fractionCompleted, 0.01)
    }

    func testPostprocessProgressLinesExposeProductPhases() {
        let merger = YtDlpTool.parseProgressLine("NDM_POST|FFmpegMerger|started")
        XCTAssertEqual(merger?.phase, .merging)
        XCTAssertEqual(merger?.status, "started")

        let subtitles = YtDlpTool.parseProgressLine("NDM_POST|FFmpegSubtitlesConvertor|processing")
        XCTAssertEqual(subtitles?.phase, .subtitles)

        let metadata = YtDlpTool.parseProgressLine("NDM_POST|FFmpegMetadata|started")
        XCTAssertEqual(metadata?.phase, .finalizing)
    }

    func testAria2ProgressIsParsed() {
        let report = YtDlpTool.parseProgressLine(
            "[#abc123 5.0MiB/10MiB(50%) CN:8 DL:1.2MiB ETA:4s]"
        )
        XCTAssertEqual(report?.componentID, "aria2:abc123")
        XCTAssertEqual(report?.downloadedBytes, 5 * 1024 * 1024)
        XCTAssertEqual(report?.totalBytes, 10 * 1024 * 1024)
        XCTAssertEqual(report?.etaSeconds, 4)
    }

    func testDownloadArgumentsEnableConcurrencyAndRealOverwrite() {
        let args = YtDlpTool.downloadArguments(
            url: "https://example.com/watch/1",
            formatID: "bv+ba/b",
            outputTemplate: "/tmp/video.%(ext)s",
            connections: 32,
            forceOverwrite: true,
            aria2cPath: "/opt/homebrew/bin/aria2c",
            temporaryDirectory: URL(fileURLWithPath: "/tmp/ndm-ytdlp-stage")
        )
        XCTAssertTrue(args.contains("--concurrent-fragments"))
        XCTAssertTrue(args.contains("32"))
        XCTAssertTrue(args.contains("--force-overwrites"))
        XCTAssertTrue(args.contains("--no-continue"))
        XCTAssertTrue(args.contains("temp:/tmp/ndm-ytdlp-stage"))
        XCTAssertTrue(args.contains("/opt/homebrew/bin/aria2c"))
        // aria2c rejects --max-connection-per-server above 16 (exit code 28),
        // so 32 requested connections must be capped in the downloader args.
        XCTAssertTrue(args.contains(where: { $0.contains("-x16") && $0.contains("-s16") }))
        XCTAssertFalse(args.contains(where: { $0.contains("-x32") }))
        XCTAssertTrue(args.contains(where: { $0.hasPrefix("postprocess:NDM_POST|") }))
    }

    func testDownloadArgumentsSkipAria2cForSmallTransfers() {
        let args = YtDlpTool.downloadArguments(
            url: "https://example.com/watch/1",
            formatID: "ba",
            outputTemplate: "/tmp/audio.%(ext)s",
            connections: 16,
            forceOverwrite: false,
            aria2cPath: "/opt/homebrew/bin/aria2c",
            estimatedBytes: 3 * 1024 * 1024
        )
        XCTAssertTrue(args.contains("--concurrent-fragments"))
        XCTAssertFalse(args.contains("--downloader"))
        XCTAssertFalse(args.contains("/opt/homebrew/bin/aria2c"))
    }

    func testDownloadArgumentsSkipAria2cForYouTubeEvenWhenLarge() {
        let args = YtDlpTool.downloadArguments(
            url: "https://www.youtube.com/watch?v=sAE7DU-g7VM",
            formatID: "136+140",
            outputTemplate: "/tmp/video.%(ext)s",
            connections: 16,
            forceOverwrite: false,
            aria2cPath: "/opt/homebrew/bin/aria2c",
            estimatedBytes: 68 * 1024 * 1024
        )
        XCTAssertTrue(args.contains("--concurrent-fragments"))
        XCTAssertFalse(args.contains("--downloader"))
        XCTAssertFalse(args.contains("/opt/homebrew/bin/aria2c"))
        XCTAssertFalse(args.contains("--extractor-args"), "Use the bundled extractor’s maintained default client selection")
        XCTAssertTrue(args.contains("--retries"))
        XCTAssertTrue(args.contains("--fragment-retries"))
    }

    func testDownloadArgumentsKeepAria2cForLargeTransfers() {
        let args = YtDlpTool.downloadArguments(
            url: "https://example.com/watch/1",
            formatID: "bv+ba/b",
            outputTemplate: "/tmp/video.%(ext)s",
            connections: 16,
            forceOverwrite: false,
            aria2cPath: "/opt/homebrew/bin/aria2c",
            estimatedBytes: YtDlpTool.aria2MinimumBytes
        )
        XCTAssertTrue(args.contains("/opt/homebrew/bin/aria2c"))
        XCTAssertFalse(args.contains("--extractor-args"))
    }

    func testDownloadArgumentsReplayFreshProbeInsteadOfTheURL() {
        let args = YtDlpTool.downloadArguments(
            url: "https://example.com/watch/1",
            formatID: "bv+ba/b",
            outputTemplate: "/tmp/video.%(ext)s",
            connections: 1,
            forceOverwrite: false,
            aria2cPath: nil,
            infoJSONPath: "/tmp/probe.info.json"
        )
        XCTAssertEqual(args[args.firstIndex(of: "--load-info-json")! + 1], "/tmp/probe.info.json")
        XCTAssertFalse(args.contains("https://example.com/watch/1"))
    }

    func testFreshInfoJSONPathRejectsMissingAndStaleFiles() throws {
        XCTAssertNil(YtDlpTool.freshInfoJSONPath(nil))
        XCTAssertNil(YtDlpTool.freshInfoJSONPath("/tmp/ndm-missing-probe.info.json"))

        let fresh = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-fresh-\(UUID().uuidString).info.json")
        try Data("{}".utf8).write(to: fresh)
        defer { try? FileManager.default.removeItem(at: fresh) }
        XCTAssertEqual(YtDlpTool.freshInfoJSONPath(fresh.path), fresh.path)

        let stale = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-stale-\(UUID().uuidString).info.json")
        try Data("{}".utf8).write(to: stale)
        defer { try? FileManager.default.removeItem(at: stale) }
        try FileManager.default.setAttributes(
            [.modificationDate: Date().addingTimeInterval(-(YtDlpTool.infoJSONFreshness + 60))],
            ofItemAtPath: stale.path
        )
        XCTAssertNil(YtDlpTool.freshInfoJSONPath(stale.path))
    }

    func testCompactContainerAndSubtitleArgumentsAreApplied() {
        let args = YtDlpTool.downloadArguments(
            url: "https://example.com/watch/1",
            formatID: "bv+ba/b",
            outputTemplate: "/tmp/video.%(ext)s",
            connections: 1,
            forceOverwrite: false,
            aria2cPath: nil,
            options: YtDlpDownloadOptions(
                container: .compactMKV,
                subtitleLanguage: "zh-Hans"
            )
        )
        XCTAssertEqual(args[args.firstIndex(of: "--merge-output-format")! + 1], "mkv")
        XCTAssertTrue(args.contains("--write-subs"))
        XCTAssertTrue(args.contains("--write-auto-subs"))
        XCTAssertEqual(args[args.firstIndex(of: "--sub-langs")! + 1], "zh-Hans")
        XCTAssertTrue(args.contains("--convert-subs"))
    }

    func testSubtitleTracksPreferManualAndMarkAutomatic() {
        let tracks = YtDlpTool.subtitleTracks(from: [
            "subtitles": ["en": [["ext": "vtt"]]],
            "automatic_captions": [
                "en": [["ext": "vtt"]],
                "zh-Hans": [["ext": "vtt"]],
            ],
        ])
        XCTAssertEqual(tracks.first(where: { $0.code == "en" })?.isAutomatic, false)
        XCTAssertEqual(tracks.first(where: { $0.code == "zh-Hans" })?.isAutomatic, true)
    }

    func testFirstUseSubtitleFollowsSystemLanguageThenEnglishInsteadOfAlphabeticalTrack() {
        let tracks = [
            YtDlpSubtitleTrack(code: "bo", displayName: "Tibetan", isAutomatic: false),
            YtDlpSubtitleTrack(code: "en", displayName: "English", isAutomatic: true),
            YtDlpSubtitleTrack(code: "zh-Hans", displayName: "Chinese", isAutomatic: true),
        ]
        XCTAssertEqual(
            YtDlpTool.preferredSubtitleIndex(in: tracks, preferredLanguages: ["zh-Hans"]),
            2
        )
        XCTAssertEqual(
            YtDlpTool.preferredSubtitleIndex(in: tracks, preferredLanguages: ["fr-FR"]),
            1
        )
    }

    func testFirstUseSubtitleLeavesNoArbitraryDefaultWhenOnlyUnrelatedTracksExist() {
        let tracks = [
            YtDlpSubtitleTrack(code: "bo", displayName: "Tibetan", isAutomatic: false),
            YtDlpSubtitleTrack(code: "eu", displayName: "Basque", isAutomatic: false),
        ]
        XCTAssertNil(
            YtDlpTool.preferredSubtitleIndex(in: tracks, preferredLanguages: ["fr-FR"])
        )
    }

    func testDownloadedSubtitleIsRenamedToMatchVideoExactly() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-subtitle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        let video = folder.appendingPathComponent("一部.测试电影.mp4")
        let taggedSubtitle = folder.appendingPathComponent("一部.测试电影.zh-Hans.srt")
        try Data().write(to: video)
        try Data("subtitle".utf8).write(to: taggedSubtitle)

        let result = try YtDlpTool.normalizeSubtitleSidecar(
            for: video,
            forceOverwrite: false
        )

        let expected = folder.appendingPathComponent("一部.测试电影.srt")
        XCTAssertEqual(result, expected)
        XCTAssertTrue(FileManager.default.fileExists(atPath: expected.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: taggedSubtitle.path))
    }

    func testExistingExactSubtitleIsPreservedWithoutOverwrite() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-subtitle-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }

        let video = folder.appendingPathComponent("Movie.mp4")
        let exact = folder.appendingPathComponent("Movie.srt")
        let tagged = folder.appendingPathComponent("Movie.en.srt")
        try Data().write(to: video)
        try Data("existing".utf8).write(to: exact)
        try Data("new".utf8).write(to: tagged)

        let result = try YtDlpTool.normalizeSubtitleSidecar(
            for: video,
            forceOverwrite: false
        )

        XCTAssertEqual(result, exact)
        XCTAssertEqual(try String(contentsOf: exact, encoding: .utf8), "existing")
        XCTAssertTrue(FileManager.default.fileExists(atPath: tagged.path))
    }

    func testFormatSelectorReflectsHighLevelPreference() {
        let format = YtDlpFormat(id: "fallback", label: "1080p", height: 1080)
        XCTAssertTrue(format.selector(for: .compatibleMP4).contains("ext=mp4"))
        XCTAssertTrue(format.selector(for: .compactMKV).contains("vcodec^=av01"))
    }

    func testCollectionSelectorDoesNotReuseSingleVideoFormatIDs() {
        let format = YtDlpFormat(
            id: "fallback",
            label: "2160p",
            height: 2160,
            compatibleSelectorOverride: "401+140",
            compactSelectorOverride: "401+251"
        )
        XCTAssertEqual(format.selector(for: .compatibleMP4), "401+140")
        XCTAssertNotEqual(format.collectionSelector(for: .compatibleMP4), "401+140")
        XCTAssertTrue(format.collectionSelector(for: .compatibleMP4).contains("height<=2160"))
    }

    func testCinematicYouTubeFormatsUseStandardQualityTiersAndExactSizes() {
        let formats: [[String: Any]] = [
            [
                "format_id": "137", "width": 1920, "height": 960,
                "format_note": "1080p", "vcodec": "avc1.640028", "acodec": "none",
                "ext": "mp4", "filesize": 115_328_849, "tbr": 1_923.57,
            ],
            [
                "format_id": "399", "width": 1920, "height": 960,
                "format_note": "1080p", "vcodec": "av01.0.08M.08", "acodec": "none",
                "ext": "mp4", "filesize": 30_073_689, "tbr": 501.599,
            ],
            [
                "format_id": "400", "width": 2560, "height": 1280,
                "format_note": "1440p", "vcodec": "av01.0.12M.08", "acodec": "none",
                "ext": "mp4", "filesize": 69_745_585, "tbr": 1_163.286,
            ],
            [
                "format_id": "401", "width": 3840, "height": 1920,
                "format_note": "2160p60 HDR", "vcodec": "av01.0.12M.08", "acodec": "none",
                "ext": "mp4", "filesize": 124_635_395, "tbr": 2_078.794,
            ],
            [
                "format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2",
                "ext": "m4a", "filesize": 7_764_529, "abr": 129.0,
            ],
        ]

        let tiers = YtDlpTool.buildTiers(from: formats, duration: 480)

        XCTAssertEqual(tiers.map(\.label), ["2160p", "1440p", "1080p"])
        XCTAssertEqual(tiers.map(\.height), [2160, 1440, 1080])
        XCTAssertEqual(tiers.map { $0.selector(for: .compatibleMP4) }, [
            "401+140", "400+140", "137+140",
        ])
        XCTAssertEqual(tiers.map { $0.estimatedBytes(for: .compatibleMP4) }, [
            132_399_924, 77_510_114, 123_093_378,
        ])
    }

    func testProgressiveTierDoesNotDoubleCountSeparateAudio() {
        let formats: [[String: Any]] = [
            [
                "format_id": "progressive",
                "height": 720,
                "vcodec": "avc1",
                "acodec": "aac",
                "filesize": 1_000,
                "tbr": 1_000.0,
            ],
            [
                "format_id": "audio",
                "vcodec": "none",
                "acodec": "aac",
                "filesize": 200,
                "abr": 128.0,
            ],
        ]
        let tier = YtDlpTool.buildTiers(from: formats, duration: 10).first
        XCTAssertEqual(tier?.componentBytes, [1_000])
        XCTAssertEqual(tier?.approximateBytes, 1_000)
    }

    func testNonMediaGenericExtractorDoesNotInventBestMP4() {
        XCTAssertTrue(YtDlpTool.buildTiers(from: [], duration: nil).isEmpty)

        let formats: [[String: Any]] = [[
            "format_id": "0",
            "ext": "gguf",
            "vcodec": "none",
            "acodec": "none",
            "filesize": 17_378_626_464,
        ]]

        XCTAssertTrue(YtDlpTool.buildTiers(from: formats, duration: nil).isEmpty)
    }

    func testTwitterVideoOnlyProbeLeavesAudioPairingToYtDlp() {
        // X/Twitter's JSON probe may omit the separate HLS audio rendition
        // from `formats`, even though yt-dlp resolves it when evaluating
        // `bestvideo+bestaudio`. Selecting `hls-817` directly creates a silent
        // MP4; the portable selector must be retained in this case.
        let formats: [[String: Any]] = [
            [
                "format_id": "hls-817",
                "height": 1080,
                "vcodec": "avc1.640032",
                "acodec": "none",
                "ext": "mp4",
                "protocol": "m3u8_native",
                "tbr": 817.535,
            ],
        ]

        let tier = YtDlpTool.buildTiers(from: formats, duration: 30).first
        let selector = tier?.selector(for: .compatibleMP4)

        XCTAssertEqual(tier?.height, 1080)
        XCTAssertNotEqual(selector, "hls-817")
        XCTAssertTrue(selector?.contains("bestvideo[height<=1080]") == true)
        XCTAssertTrue(selector?.contains("+bestaudio") == true)
    }

    func testTierEstimatesMatchTheSelectedContainerCodecFamily() {
        let formats: [[String: Any]] = [
            ["height": 1440, "vcodec": "avc1.640033", "acodec": "none", "filesize": 2_000, "tbr": 2_000.0],
            ["height": 1440, "vcodec": "av01.0.12M.08", "acodec": "none", "filesize": 1_200, "tbr": 1_200.0],
            ["vcodec": "none", "acodec": "mp4a.40.2", "filesize": 200, "abr": 128.0],
        ]
        let tier = YtDlpTool.buildTiers(from: formats, duration: 10).first
        XCTAssertEqual(tier?.height, 1440)
        XCTAssertEqual(tier?.estimatedBytes(for: .compatibleMP4), 2_200)
        XCTAssertEqual(tier?.estimatedBytes(for: .compactMKV), 1_400)
    }

    func testTierCatalogNeverInventsAnUnavailableResolutionLabel() {
        let formats: [[String: Any]] = [
            ["height": 2160, "vcodec": "vp9", "acodec": "none", "filesize": 4_000],
            ["height": 1080, "vcodec": "vp9", "acodec": "none", "filesize": 2_000],
            ["vcodec": "none", "acodec": "opus", "filesize": 200],
        ]
        let tiers = YtDlpTool.buildTiers(from: formats, duration: 10)
        XCTAssertEqual(tiers.map(\.height), [2160, 1080])
        XCTAssertFalse(tiers.contains(where: { $0.label == "1440p" }))
    }

    func testYouTubeHighBitrate1080pIsASeparateTier() {
        let formats: [[String: Any]] = [
            [
                "format_id": "137", "height": 1080, "format_note": "1080p",
                "vcodec": "avc1.640028", "acodec": "none", "ext": "mp4",
                "filesize": 80_000_000, "tbr": 2_200.0,
            ],
            [
                "format_id": "248", "height": 1080, "format_note": "1080p",
                "vcodec": "vp9", "acodec": "none", "ext": "webm",
                "filesize": 40_000_000, "tbr": 1_600.0,
            ],
            [
                "format_id": "616", "height": 1080, "format_note": "1080p Premium",
                "vcodec": "vp9", "acodec": "none", "ext": "mp4",
                "protocol": "m3u8_native", "filesize": 120_000_000, "tbr": 5_800.0,
            ],
            [
                "format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2",
                "ext": "m4a", "filesize": 8_000_000, "abr": 128.0,
            ],
        ]

        let tiers = YtDlpTool.buildTiers(
            from: formats,
            duration: 180,
            includeYouTubeHighBitrate: true
        )

        XCTAssertEqual(tiers.map(\.label), ["1080p 高码率", "1080p"])
        XCTAssertEqual(tiers.map(\.isHighBitrate), [true, false])
        XCTAssertEqual(tiers[0].selector(for: .compatibleMP4), "616+140")
        XCTAssertEqual(tiers[0].selector(for: .compactMKV), "616+140")
        XCTAssertEqual(tiers[1].selector(for: .compatibleMP4), "137+140")
        XCTAssertTrue(YtDlpTool.isYouTubeMediaURL("https://youtu.be/abc"))
        XCTAssertTrue(YtDlpTool.isYouTubeMediaURL("https://music.youtube.com/watch?v=abc"))
        XCTAssertFalse(YtDlpTool.isYouTubeMediaURL("https://www.bilibili.com/video/1"))
        XCTAssertFalse(YtDlpTool.isYouTubeMediaURL("https://example.com/?next=youtube.com"))
        XCTAssertTrue(tiers[0].collectionSelector(for: .compatibleMP4).contains("format_id=616"))
    }

    func testRegularAVCIsNotPromotedToHighBitrate() {
        let formats: [[String: Any]] = [
            [
                "format_id": "137", "height": 1080, "format_note": "1080p",
                "vcodec": "avc1.640028", "acodec": "none", "filesize": 90_000_000, "tbr": 3_000.0,
            ],
            [
                "format_id": "248", "height": 1080, "format_note": "1080p",
                "vcodec": "vp9", "acodec": "none", "filesize": 40_000_000, "tbr": 1_400.0,
            ],
            [
                "format_id": "140", "vcodec": "none", "acodec": "mp4a.40.2", "filesize": 8_000_000,
            ],
        ]
        let tiers = YtDlpTool.buildTiers(
            from: formats,
            duration: 180,
            includeYouTubeHighBitrate: true
        )
        XCTAssertEqual(tiers.map(\.label), ["1080p"])
        XCTAssertFalse(tiers.contains(where: \.isHighBitrate))
    }
}
