import XCTest
@testable import NDMCore

final class TranscriptionPlanTests: XCTestCase {
    /// The identifiers here are the ones the system actually reported on a stock
    /// machine, not invented shapes.
    private let systemSupported = [
        "zh_CN", "zh_TW", "zh_HK", "en_US", "en_GB", "ja_JP", "ko_KR", "de_DE", "fr_FR",
    ]

    private func environment(
        supported: [String]? = nil,
        installed: [String] = ["zh_CN", "en_US"],
        preferred: [String] = ["en-US"]
    ) -> TranscriptionWorkflow.Environment {
        TranscriptionWorkflow.Environment(
            isSupportedByOS: true,
            supportedLocaleIdentifiers: supported ?? systemSupported,
            installedLocaleIdentifiers: installed,
            preferredLanguages: preferred
        )
    }

    private func decide(
        file: String = "/tmp/clip.mp4",
        pageURL: String? = nil,
        pageTitle: String? = nil,
        environment env: TranscriptionWorkflow.Environment? = nil,
        exists: Bool = true
    ) -> TranscriptionWorkflow.Decision {
        TranscriptionWorkflow.decide(
            fileURL: URL(fileURLWithPath: file),
            pageURL: pageURL,
            pageTitle: pageTitle,
            environment: env ?? environment(),
            fileExists: { _ in exists }
        )
    }

    // MARK: - Gating

    func testMissingFileIsReportedBeforeAnythingElse() {
        XCTAssertEqual(decide(exists: false).unavailableReason, .noMediaFile)
    }

    func testNonMediaFileIsRejected() {
        XCTAssertEqual(decide(file: "/tmp/report.pdf").unavailableReason, .unsupportedFileType)
    }

    func testAudioOnlyFilesQualify() {
        for ext in ["mp3", "m4a", "flac", "wav", "opus"] {
            XCTAssertNotNil(
                decide(file: "/tmp/talk.\(ext)").plan,
                "\(ext) carries speech and must qualify"
            )
        }
    }

    func testOldSystemGatesTheFeatureRatherThanDegradingIt() {
        let decision = decide(environment: .unsupported)
        XCTAssertEqual(decision.unavailableReason, .systemTooOld)
    }

    /// File facts outrank system facts: telling someone to upgrade macOS when the
    /// file is simply gone would send them down the wrong path.
    func testAMissingFileOutranksAnOldSystem() {
        let decision = decide(environment: .unsupported, exists: false)
        XCTAssertEqual(decision.unavailableReason, .noMediaFile)
    }

    func testNoUsableLanguageIsItsOwnReason() {
        let decision = decide(
            pageTitle: "Untitled",
            environment: environment(supported: ["is_IS"], installed: [], preferred: ["nl-NL"])
        )
        XCTAssertEqual(decision.unavailableReason, .noSupportedLanguage)
    }

    // MARK: - Language choice

