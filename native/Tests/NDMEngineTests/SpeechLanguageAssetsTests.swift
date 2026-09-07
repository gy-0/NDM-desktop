import XCTest
@testable import NDMCore
@testable import NDMEngine

/// Readiness reporting is checked against the live system. The download itself is
/// NOT: `downloadAndInstall()` would pull a real language model onto the machine
/// running the tests, which a test suite has no business doing uninvited. The
/// download path's logic is covered by the pure state machine in
/// `LanguageAssetReadinessTests`; that it actually downloads is unverified here,
/// and stated as such rather than implied.
final class SpeechLanguageAssetsTests: XCTestCase {
    private func requireFramework() throws {
        guard #available(macOS 26, *) else {
            throw XCTSkip("on-device speech assets require macOS 26 or later")
        }
    }

    func testAnInstalledLanguageReportsReady() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let environment = await SpeechTranscriptionEngine.environment()
        guard let installed = environment.installedLocaleIdentifiers.first else {
            throw XCTSkip("no language packs installed on this machine")
        }
        let readiness = await SpeechLanguageAssets.readiness(forLocaleIdentifier: installed)
        XCTAssertEqual(readiness, .ready, "\(installed) is installed")
        XCTAssertNil(readiness.fraction)
        XCTAssertFalse(readiness.isWaiting)
    }

    /// The distinction this whole step exists for: supported-but-absent must read
    /// as a nameable one-off stage, not as readiness and not as a failure.
    func testASupportedButNotInstalledLanguageNeedsPreparation() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let environment = await SpeechTranscriptionEngine.environment()
        let installed = Set(environment.installedLocaleIdentifiers.map(
            TranscriptionWorkflow.normalized
        ))
        guard let absent = environment.supportedLocaleIdentifiers.first(where: {
            !installed.contains(TranscriptionWorkflow.normalized($0))
        }) else {
            throw XCTSkip("every supported language is already installed here")
        }
        let readiness = await SpeechLanguageAssets.readiness(forLocaleIdentifier: absent)
        XCTAssertEqual(readiness, .needsPreparation, "\(absent) is supported but absent")
        XCTAssertTrue(readiness.isWaiting)
        XCTAssertFalse(readiness.isReady)
    }

    func testAnUnsupportedLanguageReportsUnsupported() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let readiness = await SpeechLanguageAssets.readiness(
            forLocaleIdentifier: "zz_ZZ"
        )
        XCTAssertEqual(readiness, .unsupported)
    }

    /// Readiness must not depend on identifier spelling: the planner may hand back
    /// `zh_CN` while a caller holds `zh-CN`.
    func testReadinessIgnoresIdentifierSpelling() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let environment = await SpeechTranscriptionEngine.environment()
        guard let installed = environment.installedLocaleIdentifiers.first else {
            throw XCTSkip("no language packs installed on this machine")
        }
        let respelled = installed.replacingOccurrences(of: "_", with: "-").lowercased()
        let readiness = await SpeechLanguageAssets.readiness(forLocaleIdentifier: respelled)
        XCTAssertEqual(readiness, .ready, "\(respelled) is the same pack as \(installed)")
    }

    /// Preparing an already-installed language must be a no-op that returns rather
    /// than an error, since the caller will run this unconditionally before
    /// transcribing.
    func testPreparingAnInstalledLanguageReturnsWithoutDownloading() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let environment = await SpeechTranscriptionEngine.environment()
        guard let installed = environment.installedLocaleIdentifiers.first else {
            throw XCTSkip("no language packs installed on this machine")
        }
        var reported: [Double?] = []
        try await SpeechLanguageAssets().prepare(
            localeIdentifier: installed,
            onProgress: { reported.append($0) }
        )
        XCTAssertTrue(
            reported.isEmpty,
            "nothing to install means no progress should be announced, got \(reported)"
        )
    }

    /// Regression: every installed locale must be preparable, not just the first five.
    /// Creating an installation request reserves against a budget measured at five, so
    /// probing readiness by creating one made the sixth locale onward report
    /// "unsupported" — a diagnosis that points at nothing the user can fix.
    func testEveryInstalledLanguagePreparesWithoutSpendingTheReservationBudget() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let environment = await SpeechTranscriptionEngine.environment()
        let installed = environment.installedLocaleIdentifiers
        try XCTSkipIf(installed.count < 6, "needs more than the reservation budget to be meaningful")
        for identifier in installed {
            do {
                try await SpeechLanguageAssets().prepare(localeIdentifier: identifier)
            } catch {
                XCTFail("\(identifier) is installed but failed to prepare: \(error)")
            }
        }
    }

    func testPreparingAnUnsupportedLanguageReportsUnsupportedRatherThanAFailure() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        do {
            try await SpeechLanguageAssets().prepare(localeIdentifier: "zz_ZZ")
            XCTFail("an unsupported language must not appear to succeed")
        } catch let failure as SpeechLanguageAssets.PreparationFailure {
            XCTAssertEqual(
                failure,
                .unsupportedLanguage,
                "the framework throws here; that is a statement about support"
            )
        }
    }

    func testAlreadyCancelledPreparationDoesNothing() async throws {
        try requireFramework()
        guard #available(macOS 26, *) else { return }

        let token = CancelToken()
        token.cancel()
        var reported: [Double?] = []
        try await SpeechLanguageAssets().prepare(
            localeIdentifier: "zz_ZZ",
            cancelToken: token,
            onProgress: { reported.append($0) }
        )
        XCTAssertTrue(reported.isEmpty, "a cancelled preparation must not even start")
    }
}
