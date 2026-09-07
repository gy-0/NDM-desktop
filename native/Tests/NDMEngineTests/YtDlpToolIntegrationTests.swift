import XCTest
@testable import NDMEngine

/// Live yt-dlp smoke test against a known public YouTube URL.
final class YtDlpToolIntegrationTests: XCTestCase {
    private let sampleURL = "https://www.youtube.com/watch?v=M262vpHkRbk"
    private let samplePlaylistURL =
        "https://www.youtube.com/playlist?list=PL0Xy5cYzhAy9BiKIlpQZTFOoeYV5r9nwN"

    func testCookieSourceArgumentsAreOnlyAddedWhenChosen() {
        XCTAssertEqual(
            YtDlpTool.cookieArguments(.browser("chrome")),
            ["--cookies-from-browser", "chrome"]
        )
        XCTAssertEqual(
            YtDlpTool.cookieArguments(.file("/tmp/cookies.txt")),
            ["--cookies", "/tmp/cookies.txt"]
        )
        XCTAssertTrue(YtDlpTool.cookieArguments(nil).isEmpty)
    }

    func testFreshCookiesErrorIsRecognized() {
        let error = NSError(
            domain: "test",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Fresh cookies (not necessarily logged in) are needed"]
        )
        XCTAssertTrue(YtDlpTool.requiresCookies(error: error))
        XCTAssertEqual(YtDlpTool.accessIssue(error: error), .browserSessionRequired)
    }

