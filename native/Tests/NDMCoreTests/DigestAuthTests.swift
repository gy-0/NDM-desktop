import XCTest
@testable import NDMCore

final class DigestAuthTests: XCTestCase {
    func testParseChallenge() throws {
        let header = #"Digest realm="testrealm@host.com", qop="auth", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#
        let c = try XCTUnwrap(DigestAuth.parseChallenge(from: header))
        XCTAssertEqual(c.realm, "testrealm@host.com")
        XCTAssertEqual(c.nonce, "dcd98b7102dd2f0e8b11d0f600bfb0c093")
        XCTAssertEqual(c.opaque, "5ccc069c403ebaf9f0171e9517f40e41")
        XCTAssertEqual(c.qop, "auth")
    }

    func testRFC2617ExampleResponse() {
        // Classic RFC 2617 example values
        let challenge = DigestAuth.Challenge(
            realm: "testrealm@host.com",
            nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
            opaque: "5ccc069c403ebaf9f0171e9517f40e41",
            qop: "auth"
        )
        let header = DigestAuth.authorizationHeader(
            challenge: challenge,
            username: "Mufasa",
            password: "Circle Of Life",
            method: "GET",
            uri: "/dir/index.html",
            nc: "00000001",
            cnonce: "0a4f113b"
        )
        XCTAssertTrue(header.contains("Digest username=\"Mufasa\""))
        XCTAssertTrue(header.contains("response=\"6629fae49393a05397450978507c4ef1\""))
        XCTAssertTrue(header.contains("qop=auth"))
    }

    func testMD5Hex() {
        XCTAssertEqual(DigestAuth.md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e")
    }
}
