import XCTest
@testable import NDMCore

final class SegmentFileFormatTests: XCTestCase {
    func testParse4125FixtureMatchesLogRanges() throws {
        // reverse/fixtures/segments/4125_segments.bin
        let fixture = URL(fileURLWithPath: #file)
            .deletingLastPathComponent() // NDMCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // NDM
            .appendingPathComponent("reverse/fixtures/segments/4125_segments.bin")
        let data = try Data(contentsOf: fixture)
        let segs = try SegmentFileFormat.parse(data)
        XCTAssertEqual(segs.count, 2)
        XCTAssertEqual(segs[0].segmentId, 0)
        XCTAssertEqual(segs[0].start, 0)
        XCTAssertEqual(segs[0].end, 9_595_187)
        XCTAssertEqual(segs[0].nextId, 1)
        XCTAssertEqual(segs[1].segmentId, 1)
        XCTAssertEqual(segs[1].start, 9_595_188)
        XCTAssertEqual(segs[1].end, 18_207_336)
        XCTAssertEqual(segs[1].nextId, -1)
        XCTAssertEqual(segs[0].length + segs[1].length, 18_207_337)
    }

    func testSerializeRoundTrip() throws {
        let original = SegmentFileFormat.planEqualSegments(totalBytes: 1000, connections: 4)
        let data = SegmentFileFormat.serialize(original)
        let parsed = try SegmentFileFormat.parse(data)
        XCTAssertEqual(parsed, original)
    }

    func testRangeHeader() {
        let s = SegmentRecord(order: 1, segmentId: 1, nextId: -1, start: 100, end: 199)
        XCTAssertEqual(s.rangeHeader, "bytes=100-199")
    }
}