    func testBrowserAccessIssueCoversPrivateAgeAndLockedCookieStates() {
        let sessionMessages = [
            "Sign in to confirm your age",
            "This video is private",
            "This content is only available to registered users",
        ]
        for message in sessionMessages {
            let error = NSError(
                domain: "test",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
            XCTAssertEqual(
                YtDlpTool.accessIssue(error: error),
                .browserSessionRequired,
                message
            )
        }

        let locked = NSError(
            domain: "test",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Could not copy Chrome cookie database"]
        )
        XCTAssertEqual(YtDlpTool.accessIssue(error: locked), .browserDataUnavailable)
    }

    func testOrdinaryUnavailableMediaDoesNotRequestBrowserAccess() {
        let error = NSError(
            domain: "test",
            code: 3,
            userInfo: [NSLocalizedDescriptionKey: "Unsupported URL: https://example.com/page"]
        )
        XCTAssertNil(YtDlpTool.accessIssue(error: error))
        XCTAssertFalse(YtDlpTool.requiresCookies(error: error))
    }

    func testCollectionProbeBuildsPortableEntryURLs() {
        let json: [String: Any] = [
            "_type": "playlist",
            "title": "Design lessons",
            "playlist_count": 3,
            "entries": [
                [
                    "id": "abc123",
                    "title": "First lesson",
                    "duration": 91.0,
                    "thumbnail": "https://img.example/one.jpg",
                ],
                [
                    "id": "second",
                    "title": "Second lesson",
                    "webpage_url": "https://www.youtube.com/watch?v=second",
                ],
            ],
        ]

        let collection = YtDlpTool.collectionProbe(
            from: json,
            sourceURL: "https://www.youtube.com/playlist?list=PL123",
            limit: 100
        )

        XCTAssertEqual(collection?.title, "Design lessons")
        XCTAssertEqual(collection?.totalCount, 3)
        XCTAssertEqual(collection?.items.count, 2)
        XCTAssertEqual(collection?.items[0].url, "https://www.youtube.com/watch?v=abc123")
        XCTAssertEqual(collection?.items[0].durationSeconds, 91)
        XCTAssertTrue(collection?.isTruncated == true)
    }

    func testCollectionProbeRejectsOrdinaryVideoInfo() {
        XCTAssertNil(YtDlpTool.collectionProbe(
            from: ["_type": "video", "id": "abc"],
            sourceURL: sampleURL,
            limit: 100
        ))
    }

    func testCollectionProbeDoesNotClaimAnExactDeclaredCountWasTruncated() {
        let json: [String: Any] = [
            "_type": "playlist",
            "title": "Two items",
            "playlist_count": 2,
            // This field describes the uploader, not the collection. It must
            // never leak into the item count.
            "playlist_uploader_count": 900,
            "entries": [
                ["id": "one", "title": "One"],
                ["id": "two", "title": "Two"],
            ],
        ]

        let collection = YtDlpTool.collectionProbe(
            from: json,
            sourceURL: "https://www.youtube.com/playlist?list=PL123",
            limit: 2
        )

        XCTAssertEqual(collection?.totalCount, 2)
        XCTAssertEqual(collection?.items.count, 2)
        XCTAssertFalse(collection?.isTruncated ?? true)
    }

    func testDownloadArgumentsPersistBrowserAccessChoice() {
        let args = YtDlpTool.downloadArguments(
            url: sampleURL,
            formatID: "best",
            outputTemplate: "/tmp/%(title)s.%(ext)s",
            connections: 1,
            forceOverwrite: false,
            aria2cPath: nil,
            options: .init(cookieSource: .browser("firefox"))
        )
        guard let cookieFlag = args.firstIndex(of: "--cookies-from-browser") else {
            return XCTFail("missing browser access argument")
        }
        XCTAssertEqual(args[cookieFlag + 1], "firefox")
    }

    func testListFormatsForYouTubeSample() async throws {
        try LiveNetworkGate.skipUnlessEnabled("Listing YouTube formats")
        try XCTSkipIf(!YtDlpTool.isAvailable, "yt-dlp not installed")

        let probe = try await YtDlpTool.probe(url: sampleURL)
        XCTAssertFalse(probe.formats.isEmpty, "expected quality tiers")
        XCTAssertFalse(probe.title.isEmpty)
        XCTAssertTrue(probe.formats.contains(where: { $0.label.hasSuffix("p") || $0.label == "Best" }))
        XCTAssertTrue(probe.formats[0].id.contains("bestvideo") || probe.formats[0].id.contains("bv"))
        XCTAssertNotNil(probe.formats[0].approximateBytes)
        print(
            "YTDLP",
            probe.title,
            probe.formats.map { "\($0.label) \($0.sizeText ?? "?") \($0.id)" }
        )
    }

    func testProbeCollectionForYouTubeSample() async throws {
        try LiveNetworkGate.skipUnlessEnabled("Probing a YouTube playlist")
        try XCTSkipIf(!YtDlpTool.isAvailable, "yt-dlp not installed")

        let collection = try await YtDlpTool.probeCollection(
            url: samplePlaylistURL,
            limit: 3
        )
        let result = try XCTUnwrap(collection)
        XCTAssertFalse(result.title.isEmpty)
        XCTAssertEqual(result.items.count, 3)
        XCTAssertGreaterThanOrEqual(result.totalCount, result.items.count)
        XCTAssertTrue(result.items.allSatisfy { URL(string: $0.url)?.scheme == "https" })
    }

    func testMediaPreflightForCollectionProducesPlayablePrimaryItem() async throws {
        try LiveNetworkGate.skipUnlessEnabled("Preflighting a YouTube playlist")
        try XCTSkipIf(!YtDlpTool.isAvailable, "yt-dlp not installed")

        let preflight = try await MediaPreflightStore().result(for: samplePlaylistURL)
        XCTAssertFalse(preflight.probe.formats.isEmpty)
        XCTAssertNotNil(preflight.collection)
        XCTAssertTrue(preflight.mediaURL.contains("youtube.com/watch"))
        XCTAssertNotEqual(preflight.mediaURL, preflight.resolvedURL)
    }

    func testDownloadLowestTierYouTubeSample() async throws {
        try LiveNetworkGate.skipUnlessEnabled("Downloading a YouTube sample")
        try XCTSkipIf(!YtDlpTool.isAvailable, "yt-dlp not installed")

        let formats = try await YtDlpTool.listFormats(url: sampleURL)
        guard let picked = formats.last ?? formats.first else {
            XCTFail("no formats")
            return
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ytdlp-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let dest = try await YtDlpTool.download(
            url: sampleURL,
            formatID: picked.id,
            directory: dir,
            preferredName: "ndm-sample"
        )
        let size = (try? dest.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        print("YTDLP downloaded:", dest.path, "bytes=", size, "format=", picked.label)
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.path))
        XCTAssertGreaterThan(size, 100_000)
    }
}
