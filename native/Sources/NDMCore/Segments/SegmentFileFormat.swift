import Foundation

/// On-disk layout of `segments.bin` (24-byte records), recovered from runtime samples
/// and verified against LogFile Range lines (task 4125).
///
/// ```c
/// struct NeatSegmentRecord {
///   int16_t orderOrId;
///   int16_t segmentId;   // → seg.x{segmentId}
///   int32_t nextId;      // -1 = end
///   int64_t start;       // inclusive
///   int64_t end;         // inclusive
/// };
/// ```
public struct SegmentRecord: Equatable, Sendable {
    public var order: Int16
    public var segmentId: Int16
    public var nextId: Int32
    public var start: Int64
    public var end: Int64

    public static let recordSize = 24
    public static let endOfList: Int32 = -1

    public init(order: Int16, segmentId: Int16, nextId: Int32, start: Int64, end: Int64) {
        self.order = order
        self.segmentId = segmentId
        self.nextId = nextId
        self.start = start
        self.end = end
    }

    public var length: Int64 {
        max(0, end - start + 1)
    }

    public var rangeHeader: String {
        if end < 0 {
            return "bytes=\(start)-"
        }
        return "bytes=\(start)-\(end)"
    }
}

/// A bounded tail-steal plan. The configured connection count remains the
/// ceiling; `desiredConnections` is the number that still has enough work to
/// repay cancellation, TCP/TLS setup, and a fresh Range request near the end.
public struct TailRebalancePlan: Equatable, Sendable {
    public var desiredConnections: Int
    public var totalRemainingBytes: Int64
    public var minimumUsefulBytesPerConnection: Int64
    public var estimatedSecondsRemaining: Double?

    public init(
        desiredConnections: Int,
        totalRemainingBytes: Int64,
        minimumUsefulBytesPerConnection: Int64,
        estimatedSecondsRemaining: Double?
    ) {
        self.desiredConnections = desiredConnections
        self.totalRemainingBytes = totalRemainingBytes
        self.minimumUsefulBytesPerConnection = minimumUsefulBytesPerConnection
        self.estimatedSecondsRemaining = estimatedSecondsRemaining
    }
}

public enum SegmentFileFormat {
    public static func parse(_ data: Data) throws -> [SegmentRecord] {
        guard data.count % SegmentRecord.recordSize == 0 else {
            throw SegmentError.invalidSize(data.count)
        }
        var records: [SegmentRecord] = []
        records.reserveCapacity(data.count / SegmentRecord.recordSize)
        var offset = 0
        while offset < data.count {
            let order = readI16(data, offset)
            let segId = readI16(data, offset + 2)
            let next = readI32(data, offset + 4)
            let start = readI64(data, offset + 8)
            let end = readI64(data, offset + 16)
            records.append(SegmentRecord(order: order, segmentId: segId, nextId: next, start: start, end: end))
            offset += SegmentRecord.recordSize
        }
        return records
    }

    public static func serialize(_ records: [SegmentRecord]) -> Data {
        var data = Data(capacity: records.count * SegmentRecord.recordSize)
        for r in records {
            appendI16(&data, r.order)
            appendI16(&data, r.segmentId)
            appendI32(&data, r.nextId)
            appendI64(&data, r.start)
            appendI64(&data, r.end)
        }
        return data
    }

    /// First-party NDM 1.3 scheduling constants recovered from the owned 2021
    /// binary. `FUN_10005e1e0` uses 0x3A000 bytes as the normal HTTP planning
    /// quantum; `FUN_10005e2b4` only selects a parent whose remaining interval is
    /// greater than 0x32000 bytes. The alternate mode uses 0x88000 / 0x80000.
    /// Modern NDM keeps these as the hard behavioural floor, then adds a live
    /// connection-payback guard before recycling workers near completion.
    public static let originalHTTPPlanningQuantumBytes: Int64 = 0x3A000
    public static let originalHTTPSplitThresholdBytes: Int64 = 0x32000
    public static let originalAlternatePlanningQuantumBytes: Int64 = 0x88000
    public static let originalAlternateSplitThresholdBytes: Int64 = 0x80000

