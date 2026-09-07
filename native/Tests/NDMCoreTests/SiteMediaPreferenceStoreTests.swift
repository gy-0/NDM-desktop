import XCTest
@testable import NDMCore

final class SiteMediaPreferenceStoreTests: XCTestCase {
    private func makeDefaults() -> (UserDefaults, String) {
        let suiteName = "dev.ndm.open.site-preferences.tests.\(UUID().uuidString)"
        return (UserDefaults(suiteName: suiteName)!, suiteName)
    }

    func testCanonicalizesKnownSiteFamiliesAndShortLinks() {
        XCTAssertEqual(
            SiteMediaPreferenceStore.canonicalSiteKey(for: "https://m.youtube.com/watch?v=1"),
            "youtube.com"
        )
        XCTAssertEqual(
            SiteMediaPreferenceStore.canonicalSiteKey(for: "youtu.be/abc"),
            "youtube.com"
        )
        XCTAssertEqual(
            SiteMediaPreferenceStore.canonicalSiteKey(for: "https://www.bilibili.com/video/BV1"),
            "bilibili.com"
        )
        XCTAssertEqual(
            SiteMediaPreferenceStore.canonicalSiteKey(for: "https://v.douyin.com/example"),
            "douyin.com"
        )
        XCTAssertEqual(
            SiteMediaPreferenceStore.canonicalSiteKey(for: "https://xhslink.com/a/xyz"),
            "xiaohongshu.com"
        )
    }

    func testRoundTripIsScopedToCanonicalSite() throws {
        let (defaults, suiteName) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let preference = SiteMediaPreference(
            qualityHeight: 1080,
            container: .compactMKV,
            subtitleLanguage: "zh-Hans"
        )

        SiteMediaPreferenceStore.save(
            preference,
            for: "https://music.youtube.com/watch?v=abc",
            defaults: defaults
        )

        XCTAssertEqual(
            SiteMediaPreferenceStore.load(for: "youtu.be/xyz", defaults: defaults),
            preference
        )
        XCTAssertNil(
            SiteMediaPreferenceStore.load(for: "vimeo.com/xyz", defaults: defaults)
        )

        let data = try XCTUnwrap(defaults.data(forKey: SiteMediaPreferenceStore.storageKey))
        let json = try XCTUnwrap(String(data: data, encoding: .utf8))
        XCTAssertTrue(json.contains("youtube.com"))
        XCTAssertFalse(json.contains("music.youtube.com"))
        XCTAssertFalse(json.contains("watch?v=abc"))
        XCTAssertFalse(json.contains("xyz"))
    }

    func testResolveRestoresExactChoices() {
        let preference = SiteMediaPreference(
            qualityHeight: 720,
            container: .compactMKV,
            subtitleLanguage: "en"
        )
        XCTAssertEqual(
            preference.resolved(
                formatHeights: [1080, 720, 480],
                subtitleCodes: ["zh-Hans", "en"]
            ),
            SiteMediaPreferenceResolution(
                selectedFormatIndex: 1,
                container: .compactMKV,
                subtitleLanguage: "en"
            )
        )
    }

    func testResolveFallsBackToRecommendedQualityAndNoSubtitle() {
        let preference = SiteMediaPreference(
            qualityHeight: 2160,
            container: .compatibleMP4,
            subtitleLanguage: "ja"
        )
        XCTAssertEqual(
            preference.resolved(
                formatHeights: [1080, 720, 480],
                subtitleCodes: ["en"]
            ),
            SiteMediaPreferenceResolution(
                selectedFormatIndex: 0,
                container: .compatibleMP4,
                subtitleLanguage: nil
            )
        )
    }

    func testExactResolutionNeverSilentlySubstitutesQuickChoice() {
        let preference = SiteMediaPreference(
            qualityHeight: 1080,
            container: .compactMKV,
            subtitleLanguage: "zh-Hans"
        )
        XCTAssertEqual(
            preference.exactResolution(
                formatHeights: [2160, 1080, 720],
                subtitleCodes: ["en", "zh-Hans"]
            )?.selectedFormatIndex,
            1
        )
        XCTAssertNil(preference.exactResolution(
            formatHeights: [720, 480],
            subtitleCodes: ["zh-Hans"]
        ))
        XCTAssertNil(preference.exactResolution(
            formatHeights: [1080, 720],
            subtitleCodes: ["en"]
        ))
    }

    func testMalformedPayloadIsIgnored() {
        let (defaults, suiteName) = makeDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(Data("not-json".utf8), forKey: SiteMediaPreferenceStore.storageKey)
        XCTAssertNil(
            SiteMediaPreferenceStore.load(for: "youtube.com", defaults: defaults)
        )
    }
}
