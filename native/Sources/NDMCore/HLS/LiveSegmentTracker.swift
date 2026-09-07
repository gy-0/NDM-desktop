import Foundation

/// Decides which segments of a rolling live playlist are new.
///
/// A live playlist is a *window* that slides: the same array index means a different
/// segment on every refresh, and a segment that was at index 5 is at index 2 a few
/// seconds later. Deduplicating by index therefore either re-downloads everything or
/// silently skips content. Identity comes from the media sequence number —
/// `#EXT-X-MEDIA-SEQUENCE` plus position — which the server guarantees to increase.
///
/// Pure on purpose: this is the part that decides what ends up in the recording, so it
/// has to be testable without a network, a clock, or a live stream to point at.
public struct LiveSegmentTracker: Sendable, Equatable {
    /// Highest media sequence number already taken. Nil before the first refresh.
    public private(set) var lastTakenSequence: Int?
    /// Segments that fell out of the window before being taken, i.e. real gaps in the
    /// recording. Counted rather than hidden: a recording with holes must be able to
    /// say so.
    public private(set) var missedSegmentCount = 0
    /// Total taken, which doubles as the next output file's index.
    public private(set) var takenCount = 0

    public init() {}

    /// One segment to fetch, with the sequence number it is identified by.
    public struct Pending: Equatable, Sendable {
        public let sequence: Int
        public let segment: HLSPlaylist.Segment
        /// Position in the recording, so output files stay in order even as the
        /// playlist window slides underneath.
        public let outputIndex: Int

        public init(sequence: Int, segment: HLSPlaylist.Segment, outputIndex: Int) {
            self.sequence = sequence
            self.segment = segment
            self.outputIndex = outputIndex
        }
    }

    /// Absorb a refreshed playlist and report what has not been taken yet.
    ///
    /// Mutating, because "what is new" only means anything relative to what came
    /// before.
    public mutating func absorb(_ media: HLSPlaylist.Media) -> [Pending] {
        // `Segment.id` is seeded from #EXT-X-MEDIA-SEQUENCE by the parser and
        // increments per segment, so it *is* the media sequence number.
        let sequences = media.segments.map(\.id)
        guard let firstAvailable = sequences.first else { return [] }

        if let lastTaken = lastTakenSequence {
            // The window moved past segments never taken. Polling too slowly, or a
            // stall, and the recording now has a hole in it.
            if firstAvailable > lastTaken + 1 {
                missedSegmentCount += firstAvailable - (lastTaken + 1)
            }
        }

        var pending: [Pending] = []
        for segment in media.segments {
            if let lastTaken = lastTakenSequence, segment.id <= lastTaken { continue }
            pending.append(Pending(
                sequence: segment.id,
                segment: segment,
                outputIndex: takenCount + pending.count
            ))
        }
        return pending
    }

    /// Record that a pending segment reached disk.
    ///
    /// Separate from `absorb` so a failed download does not advance the cursor: the
    /// next refresh must be able to try it again while it is still in the window.
    public mutating func commit(_ pending: Pending) {
        lastTakenSequence = max(lastTakenSequence ?? Int.min, pending.sequence)
        takenCount += 1
    }

    /// How long to wait before refreshing.
    ///
    /// Half the target duration, which is the usual reading of the HLS spec's advice:
    /// poll faster than segments are produced or the window slides past you, but not so
    /// fast that it is a busy loop against someone's CDN.
    public static func refreshDelay(
        targetDuration: TimeInterval,
        floor: TimeInterval = 1.0,
        ceiling: TimeInterval = 10.0
    ) -> TimeInterval {
        guard targetDuration > 0 else { return floor }
        return min(max(targetDuration / 2, floor), ceiling)
    }
}
