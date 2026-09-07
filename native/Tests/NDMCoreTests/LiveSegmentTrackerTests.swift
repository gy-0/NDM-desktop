import XCTest
@testable import NDMCore

final class LiveSegmentTrackerTests: XCTestCase {
    /// A rolling window: `count` segments starting at media sequence `from`.
    private func window(from: Int, count: Int, targetDuration: Double = 4) -> HLSPlaylist.Media {
        HLSPlaylist.Media(
            targetDuration: targetDuration,
            mediaSequence: from,
            endList: false,
            segments: (0..<count).map { offset in
                HLSPlaylist.Segment(
                    id: from + offset,
                    uri: "seg\(from + offset).ts",
                    duration: targetDuration
                )
            }
        )
    }

    // MARK: - Identity

    func testTheFirstRefreshTakesEverythingInTheWindow() {
        var tracker = LiveSegmentTracker()
        let pending = tracker.absorb(window(from: 100, count: 3))
        XCTAssertEqual(pending.map(\.sequence), [100, 101, 102])
        XCTAssertEqual(pending.map(\.outputIndex), [0, 1, 2])
    }

    /// The whole reason this type exists. The window slides, so index 0 is a different
    /// segment on every refresh; deduplicating by index would re-download the lot.
    func testASlidingWindowOnlyYieldsGenuinelyNewSegments() {
        var tracker = LiveSegmentTracker()
        for pending in tracker.absorb(window(from: 100, count: 3)) {
            tracker.commit(pending)
        }
        // Two new segments arrived, two fell off the front — every index changed.
        let next = tracker.absorb(window(from: 102, count: 3))
        XCTAssertEqual(
            next.map(\.sequence),
            [103, 104],
            "102 was already taken; only 103 and 104 are new"
        )
    }

    func testAnUnchangedPlaylistYieldsNothing() {
        var tracker = LiveSegmentTracker()
        let first = tracker.absorb(window(from: 100, count: 3))
        for pending in first { tracker.commit(pending) }
        XCTAssertTrue(
            tracker.absorb(window(from: 100, count: 3)).isEmpty,
            "a stream that has not produced anything must not produce duplicates"
        )
    }

    func testOutputIndicesStayContiguousAcrossRefreshes() {
        var tracker = LiveSegmentTracker()
        var indices: [Int] = []
        for start in stride(from: 100, through: 106, by: 2) {
            for pending in tracker.absorb(window(from: start, count: 3)) {
                indices.append(pending.outputIndex)
                tracker.commit(pending)
            }
        }
        XCTAssertEqual(indices, Array(0..<indices.count), "output order must not have holes")
    }

    // MARK: - Failure and retry

    /// A failed download must not advance the cursor, or the segment is lost while it
    /// is still sitting in the window waiting to be retried.
    func testAnUncommittedSegmentIsOfferedAgain() {
        var tracker = LiveSegmentTracker()
        let first = tracker.absorb(window(from: 100, count: 3))
        tracker.commit(first[0])
        // 101 and 102 were offered but never committed — a download failure.
        let again = tracker.absorb(window(from: 100, count: 3))
        XCTAssertEqual(again.map(\.sequence), [101, 102])
    }

    func testCommittingOutOfOrderStillAdvancesToTheHighest() {
        var tracker = LiveSegmentTracker()
        let pending = tracker.absorb(window(from: 100, count: 3))
        tracker.commit(pending[2])
        tracker.commit(pending[0])
        XCTAssertEqual(tracker.lastTakenSequence, 102)
        XCTAssertTrue(tracker.absorb(window(from: 100, count: 3)).isEmpty)
    }

    // MARK: - Gaps

    /// Polling too slowly loses content permanently. A recording with holes has to be
    /// able to admit it rather than looking complete.
    func testSegmentsThatFellOutOfTheWindowAreCountedAsMissed() {
        var tracker = LiveSegmentTracker()
        for pending in tracker.absorb(window(from: 100, count: 3)) {
            tracker.commit(pending)
        }
        // Jumped from 102 to 110: 103…109 are gone for good.
        let next = tracker.absorb(window(from: 110, count: 3))
        XCTAssertEqual(tracker.missedSegmentCount, 7)
        XCTAssertEqual(next.map(\.sequence), [110, 111, 112])
    }

    func testKeepingUpMissesNothing() {
        var tracker = LiveSegmentTracker()
        for start in stride(from: 100, through: 120, by: 1) {
            for pending in tracker.absorb(window(from: start, count: 4)) {
                tracker.commit(pending)
            }
        }
        XCTAssertEqual(tracker.missedSegmentCount, 0)
    }

    func testTheFirstRefreshNeverCountsAsAMiss() {
        var tracker = LiveSegmentTracker()
        // Joining a stream already at sequence 5000 is not a gap in the recording; it
        // is simply where the recording starts.
        _ = tracker.absorb(window(from: 5000, count: 3))
        XCTAssertEqual(tracker.missedSegmentCount, 0)
    }