    /// A Bilibili video is spoken Chinese whatever the user's interface language,
    /// so the site must outrank the system preference.
    func testSiteBeatsSystemPreference() throws {
        let plan = try XCTUnwrap(decide(
            pageURL: "https://www.bilibili.com/video/BV1GJ411x7h7",
            pageTitle: "Never Gonna Give You Up",
            environment: environment(preferred: ["en-US"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "zh_CN")
        XCTAssertEqual(plan.source, .site)
    }

    func testDomesticSitesAllResolveToSimplifiedChinese() throws {
        for url in [
            "https://www.douyin.com/video/123",
            "https://www.xiaohongshu.com/explore/abc",
            "https://xhslink.com/a/abc",
            "https://b23.tv/abc",
            "https://weibo.com/1/abc",
            "https://v.kuaishou.com/abc",
            "https://www.iqiyi.com/v_abc.html",
        ] {
            let plan = try XCTUnwrap(decide(pageURL: url).plan, url)
            XCTAssertEqual(plan.localeIdentifier, "zh_CN", url)
        }
    }

    func testRegionalDomainsPickTheMatchingScript() throws {
        XCTAssertEqual(
            try XCTUnwrap(decide(pageURL: "https://news.example.tw/v").plan).localeIdentifier,
            "zh_TW"
        )
        XCTAssertEqual(
            try XCTUnwrap(decide(pageURL: "https://example.co.jp/v").plan).localeIdentifier,
            "ja_JP"
        )
    }

    /// Global platforms must NOT be guessed from the domain — a YouTube video can
    /// be in any language, so the title and the user's own languages decide.
    func testGlobalPlatformsAreNotGuessedFromTheDomain() {
        XCTAssertNil(TranscriptionWorkflow.siteLanguageTag("https://www.youtube.com/watch?v=abc"))
        XCTAssertNil(TranscriptionWorkflow.siteLanguageTag("https://www.tiktok.com/@a/video/1"))
        XCTAssertNil(TranscriptionWorkflow.siteLanguageTag("https://vimeo.com/123"))
    }

    func testTitleScriptDecidesWhenTheSiteCannot() throws {
        let plan = try XCTUnwrap(decide(
            pageURL: "https://www.youtube.com/watch?v=abc",
            pageTitle: "大模型中转站，怎么便宜？",
            environment: environment(preferred: ["en-US"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "zh_CN")
        XCTAssertEqual(plan.source, .titleScript)
    }

    func testTraditionalTitleResolvesToTraditional() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "這個影片是繁體中文的說明",
            environment: environment(preferred: ["en-US"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "zh_TW")
    }

    /// Japanese writes with Han characters too, so kana must settle it — otherwise
    /// every Japanese video would be transcribed as Chinese.
    func testKanaWinsOverHan() {
        XCTAssertEqual(TranscriptionWorkflow.scriptLanguageTag("日本語のテスト動画"), "ja")
    }

    func testHangulIsDetected() {
        XCTAssertEqual(TranscriptionWorkflow.scriptLanguageTag("한국어 테스트"), "ko")
    }

    func testLatinTitleCarriesNoScriptSignal() {
        XCTAssertNil(TranscriptionWorkflow.scriptLanguageTag("A Better Download"))
        XCTAssertNil(TranscriptionWorkflow.scriptLanguageTag(""))
        XCTAssertNil(TranscriptionWorkflow.scriptLanguageTag(nil))
    }

    func testSystemPreferenceUsedWhenNoOtherSignal() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "Weekly Review",
            environment: environment(preferred: ["ja-JP", "en-US"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "ja_JP")
        XCTAssertEqual(plan.source, .systemPreference)
    }

    func testUnsupportedPreferenceFallsThroughToTheNextOne() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "Weekly Review",
            environment: environment(preferred: ["is-IS", "ko-KR"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "ko_KR")
    }

    func testEnglishIsTheLastResortAndSaysSo() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "Weekly Review",
            environment: environment(preferred: ["is-IS"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "en_US")
        XCTAssertEqual(
            plan.source,
            .englishFallback,
            "an admitted guess must be recorded as one"
        )
    }

    // MARK: - Download need

    func testSupportedButNotInstalledNeedsADownload() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "한국어 테스트",
            environment: environment(installed: ["zh_CN", "en_US"])
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "ko_KR")
        XCTAssertTrue(plan.needsLanguageDownload)
    }

    func testAlreadyInstalledNeedsNoDownload() throws {
        let plan = try XCTUnwrap(decide(
            pageURL: "https://www.bilibili.com/video/BV1",
            environment: environment(installed: ["zh_CN"])
        ).plan)
        XCTAssertFalse(
            plan.needsLanguageDownload,
            "zh_CN ships installed on a stock machine; do not ask for a download"
        )
    }

    func testInstalledComparisonIgnoresIdentifierSpelling() throws {
        let plan = try XCTUnwrap(decide(
            pageURL: "https://www.bilibili.com/video/BV1",
            environment: environment(installed: ["zh-cn"])
        ).plan)
        XCTAssertFalse(
            plan.needsLanguageDownload,
            "zh-cn and zh_CN are the same language pack"
        )
    }

    // MARK: - Identifier matching

    func testMatchingAcceptsBothSpellings() {
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh-Hans", in: systemSupported), "zh_CN")
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh_CN", in: systemSupported), "zh_CN")
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh-Hans-CN", in: systemSupported), "zh_CN")
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh-Hant", in: systemSupported), "zh_TW")
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh-HK", in: systemSupported), "zh_TW")
    }

    /// `zh-Hans-US` is what this machine actually reports: a Simplified user in a
    /// non-Chinese region. Keying off the region instead of the script would send
    /// them to a Traditional model whenever the supported list happened to list
    /// zh_TW first.
    func testRealWorldPreferredLanguageShapesResolveByScript() {
        XCTAssertEqual(
            TranscriptionWorkflow.match(tag: "zh-Hans-US", in: ["zh_TW", "zh_HK", "zh_CN"]),
            "zh_CN"
        )
        XCTAssertEqual(
            TranscriptionWorkflow.match(tag: "zh-Hant-US", in: ["zh_CN", "zh_TW"]),
            "zh_TW"
        )
        XCTAssertEqual(
            TranscriptionWorkflow.match(tag: "zh", in: ["zh_TW", "zh_CN"]),
            "zh_CN",
            "bare zh means Simplified for the mainstream user"
        )
    }

    func testPreferredLanguagesFromThisMachineProduceAChinesePlan() throws {
        let plan = try XCTUnwrap(decide(
            pageTitle: "Weekly Review",
            environment: environment(
                supported: ["zh_TW", "zh_HK", "zh_CN", "en_US"],
                installed: ["zh_CN"],
                preferred: ["zh-Hans-US", "en-US"]
            )
        ).plan)
        XCTAssertEqual(plan.localeIdentifier, "zh_CN")
        XCTAssertEqual(plan.source, .systemPreference)
        XCTAssertFalse(plan.needsLanguageDownload)
    }

    func testMatchingFallsBackToTheBaseLanguage() {
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "de-AT", in: systemSupported), "de_DE")
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "en-CA", in: systemSupported), "en_US")
    }

