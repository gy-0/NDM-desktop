import Foundation
import XCTest

/// Gate for tests that reach the public internet.
///
/// Such tests are worth keeping, but they must not sit in the default suite:
///
/// - They fail on rate limiting rather than on regressions. A YouTube probe
///   answering 403 says nothing about this repository, yet it turns the suite
///   red — which makes "all tests green" worthless as a merge signal for the
///   unattended development loop.
/// - They depend on foreign CDNs, so a failure cannot be told apart from local
///   network trouble. `docs/NORTHSTAR.md` makes avoiding that a hard rule.
///
/// Run them deliberately instead:
///
///     NDM_LIVE_NETWORK_TESTS=1 swift test --filter YtDlpToolIntegrationTests
enum LiveNetworkGate {
    static let environmentKey = "NDM_LIVE_NETWORK_TESTS"

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
            "\(subject) reaches the public internet; set \(environmentKey)=1 to run it",
            file: file,
            line: line
        )
    }
}

final class LiveNetworkGateTests: XCTestCase {
    func testGateIsOffWhenUnset() {
        XCTAssertFalse(LiveNetworkGate.isEnabled(environment: [:]))
    }

    func testExplicitFalseyValuesKeepTheGateClosed() {
        for value in ["0", "false", "no", "off", "OFF", " 0 ", ""] {
            XCTAssertFalse(
                LiveNetworkGate.isEnabled(
                    environment: [LiveNetworkGate.environmentKey: value]
                ),
                "\(value.debugDescription) must not enable live network tests"
            )
        }
    }

    func testTruthyValuesOpenTheGate() {
        for value in ["1", "true", "yes", "on"] {
            XCTAssertTrue(
                LiveNetworkGate.isEnabled(
                    environment: [LiveNetworkGate.environmentKey: value]
                ),
                "\(value.debugDescription) must enable live network tests"
            )
        }
    }
}
