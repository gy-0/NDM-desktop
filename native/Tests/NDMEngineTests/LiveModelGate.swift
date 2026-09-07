import Foundation
import XCTest

/// Gate for tests that call the on-device language model.
///
/// The model is real and local, so these tests are not rate-limited the way
/// public-internet probes are, but they still must not sit in the default suite:
///
/// - A cold or momentarily unavailable model answers `nil` in milliseconds, which
///   says nothing about this repository yet turns the suite red — making "all
///   tests green" worthless as a merge signal.
/// - The result depends on machine state (language packs, Apple Intelligence
///   availability, contention with other sessions), which is exactly the kind of
///   failure `docs/NORTHSTAR.md` keeps out of unattended gates.
///
/// Run them deliberately instead:
///
///     NDM_LIVE_MODEL_TESTS=1 swift test --filter TranscriptNarratorTests
enum LiveModelGate {
    static let environmentKey = "NDM_LIVE_MODEL_TESTS"

    /// Off unless the variable is present and not an explicit falsey value, so
    /// the safe state is the default and `=0` reads the way anyone would expect.
    static func isEnabled(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        guard let raw = environment[environmentKey]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
            !raw.isEmpty
        else { return false }
        return !["0", "false", "no", "off"].contains(raw)
    }

    static func skipUnlessEnabled(
        _ subject: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        try XCTSkipUnless(
            isEnabled(),
            "\(subject) calls the on-device language model; set \(environmentKey)=1 to run it",
            file: file,
            line: line
        )
    }
}

final class LiveModelGateTests: XCTestCase {
    func testGateIsOffWhenUnset() {
        XCTAssertFalse(LiveModelGate.isEnabled(environment: [:]))
    }

    func testExplicitFalseyValuesKeepTheGateClosed() {
        for value in ["0", "false", "no", "off", "OFF", " 0 ", ""] {
            XCTAssertFalse(
                LiveModelGate.isEnabled(
                    environment: [LiveModelGate.environmentKey: value]
                ),
                "\(value.debugDescription) must not enable live model tests"
            )
        }
    }

    func testTruthyValuesOpenTheGate() {
        for value in ["1", "true", "yes", "on"] {
            XCTAssertTrue(
                LiveModelGate.isEnabled(
                    environment: [LiveModelGate.environmentKey: value]
                ),
                "\(value.debugDescription) must enable live model tests"
            )
        }
    }
}