    // MARK: - Edges

    func testAnEmptyPlaylistYieldsNothingAndChangesNothing() {
        var tracker = LiveSegmentTracker()
        let empty = HLSPlaylist.Media(mediaSequence: 0, endList: false, segments: [])
        XCTAssertTrue(tracker.absorb(empty).isEmpty)
        XCTAssertNil(tracker.lastTakenSequence)
        XCTAssertEqual(tracker.missedSegmentCount, 0)
    }

    func testAPlaylistThatRewindsDoesNotResendOldSegments() {
        var tracker = LiveSegmentTracker()
        for pending in tracker.absorb(window(from: 200, count: 3)) {
            tracker.commit(pending)
        }
        // A misbehaving server rewinding its sequence must not make the recording
        // repeat itself.
        XCTAssertTrue(tracker.absorb(window(from: 100, count: 3)).isEmpty)
    }

    func testTakenCountTracksWhatReachedDisk() {
        var tracker = LiveSegmentTracker()
        let pending = tracker.absorb(window(from: 0, count: 5))
        XCTAssertEqual(tracker.takenCount, 0, "offering is not taking")
        for item in pending.prefix(3) { tracker.commit(item) }
        XCTAssertEqual(tracker.takenCount, 3)
    }

    // MARK: - Refresh pacing

    /// Half the target duration: fast enough that the window cannot slide past, slow
    /// enough not to hammer someone's CDN.
    func testRefreshDelayIsHalfTheTargetDuration() {
        XCTAssertEqual(LiveSegmentTracker.refreshDelay(targetDuration: 6), 3)
        XCTAssertEqual(LiveSegmentTracker.refreshDelay(targetDuration: 4), 2)
    }

    func testRefreshDelayIsClamped() {
        XCTAssertEqual(LiveSegmentTracker.refreshDelay(targetDuration: 0.2), 1.0, "no busy loop")
        XCTAssertEqual(LiveSegmentTracker.refreshDelay(targetDuration: 600), 10.0, "no long nap")
        XCTAssertEqual(
            LiveSegmentTracker.refreshDelay(targetDuration: 0),
            1.0,
            "a playlist with no target duration still has to be polled"
        )
    }
}

final class LiveSegmentIdentityTests: XCTestCase {
    /// Load-bearing assumption, verified against the real parser rather than assumed:
    /// `Segment.id` is the media sequence number, not the array index. If it were the
    /// index, the tracker would treat every refresh as entirely new content.
    func testSegmentIdIsTheMediaSequenceNumber() throws {
        let text = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:4
        #EXT-X-MEDIA-SEQUENCE:8471
        #EXTINF:4.0,
        a.ts
        #EXTINF:4.0,
        b.ts
        #EXTINF:4.0,
        c.ts
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected a media playlist")
        }
        XCTAssertEqual(media.segments.map(\.id), [8471, 8472, 8473])
        XCTAssertFalse(media.endList, "no ENDLIST means this is live")
        XCTAssertEqual(media.targetDuration, 4)
    }

    /// The parser must report a rolling playlist as unfinished, since that flag is the
    /// only thing distinguishing a live stream from a completed one.
    func testAPlaylistWithEndListIsNotLive() throws {
        let text = """
        #EXTM3U
        #EXT-X-TARGETDURATION:4
        #EXTINF:4.0,
        a.ts
        #EXT-X-ENDLIST
        """
        guard case .media(let media) = try HLSPlaylist.parse(text) else {
            return XCTFail("expected a media playlist")
        }
        XCTAssertTrue(media.endList)
    }

    /// End to end over two real refreshes of a rolling window.
    func testTwoRealRefreshesYieldOnlyTheNewSegments() throws {
        func playlist(from: Int) -> String {
            """
            #EXTM3U
            #EXT-X-TARGETDURATION:4
            #EXT-X-MEDIA-SEQUENCE:\(from)
            #EXTINF:4.0,
            s\(from).ts
            #EXTINF:4.0,
            s\(from + 1).ts
            #EXTINF:4.0,
            s\(from + 2).ts
            """
        }
        var tracker = LiveSegmentTracker()
        guard case .media(let first) = try HLSPlaylist.parse(playlist(from: 10)),
              case .media(let second) = try HLSPlaylist.parse(playlist(from: 12))
        else { return XCTFail("expected media playlists") }

        for pending in tracker.absorb(first) { tracker.commit(pending) }
        let new = tracker.absorb(second)
        XCTAssertEqual(new.map(\.segment.uri), ["s13.ts", "s14.ts"])
        XCTAssertEqual(tracker.missedSegmentCount, 0)
    }
}
