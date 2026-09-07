import XCTest
@testable import NDMCore

final class SharedLinkResolverTests: XCTestCase {
    func testDirectYouTubeURLStaysDirect() {
        let result = SharedLinkResolver.resolve("https://www.youtube.com/watch?v=abc123")
        XCTAssertEqual(result?.urlString, "https://www.youtube.com/watch?v=abc123")
        XCTAssertEqual(result?.source, .youtube)
        XCTAssertEqual(result?.wasExtractedFromText, false)
    }

    func testExtractsDouyinURLFromFullShareCommand() {
        let result = SharedLinkResolver.resolve(
            "8.93 复制打开抖音，看看【一个很棒的视频】 https://v.douyin.com/iABC123/ 03/07 abc:/"
        )
        XCTAssertEqual(result?.urlString, "https://v.douyin.com/iABC123/")
        XCTAssertEqual(result?.source, .douyin)
        XCTAssertEqual(result?.wasExtractedFromText, true)
        XCTAssertEqual(
            result?.inputText,
            "8.93 复制打开抖音，看看【一个很棒的视频】 https://v.douyin.com/iABC123/ 03/07 abc:/"
        )
    }

    func testExtractsXiaohongshuURLAndTrimsChinesePunctuation() {
        let result = SharedLinkResolver.resolve(
            "打开小红书查看笔记\nhttp://xhslink.com/a/AbC123，复制本条信息后打开 App。"
        )
        XCTAssertEqual(result?.urlString, "http://xhslink.com/a/AbC123")
        XCTAssertEqual(result?.source, .xiaohongshu)
    }

    func testKnownMediaURLWinsOverUnrelatedURL() {
        let result = SharedLinkResolver.resolve(
            "帮助：https://example.com/help 视频：https://b23.tv/AbCdEf"
        )
        XCTAssertEqual(result?.urlString, "https://b23.tv/AbCdEf")
        XCTAssertEqual(result?.source, .bilibili)
    }

    func testRecognizesSchemeLessKnownShortLink() {
        let result = SharedLinkResolver.resolve("复制打开：v.douyin.com/iNoScheme/")
        XCTAssertEqual(result?.urlString, "https://v.douyin.com/iNoScheme/")
        XCTAssertEqual(result?.source, .douyin)
    }

    func testRecognizesBareIesdouyinHostAsDouyin() {
        let result = SharedLinkResolver.resolve("https://iesdouyin.com/share/video/123")
        XCTAssertEqual(result?.source, .douyin)
        let subdomain = SharedLinkResolver.resolve("https://www.iesdouyin.com/share/video/123")
        XCTAssertEqual(subdomain?.source, .douyin)
    }

    func testRecognizesSchemeLessTikTokShareLink() {
        let result = SharedLinkResolver.resolve("Watch this: vm.tiktok.com/ZMExample/")
        XCTAssertEqual(result?.urlString, "https://vm.tiktok.com/ZMExample/")
        XCTAssertEqual(result?.source, .tiktok)
        XCTAssertTrue(result?.wasExtractedFromText == true)
    }

    func testNormalizesFullWidthAndInvisibleCharactersFromShareSheets() {
        let result = SharedLinkResolver.resolve(
            "复制打开：ｈｔｔｐｓ：／／ｖ．ｄｏｕｙｉｎ．ｃｏｍ／ＡｂＣ１２３／，查看视频"
        )
        XCTAssertEqual(result?.urlString, "https://v.douyin.com/AbC123/")
        XCTAssertEqual(result?.source, .douyin)
        XCTAssertTrue(result?.wasExtractedFromText == true)

        let invisible = SharedLinkResolver.resolve(
            "看看 https://b23.\u{200B}tv/BV1Magic"
        )
        XCTAssertEqual(invisible?.urlString, "https://b23.tv/BV1Magic")
        XCTAssertEqual(invisible?.source, .bilibili)
    }

    func testDecodesHTMLAmpersandWithoutDiscardingQueryParameters() {
        let result = SharedLinkResolver.resolve(
            "Watch https://www.youtube.com/watch?v=abc123&amp;list=PLMagic"
        )
        XCTAssertEqual(
            result?.urlString,
            "https://www.youtube.com/watch?v=abc123&list=PLMagic"
        )
    }

    func testRecognizesMoreMediaShareHostsWithoutScheme() {
        let cases: [(String, SharedLinkResolution.Source)] = [
            ("v.kuaishou.com/AbC123", .kuaishou),
            ("www.instagram.com/reel/Example/", .instagram),
            ("x.com/example/status/123", .x),
            ("fb.watch/AbC123/", .facebook),
            ("vimeo.com/123456", .vimeo),
            ("www.twitch.tv/videos/123456", .twitch),
            ("dai.ly/x12345", .dailymotion),
            ("m.weibo.cn/status/123456", .weibo),
        ]
        for (input, expected) in cases {
            let result = SharedLinkResolver.resolve("Shared with you: \(input)")
            XCTAssertEqual(result?.source, expected, input)
            XCTAssertTrue(result?.urlString.hasPrefix("https://") == true, input)
        }
    }

    func testKnownMediaLinkStillWinsWhenGenericLinkAppearsFirst() {
        let result = SharedLinkResolver.resolve(
            "Terms https://example.com/legal and clip www.instagram.com/reel/Magic/"
        )
        XCTAssertEqual(result?.urlString, "https://www.instagram.com/reel/Magic/")
        XCTAssertEqual(result?.source, .instagram)
    }

    func testDirectFileWinsOverGenericLandingPage() {
        let result = SharedLinkResolver.resolve(
            "Page https://example.com/download then file https://cdn.example.com/movie.mp4"
        )
        XCTAssertEqual(result?.urlString, "https://cdn.example.com/movie.mp4")
    }

    func testValidASCIIURLPunctuationInsidePathAndQueryIsPreserved() {
        let url = "https://example.com/a;b,c?items=1,2&next=/watch(v2)#part"
        let result = SharedLinkResolver.resolve(url)
        XCTAssertEqual(result?.urlString, url)
        XCTAssertFalse(result?.wasExtractedFromText ?? true)
    }

    func testRejectsOversizedClipboardPayload() {
        XCTAssertNil(SharedLinkResolver.resolve(
            String(repeating: "x", count: 32_769) + " https://youtu.be/abc"
        ))
    }

    func testRejectsTextWithoutLink() {
        XCTAssertNil(SharedLinkResolver.resolve("只有标题，没有任何链接"))
    }
}
