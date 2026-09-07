import XCTest
@testable import NDMCore

final class DigestCapabilityTests: XCTestCase {
    func testSHA256KnownResponsesWithAndWithoutQopCarryTheAlgorithm() throws {
        for (qop, expected) in [("auth" as String?, "5abdd07184ba512a22c53f41470e5eea7dcaa3a93a59b630c13dfe0a5dc6e38b"),
                                (nil, "e71f89d8267982ee1cd4dfb3637698eaf2f55848fe056aee7be175262aab5d2a")] {
            let challenge = DigestAuth.Challenge(realm: "testrealm@host.com", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", qop: qop, algorithm: "SHA-256")
            let header = try DigestAuth.authorizationHeader(challenge: challenge, username: "Mufasa", password: "Circle Of Life",
                method: "GET", uri: "/dir/index.html", nc: "00000001", cnonce: "0a4f113b")
            XCTAssertTrue(header.contains("algorithm=SHA-256"))
            XCTAssertTrue(header.contains("response=\"\(expected)\""))
        }
    }

    func testQuotedParametersRoundTripWithoutMatchingLongerNames() throws {
        let challenge = try XCTUnwrap(DigestAuth.parseChallenge(from: #"Digest xrealm="wrong", realm="a\"b", nonce="n\\z", opaque="o\"p", qop="auth""#))
        XCTAssertEqual(challenge.realm, "a\"b")
        XCTAssertEqual(challenge.nonce, "n\\z")
        let header = try DigestAuth.authorizationHeader(challenge: challenge, username: "u\"v", password: "p", method: "GET", uri: "/")
        XCTAssertTrue(header.contains(#"username="u\"v""#))
        XCTAssertTrue(header.contains(#"opaque="o\"p""#))
        XCTAssertEqual(DigestAuth.parseChallenge(from: header)?.realm, challenge.realm)
        XCTAssertEqual(DigestAuth.parseChallenge(from: header)?.nonce, challenge.nonce)
        XCTAssertNil(DigestAuth.parseChallenge(from: #"Digest xrealm="wrong", nonce="n""#))
    }
    func testUnsupportedCapabilitiesCannotGenerateAMislabeledMD5Header() {
        for challenge in [
            DigestAuth.Challenge(realm: "r", nonce: "n", qop: "auth", algorithm: "SHA-512"),
            DigestAuth.Challenge(realm: "r", nonce: "n", qop: "auth", algorithm: "MD5-sess"),
            DigestAuth.Challenge(realm: "r", nonce: "n", qop: "auth-int")
        ] {
            XCTAssertThrowsError(try DigestAuth.authorizationHeader(challenge: challenge, username: "u", password: "p", method: "GET", uri: "/"))
        }
    }
    func testQopListSelectsSupportedAuthRatherThanAuthInt() throws {
        let challenge = try XCTUnwrap(DigestAuth.parseChallenge(from: "Digest realm=\"r\", nonce=\"n\", qop=\"auth-int, auth\""))
        XCTAssertEqual(challenge.qop, "auth")
    }
}
