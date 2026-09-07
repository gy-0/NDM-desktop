import XCTest
@testable import NDMCore

final class DuplicateDownloadMatcherTests: XCTestCase {
    func testYouTubeShareVariantsUseTheStableVideoID() {
        XCTAssertEqual(
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://youtu.be/abc123?si=share-token"
            ),
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://www.youtube.com/watch?v=abc123&utm_source=chat"
            )
        )
        XCTAssertEqual(
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://www.youtube.com/shorts/abc123"
            ),
            "youtube:video:abc123"
        )
    }

    func testCollectionsDoNotCollapseIntoTheirFirstVideo() {
        XCTAssertNotEqual(
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://www.youtube.com/playlist?list=PL123"
            ),
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://www.youtube.com/watch?v=first&list=PL123"
            )
        )
    }

    func testGenericURLsDropMarketingButKeepSignedParameters() {
        XCTAssertEqual(
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://files.example.com/movie.mp4?token=secret&utm_campaign=summer&part=1"
            ),
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://files.example.com/movie.mp4?part=1&token=secret"
            )
        )
        XCTAssertNotEqual(
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://files.example.com/movie.mp4?token=one"
            ),
            DuplicateDownloadMatcher.canonicalKey(
                for: "https://files.example.com/movie.mp4?token=two"
            )
        )
    }

    func testBestMatchPrefersAnActiveTaskThenNewestTask() {
        let completed = DownloadTask(
            id: 7,
            url: "https://youtu.be/abc123",
            linkType: "ytdlp",
            status: .complete
        )
        let olderActive = DownloadTask(
            id: 8,
            url: "https://www.youtube.com/watch?v=abc123",
            linkType: "ytdlp",
            status: .downloading
        )
        let newerActive = DownloadTask(
            id: 9,
            url: "https://www.youtube.com/shorts/abc123",
            linkType: "ytdlp",
            status: .waiting
        )

        XCTAssertEqual(
            DuplicateDownloadMatcher.bestMatch(
                for: ["https://youtu.be/abc123?si=share"],
                in: [completed, olderActive, newerActive]
            )?.id,
            9
        )
    }

    func testPageURLOnlyParticipatesForMediaPageTasks() {
        let ordinaryAsset = DownloadTask(
            id: 1,
            url: "https://cdn.example.com/poster.jpg",
            linkType: "normal",
            status: .complete,
            pageURL: "https://www.youtube.com/watch?v=abc123"
        )
        let media = DownloadTask(
            id: 2,
            url: "https://cdn.example.com/video.m4s",
            linkType: "ytdlp",
            status: .complete,
            pageURL: "https://www.youtube.com/watch?v=abc123"
        )

        XCTAssertNil(DuplicateDownloadMatcher.bestMatch(
            for: ["https://youtu.be/abc123"],
            in: [ordinaryAsset]
        ))
        XCTAssertEqual(DuplicateDownloadMatcher.bestMatch(
            for: ["https://youtu.be/abc123"],
            in: [ordinaryAsset, media]
        )?.id, 2)
    }
}
