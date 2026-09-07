import XCTest
@testable import NDMCore

final class SegmentDynamicPlanTests: XCTestCase {
    func testOwnedOriginalDynamicThresholdsRemainPinned() {
        XCTAssertEqual(SegmentFileFormat.originalHTTPPlanningQuantumBytes, 0x3A000)
        XCTAssertEqual(SegmentFileFormat.originalHTTPSplitThresholdBytes, 0x32000)
        XCTAssertEqual(SegmentFileFormat.originalAlternatePlanningQuantumBytes, 0x88000)
        XCTAssertEqual(SegmentFileFormat.originalAlternateSplitThresholdBytes, 0x80000)
    }

    func testOwnedOriginalWorkerCapacityUsesPerRangeQuantum() {
        let quantum = SegmentFileFormat.originalHTTPPlanningQuantumBytes
        XCTAssertEqual(
            SegmentFileFormat.originalHTTPWorkerCapacity(remainingRanges: []),
            0
        )
        XCTAssertEqual(
            SegmentFileFormat.originalHTTPWorkerCapacity(remainingRanges: [quantum - 1]),
            1
        )
        XCTAssertEqual(
            SegmentFileFormat.originalHTTPWorkerCapacity(remainingRanges: [quantum]),
            2
        )
        XCTAssertEqual(
            SegmentFileFormat.originalHTTPWorkerCapacity(
                remainingRanges: [2 * quantum, quantum / 2]
            ),
            4
        )
        XCTAssertEqual(
            SegmentFileFormat.originalHTTPWorkerCapacity(
                remainingRanges: [100 * quantum]
            ),
            32
        )
    }

    func testTailRebalanceWaitsForMeaningfulWorkerDeficitAndBytes() {
        let oneMiB = Int64(1024 * 1024)

        XCTAssertFalse(SegmentFileFormat.shouldRebalanceTail(
            targetConnections: 32,
            activeConnections: 31,
            remainingBytesBySegment: Array(repeating: oneMiB, count: 31)
        ))
        XCTAssertTrue(SegmentFileFormat.shouldRebalanceTail(
            targetConnections: 32,
            activeConnections: 24,
            remainingBytesBySegment: Array(repeating: 2 * oneMiB, count: 24)
        ))
        XCTAssertFalse(SegmentFileFormat.shouldRebalanceTail(
            targetConnections: 32,
            activeConnections: 24,
            remainingBytesBySegment: Array(repeating: 128 * 1024, count: 24)
        ))
        XCTAssertFalse(SegmentFileFormat.shouldRebalanceTail(
            targetConnections: 1,
            activeConnections: 0,
            remainingBytesBySegment: [oneMiB]
        ))
    }

    func testTailRebalanceSkipsWhenCurrentWorkersWillFinishBeforeReconnectPaysBack() {
        let plan = SegmentFileFormat.tailRebalancePlan(
            targetConnections: 8,
            activeConnections: 4,
            remainingBytesBySegment: [2 * 1024 * 1024],
            bytesPerSecond: 20 * 1024 * 1024,
            connectionSetupSeconds: 0.75
        )
        XCTAssertNil(plan)
    }

    func testTailRebalanceUsesOnlyConnectionsWithEnoughWork() throws {
        let plan = try XCTUnwrap(SegmentFileFormat.tailRebalancePlan(
            targetConnections: 32,
            activeConnections: 8,
            remainingBytesBySegment: [40 * 1024 * 1024],
            bytesPerSecond: 8 * 1024 * 1024,
            connectionSetupSeconds: 0.75
        ))
        XCTAssertEqual(plan.desiredConnections, 16)
        XCTAssertEqual(plan.minimumUsefulBytesPerConnection, 1_572_864)
        XCTAssertEqual(plan.totalRemainingBytes, 40 * 1024 * 1024)
        XCTAssertEqual(plan.estimatedSecondsRemaining ?? -1, 5, accuracy: 0.001)
    }

    func testTailRebalanceStopsBeforeBisectionCreatesTinyLeafRanges() throws {
        let oneMiB = Int64(1024 * 1024)
        let plan = try XCTUnwrap(SegmentFileFormat.tailRebalancePlan(
            targetConnections: 8,
            activeConnections: 2,
            remainingBytesBySegment: [5 * oneMiB, oneMiB],
            bytesPerSecond: 0
        ))

        XCTAssertEqual(
            plan.minimumUsefulBytesPerConnection,
            SegmentFileFormat.originalHTTPPlanningQuantumBytes * 4
        )
        XCTAssertEqual(plan.desiredConnections, 5)
    }

