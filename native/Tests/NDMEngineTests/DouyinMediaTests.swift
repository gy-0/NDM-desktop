import XCTest
@testable import NDMEngine

final class DouyinMediaTests: XCTestCase {
    /// Trimmed from a real `/aweme/v1/web/aweme/detail/` response.
    private let videoFixture = """
    {
      "aweme_id": "7662339530070410737",
      "desc": "女人的心病 #澳洲生活#网约车",
      "aweme_type": 0,
      "author": { "nickname": "圣诞在夏天" },
      "video": {
        "duration": 362100,
        "cover": { "url_list": ["https://p3-sign.douyinpic.com/example-cover.jpg"] },
        "bit_rate": [
          { "gear_name": "normal_1080_0", "bit_rate": 3000000,
            "play_addr": { "data_size": 62008884, "width": 1920, "height": 1080,
              "url_list": ["https://v26-web.douyinvod.com/e/1080.mp4?watermark=0"] } },
          { "gear_name": "normal_1080_0", "bit_rate": 2900000,
            "play_addr": { "data_size": 59749922, "width": 1920, "height": 1080,
              "url_list": ["https://v11-weba.douyinvod.com/e/1080b.mp4?watermark=0"] } },
          { "gear_name": "normal_540_0", "bit_rate": 2800000,
            "play_addr": { "data_size": 50280945, "width": 1024, "height": 576,
              "url_list": ["https://v26-web.douyinvod.com/e/540.mp4?watermark=0"] } },
          { "gear_name": "normal_720_0", "bit_rate": 2700000,
            "play_addr": { "data_size": 44542154, "width": 1280, "height": 720,
              "url_list": ["https://v26-web.douyinvod.com/e/720.mp4?watermark=0"] } }
        ]
      }
    }
    """

    func testRealShapeVideoFixtureParses() throws {
        let media = try XCTUnwrap(DouyinMediaParser.parse(try decode(videoFixture)))
        XCTAssertEqual(media.kind, .video)
        XCTAssertEqual(media.awemeID, "7662339530070410737")
        XCTAssertEqual(media.title, "女人的心病 #澳洲生活#网约车")
        XCTAssertEqual(media.authorName, "圣诞在夏天")
        XCTAssertEqual(media.coverURL, "https://p3-sign.douyinpic.com/example-cover.jpg")
        XCTAssertEqual(media.durationSeconds ?? 0, 362.1, accuracy: 0.01)
        XCTAssertEqual(media.videoTiers.map(\.height), [1080, 720, 540])
        // The duplicate 1080 gear keeps the higher-bitrate entry.
        XCTAssertEqual(media.videoTiers.first?.dataSize, 62008884)
        for tier in media.videoTiers {
            XCTAssertFalse(tier.urls.isEmpty)
            XCTAssertFalse(tier.isPlayEndpoint)
        }
    }

    func testVideoWithoutLadderFallsBackToPrimaryPlayAddr() throws {
        let json = """
        {
          "aweme_id": "1",
          "desc": "",
          "video": {
            "play_addr": { "data_size": 100, "width": 720, "height": 1280,
              "url_list": ["https://v3-web.douyinvod.com/only.mp4"] }
          }
        }
        """
        let media = try XCTUnwrap(DouyinMediaParser.parse(try decode(json)))
        XCTAssertEqual(media.videoTiers.map(\.height), [720])
        XCTAssertEqual(media.videoTiers.first?.urls, ["https://v3-web.douyinvod.com/only.mp4"])
    }

    func testWatermarkedAndPlayEndpointCandidatesRankLast() throws {
        let json = """
        {
          "aweme_id": "1",
          "desc": "x",
          "video": {
            "bit_rate": [
              { "gear_name": "normal_720_0", "bit_rate": 1000,
                "play_addr": { "data_size": 10, "width": 1280, "height": 720,
                  "url_list": [
                    "https://www.douyin.com/aweme/v1/play/?video_id=1",
                    "https://v26-web.douyinvod.com/wm.mp4?watermark=1",
                    "https://v26-web.douyinvod.com/clean.mp4?watermark=0"
                  ] } }
            ]
          }
        }
        """
        let media = try XCTUnwrap(DouyinMediaParser.parse(try decode(json)))
        XCTAssertEqual(media.videoTiers.first?.urls.first, "https://v26-web.douyinvod.com/clean.mp4?watermark=0")
    }

    func testGalleryCandidateRanking() throws {
        let json = """
        {
          "aweme_id": "2",
          "desc": "图集",
          "aweme_type": 2,
          "image_post_info": {
            "images": [
              {
                "width": 1080, "height": 1440,
                "watermark_free_download_url_list": ["https://p3.douyinpic.com/free.jpg"],
                "origin_image": { "width": 1080, "height": 1440,
                  "url_list": ["https://p3.douyinpic.com/origin.jpg"] },
                "display_image": { "width": 720, "height": 960,
                  "url_list": ["https://p3.douyinpic.com/display.jpg"] },
                "url_list": ["https://p3.douyinpic.com/item.jpg"],
                "download_url": { "url_list": ["https://p3.douyinpic.com/download.jpg"] },
                "download_addr": { "url_list": ["https://p3.douyinpic.com/addr.jpg"] },
                "download_url_list": ["https://p3.douyinpic.com/list.jpg"],
                "owner_watermark_image": { "url_list": ["https://p3.douyinpic.com/owner.jpg"] }
              },
              {
                "width": 1080, "height": 1440,
                "origin_image": { "width": 1080, "height": 1440,
                  "url_list": ["https://p3.douyinpic.com/second.webp"] }
              }
            ]
          }
        }
        """
        let media = try XCTUnwrap(DouyinMediaParser.parse(try decode(json)))
        XCTAssertEqual(media.kind, .gallery)
        XCTAssertEqual(media.galleryImages.count, 2)
        XCTAssertEqual(media.galleryImages[0].urls.first, "https://p3.douyinpic.com/free.jpg")
        // Watermarked / lower-priority sources trail the clean candidates.
        let first = media.galleryImages[0].urls
        XCTAssertEqual(first.last, "https://p3.douyinpic.com/owner.jpg")
        XCTAssertTrue(first.firstIndex(of: "https://p3.douyinpic.com/origin.jpg")! < first.firstIndex(of: "https://p3.douyinpic.com/display.jpg")!)
        XCTAssertEqual(DouyinProbe.imageExtension(for: first[1]), "jpg")
        XCTAssertEqual(DouyinProbe.imageExtension(for: media.galleryImages[1].urls[0]), "webp")
    }

