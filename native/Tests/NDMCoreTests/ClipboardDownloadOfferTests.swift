import XCTest
@testable import NDMCore

final class ClipboardDownloadOfferTests: XCTestCase {
    func testShareCommandBecomesSourceAwareOffer() throws {
        let raw = "3.21 复制打开抖音，看看【示例】 https://v.douyin.com/abc123/ 08/09"
        let offer = try XCTUnwrap(ClipboardDownloadOfferResolver.offer(
            for: raw,
            existingTasks: []
        ))
        XCTAssertEqual(offer.source, .douyin)
        XCTAssertTrue(offer.wasExtractedFromText)
        XCTAssertEqual(offer.urlString, "https://v.douyin.com/abc123/")
        XCTAssertEqual(offer.inputText, raw)
    }

    func testExistingTaskSuppressesClipboardOffer() {
        let existing = DownloadTask(
            id: 7,
            url: "https://www.youtube.com/watch?v=abc123",
            linkType: "ytdlp",
            status: .complete
        )
        XCTAssertNil(ClipboardDownloadOfferResolver.offer(
            for: "https://youtu.be/abc123",
            existingTasks: [existing]
        ))
    }

    func testUnrelatedClipboardTextIsIgnored() {
        XCTAssertNil(ClipboardDownloadOfferResolver.offer(
            for: "meeting notes without a link",
            existingTasks: []
        ))
    }
}
