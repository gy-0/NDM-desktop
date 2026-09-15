import XCTest
@testable import NDMEngine

final class DouyinURLTests: XCTestCase {
    func testVideoLinks() {
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/video/7662339530070410737"),
            .video(awemeID: "7662339530070410737")
        )
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/?modal_id=7662339530070410737&foo=1"),
            .video(awemeID: "7662339530070410737")
        )
    }

    func testGalleryLinks() {
        let expected = DouyinLink.gallery(noteID: "7341234567890123456")
        XCTAssertEqual(DouyinURL.parse("https://www.douyin.com/note/7341234567890123456"), expected)
        XCTAssertEqual(DouyinURL.parse("https://www.douyin.com/gallery/7341234567890123456"), expected)
        XCTAssertEqual(DouyinURL.parse("https://www.douyin.com/slides/7341234567890123456"), expected)
    }

    func testProfileLink() {
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/user/MS4wLjABAAAAzzzz"),
            .user(secUID: "MS4wLjABAAAAzzzz")
        )
    }

    func testCollectionMixAndMusicLinks() {
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/collection/7341234567890123456"),
            .collection(mixID: "7341234567890123456")
        )
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/mix/7341234567890123456"),
            .collection(mixID: "7341234567890123456")
        )
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/music/7341234567890123456"),
            .music(musicID: "7341234567890123456")
        )
    }

    func testLiveLinks() {
        XCTAssertEqual(DouyinURL.parse("https://live.douyin.com/123456789"), .live(roomID: "123456789"))
        XCTAssertEqual(
            DouyinURL.parse("https://www.douyin.com/follow/live/123456789"),
            .live(roomID: "123456789")
        )
        XCTAssertEqual(
            DouyinURL.parse("https://webcast.amemv.com/douyin/webcast/reflow/123456789"),
            .live(roomID: "123456789")
        )
    }

    func testShortLinksNeedExpansion() {
        XCTAssertEqual(DouyinURL.parse("https://v.douyin.com/abc123/"), .short)
        XCTAssertEqual(DouyinURL.parse("https://v.iesdouyin.com/abc123"), .short)
    }

    func testNonDouyinAndUnsupportedLinks() {
        XCTAssertNil(DouyinURL.parse("https://www.youtube.com/watch?v=1"))
        XCTAssertNil(DouyinURL.parse("not a url"))
        XCTAssertFalse(DouyinURL.isDouyin("https://www.douyin.com.evil.example/video/1"))
        XCTAssertTrue(DouyinURL.isDouyin("https://www.douyin.com/user/self?showTab=favorite_collection"))
    }

    func testAwemeIdentity() {
        XCTAssertEqual(DouyinURL.awemeID(for: .video(awemeID: "1")), "1")
        XCTAssertEqual(DouyinURL.awemeID(for: .gallery(noteID: "2")), "2")
        XCTAssertNil(DouyinURL.awemeID(for: .user(secUID: "u")))
    }
}
