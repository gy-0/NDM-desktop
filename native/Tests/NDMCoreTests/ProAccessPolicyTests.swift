import XCTest
@testable import NDMCore

final class ProAccessPolicyTests: XCTestCase {
    func testMainstreamSingleVideoRemainsFree() {
        XCTAssertEqual(
            ProAccessPolicy.mediaRequirements(
                height: 1080,
                collectionItemCount: nil,
                includesSubtitles: false
            ),
            []
        )
    }

    func testContextPreservesEveryRequestedProValue() {
        XCTAssertEqual(
            ProAccessPolicy.mediaRequirements(
                height: 2160,
                collectionItemCount: 24,
                includesSubtitles: true
            ),
            [
                .collection(itemCount: 24),
                .ultraHD(height: 2160),
                .subtitles,
            ]
        )
    }

    func testSingleItemCollectionDoesNotCreateBatchGate() {
        XCTAssertEqual(
            ProAccessPolicy.mediaRequirements(
                height: 720,
                collectionItemCount: 1,
                includesSubtitles: false
            ),
            []
        )
    }

    func testPurchaseURLComesFromPackagedConfiguration() {
        XCTAssertEqual(
            PurchaseConfiguration.purchaseURL(infoDictionary: [
                PurchaseConfiguration.infoPlistKey: "https://store.example.org/pelican-pro"
            ]),
            URL(string: "https://store.example.org/pelican-pro")
        )
        XCTAssertNil(PurchaseConfiguration.purchaseURL(infoDictionary: [:]))
        XCTAssertNil(PurchaseConfiguration.purchaseURL(infoDictionary: [
            PurchaseConfiguration.infoPlistKey: "javascript:alert(1)"
        ]))
        XCTAssertNil(PurchaseConfiguration.purchaseURL(infoDictionary: [
            PurchaseConfiguration.infoPlistKey: "http://store.example.org/pelican-pro"
        ]))
    }
}
