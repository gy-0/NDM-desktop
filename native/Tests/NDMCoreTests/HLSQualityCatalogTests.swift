import XCTest
@testable import NDMCore

final class HLSQualityCatalogTests: XCTestCase {
    private func variant(_ bw: Int, _ res: String?, codecs: String? = nil, uri: String = "v.m3u8") -> HLSPlaylist.Variant {
        HLSPlaylist.Variant(bandwidth: bw, resolution: res, codecs: codecs, uri: uri)
    }

    func testDeduplicatesByHeightKeepingHighestBandwidth() {
        // 14 raw streams collapse into the honest choices (design suite §03).
        let master = HLSPlaylist.Master(variants: [
            variant(4_800_000, "1920x1080", uri: "hi-a.m3u8"),
            variant(4_200_000, "1920x1080", uri: "hi-b.m3u8"),
            variant(2_400_000, "1280x720", uri: "mid-a.m3u8"),
            variant(2_100_000, "1280x720", uri: "mid-b.m3u8"),
            variant(900_000, "854x480", uri: "low.m3u8"),
        ])
        let options = HLSQualityCatalog.options(from: master)
        XCTAssertEqual(options.map(\.label), ["1080p", "720p", "480p"])
        XCTAssertEqual(options[0].variant.uri, "hi-a.m3u8", "should keep highest bandwidth per height")
        XCTAssertEqual(options[1].variant.uri, "mid-a.m3u8")
    }

    func testSizeEstimateFromDuration() {
        let master = HLSPlaylist.Master(variants: [
            variant(4_000_000, "1920x1080"),
            variant(2_000_000, "1280x720"),
        ])
        // 42 min at 4 Mbps ≈ 1.26 GB
        let options = HLSQualityCatalog.options(from: master, duration: 42 * 60)
        XCTAssertEqual(options[0].estimatedBytes, Int64(42 * 60 * 4_000_000 / 8))
        XCTAssertNotNil(options[0].estimatedSizeText)
        XCTAssertTrue(options[0].estimatedSizeText!.hasPrefix("≈ "))
    }

    func testBandwidthOnlyMastersStillOfferChoices() {
        let master = HLSPlaylist.Master(variants: [
            variant(5_000_000, nil),
            variant(1_000_000, nil),
        ])
        let options = HLSQualityCatalog.options(from: master)
        XCTAssertEqual(options.count, 2)
        XCTAssertEqual(options[0].label, "5.0 Mbps")
    }

    func testCodecDetail() {
        let master = HLSPlaylist.Master(variants: [
            variant(4_000_000, "1920x1080", codecs: "avc1.640028,mp4a.40.2"),
            variant(2_000_000, "1280x720", codecs: "hvc1.1.6.L120"),
        ])
        let options = HLSQualityCatalog.options(from: master)
        XCTAssertTrue(options[0].detail.contains("H.264"))
        XCTAssertTrue(options[1].detail.contains("HEVC"))
    }

    func testHeightParsingVariants() {
        XCTAssertEqual(HLSQualityCatalog.heightLabel(resolution: "1920x1080"), "1080p")
        XCTAssertEqual(HLSQualityCatalog.heightLabel(resolution: "1280×720"), "720p")
        XCTAssertNil(HLSQualityCatalog.heightLabel(resolution: nil))
        XCTAssertNil(HLSQualityCatalog.heightLabel(resolution: "garbage"))
    }

    func testTotalDuration() {
        let media = HLSPlaylist.Media(segments: [
            .init(id: 0, uri: "a.ts", duration: 9.0),
            .init(id: 1, uri: "b.ts", duration: 8.5),
        ])
        XCTAssertEqual(HLSQualityCatalog.totalDuration(of: media), 17.5)
    }
}