    /// Compatibility name used by the Swift planner and persisted-plan tests.
    public static let minSegmentBytes = originalHTTPPlanningQuantumBytes

    /// Direct Swift port of the original normal-HTTP worker-capacity estimate in
    /// `FUN_10005e1e0`: every unfinished range keeps one worker and earns another
    /// worker for each complete 0x3A000-byte quantum, capped by NDM's 32 sockets.
    public static func originalHTTPWorkerCapacity(
        remainingRanges: [Int64]
    ) -> Int {
        var workers = 0
        for remaining in remainingRanges where remaining > 0 {
            let contribution = remaining / originalHTTPPlanningQuantumBytes + 1
            let available = Int64(max(0, 32 - workers))
            workers += Int(min(available, contribution))
            if workers >= 32 { return 32 }
        }
        return workers
    }

    /// Validate the persisted linked range plan before any `seg.xN` file is
    /// trusted. A malformed plan must never be treated as resumable: duplicate
    /// ids can alias two logical ranges to one file, while gaps/overlaps silently
    /// corrupt the merged output.
    public static func isValidResumePlan(
        _ records: [SegmentRecord],
        totalBytes: Int64
    ) -> Bool {
        guard totalBytes > 0, !records.isEmpty else { return false }
        guard Set(records.map(\.segmentId)).count == records.count,
              records.allSatisfy({
                  $0.segmentId >= 0
                      && $0.start >= 0
                      && $0.end >= $0.start
                      && $0.end < totalBytes
              }) else {
            return false
        }

        let sorted = records.sorted { lhs, rhs in
            lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
        }
        guard sorted.first?.start == 0,
              sorted.last?.end == totalBytes - 1 else {
            return false
        }
        for (index, segment) in sorted.enumerated() {
            let expectedNext = index == sorted.count - 1
                ? SegmentRecord.endOfList
                : Int32(sorted[index + 1].segmentId)
            guard segment.nextId == expectedNext else { return false }
            if index > 0, sorted[index - 1].end + 1 != segment.start {
                return false
            }
        }
        return true
    }