    func testMatchingReturnsNilRatherThanAWrongLanguage() {
        XCTAssertNil(TranscriptionWorkflow.match(tag: "is-IS", in: systemSupported))
        XCTAssertNil(TranscriptionWorkflow.match(tag: "zh-Hans", in: []))
    }

    /// The identifier handed back must be the system's own spelling, or the engine
    /// will not recognise it.
    func testMatchPreservesTheSystemSpelling() {
        XCTAssertEqual(TranscriptionWorkflow.match(tag: "zh-Hans", in: ["ZH_cn"]), "ZH_cn")
    }

    // MARK: - Wording

    func testReasonsAreFreeOfImplementationVocabulary() {
        for reason in TranscriptionWorkflow.UnavailableReason.allCases {
            let combined = (reason.title + " " + reason.detail).lowercased()
            for jargon in [
                "speech", "whisper", "codec", "locale", "framework",
                "ffmpeg", "api", "model", "transcriber",
            ] {
                XCTAssertFalse(
                    combined.contains(jargon),
                    "\(reason.rawValue) exposes \(jargon.debugDescription) to the user"
                )
            }
            XCTAssertFalse(reason.title.isEmpty)
            XCTAssertFalse(reason.detail.isEmpty)
        }
    }
}

final class TranscriptionSupportedFormatTests: XCTestCase {
    /// Caught by running the CLI rather than by any unit test: the engine tests call
    /// the engine directly and never pass through this gate, so an eligible file being
    /// rejected here was invisible to them.
    func testStandardMacAudioContainersAreEligible() {
        for ext in ["aiff", "aif", "caf", "wav", "m4a", "mp3", "flac"] {
            XCTAssertTrue(
                TranscriptionWorkflow.supports(
                    fileURL: URL(fileURLWithPath: "/tmp/recording.\(ext)")
                ),
                ".\(ext) holds speech this Mac can read"
            )
        }
    }

    /// `say` writes AIFF, and it is what the repository's own tests transcribe — the
    /// gate must accept what the project itself produces.
    func testTheFormatOurOwnToolingProducesIsEligible() {
        XCTAssertTrue(
            TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/a.aiff"))
        )
    }

    /// An audiobook is the most obviously transcribable file there is.
    func testAudiobooksAreEligible() {
        XCTAssertTrue(
            TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/book.m4b"))
        )
    }

    func testNonMediaStaysIneligible() {
        for ext in ["pdf", "zip", "txt", "srt", "dmg", "html"] {
            XCTAssertFalse(
                TranscriptionWorkflow.supports(
                    fileURL: URL(fileURLWithPath: "/tmp/file.\(ext)")
                ),
                ".\(ext) has no speech in it"
            )
        }
    }

    func testExtensionMatchingIgnoresCase() {
        XCTAssertTrue(
            TranscriptionWorkflow.supports(fileURL: URL(fileURLWithPath: "/tmp/A.AIFF"))
        )
    }
}
