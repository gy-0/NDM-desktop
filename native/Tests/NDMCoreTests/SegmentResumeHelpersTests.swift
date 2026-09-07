import XCTest
@testable import NDMCore

final class SegmentResumeHelpersTests: XCTestCase {
    func testRemainingRange() {
        let seg = SegmentRecord(order: 0, segmentId: 0, nextId: -1, start: 100, end: 199)
        XCTAssertNil(SegmentFileFormat.remainingRange(for: seg, have: 100))
        let rem = SegmentFileFormat.remainingRange(for: seg, have: 40)
        XCTAssertEqual(rem?.start, 140)
        XCTAssertEqual(rem?.end, 199)
    }

    func testExistingByteCountClamped() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-seg-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let seg = SegmentRecord(order: 0, segmentId: 3, nextId: -1, start: 0, end: 9)
        try Data(repeating: 1, count: 50).write(to: SegmentFileFormat.segmentFileURL(id: 3, in: dir))
        XCTAssertEqual(SegmentFileFormat.existingByteCount(for: seg, in: dir), 10)
    }
}