    /// Decide how many workers a straggler tail can still use profitably.
    ///
    /// The original engine keeps recycling idle sockets into unfinished ranges.
    /// URLSession cannot safely shorten an in-flight response, so the clean-room
    /// engine rebalances in bounded rounds instead: after enough workers become
    /// idle, cancel the remaining requests, preserve every written prefix, split
    /// the holes again, and refill only workers that still have enough data to
    /// repay a new connection. Large pools use the original-like 75% threshold;
    /// small pools wait until half are idle. Aggregate throughput makes the final
    /// decision speed-aware: a fast transfer with a second left simply finishes
    /// instead of throwing away live sockets for another TCP/TLS round.
    public static func tailRebalancePlan(
        targetConnections: Int,
        activeConnections: Int,
        remainingBytesBySegment: [Int64],
        bytesPerSecond: Double,
        connectionSetupSeconds: Double = 0.75,
        useSetupPayback: Bool = true
    ) -> TailRebalancePlan? {
        let target = max(1, min(targetConnections, 32))
        guard target > 1,
              activeConnections > 0,
              activeConnections < target else {
            return nil
        }

        let positive = remainingBytesBySegment.filter { $0 > 0 }
        guard !positive.isEmpty else { return nil }

        // The original 32-worker engine starts stealing again around 24 active
        // sockets. Cancelling a small 4-worker round after the first completion
        // is disproportionately expensive, so pools below 16 wait until half
        // their workers are idle before considering a new round.
        if useSetupPayback {
            let idleThreshold = max(
                1,
                target >= 16 ? target * 3 / 4 : target / 2
            )
            guard activeConnections <= idleThreshold else { return nil }
        }

        let totalRemaining = positive.reduce(Int64(0), +)
        let largestRemaining = positive.max() ?? 0
        let setupSeconds = max(0.1, connectionSetupSeconds)
        let speed = max(0, bytesPerSecond)
        let estimatedSeconds = speed > 0 ? Double(totalRemaining) / speed : nil

        let minimumUsefulBytes: Int64
        if useSetupPayback {
            // Cancelling healthy requests and reconnecting cannot win if the whole
            // tail is already expected to finish within roughly two setup cycles.
            if let estimatedSeconds, estimatedSeconds <= setupSeconds * 2 {
                return nil
            }

            // Without a stable speed sample, require at least 1 MiB per worker.
            // This deliberately favors finishing the current tail over speculative
            // reconnects during the first sub-second progress window.
            let conservativeUnknownSpeedFloor = minSegmentBytes * 4
            let perActiveConnectionSpeed = speed > 0
                ? speed / Double(max(1, activeConnections))
                : 0
            let speedPaybackBytes = Int64(
                min(
                    Double(Int64.max / 2),
                    ceil(perActiveConnectionSpeed * setupSeconds * 2)
                )
            )
            minimumUsefulBytes = max(
                conservativeUnknownSpeedFloor,
                speedPaybackBytes
            )
        } else {
            // Original NDM: steal any leftover larger than the 0x32000 parent
            // split threshold. Do not refuse because TLS setup might not pay back.
            minimumUsefulBytes = originalHTTPSplitThresholdBytes
        }
        guard minimumUsefulBytes > 0 else { return nil }

        // Aggregate bytes alone are not enough to choose a worker count. For
        // example, 40 MiB / 1.5 MiB suggests 26 workers, but repeatedly bisecting
        // that one straggler would create 1.25 MiB leaves that cannot repay setup.
        // Simulate the exact largest-range bisection used by `replanConnections`
        // and add a worker only when both children remain independently useful.
        guard positive.count <= target else { return nil }
        var profitableRanges = positive
        let minimumSplittableBytes = max(
            minimumUsefulBytes * 2,
            originalHTTPSplitThresholdBytes + 1
        )
        while profitableRanges.count < target {
            guard let index = profitableRanges.indices
                .filter({ profitableRanges[$0] >= minimumSplittableBytes })
                .max(by: { profitableRanges[$0] < profitableRanges[$1] }) else {
                break
            }
            let original = profitableRanges[index]
            let left = original / 2
            let right = original - left
            guard left >= minimumUsefulBytes,
                  right >= minimumUsefulBytes else {
                break
            }
            profitableRanges[index] = left
            profitableRanges.append(right)
        }

        let desired = profitableRanges.count
        guard desired > activeConnections,
              largestRemaining >= minimumSplittableBytes else {
            return nil
        }

        return TailRebalancePlan(
            desiredConnections: desired,
            totalRemainingBytes: totalRemaining,
            minimumUsefulBytesPerConnection: minimumUsefulBytes,
            estimatedSecondsRemaining: estimatedSeconds
        )
    }

    /// Compatibility helper for callers that do not yet have a speed sample.
    public static func shouldRebalanceTail(
        targetConnections: Int,
        activeConnections: Int,
        remainingBytesBySegment: [Int64]
    ) -> Bool {
        tailRebalancePlan(
            targetConnections: targetConnections,
            activeConnections: activeConnections,
            remainingBytesBySegment: remainingBytesBySegment,
            bytesPerSecond: 0
        ) != nil
    }