    func testTailRebalanceRequiresOneMiBPerNewWorkerBeforeSpeedIsKnown() {
        XCTAssertNil(SegmentFileFormat.tailRebalancePlan(
            targetConnections: 4,
            activeConnections: 2,
            remainingBytesBySegment: [3 * 1024 * 1024],
            bytesPerSecond: 0
        ))
        XCTAssertEqual(SegmentFileFormat.tailRebalancePlan(
            targetConnections: 4,
            activeConnections: 2,
            remainingBytesBySegment: [8 * 1024 * 1024],
            bytesPerSecond: 0
        )?.desiredConnections, 4)
    }

    func test4125ObservedPrefixProducesExactFixtureBoundary() {
        let total: Int64 = 18_207_337
        let segs = SegmentFileFormat.planDynamicInitial(
            totalBytes: total,
            completedPrefixBytes: 983_040
        )
        XCTAssertEqual(segs.count, 2)
        XCTAssertEqual(segs[0].start, 0)
        XCTAssertEqual(segs[0].end, 9_595_187)
        XCTAssertEqual(segs[1].start, 9_595_188)
        XCTAssertEqual(segs[1].end, total - 1)
    }

    func testDynamicExpansionKeeps4125FirstSplitAndCoversFile() {
        let total: Int64 = 18_207_337
        let segments = SegmentFileFormat.planDynamicConnections(
            totalBytes: total,
            connections: 32,
            completedPrefixBytes: 983_040
        )
        XCTAssertEqual(segments.count, 32)
        XCTAssertEqual(segments.first?.start, 0)
        XCTAssertEqual(segments.last?.end, total - 1)
        XCTAssertTrue(segments.contains { $0.end == 9_595_187 })
        XCTAssertTrue(segments.contains { $0.start == 9_595_188 })
        for (left, right) in zip(segments, segments.dropFirst()) {
            XCTAssertEqual(left.end + 1, right.start)
            XCTAssertEqual(left.nextId, Int32(right.segmentId))
        }
    }

    /// Regression: a small file (BearCleaner 7.7 MB, 960 KiB bootstrap prefix)
    /// bisected segment 0 down to ~271 KB while its file held the full 960 KiB
    /// prefix, so the strict merge (`have == seg.length`) failed with
    /// "已下载分段合并失败". Segment 0 must never be planned shorter than the
    /// prefix already on disk.
    func testSegmentZeroNeverShrinksBelowBootstrapPrefix() {
        let total: Int64 = 7_716_106
        let prefix: Int64 = 983_040
        let segments = SegmentFileFormat.planDynamicConnections(
            totalBytes: total,
            connections: 32,
            completedPrefixBytes: prefix
        )
        let segZero = segments.first { $0.segmentId == 0 && $0.start == 0 }
        XCTAssertNotNil(segZero)
        XCTAssertGreaterThanOrEqual(segZero!.length, prefix,
            "segment 0 must keep at least its downloaded bootstrap prefix")
        // Still a valid, gap-free plan over the whole file.
        XCTAssertEqual(segments.first?.start, 0)
        XCTAssertEqual(segments.last?.end, total - 1)
        for (left, right) in zip(segments, segments.dropFirst()) {
            XCTAssertEqual(left.end + 1, right.start)
        }
    }

    func testMinSegmentCapsConnections() {
        let segs = SegmentFileFormat.planEqualSegments(totalBytes: 100_000, connections: 32)
        XCTAssertLessThan(segs.count, 32)
        XCTAssertGreaterThanOrEqual(segs.count, 1)
    }

    func testDynamicPlanTreatsConnectionCountAsCeilingForSmallFiles() {
        XCTAssertEqual(
            SegmentFileFormat.planDynamicConnections(
                totalBytes: 100_000,
                connections: 32,
                completedPrefixBytes: 25_000
            ).count,
            1
        )
        XCTAssertEqual(
            SegmentFileFormat.planDynamicConnections(
                totalBytes: 600_000,
                connections: 32,
                completedPrefixBytes: 150_000
            ).count,
            3
        )
    }

