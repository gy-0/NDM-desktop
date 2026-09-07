import XCTest
@testable import NDMCore

final class DownloadDestinationPolicyTests: XCTestCase {
    func testPerDownloadChoiceWinsExactly() {
        let root = URL(fileURLWithPath: "/tmp/Downloads", isDirectory: true)
        let chosen = URL(fileURLWithPath: "/tmp/Client Project", isDirectory: true)

        XCTAssertEqual(
            DownloadDestinationPolicy.directory(
                defaultDirectory: root,
                override: chosen,
                category: .video,
                organizeByCategory: true
            ).path,
            chosen.path
        )
    }

    func testGlobalCategoryOrganizationStillAppliesWithoutOverride() {
        let root = URL(fileURLWithPath: "/tmp/Downloads", isDirectory: true)

        XCTAssertEqual(
            DownloadDestinationPolicy.directory(
                defaultDirectory: root,
                override: nil,
                category: .video,
                organizeByCategory: true
            ).path,
            root.appendingPathComponent("Video", isDirectory: true).path
        )
    }

    func testGlobalRootIsUsedWhenOrganizationIsOff() {
        let root = URL(fileURLWithPath: "/tmp/Downloads", isDirectory: true)

        XCTAssertEqual(
            DownloadDestinationPolicy.directory(
                defaultDirectory: root,
                override: nil,
                category: .document,
                organizeByCategory: false
            ).path,
            root.path
        )
    }
}