    /// Split total file size into `connections` contiguous inclusive ranges (original starts with 1 then grows).
    public static func planEqualSegments(totalBytes: Int64, connections: Int) -> [SegmentRecord] {
        guard totalBytes > 0 else { return [] }
        let n = max(1, min(connections, 32))
        if n == 1 {
            return [SegmentRecord(order: 0, segmentId: 0, nextId: SegmentRecord.endOfList, start: 0, end: totalBytes - 1)]
        }
        let effective = min(
            n,
            max(1, originalHTTPWorkerCapacity(remainingRanges: [totalBytes]))
        )
        let part = totalBytes / Int64(effective)
        var segs: [SegmentRecord] = []
        for i in 0..<effective {
            let start = Int64(i) * part
            let end = (i == effective - 1) ? (totalBytes - 1) : (start + part - 1)
            let next: Int32 = (i == effective - 1) ? SegmentRecord.endOfList : Int32(i + 1)
            segs.append(SegmentRecord(order: Int16(i), segmentId: Int16(i), nextId: next, start: start, end: end))
        }
        return segs
    }

    /// Original behaviour: socket 1 has already received a prefix while socket 2 is
    /// connecting, then socket 2 steals half of the *remaining* interval.
    ///
    /// Task 4125 proves the timing-dependent form: after 983,040 bytes were received,
    /// `(983_040 + 18_207_337) / 2 == 9_595_188`, exactly matching the second Range
    /// and the persisted `segments.bin` boundary.
    public static func planDynamicInitial(
        totalBytes: Int64,
        completedPrefixBytes: Int64 = 0
    ) -> [SegmentRecord] {
        guard totalBytes > 0 else { return [] }
        guard totalBytes > 1 else {
            return planEqualSegments(totalBytes: totalBytes, connections: 1)
        }
        let prefix = min(max(0, completedPrefixBytes), totalBytes - 2)
        let mid = prefix + (totalBytes - prefix) / 2
        return [
            SegmentRecord(order: 0, segmentId: 0, nextId: 1, start: 0, end: mid - 1),
            SegmentRecord(order: 1, segmentId: 1, nextId: SegmentRecord.endOfList, start: mid, end: totalBytes - 1),
        ]
    }

    /// Grow the two-socket dynamic split by repeatedly bisecting the largest range,
    /// which is the clean-room equivalent of idle sockets stealing unfinished tails.
    /// Segment 0 deliberately keeps its id so an already-downloaded prefix in `seg.x0`
    /// remains append-compatible.
    public static func planDynamicConnections(
        totalBytes: Int64,
        connections: Int,
        completedPrefixBytes: Int64
    ) -> [SegmentRecord] {
        guard totalBytes > 0 else { return [] }
        let byteLimitedWorkers = max(
            1,
            originalHTTPWorkerCapacity(remainingRanges: [totalBytes])
        )
        let target = max(1, min(connections, 32, byteLimitedWorkers))
        guard target > 1 else {
            return planEqualSegments(totalBytes: totalBytes, connections: 1)
        }

        var segments = planDynamicInitial(
            totalBytes: totalBytes,
            completedPrefixBytes: completedPrefixBytes
        )
        // Segment 0 already holds `completedPrefixBytes` on disk (the bootstrap
        // prefix). Bisecting it below that floor would leave more bytes in
        // seg.x0 than the plan claims it should have, and the strict merge
        // (`have == seg.length`) then fails — the "已下载分段合并失败" bug on
        // small multi-connection files. Never split segment 0 under its prefix.
        let prefixFloor = min(max(0, completedPrefixBytes), totalBytes)
        var nextID: Int16 = 2
        while segments.count < target {
            let candidates = segments.indices.filter { index in
                let seg = segments[index]
                guard seg.length > 1 else { return false }
                // Segment 0 is only splittable in the region past its prefix.
                if seg.segmentId == 0, seg.start == 0 {
                    return seg.end >= prefixFloor && (seg.end - prefixFloor) >= 1
                }
                return true
            }
            guard let index = candidates.max(by: { segments[$0].length < segments[$1].length }) else {
                break
            }
            let original = segments[index]
            var split = original.start + original.length / 2
            if original.segmentId == 0, original.start == 0 {
                split = max(split, prefixFloor)
            }
            // A split that can't advance (already at the boundary) would loop.
            guard split > original.start, split <= original.end else { break }
            segments[index].end = split - 1
            segments.append(SegmentRecord(
                order: 0,
                segmentId: nextID,
                nextId: SegmentRecord.endOfList,
                start: split,
                end: original.end
            ))
            nextID += 1
        }
        return finalizeLinksPreservingIDs(segments)
    }

