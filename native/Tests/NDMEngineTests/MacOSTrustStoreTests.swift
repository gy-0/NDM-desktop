import XCTest
@testable import NDMEngine

final class MacOSTrustStoreTests: XCTestCase {
    func testCombinedPEMSeparatesBaseAndAdministratorCertificates() {
        let base = Data("BASE".utf8)
        let administrator = Data("ADMIN".utf8)

        let result = MacOSTrustStore.combinedPEM(
            base: base,
            administratorCertificates: administrator
        )

        XCTAssertEqual(String(decoding: result, as: UTF8.self), "BASE\nADMIN")
    }

    func testSystemTrustBundleIsReadablePEM() throws {
        let url = try XCTUnwrap(MacOSTrustStore.certificateBundleURL)
        let text = try String(contentsOf: url, encoding: .utf8)

        XCTAssertTrue(text.contains("-----BEGIN CERTIFICATE-----"))
        XCTAssertGreaterThan(text.utf8.count, 100_000)
    }
}
