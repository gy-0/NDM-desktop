import XCTest
@testable import NDMCore

final class LanguageAssetReadinessTests: XCTestCase {
    func testInstalledIsReady() {
        XCTAssertEqual(
            LanguageAssetReadiness.from(isInstalled: true, isSupported: true),
            .ready
        )
    }

    /// Installed always wins, even if the supported list somehow disagrees — a
    /// language present on disk is usable regardless of what else is reported.
    func testInstalledWinsOverAMissingSupportedEntry() {
        XCTAssertEqual(
            LanguageAssetReadiness.from(isInstalled: true, isSupported: false),
            .ready
        )
    }

    func testSupportedButNotInstalledNeedsPreparation() {
        XCTAssertEqual(
            LanguageAssetReadiness.from(isInstalled: false, isSupported: true),
            .needsPreparation
        )
    }

    func testNeitherInstalledNorSupportedIsUnsupported() {
        XCTAssertEqual(
            LanguageAssetReadiness.from(isInstalled: false, isSupported: false),
            .unsupported
        )
    }

    func testWaitingStatesAreExactlyTheOnesWorthShowingAStageFor() {
        XCTAssertTrue(LanguageAssetReadiness.needsPreparation.isWaiting)
        XCTAssertTrue(LanguageAssetReadiness.preparing(fraction: nil).isWaiting)
        XCTAssertTrue(LanguageAssetReadiness.preparing(fraction: 0.4).isWaiting)
        XCTAssertFalse(LanguageAssetReadiness.ready.isWaiting)
        XCTAssertFalse(LanguageAssetReadiness.unsupported.isWaiting)
    }

    /// A freshly created installation request reports an indeterminate progress
    /// with a zero total. Presenting that as 0% would be a made-up number shown to
    /// someone who is already waiting.
    func testIndeterminatePreparationHasNoFractionRatherThanZero() {
        XCTAssertNil(LanguageAssetReadiness.preparing(fraction: nil).fraction)
        XCTAssertEqual(LanguageAssetReadiness.preparing(fraction: 0.0).fraction, 0.0)
        XCTAssertNotEqual(
            LanguageAssetReadiness.preparing(fraction: nil),
            .preparing(fraction: 0.0),
            "unknown and zero are different states"
        )
    }

    func testOnlyReadyReportsReady() {
        XCTAssertTrue(LanguageAssetReadiness.ready.isReady)
        for other: LanguageAssetReadiness in [
            .needsPreparation, .preparing(fraction: nil), .preparing(fraction: 1.0), .unsupported,
        ] {
            XCTAssertFalse(other.isReady, "\(other) must not claim readiness")
        }
    }

    func testWordingNamesTheLanguageAndStaysFreeOfJargon() {
        let states: [LanguageAssetReadiness] = [
            .ready, .needsPreparation, .preparing(fraction: 0.5), .unsupported,
        ]
        for state in states {
            let title = state.title(languageName: "中文")
            let detail = state.detail(languageName: "中文")
            XCTAssertFalse(title.isEmpty)
            XCTAssertFalse(detail.isEmpty)
            let combined = (title + " " + detail).lowercased()
            for jargon in [
                "speech", "asset", "locale", "model", "framework",
                "download and install", "api", "transcriber", "inventory",
            ] {
                XCTAssertFalse(
                    combined.contains(jargon),
                    "\(state) exposes \(jargon.debugDescription) to the user"
                )
            }
        }
    }

    /// The waiting states have to name the language, or the user is looking at a
    /// nameless delay.
    func testWaitingStatesMentionTheLanguage() {
        XCTAssertTrue(LanguageAssetReadiness.needsPreparation.title(languageName: "中文").contains("中文"))
        XCTAssertTrue(LanguageAssetReadiness.preparing(fraction: nil).title(languageName: "中文").contains("中文"))
    }

    /// A one-off cost is much easier to accept when it is stated as one-off.
    func testPreparationWordingSaysItHappensOnce() {
        let detail = LanguageAssetReadiness.needsPreparation.detail(languageName: "中文")
        XCTAssertTrue(
            detail.contains("一次") || detail.lowercased().contains("once"),
            "detail was \(detail.debugDescription)"
        )
    }

    /// Waiting is only tolerable if the user knows it resumes by itself.
    func testPreparingWordingPromisesItContinuesAutomatically() {
        let detail = LanguageAssetReadiness.preparing(fraction: nil).detail(languageName: "中文")
        XCTAssertTrue(
            detail.contains("自动") || detail.lowercased().contains("on its own"),
            "detail was \(detail.debugDescription)"
        )
    }
}
