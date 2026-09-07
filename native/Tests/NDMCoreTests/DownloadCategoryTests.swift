import XCTest
@testable import NDMCore

final class DownloadCategoryTests: XCTestCase {
    func testInferVideo() {
        XCTAssertEqual(DownloadCategory.infer(filename: "a.mp4", mimeType: nil), .video)
        XCTAssertEqual(DownloadCategory.infer(filename: "x", mimeType: "video/mp4"), .video)
    }

    func testInferCompressed() {
        XCTAssertEqual(DownloadCategory.infer(filename: "a.zip", mimeType: nil), .compressed)
    }
}
