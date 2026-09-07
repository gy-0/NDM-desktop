import XCTest
@testable import NDMEngine

final class MediaPreflightTests: XCTestCase {
    actor Counter {
        private(set) var value = 0
        func increment() { value += 1 }
    }

    private let sampleProbe = YtDlpProbe(
        title: "A real title",
        durationSeconds: 92,
        formats: [YtDlpFormat(id: "720", label: "720p", height: 720)],
        thumbnailURL: "https://img.example/cover.jpg",
        subtitleTracks: [YtDlpSubtitleTrack(code: "zh", displayName: "Chinese", isAutomatic: false)]
    )

    func testPreparationPlanResolvesShortMediaPagesBeforeProbe() {
        let shortLinks = [
            "https://v.douyin.com/abc/",
            "https://xhslink.com/a/abc",
            "https://b23.tv/abc",
            "https://youtu.be/abc",
        ]
        for link in shortLinks {
            XCTAssertTrue(MediaLinkClassifier.looksLikeMediaPage(link), link)
            XCTAssertTrue(MediaPreparationPlan.shouldResolveSharedLink(
                link,
                hasPreparedMetadata: false
            ), link)
            XCTAssertFalse(MediaPreparationPlan.shouldResolveSharedLink(
                link,
                hasPreparedMetadata: true
            ), link)
        }
        XCTAssertFalse(MediaPreparationPlan.shouldResolveSharedLink(
            "https://www.youtube.com/watch?v=abc",
            hasPreparedMetadata: false
        ))
    }

    func testConcurrentRequestsShareOneProbe() async throws {
        let counter = Counter()
        let expected = sampleProbe
        let store = MediaPreflightStore(
            expand: { ExpandedShortLink(originalURL: $0, resolvedURL: $0, didExpand: false) },
            probe: { _ in
                await counter.increment()
                try await Task.sleep(nanoseconds: 30_000_000)
                return expected
            }
        )

        async let first = store.result(for: "https://example.com/watch/1")
        async let second = store.result(for: "https://example.com/watch/1")
        let (a, b) = try await (first, second)
        let probeCount = await counter.value

        XCTAssertEqual(a, b)
        XCTAssertEqual(probeCount, 1)
    }

    func testExpandedAndOriginalURLsShareCachedResult() async throws {
        let counter = Counter()
        let expected = sampleProbe
        let short = "https://b23.tv/abc"
        let resolved = "https://www.bilibili.com/video/BV1"
        let store = MediaPreflightStore(
            expand: { raw in
                ExpandedShortLink(originalURL: raw, resolvedURL: resolved, didExpand: true)
            },
            probe: { _ in
                await counter.increment()
                return expected
            }
        )

        let result = try await store.result(for: short)
        let cachedByResolved = try await store.result(for: resolved)
        let probeCount = await counter.value

        XCTAssertTrue(result.didExpandShortLink)
        XCTAssertEqual(cachedByResolved, result)
        XCTAssertEqual(probeCount, 1)
    }

    func testFailureIsNotPermanentlyCached() async {
        enum SampleError: Error { case unavailable }
        let counter = Counter()
        let expected = sampleProbe
        let store = MediaPreflightStore(
            expand: { ExpandedShortLink(originalURL: $0, resolvedURL: $0, didExpand: false) },
            probe: { _ in
                await counter.increment()
                if await counter.value == 1 { throw SampleError.unavailable }
                return expected
            }
        )

        do {
            _ = try await store.result(for: "https://example.com/watch/2")
            XCTFail("Expected the first probe to fail")
        } catch {}

        let recovered = try? await store.result(for: "https://example.com/watch/2")
        let probeCount = await counter.value
        XCTAssertEqual(recovered?.probe, expected)
        XCTAssertEqual(probeCount, 2)
    }

    func testCollectionMetadataTravelsWithSingleVideoProbe() async throws {
        let expected = sampleProbe
        let collection = YtDlpCollectionProbe(
            title: "Design lessons",
            items: [
                YtDlpCollectionItem(
                    id: "one",
                    title: "First",
                    url: "https://www.youtube.com/watch?v=one"
                ),
                YtDlpCollectionItem(
                    id: "two",
                    title: "Second",
                    url: "https://www.youtube.com/watch?v=two"
                ),
            ],
            totalCount: 2,
            isTruncated: false
        )
        let store = MediaPreflightStore(
            expand: { ExpandedShortLink(originalURL: $0, resolvedURL: $0, didExpand: false) },
            probe: { _ in expected },
            probeCollection: { _ in collection }
        )

        let result = try await store.result(
            for: "https://www.youtube.com/watch?v=one&list=PL123"
        )

        XCTAssertEqual(result.collection, collection)
        XCTAssertEqual(result.mediaURL, result.resolvedURL)
    }

