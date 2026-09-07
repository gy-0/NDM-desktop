import XCTest
@testable import NDMCore

final class TranscriptionScopeTests: XCTestCase {
    /// Off by default. Reading speech is fast but a long lecture is still minutes of
    /// sustained CPU, it writes files nobody asked for, and a large share of audio
    /// downloads are music — where a transcript is nonsense.
    func testAutomaticTranscriptionIsOffUntilChosen() {
        let settings = AppSettings()
        XCTAssertEqual(settings.transcriptionScopePreference, .off)
        for category in DownloadCategory.allCases {
            XCTAssertFalse(
                settings.transcribesAutomatically(category: category),
                "\(category) must not be transcribed without being asked"
            )
        }
    }

    func testAudioOnlyScopeCoversAudioAndNothingElse() {
        var settings = AppSettings()
        settings.transcriptionScope = .audioOnly
        XCTAssertTrue(settings.transcribesAutomatically(category: .audio))
        for category in DownloadCategory.allCases where category != .audio {
            XCTAssertFalse(settings.transcribesAutomatically(category: category))
        }
    }

    /// "Everything" still means spoken media. A transcript of a zip file is not a
    /// thing, and attempting one would waste time and produce an error.
    func testEverythingScopeStopsAtSpokenMedia() {
        var settings = AppSettings()
        settings.transcriptionScope = .everything
        XCTAssertTrue(settings.transcribesAutomatically(category: .audio))
        XCTAssertTrue(settings.transcribesAutomatically(category: .video))
        for category in DownloadCategory.allCases
        where category != .audio && category != .video {
            XCTAssertFalse(
                settings.transcribesAutomatically(category: category),
                "\(category) contains no speech"
            )
        }
    }

    func testTextFileIsWrittenByDefault() {
        XCTAssertTrue(AppSettings().transcriptionWritesTextFileEnabled)
        var settings = AppSettings()
        settings.transcriptionWritesTextFile = false
        XCTAssertFalse(settings.transcriptionWritesTextFileEnabled)
    }

    func testLanguageOverrideIsAutomaticUntilSet() {
        XCTAssertNil(
            AppSettings().transcriptionLanguage,
            "nil means let the planner decide, which is right more often than a fixed choice"
        )
    }

    func testEveryScopeHasWording() {
        for scope in TranscriptionScope.allCases {
            XCTAssertFalse(scope.settingsTitle.isEmpty)
            let lowered = scope.settingsTitle.lowercased()
            for jargon in ["transcribe", "speech", "asr", "srt", "locale"] {
                XCTAssertFalse(
                    lowered.contains(jargon),
                    "\(scope) exposes \(jargon.debugDescription)"
                )
            }
        }
    }
}

final class TranscriptionLanguageValidationTests: XCTestCase {
    func testPlausibleTagsAreAccepted() {
        for tag in ["zh", "zh-CN", "zh-Hans", "zh-Hans-CN", "en", "en-US", "yue-Hant-HK"] {
            XCTAssertEqual(
                SettingsInputValidation.transcriptionLanguageTag(tag),
                tag,
                "\(tag) is a well-formed tag"
            )
        }
    }

    func testWhitespaceIsTrimmed() {
        XCTAssertEqual(
            SettingsInputValidation.transcriptionLanguageTag("  zh-Hans \n"),
            "zh-Hans"
        )
    }

    /// A typo must become "automatic" rather than a setting that looks applied and
    /// silently never matches anything.
    func testNonsenseIsRejectedRatherThanStored() {
        for bad in [
            "", "   ", "chinese please", "z", "zh_CN", "zh--CN",
            "zh-", "-zh", "toolongtag", "zh-Hans-CN-extra", "zh-中文", "1234",
        ] {
            XCTAssertNil(
                SettingsInputValidation.transcriptionLanguageTag(bad),
                "\(bad.debugDescription) must not be accepted"
            )
        }
    }

    /// This validator checks *shape*, not availability: which languages exist is the
    /// running system's answer, so a valid-looking tag this Mac cannot do is still
    /// accepted here and resolved later.
    func testAWellFormedButUnavailableTagIsStillAccepted() {
        XCTAssertEqual(
            SettingsInputValidation.transcriptionLanguageTag("is-IS"),
            "is-IS"
        )
    }
}

final class SettingsPersistenceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        suiteName = "ndm.settings.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
    }

    func testTranscriptionSettingsSurviveARoundTrip() {
        var settings = AppSettings()
        settings.transcriptionScope = .audioOnly
        settings.transcriptionLanguage = "zh-Hans"
        settings.transcriptionWritesTextFile = false
        SettingsStore.save(settings, defaults: defaults)

        let loaded = SettingsStore.load(defaults: defaults)
        XCTAssertEqual(loaded.transcriptionScope, .audioOnly)
        XCTAssertEqual(loaded.transcriptionLanguage, "zh-Hans")
        XCTAssertEqual(loaded.transcriptionWritesTextFile, false)
    }

    /// Pre-existing bug, fixed here: mediaQuality was absent from the persisted
    /// shape entirely, so the settings window wrote a choice that was discarded on
    /// the next launch. No error, it simply never stuck.
    func testMediaQualityChoiceSurvivesARelaunch() {
        var settings = AppSettings()
        settings.mediaQuality = .maxHeight(1080)
        SettingsStore.save(settings, defaults: defaults)

        let loaded = SettingsStore.load(defaults: defaults)
        XCTAssertEqual(
            loaded.mediaQuality,
            .maxHeight(1080),
            "a chosen quality must not be silently forgotten"
        )
        XCTAssertEqual(loaded.mediaQualityPreference, .maxHeight(1080))
    }

    func testMediaQualityAskIsAlsoPreserved() {
        var settings = AppSettings()
        settings.mediaQuality = .ask
        SettingsStore.save(settings, defaults: defaults)
        XCTAssertEqual(SettingsStore.load(defaults: defaults).mediaQuality, .ask)
    }

    /// A settings blob written before these fields existed must still load, with the
    /// new options simply unset.
    func testOlderStoredSettingsStillLoad() {
        var settings = AppSettings()
        settings.maxConnections = 7
        SettingsStore.save(settings, defaults: defaults)

        let loaded = SettingsStore.load(defaults: defaults)
        XCTAssertEqual(loaded.maxConnections, 7)
        XCTAssertNil(loaded.transcriptionScope)
        XCTAssertEqual(loaded.transcriptionScopePreference, .off)
        XCTAssertTrue(loaded.transcriptionWritesTextFileEnabled)
    }

    func testUnknownScopeValueFallsBackToAskingRatherThanGuessing() {
        var settings = AppSettings()
        settings.transcriptionScope = .everything
        SettingsStore.save(settings, defaults: defaults)

        // Simulate a value written by a newer build.
        var raw = try! JSONSerialization.jsonObject(
            with: defaults.data(forKey: "AppSettingsJSON")!
        ) as! [String: Any]
        raw["transcriptionScope"] = "someFutureMode"
        defaults.set(try! JSONSerialization.data(withJSONObject: raw), forKey: "AppSettingsJSON")

        let loaded = SettingsStore.load(defaults: defaults)
        XCTAssertNil(loaded.transcriptionScope)
        XCTAssertEqual(
            loaded.transcriptionScopePreference,
            .off,
            "an unrecognised mode must not turn automatic work on"
        )
    }
}
