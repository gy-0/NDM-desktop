import XCTest
@testable import NDMCore
@testable import NDMEngine

final class MKVMergeProgressTests: XCTestCase {
    func testDualTrackSegmentsOccupyOneContinuousLogicalByteSpace() {
        let video = DownloadProgress(
            taskID: 7,
            totalBytes: 100,
            completedBytes: 80,
            bytesPerSecond: 40,
            segmentStates: [
                SegmentState(id: 0, start: 0, end: 49, completed: 50, isFinished: true),
                SegmentState(id: 1, start: 50, end: 99, completed: 30),
            ],
            status: .downloading
        )
        let audio = DownloadProgress(
            taskID: 8,
            totalBytes: 50,
            completedBytes: 20,
            bytesPerSecond: 10,
            segmentStates: [
                SegmentState(id: 0, start: 0, end: 24, completed: 20),
                SegmentState(id: 1, start: 25, end: 49, completed: 0),
            ],
            status: .downloading
        )

        let combined = MKVMergeEngine.combineProgress(video: video, audio: audio)

        XCTAssertEqual(combined.taskID, video.taskID)
        XCTAssertEqual(combined.totalBytes, 150)
        XCTAssertEqual(combined.completedBytes, 100)
        XCTAssertEqual(combined.bytesPerSecond, 50)
        XCTAssertEqual(combined.segmentStates.map(\.id), [0, 1, 1000, 1001])
        XCTAssertEqual(combined.segmentStates.map(\.start), [0, 50, 100, 125])
        XCTAssertEqual(combined.segmentStates.map(\.end), [49, 99, 124, 149])
        XCTAssertEqual(
            combined.segmentStates[1].end + 1,
            combined.segmentStates[2].start
        )
    }

    func testCombinedExtentFallsBackToSegmentsWhenTotalsAreNotReportedYet() {
        let video = DownloadProgress(
            taskID: 1,
            completedBytes: 25,
            segmentStates: [
                SegmentState(id: 0, start: 0, end: 99, completed: 25),
            ],
            status: .downloading
        )
        let audio = DownloadProgress(
            taskID: 2,
            completedBytes: 10,
            segmentStates: [
                SegmentState(id: 0, start: 0, end: 39, completed: 10),
            ],
            status: .downloading
        )

        let combined = MKVMergeEngine.combineProgress(video: video, audio: audio)

        XCTAssertEqual(combined.totalBytes, 140)
        XCTAssertEqual(combined.segmentStates[1].start, 100)
        XCTAssertEqual(combined.segmentStates[1].end, 139)
    }
}