    /// Re-plan unfinished ranges into `newConnections` segments while preserving completed bytes on disk
    /// by keeping finished segments and re-splitting remaining byte ranges.
    public static func replanConnections(
        existing: [SegmentRecord],
        totalBytes: Int64,
        newConnections: Int,
        completedByID: [Int16: Int64]
    ) -> [SegmentRecord] {
        guard totalBytes > 0 else { return existing }
        let requestedWorkers = max(1, min(newConnections, 32))

        struct Hole {
            var start: Int64
            var end: Int64
            var reusableID: Int16?
            var length: Int64 { end - start + 1 }
        }

        var fixed: [SegmentRecord] = []
        var holes: [Hole] = []
        let sorted = existing.sorted { $0.start < $1.start }
        for segment in sorted {
            let have = min(max(0, completedByID[segment.segmentId] ?? 0), segment.length)
            if have > 0 {
                var prefix = segment
                prefix.end = segment.start + have - 1
                fixed.append(prefix)
            }
            if have < segment.length {
                holes.append(Hole(
                    start: segment.start + have,
                    end: segment.end,
                    reusableID: have == 0 ? segment.segmentId : nil
                ))
            }
        }
        guard !holes.isEmpty else {
            return finalizeLinksPreservingIDs(fixed)
        }

        let byteLimitedWorkers = max(
            1,
            originalHTTPWorkerCapacity(remainingRanges: holes.map(\.length))
        )
        let targetHoles = max(
            holes.count,
            min(requestedWorkers, byteLimitedWorkers)
        )
        while holes.count < targetHoles {
            guard let index = holes.indices
                .filter({ holes[$0].length > 1 })
                .max(by: { holes[$0].length < holes[$1].length }) else {
                break
            }
            let original = holes[index]
            let split = original.start + original.length / 2
            holes[index].end = split - 1
            holes.append(Hole(start: split, end: original.end, reusableID: nil))
        }

        var usedIDs = Set(existing.map(\.segmentId))
        func allocateID() -> Int16 {
            for candidate in Int16.min...Int16.max where candidate >= 0 && !usedIDs.contains(candidate) {
                usedIDs.insert(candidate)
                return candidate
            }
            // The format cannot represent more ids; this is unreachable under the 32-worker cap.
            return 0
        }

        var result = fixed
        for hole in holes {
            let id = hole.reusableID ?? allocateID()
            result.append(SegmentRecord(
                order: 0,
                segmentId: id,
                nextId: SegmentRecord.endOfList,
                start: hole.start,
                end: hole.end
            ))
        }
        return finalizeLinksPreservingIDs(result)
    }

    /// Roll an automatically-created upper-half child back into the adjacent
    /// lower range from which it was split. This mirrors the owned original
    /// engine's `Segment Rolled Back ... Merged To Segment` recovery without
    /// touching any other successfully downloaded child ranges.
    public static func rollbackTailSplit(
        existing: [SegmentRecord],
        failedSegmentID: Int16,
        originalParent: SegmentRecord
    ) -> (records: [SegmentRecord], survivorID: Int16)? {
        var sorted = existing.sorted { lhs, rhs in
            lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
        }
        guard let failedIndex = sorted.firstIndex(where: {
            $0.segmentId == failedSegmentID
        }), failedIndex > 0 else {
            return nil
        }

        let failed = sorted[failedIndex]
        let survivorIndex = failedIndex - 1
        let survivor = sorted[survivorIndex]
        guard failed.start >= originalParent.start,
              failed.end <= originalParent.end,
              survivor.start >= originalParent.start,
              survivor.end < originalParent.end,
              survivor.end + 1 == failed.start else {
            return nil
        }

        sorted[survivorIndex].end = failed.end
        let survivorID = survivor.segmentId
        sorted.remove(at: failedIndex)
        return (finalizeLinksPreservingIDs(sorted), survivorID)
    }

