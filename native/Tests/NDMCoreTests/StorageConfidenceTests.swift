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
}
