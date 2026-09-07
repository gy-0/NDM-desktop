import XCTest
@testable import NDMCore

final class StorageConfidenceTests: XCTestCase {
    func testSingleSeparatedMediaIncludesOneMergeWorkspace() {
        let budget = StorageBudget.media(
            sampleFinalBytes: 900,
            sampleComponentBytes: [700, 200],
            sampleDurationSeconds: 60
        )

        XCTAssertEqual(budget.finalBytes, 900)
        XCTAssertEqual(budget.temporaryBytes, 900)
        XCTAssertEqual(budget.peakBytes, 1_800)
        XCTAssertFalse(budget.isCollectionEstimate)
    }

    func testProgressiveMediaDoesNotDoubleCountFinalFile() {
        let budget = StorageBudget.media(
            sampleFinalBytes: 900,
            sampleComponentBytes: [900],
            sampleDurationSeconds: 60
        )

        XCTAssertEqual(budget.peakBytes, 900)
    }

    func testCollectionUsesDurationsAndOnlyOneItemMergeWorkspace() {
        let budget = StorageBudget.media(
            sampleFinalBytes: 600,
            sampleComponentBytes: [500, 100],
            sampleDurationSeconds: 60,
            collectionDurations: [30, 60, 90]
        )

        XCTAssertEqual(budget.finalBytes, 1_800)
        XCTAssertEqual(budget.temporaryBytes, 600)
        XCTAssertEqual(budget.peakBytes, 2_400)
        XCTAssertTrue(budget.isCollectionEstimate)
    }

    func testCollectionFillsMissingDurationsWithKnownAverage() {
        let budget = StorageBudget.media(
            sampleFinalBytes: 600,
            sampleComponentBytes: [],
            sampleDurationSeconds: 60,
            collectionDurations: [30, nil, 90]
        )

        XCTAssertEqual(budget.finalBytes, 1_800)
    }

    func testConfidenceSeparatesComfortableTightAndInsufficient() {
        let budget = StorageBudget(finalBytes: 800, temporaryBytes: 200)
        XCTAssertEqual(StorageConfidence(
            budget: budget,
            availableBytes: 2_000,
            safetyReserveBytes: 500
        ).level, .comfortable)
        XCTAssertEqual(StorageConfidence(
            budget: budget,
            availableBytes: 1_200,
            safetyReserveBytes: 500
        ).level, .tight)
        let insufficient = StorageConfidence(
            budget: budget,
            availableBytes: 750,
            safetyReserveBytes: 500
        )
        XCTAssertEqual(insufficient.level, .insufficient)
        XCTAssertEqual(insufficient.shortfallBytes, 250)
    }

    func testLiveCapacityReadsTemporaryVolume() {
        let available = VolumeCapacity.availableBytes(at: FileManager.default.temporaryDirectory)
        XCTAssertNotNil(available)
        XCTAssertGreaterThan(available ?? 0, 0)
    }

    func testDirectDownloadCountsTemporaryAndFinalFileOnSharedVolume() {
        let budget = DirectDownloadStorageBudget(
            totalBytes: 1_000,
            existingWorkBytes: 250,
            existingDestinationBytes: 100,
            sharesVolume: true
        )

        XCTAssertEqual(budget.workBytesRequired, 750)
        XCTAssertEqual(budget.destinationBytesRequired, 900)
        XCTAssertEqual(budget.sharedVolumeBytesRequired, 1_650)
    }

    func testDirectDownloadKeepsVolumeRequirementsSeparate() {
        let budget = DirectDownloadStorageBudget(
            totalBytes: 1_000,
            existingWorkBytes: 250,
            existingDestinationBytes: 100,
            sharesVolume: false
        )

        XCTAssertEqual(budget.workBytesRequired, 750)
        XCTAssertEqual(budget.destinationBytesRequired, 900)
        XCTAssertNil(budget.sharedVolumeBytesRequired)
    }

    func testTemporaryDirectoryAndMissingChildResolveToSameVolume() {
        let temp = FileManager.default.temporaryDirectory
        let missing = temp.appendingPathComponent(UUID().uuidString, isDirectory: true)
        XCTAssertTrue(VolumeCapacity.areOnSameVolume(temp, missing))
    }
    func testOffsetBudgetOnlyChargesDestinationPayload() {
        for shared in [false, true] {
            let budget = DirectDownloadStorageBudget(totalBytes: 1000,
                existingWorkBytes: 900, existingDestinationBytes: 1000,
                sharesVolume: shared, mode: .offsetDestination,
                verifiedAllocatedDestinationBytes: 200)
            XCTAssertEqual(budget.workBytesRequired, 0)
            XCTAssertEqual(budget.destinationBytesRequired, 800)
            XCTAssertEqual(budget.sharedVolumeBytesRequired, shared ? 800 : nil)
        }
    }

    func testSparseLogicalLengthDoesNotCountAsAllocatedStorage() {
        let budget = DirectDownloadStorageBudget(totalBytes: 1000,
            existingDestinationBytes: 1000, sharesVolume: true,
            mode: .offsetDestination)
        XCTAssertEqual(budget.sharedVolumeBytesRequired, 1000)
    }

    func testOffsetBudgetClampsInvalidAndOversizedAllocation() {
        let cases: [(Int64, Int64, Int64)] = [
            (-1, 20, 0), (100, -1, 100), (100, 200, 0),
            (Int64.max, Int64.min, Int64.max), (Int64.max, Int64.max, 0)
        ]
        for (total, allocated, expected) in cases {
            let budget = DirectDownloadStorageBudget(totalBytes: total,
                sharesVolume: true, mode: .offsetDestination,
                verifiedAllocatedDestinationBytes: allocated)
            XCTAssertEqual(budget.destinationBytesRequired, expected)
            XCTAssertEqual(budget.sharedVolumeBytesRequired, expected)
        }
    }

    func testLegacyDefaultIgnoresOffsetAllocationAndSaturatesPeak() {
        let legacy = DirectDownloadStorageBudget(totalBytes: 1000,
            existingWorkBytes: 200, existingDestinationBytes: 300,
            sharesVolume: true, verifiedAllocatedDestinationBytes: 1000)
        XCTAssertEqual(legacy.mode, .legacySegments)
        XCTAssertEqual(legacy.sharedVolumeBytesRequired, 1500)
        let huge = DirectDownloadStorageBudget(totalBytes: Int64.max, sharesVolume: true)
        XCTAssertEqual(huge.sharedVolumeBytesRequired, Int64.max)
    }

    func testMutableBudgetInputsRemainBoundedWithoutOverflow() {
        var budget = DirectDownloadStorageBudget(totalBytes: 100, sharesVolume: true, mode: .offsetDestination)
        budget.verifiedAllocatedDestinationBytes = .min
        budget.totalBytes = .max
        XCTAssertEqual(budget.destinationBytesRequired, .max)
        budget.totalBytes = .min
        XCTAssertEqual(budget.destinationBytesRequired, 0)
    }

}
