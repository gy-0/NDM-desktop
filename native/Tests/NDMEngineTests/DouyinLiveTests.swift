import XCTest
@testable import NDMEngine

/// Live verification against douyin.com. Runs only when
/// `NDM_DOUYIN_LIVE_AWEME` names an aweme ID; uses the browser named by
/// `NDM_DOUYIN_LIVE_BROWSER` (default `chrome:Default`) as the cookie source, so the
/// machine must be signed in to Douyin in that browser. The gallery test also
/// needs `NDM_DOUYIN_LIVE_GALLERY` (a note share link).
final class DouyinLiveTests: XCTestCase {
    private var awemeID: String? {
        let value = ProcessInfo.processInfo.environment["NDM_DOUYIN_LIVE_AWEME"]
        return (value?.isEmpty == false) ? value : nil
    }

    private var browser: String {
        ProcessInfo.processInfo.environment["NDM_DOUYIN_LIVE_BROWSER"] ?? "chrome:Default"
    }

    private var verbose: Bool {
        ProcessInfo.processInfo.environment["NDM_DOUYIN_LIVE_VERBOSE"] != nil
    }

    private func liveAwemeID() throws -> String {
        guard let value = awemeID else {
            throw XCTSkip("NDM_DOUYIN_LIVE_AWEME not set")
        }
        return value
    }

    func testResolveVideoAndRangeDownload() async throws {
        let awemeID = try liveAwemeID()
        let preflight = try await DouyinProbe.resolve(
            url: "https://www.douyin.com/video/\(awemeID)",
            cookieSource: .browser(browser)
        )
        let media = try singleMedia(from: preflight)
        XCTAssertEqual(media.kind, .video)
        XCTAssertFalse(media.videoTiers.isEmpty)
        XCTAssertFalse(media.title.isEmpty)

        let top = try XCTUnwrap(media.videoTiers.first)
        XCTAssertGreaterThan(top.height, 0)
        let url = try XCTUnwrap(DouyinProbe.downloadURL(for: top))
        let (data, response) = try await rangedGet(url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertTrue(status == 200 || status == 206, "unexpected CDN status \(status)")
        XCTAssertFalse(data.isEmpty)
        let contentType = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
        XCTAssertTrue(contentType.hasPrefix("video/"), "unexpected content type \(contentType)")
    }

    func testResolveGalleryFromShareLink() async throws {
        let link = ProcessInfo.processInfo.environment["NDM_DOUYIN_LIVE_GALLERY"] ?? ""
        try XCTSkipIf(link.isEmpty, "NDM_DOUYIN_LIVE_GALLERY not set")
        let preflight = try await DouyinProbe.resolve(url: link, cookieSource: .browser(browser))
        let media = try singleMedia(from: preflight)
        XCTAssertEqual(media.kind, .gallery)
        XCTAssertFalse(media.galleryImages.isEmpty)
        XCTAssertTrue(preflight.didExpandShortLink)
        XCTAssertFalse(media.title.isEmpty)

        let first = try XCTUnwrap(media.galleryImages.first)
        let url = try XCTUnwrap(first.primaryURL)
        let (data, response) = try await rangedGet(url)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let contentType = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? ""
        XCTAssertTrue(status == 200 || status == 206, "unexpected image status \(status)")
        XCTAssertFalse(data.isEmpty)
        XCTAssertTrue(contentType.hasPrefix("image/") || contentType.hasPrefix("application/octet-stream"),
                      "unexpected content type \(contentType)")

        let probe = DouyinProbe.probe(from: preflight)
        XCTAssertEqual(probe.formats.map(\.id), [DouyinProbe.galleryFormatID])
        if verbose {
            print("gallery \(media.awemeID): images=\(media.galleryImages.count) "
                + "title=\(media.title.prefix(30))")
        }
    }

    func testResolveProfileBatch() async throws {
        let awemeID = try liveAwemeID()
        let cookies = try await DouyinCookieStore.jar(for: .browser(browser))
        let client = DouyinAPIClient(cookies: cookies)
        let secUIDValue = await authorSecUID(client: client, awemeID: awemeID)
        let secUID = try XCTUnwrap(secUIDValue, "author sec_uid not available")

        let preflight = try await DouyinProbe.resolve(
            url: "https://www.douyin.com/user/\(secUID)",
            cookieSource: .browser(browser)
        )
        guard case .batch(let batch) = preflight.resolution else {
            return XCTFail("profile did not resolve to a batch")
        }
        XCTAssertFalse(batch.items.isEmpty)
        XCTAssertFalse(batch.title.isEmpty)
        XCTAssertLessThanOrEqual(batch.items.count, DouyinProbe.batchPageSize)

        let probe = DouyinProbe.probe(from: preflight)
        XCTAssertEqual(probe.formats.map(\.id), [DouyinProbe.batchFormatID])
        // Every batch item must know how to download itself.
        for item in batch.items {
            switch item.kind {
            case .video:
                XCTAssertFalse(item.videoTiers.isEmpty, "video \(item.awemeID) has no tier")
            case .gallery:
                XCTAssertFalse(item.galleryImages.isEmpty, "gallery \(item.awemeID) has no image")
            }
        }
        if verbose {
            let galleries = batch.items.filter { $0.kind == .gallery }.count
            print("profile \(batch.title): \(batch.items.count) items, \(galleries) galleries")
        }
    }

    func testResolveMusic() async throws {
        let value = ProcessInfo.processInfo.environment["NDM_DOUYIN_LIVE_MUSIC"] ?? ""
        try XCTSkipIf(value.isEmpty, "NDM_DOUYIN_LIVE_MUSIC not set")
        let url = value.hasPrefix("http") ? value : "https://www.douyin.com/music/\(value)"
        let preflight = try await DouyinProbe.resolve(url: url, cookieSource: .browser(browser))
        guard case .audio(let track) = preflight.resolution else {
            return XCTFail("music link did not resolve to a track")
        }
        XCTAssertFalse(track.urls.isEmpty)
        let (data, response) = try await rangedGet(track.urls[0])
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        XCTAssertTrue(status == 200 || status == 206, "unexpected audio status \(status)")
        XCTAssertFalse(data.isEmpty)
        if verbose {
            print("music \(track.title): urls=\(track.urls.count) duration=\(track.durationSeconds ?? -1)")
        }
    }

    private func singleMedia(from preflight: DouyinPreflight) throws -> DouyinMedia {
        guard case .single(let media) = preflight.resolution else {
            throw XCTSkip("expected a single media resolution")
        }
        return media
    }

    private func rangedGet(_ url: String) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: try XCTUnwrap(URL(string: url)))
        request.setValue("bytes=0-1023", forHTTPHeaderField: "Range")
        for header in DouyinProbe.downloadHeaders {
            let parts = header.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            request.setValue(parts[1].trimmingCharacters(in: .whitespaces),
                             forHTTPHeaderField: String(parts[0]))
        }
        return try await URLSession.shared.data(for: request)
    }

    private func authorSecUID(client: DouyinAPIClient, awemeID: String) async -> String? {
        guard let detail = try? await client.detail(awemeID: awemeID),
              let author = detail["author"] as? [String: Any] else { return nil }
        return author["sec_uid"] as? String
    }
}
