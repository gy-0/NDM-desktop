import XCTest
import NDMEngine

final class YtDlpSanitizeFilenameTests: XCTestCase {
    func testShortNamesPassThrough() {
        XCTAssertEqual(YtDlpTool.sanitizeFilename("abc.mp4"), "abc")
    }

    func testCJKTitleIsCappedByUTF8Bytes() {
        let name = String(repeating: "睡", count: 200) + ".mp4"
        let out = YtDlpTool.sanitizeFilename(name)
        XCTAssertFalse(out.isEmpty)
        // APFS limit is 255 bytes for the whole name; the stem must leave
        // room for suffixes and the extension.
        XCTAssertLessThanOrEqual(out.utf8.count, 180)
    }

    func testLongASCIITitleStillCappedByCharacters() {
        let name = String(repeating: "a", count: 300)
        XCTAssertEqual(YtDlpTool.sanitizeFilename(name).count, 120)
    }
}
