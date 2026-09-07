import XCTest
@testable import NDMCore

final class HLSPlaylistTests: XCTestCase {
    func testParseMediaPlaylist() throws {
        let text = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:10
        #EXT-X-MEDIA-SEQUENCE:5
        #EXTINF:9.0,
        seg0.ts
        #EXTINF:9.0,
        seg1.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected media")
        }
        XCTAssertEqual(media.version, 3)
        XCTAssertEqual(media.targetDuration, 10)
        XCTAssertEqual(media.mediaSequence, 5)
        XCTAssertTrue(media.endList)
        XCTAssertEqual(media.segments.count, 2)
        XCTAssertEqual(media.segments[0].id, 5)
        XCTAssertEqual(media.segments[0].uri, "seg0.ts")
        XCTAssertEqual(media.segments[1].id, 6)
    }

    func testParseMasterPrefersHighestBandwidth() throws {
        let text = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
        low.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720
        hi.m3u8
        """
        guard case .master(let master) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected master")
        }
        XCTAssertEqual(master.variants.count, 2)
        XCTAssertEqual(master.preferredVariant?.uri, "hi.m3u8")
        XCTAssertEqual(master.preferredVariant?.bandwidth, 2_400_000)
    }

    func testParseKeyAndByteRange() throws {
        let text = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example/key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
        #EXTINF:4.0,
        #EXT-X-BYTERANGE:1000@200
        media.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected media")
        }
        XCTAssertEqual(media.key?.method, "AES-128")
        XCTAssertEqual(media.key?.uri, "https://cdn.example/key.bin")
        XCTAssertEqual(media.key?.ivHex, "0123456789ABCDEF0123456789ABCDEF")
        XCTAssertTrue(media.key?.isAES128 == true)
        XCTAssertEqual(media.segments[0].byteRange?.length, 1000)
        XCTAssertEqual(media.segments[0].byteRange?.offset, 200)
        XCTAssertEqual(
            media.segments[0].key?.uri,
            "https://cdn.example/key.bin",
            "the key must be attached to the segment it governs"
        )
    }

    /// A KEY tag governs the segments that follow it until the next one. Treating
    /// the playlist as having a single key decrypts most of a rotating stream with
    /// the wrong key and reports success.
    func testKeyAppliesToFollowingSegmentsUntilReplaced() throws {
        let text = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="k0.bin"
        #EXTINF:4.0,
        a.ts
        #EXTINF:4.0,
        b.ts
        #EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
        #EXTINF:4.0,
        c.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected media")
        }
        XCTAssertEqual(media.segments.map { $0.key?.uri }, ["k0.bin", "k0.bin", "k1.bin"])
        XCTAssertTrue(media.hasEncryptedSegments)
    }

    /// `METHOD=NONE` mid-playlist marks the rest as clear — ad splices rely on it.
    func testMethodNoneClearsTheKeyForLaterSegmentsOnly() throws {
        let text = """
        #EXTM3U
        #EXT-X-KEY:METHOD=AES-128,URI="k.bin"
        #EXTINF:4.0,
        enc.ts
        #EXT-X-KEY:METHOD=NONE
        #EXTINF:4.0,
        clear.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected media")
        }
        XCTAssertTrue(media.segments[0].key?.isAES128 == true)
        XCTAssertFalse(
            media.segments[1].key?.isAES128 == true,
            "a segment after METHOD=NONE must not be decrypted"
        )
        XCTAssertTrue(media.hasEncryptedSegments)
    }

    /// Segments before any KEY tag are clear even when the playlist encrypts later.
    func testSegmentsBeforeAnyKeyTagStayClear() throws {
        let text = """
        #EXTM3U
        #EXTINF:4.0,
        clear.ts
        #EXT-X-KEY:METHOD=AES-128,URI="k.bin"
        #EXTINF:4.0,
        enc.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected media")
        }
        XCTAssertNil(media.segments[0].key)
        XCTAssertTrue(media.segments[1].key?.isAES128 == true)
    }

    func testResolveURL() {
        let base = URL(string: "https://cdn.example/v/playlist.m3u8")!
        XCTAssertEqual(
            HLSPlaylist.resolveURL("a.ts", against: base)?.absoluteString,
            "https://cdn.example/v/a.ts"
        )
        XCTAssertEqual(
            HLSPlaylist.resolveURL("https://other/x.ts", against: base)?.absoluteString,
            "https://other/x.ts"
        )
    }

    func testRejectNonPlaylist() {
        XCTAssertThrowsError(try HLSPlaylist.parse("not a playlist")) { err in
            XCTAssertEqual(err as? HLSError, .notPlaylist)
        }
    }

    /// X/Twitter serves video and audio as separate HLS renditions. The master
    /// parser must capture the EXT-X-MEDIA:TYPE=AUDIO rendition and link it to
    /// the video variant, or the download is silent (the reported bug).
    func testMasterParsesSeparateAudioRendition() throws {
        let text = """
        #EXTM3U
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,URI="/a/audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=2176000,RESOLUTION=1280x720,CODECS="avc1.640020,mp4a.40.2",AUDIO="aud"
        /v/720.m3u8
        #EXT-X-STREAM-INF:BANDWIDTH=832000,RESOLUTION=640x360,AUDIO="aud"
        /v/360.m3u8
        """
        guard case .master(let master) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected master playlist")
        }
        XCTAssertEqual(master.variants.count, 2)
        XCTAssertEqual(master.audioRenditions.count, 1)
        let variant = try XCTUnwrap(master.preferredVariant)
        XCTAssertEqual(variant.audioGroupID, "aud")
        XCTAssertEqual(master.audioURI(for: variant), "/a/audio.m3u8")
    }

    /// A self-contained variant (audio muxed into the video stream) has no
    /// separate rendition to fetch.
    func testMasterWithoutSeparateAudioReturnsNil() throws {
        let text = """
        #EXTM3U
        #EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720
        /v/720.m3u8
        """
        guard case .master(let master) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected master playlist")
        }
        let variant = try XCTUnwrap(master.preferredVariant)
        XCTAssertNil(variant.audioGroupID)
        XCTAssertNil(master.audioURI(for: variant))
    }
}