    private static func finalizeLinksPreservingIDs(_ segs: [SegmentRecord]) -> [SegmentRecord] {
        var sorted = segs.sorted { $0.start < $1.start }
        for i in 0..<sorted.count {
            sorted[i].order = Int16(i)
            sorted[i].nextId = (i == sorted.count - 1)
                ? SegmentRecord.endOfList
                : Int32(sorted[i + 1].segmentId)
        }
        return sorted
    }

    public static func segmentFileName(id: Int16) -> String {
        "seg.x\(id)"
    }

    public static func segmentFileURL(id: Int16, in workDirectory: URL) -> URL {
        workDirectory.appendingPathComponent(segmentFileName(id: id))
    }

    /// Bytes already on disk for a segment (0 if missing / unreadable).
    public static func existingByteCount(for segment: SegmentRecord, in workDirectory: URL) -> Int64 {
        min(rawExistingByteCount(for: segment, in: workDirectory), segment.length)
    }

    /// Unclamped size is required when validating resume and merge inputs.
    /// `existingByteCount` intentionally clamps for progress calculations, but
    /// an oversized part is evidence of a server ignoring Range or stale data.
    public static func rawExistingByteCount(for segment: SegmentRecord, in workDirectory: URL) -> Int64 {
        let url = segmentFileURL(id: segment.segmentId, in: workDirectory)
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else {
            return 0
        }
        return max(0, size.int64Value)
    }

    /// Inclusive Range still needed, or `nil` if the segment file is complete.
    public static func remainingRange(for segment: SegmentRecord, have: Int64) -> (start: Int64, end: Int64)? {
        guard have < segment.length else { return nil }
        let start = segment.start + have
        return (start, segment.end)
    }

    public static func loadSegmentsBin(from workDirectory: URL) throws -> [SegmentRecord]? {
        let url = workDirectory.appendingPathComponent("segments.bin")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        guard !data.isEmpty else { return nil }
        return try parse(data)
    }

    // MARK: - LE helpers

    private static func readI16(_ d: Data, _ o: Int) -> Int16 {
        Int16(bitPattern: UInt16(d[o]) | (UInt16(d[o + 1]) << 8))
    }

    private static func readI32(_ d: Data, _ o: Int) -> Int32 {
        Int32(bitPattern:
            UInt32(d[o]) |
            (UInt32(d[o + 1]) << 8) |
            (UInt32(d[o + 2]) << 16) |
            (UInt32(d[o + 3]) << 24)
        )
    }

    private static func readI64(_ d: Data, _ o: Int) -> Int64 {
        var v: UInt64 = 0
        for i in 0..<8 {
            v |= UInt64(d[o + i]) << (8 * i)
        }
        return Int64(bitPattern: v)
    }

    private static func appendI16(_ d: inout Data, _ v: Int16) {
        let u = UInt16(bitPattern: v)
        d.append(UInt8(u & 0xff))
        d.append(UInt8((u >> 8) & 0xff))
    }

    private static func appendI32(_ d: inout Data, _ v: Int32) {
        let u = UInt32(bitPattern: v)
        for i in 0..<4 { d.append(UInt8((u >> (8 * i)) & 0xff)) }
    }

    private static func appendI64(_ d: inout Data, _ v: Int64) {
        let u = UInt64(bitPattern: v)
        for i in 0..<8 { d.append(UInt8((u >> (8 * i)) & 0xff)) }
    }
}

public enum SegmentError: Error, LocalizedError {
    case invalidSize(Int)
    public var errorDescription: String? {
        switch self {
        case .invalidSize(let n): return "segments.bin size \(n) is not a multiple of 24"
        }
    }
}