    func testManualReplanDoesNotSplitTinyTailIntoManyConnections() {
        let total: Int64 = 4 * 1024 * 1024
        let existing = SegmentFileFormat.planEqualSegments(
            totalBytes: total,
            connections: 1
        )
        let remaining: Int64 = 128 * 1024
        let replanned = SegmentFileFormat.replanConnections(
            existing: existing,
            totalBytes: total,
            newConnections: 32,
            completedByID: [0: total - remaining]
        )

        XCTAssertEqual(replanned.count, 2) // downloaded prefix + one useful tail
        XCTAssertEqual(replanned.last?.length, remaining)
        XCTAssertTrue(SegmentFileFormat.isValidResumePlan(replanned, totalBytes: total))
    }

    func testReplanPreservesCompletedPrefix() {
        let total: Int64 = 1_000_000
        let existing = SegmentFileFormat.planEqualSegments(totalBytes: total, connections: 2)
        let completed: [Int16: Int64] = [
            0: existing[0].length, // first fully done
            1: existing[1].length / 2,
        ]
        let replanned = SegmentFileFormat.replanConnections(
            existing: existing,
            totalBytes: total,
            newConnections: 4,
            completedByID: completed
        )
        XCTAssertFalse(replanned.isEmpty)
        XCTAssertEqual(replanned.first?.start, 0)
        XCTAssertEqual(replanned.last?.end, total - 1)
        XCTAssertEqual(replanned.first?.segmentId, existing[0].segmentId)
        XCTAssertTrue(replanned.contains {
            $0.segmentId == existing[1].segmentId
                && $0.start == existing[1].start
                && $0.length == completed[existing[1].segmentId]
        })
        XCTAssertEqual(Set(replanned.map(\.segmentId)).count, replanned.count)
        for (left, right) in zip(replanned, replanned.dropFirst()) {
            XCTAssertEqual(left.end + 1, right.start)
            XCTAssertEqual(left.nextId, Int32(right.segmentId))
        }
    }

    func testTailRollbackMergesOnlyFailedChildBackIntoItsParent() throws {
        let total: Int64 = 2 * 1024 * 1024
        let parent = SegmentRecord(
            order: 0,
            segmentId: 7,
            nextId: SegmentRecord.endOfList,
            start: 0,
            end: total - 1
        )
        let children = SegmentFileFormat.replanConnections(
            existing: [parent],
            totalBytes: total,
            newConnections: 3,
            completedByID: [7: 0]
        )
        let failed = try XCTUnwrap(children.last)
        let rollback = try XCTUnwrap(SegmentFileFormat.rollbackTailSplit(
            existing: children,
            failedSegmentID: failed.segmentId,
            originalParent: parent
        ))

        XCTAssertEqual(rollback.records.count, children.count - 1)
        XCTAssertFalse(rollback.records.contains { $0.segmentId == failed.segmentId })
        let survivor = try XCTUnwrap(rollback.records.first {
            $0.segmentId == rollback.survivorID
        })
        XCTAssertEqual(survivor.end, failed.end)
        for (left, right) in zip(rollback.records, rollback.records.dropFirst()) {
            XCTAssertEqual(left.end + 1, right.start)
            XCTAssertEqual(left.nextId, Int32(right.segmentId))
        }
    }

    func testTailRollbackRejectsOriginalOrUnrelatedSegment() {
        let original = SegmentFileFormat.planEqualSegments(
            totalBytes: 4 * 1024 * 1024,
            connections: 2
        )
        XCTAssertNil(SegmentFileFormat.rollbackTailSplit(
            existing: original,
            failedSegmentID: original[0].segmentId,
            originalParent: original[0]
        ))
        XCTAssertNil(SegmentFileFormat.rollbackTailSplit(
            existing: original,
            failedSegmentID: original[1].segmentId,
            originalParent: original[0]
        ))
    }

    func testResumePlanValidationRejectsAliasGapAndBrokenLink() {
        let valid = SegmentFileFormat.planEqualSegments(
            totalBytes: 1_048_576,
            connections: 4
        )
        XCTAssertTrue(SegmentFileFormat.isValidResumePlan(
            valid,
            totalBytes: 1_048_576
        ))

        var duplicateID = valid
        duplicateID[1].segmentId = duplicateID[0].segmentId
        XCTAssertFalse(SegmentFileFormat.isValidResumePlan(
            duplicateID,
            totalBytes: 1_048_576
        ))

        var gap = valid
        gap[1].start += 1
        XCTAssertFalse(SegmentFileFormat.isValidResumePlan(
            gap,
            totalBytes: 1_048_576
        ))

        var brokenLink = valid
        brokenLink[0].nextId = SegmentRecord.endOfList
        XCTAssertFalse(SegmentFileFormat.isValidResumePlan(
            brokenLink,
            totalBytes: 1_048_576
        ))
    }
}
