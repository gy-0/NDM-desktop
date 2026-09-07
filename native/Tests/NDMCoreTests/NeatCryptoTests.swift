import XCTest
@testable import NDMCore

final class NeatCryptoTests: XCTestCase {
    func testEmptyPasswordMatchesOriginalPrefsCiphertext() {
        // Live NDM empty proxy password → BqhotGJODXhOF2DHpxSOGQ==
        XCTAssertEqual(NeatCrypto.encryptString(""), "BqhotGJODXhOF2DHpxSOGQ==")
    }

    func testRoundTrip() {
        for s in ["", "password", "hello", "SG2921"] {
            let enc = NeatCrypto.encryptString(s)
            XCTAssertEqual(NeatCrypto.decryptString(enc), s)
        }
    }
}