    func testCollectionOnlyPageFallsBackToFirstItemForQualityProbe() async throws {
        enum SampleError: Error { case noSingleVideo }
        let expected = sampleProbe
        let firstURL = "https://www.youtube.com/watch?v=first"
        let collection = YtDlpCollectionProbe(
            title: "Collection",
            items: [
                YtDlpCollectionItem(id: "first", title: "First", url: firstURL),
            ],
            totalCount: 1,
            isTruncated: false
        )
        let store = MediaPreflightStore(
            expand: { ExpandedShortLink(originalURL: $0, resolvedURL: $0, didExpand: false) },
            probe: { url in
                guard url == firstURL else { throw SampleError.noSingleVideo }
                return expected
            },
            probeCollection: { _ in collection }
        )

        let result = try await store.result(
            for: "https://www.youtube.com/playlist?list=PL123"
        )

        XCTAssertEqual(result.mediaURL, firstURL)
        XCTAssertEqual(result.probe, expected)
        XCTAssertEqual(result.collection, collection)
    }

    func testClassifierSeparatesPagesFromDirectFiles() {
        let ggufDownload = "https://hf-mirror.com/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-UD-Q4_K_XL.gguf?download=true&utm_source=chatgpt.com"
        XCTAssertTrue(MediaLinkClassifier.looksLikeMediaPage("https://youtube.com/watch?v=1"))
        XCTAssertTrue(MediaLinkClassifier.looksLikeMediaPage("https://example.com/article/1"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("https://example.com/movie.mp4"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("https://example.com/app.dmg"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("https://example.com/README.md"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("https://example.com/install.sh"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("https://example.com/payload.dat"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage(ggufDownload))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload(ggufDownload))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload("https://models.example/model.safetensors"))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload("https://models.example/model.onnx"))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload("https://models.example/model.ckpt"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage("ftp://example.com/archive.zip"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeMediaPage(
            "https://release-assets.githubusercontent.com/assets/opaque-token?response-content-disposition=attachment%3B%20filename%3DCipherTalk-Setup.dmg"
        ))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload(
            "https://release-assets.githubusercontent.com/assets/opaque-token",
            suggestedFilename: "CipherTalk-Setup.dmg"
        ))
        XCTAssertTrue(MediaLinkClassifier.looksLikeCollectionURL(
            "https://www.youtube.com/watch?v=one&list=PL123"
        ))
        XCTAssertTrue(MediaLinkClassifier.looksLikeCollectionURL(
            "https://www.bilibili.com/medialist/play/123"
        ))
        XCTAssertFalse(MediaLinkClassifier.looksLikeCollectionURL(
            "https://www.youtube.com/watch?v=one"
        ))
        XCTAssertTrue(MediaLinkClassifier.hasExplicitSingleMedia(
            "https://www.youtube.com/watch?v=one&list=PL123"
        ))
        XCTAssertFalse(MediaLinkClassifier.hasExplicitSingleMedia(
            "https://www.youtube.com/playlist?list=PL123"
        ))
    }

    func testPageResolverIsNotUsedForOrdinaryFilesOnVideoSites() {
        let bilibiliPage = "https://www.bilibili.com/video/BV1GJ411x7h7"
        let appPage = "https://app.bilibili.com/?spm_id_from=333.1007.0.0"
        let dmg = "https://dl.hdslb.com/mobile/fixed/pc_electron_mac/bili_mac.dmg?v=1.17.9"
        let telemetry = "https://data.bilibili.com/log/web.txt"

        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload(dmg))
        XCTAssertTrue(MediaLinkClassifier.looksLikeOrdinaryFileDownload(telemetry))
        XCTAssertFalse(MediaLinkClassifier.shouldPreferPageResolver(
            url: dmg,
            ltype: "normal",
            pageURL: appPage
        ))
        XCTAssertFalse(MediaLinkClassifier.shouldPreferPageResolver(
            url: telemetry,
            ltype: "normal",
            pageURL: bilibiliPage
        ))
        XCTAssertTrue(MediaLinkClassifier.shouldPreferPageResolver(
            url: "https://upos.example/segment.mp4",
            ltype: "media",
            pageURL: bilibiliPage
        ))
    }

    func testOrdinaryFileDownloadsStayOnTheNeatEngine() {
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(url: "https://example.com/app.dmg"),
            "normal"
        )
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(url: "https://cdn.example.com/payload?id=9"),
            "normal"
        )
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(
                url: "https://dl.hdslb.com/mobile/fixed/pc_electron_mac/bili_mac.dmg"
            ),
            "normal"
        )
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(url: "https://www.youtube.com/watch?v=sAE7DU-g7VM"),
            "normal"
        )
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(
                url: "https://www.youtube.com/watch?v=sAE7DU-g7VM",
                requestedType: "ytdlp"
            ),
            "ytdlp"
        )
        XCTAssertEqual(
            MediaLinkClassifier.engineLinkType(
                url: "https://cdn.example.com/opaque",
                formatID: "136+140"
            ),
            "ytdlp"
        )
        XCTAssertFalse(MediaLinkClassifier.looksLikeVideoSitePage("https://github.com/foo/bar/releases/tag/v1"))
        XCTAssertTrue(MediaLinkClassifier.looksLikeVideoSitePage("https://www.youtube.com/watch?v=1"))
        XCTAssertFalse(MediaLinkClassifier.looksLikeVideoSitePage("https://www.bilibili.com/app.dmg"))
    }
}
