import XCTest
import NDMCore
@testable import NDMEngine

final class LiveTailPaybackTests: XCTestCase {
    func testUnknownSmallTailWaitsButLargeStallCanHedge() {
        let small = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: 2 * 1024 * 1024 - 1), completed: 0)
        XCTAssertFalse(small.canBenefitFromTailSplit(setupSeconds: 0.1, now: 10))
        let large = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: 8 * 1024 * 1024 - 1), completed: 0)
        XCTAssertTrue(large.canBenefitFromTailSplit(setupSeconds: 0.1, now: 10))
    }
    func testActualBodyRateExcludesRestoredPrefixAndPaysResponseCost() {
        let lease = RangeTransferLease(segment: SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 0, end: 4_000_000 - 1), completed: 2_000_000)
        lease.recordTransferSample(now: 10)
        lease.completed += 500_000
        XCTAssertTrue(lease.canBenefitFromTailSplit(setupSeconds: 0.1, now: 10.5))
        XCTAssertFalse(lease.canBenefitFromTailSplit(setupSeconds: 1, now: 10.5))
        lease.completed = 3_950_000
        XCTAssertFalse(lease.canBenefitFromTailSplit(setupSeconds: 0.1, now: 10.6))
        lease.resetTransferSample()
        XCTAssertFalse(lease.canBenefitFromTailSplit(setupSeconds: 0.1, now: 20))
    }
}