    func testAwemeTypeGalleryWithoutImagesFails() throws {
        let json = """
        { "aweme_id": "3", "desc": "", "aweme_type": 2, "video": {} }
        """
        XCTAssertNil(DouyinMediaParser.parse(try decode(json)))
    }

    func testProbeSynthesisMapsTiersAndGallery() throws {
        let media = try XCTUnwrap(DouyinMediaParser.parse(try decode(videoFixture)))
        let preflight = DouyinPreflight(
            originalURL: "https://www.douyin.com/video/7662339530070410737",
            resolvedURL: "https://www.douyin.com/video/7662339530070410737",
            didExpandShortLink: false,
            resolution: .single(media)
        )
        let probe = DouyinProbe.probe(from: preflight)
        XCTAssertEqual(probe.formats.map(\.id), ["douyin-1080", "douyin-720", "douyin-540"])
        XCTAssertEqual(probe.formats.first?.approximateBytes, 62008884)
        XCTAssertEqual(probe.durationSeconds ?? 0, 362.1, accuracy: 0.01)
    }

    func testBatchProbeSynthesisCountsItems() throws {
        let video = try XCTUnwrap(DouyinMediaParser.parse(try decode(videoFixture)))
        let gallery = try XCTUnwrap(DouyinMediaParser.parse(try decode("""
        {
          "aweme_id": "9", "desc": "图集", "aweme_type": 2,
          "image_post_info": { "images": [
            { "width": 100, "height": 100, "url_list": ["https://p3.douyinpic.com/a.jpg"] }
          ] }
        }
        """)))
        let batch = DouyinBatch(title: "某博主", items: [video, gallery])
        let preflight = DouyinPreflight(
            originalURL: "https://www.douyin.com/user/MS4wLjABAAAA",
            resolvedURL: "https://www.douyin.com/user/MS4wLjABAAAA",
            didExpandShortLink: false,
            resolution: .batch(batch)
        )
        let probe = DouyinProbe.probe(from: preflight)
        XCTAssertEqual(probe.title, "某博主")
        XCTAssertEqual(probe.formats.map(\.id), [DouyinProbe.batchFormatID])
        XCTAssertEqual(probe.formats.first?.label, "作品 · 2 个（含图集）")
    }

    func testMusicParsingPrefersFullQualityURLs() {
        // Current clients answer `music_info` with seconds; the older `music`
        // wrapper used milliseconds.
        let current: [String: Any] = [
            "music_info": [
                "title": "原声",
                "duration": 362,
                "play_url": ["url_list": ["https://sf.douyin.com/full.mp3"]],
                "play_url_lowbr": ["url_list": ["https://sf.douyin.com/low.mp3"]],
            ],
        ]
        let track = DouyinProbe.parseMusic(current)
        XCTAssertEqual(track?.title, "原声")
        XCTAssertEqual(track?.durationSeconds ?? 0, 362, accuracy: 0.01)
        XCTAssertEqual(track?.urls.first, "https://sf.douyin.com/full.mp3")

        let legacy: [String: Any] = [
            "music": [
                "title": "原声",
                "duration": 30_000,
                "play_url": ["url_list": ["https://sf.douyin.com/full.mp3"]],
            ],
        ]
        XCTAssertEqual(DouyinProbe.parseMusic(legacy)?.durationSeconds ?? 0, 30, accuracy: 0.01)
        XCTAssertNil(DouyinProbe.parseMusic(["music": ["title": "nothing"]]))
    }

    func testDirectCDNURLPassesThroughAndPlayEndpointGetsSignature() {
        let direct = DouyinVideoTier(height: 720, width: 1280, dataSize: 1,
            urls: ["https://v26-web.douyinvod.com/a.mp4?watermark=0"])
        XCTAssertEqual(DouyinProbe.downloadURL(for: direct), "https://v26-web.douyinvod.com/a.mp4?watermark=0")

        let play = DouyinVideoTier(height: 720, width: 1280, dataSize: 1,
            urls: ["https://www.douyin.com/aweme/v1/play/?video_id=1"])
        let signed = DouyinProbe.downloadURL(for: play)
        XCTAssertTrue(signed?.contains("&X-Bogus=") == true)
    }

    func testNominalHeightUsesGearName() {
        XCTAssertEqual(DouyinMediaParser.nominalHeight(gearName: "normal_1080_0", shortEdge: 1072), 1080)
        XCTAssertEqual(DouyinMediaParser.nominalHeight(gearName: "1080_1_1", shortEdge: 1072), 1080)
        XCTAssertEqual(DouyinMediaParser.nominalHeight(gearName: "adapt_low_540_0", shortEdge: 576), 540)
        XCTAssertEqual(DouyinMediaParser.nominalHeight(gearName: nil, shortEdge: 720), 720)
    }

    private func decode(_ json: String) throws -> [String: Any] {
        let data = try XCTUnwrap(json.data(using: .utf8))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
