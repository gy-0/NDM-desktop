import XCTest
import CryptoKit
@testable import NDMCore

final class LicenseStoreTests: XCTestCase {
    func testActivationPersistsAndCanBeReadImmediately() throws {
        let signer = Curve25519.Signing.PrivateKey()
        let publicKeyBase64 = signer.publicKey.rawRepresentation.base64EncodedString()
        let key = try LicenseStore.makeKey(
            email: "buyer@example.com",
            expiry: nil,
            privateKey: signer
        )
        let suite = "dev.ndm.open.license-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let activated = try LicenseStore.activate(
            key,
            publicKeyBase64: publicKeyBase64,
            defaults: defaults
        )

        XCTAssertEqual(activated.email, "buyer@example.com")
        XCTAssertEqual(
            LicenseStore.current(publicKeyBase64: publicKeyBase64, defaults: defaults),
            activated
        )
    }

    private let signer = Curve25519.Signing.PrivateKey()
    private var publicKeyBase64: String {
        signer.publicKey.rawRepresentation.base64EncodedString()
    }

    func testRoundTripPerpetualKey() throws {
        let key = try LicenseStore.makeKey(email: "yuan@example.com", expiry: nil, privateKey: signer)
        XCTAssertTrue(key.hasPrefix("NDMP1."))
        let license = try LicenseStore.parse(key: key, publicKeyBase64: publicKeyBase64)
        XCTAssertEqual(license.email, "yuan@example.com")
        XCTAssertNil(license.expiry)
    }

    func testExpiryHonored() throws {
        let future = Date().addingTimeInterval(400 * 24 * 3600)
        let key = try LicenseStore.makeKey(email: "a@b.c", expiry: future, privateKey: signer)
        let license = try LicenseStore.parse(key: key, publicKeyBase64: publicKeyBase64)
        XCTAssertNotNil(license.expiry)

        // Same key evaluated after its expiry date → expired.
        let wayLater = Date().addingTimeInterval(500 * 24 * 3600)
        XCTAssertThrowsError(
            try LicenseStore.parse(key: key, publicKeyBase64: publicKeyBase64, now: wayLater)
        ) { error in
            XCTAssertEqual(error as? LicenseError, .expired)
        }
    }

    func testTamperedPayloadRejected() throws {
        let key = try LicenseStore.makeKey(email: "a@b.c", expiry: nil, privateKey: signer)
        var parts = key.split(separator: ".").map(String.init)
        // Forge a different email into the payload; the signature must not match.
        let forged = try JSONEncoder().encode(["email": "evil@example.com"])
        parts[1] = forged.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let tampered = parts.joined(separator: ".")
        XCTAssertThrowsError(
            try LicenseStore.parse(key: tampered, publicKeyBase64: publicKeyBase64)
        ) { error in
            XCTAssertEqual(error as? LicenseError, .badSignature)
        }
    }

    func testKeySignedByDifferentKeyRejected() throws {
        let otherSigner = Curve25519.Signing.PrivateKey()
        let key = try LicenseStore.makeKey(email: "a@b.c", expiry: nil, privateKey: otherSigner)
        XCTAssertThrowsError(
            try LicenseStore.parse(key: key, publicKeyBase64: publicKeyBase64)
        ) { error in
            XCTAssertEqual(error as? LicenseError, .badSignature)
        }
    }

    func testGarbageRejected() {
        XCTAssertThrowsError(try LicenseStore.parse(key: "hello", publicKeyBase64: publicKeyBase64))
        XCTAssertThrowsError(try LicenseStore.parse(key: "NDMP1.a.b", publicKeyBase64: publicKeyBase64))
        XCTAssertThrowsError(try LicenseStore.parse(key: "", publicKeyBase64: publicKeyBase64))
    }

    func testWhitespaceTolerated() throws {
        let key = try LicenseStore.makeKey(email: "a@b.c", expiry: nil, privateKey: signer)
        let padded = "  \(key)\n"
        let license = try LicenseStore.parse(key: padded, publicKeyBase64: publicKeyBase64)
        XCTAssertEqual(license.email, "a@b.c")
    }

    func testConnectionCaps() {
        XCTAssertEqual(LicenseStore.connectionsCap(isPro: false), 4)
        XCTAssertEqual(LicenseStore.connectionsCap(isPro: true), 32)
    }
}
