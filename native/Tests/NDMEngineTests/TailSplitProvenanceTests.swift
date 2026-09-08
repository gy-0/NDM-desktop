import XCTest
@testable import NDMCore
@testable import NDMEngine

final class TailSplitProvenanceTests: XCTestCase {
    private func fixture() throws -> (URL, [SegmentRecord], [SegmentRecord]) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = [record(0, 0, 99), record(1, 100, 999)]
        let split = [record(0, 0, 99), record(1, 100, 499), record(2, 500, 999)]
        return (root, original, split)
    }
    private func record(_ id: Int16, _ start: Int64, _ end: Int64) -> SegmentRecord {
        .init(order: id, segmentId: id, nextId: -1, start: start, end: end)
    }
    private let empty = TailSplitProvenance.State(origins: [:], rebalanceDisabled: false)

    func testBothSidesOfInterruptedPlanCommitRemainRecoverable() throws {
        let (root, original, split) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity-a")
        try journal.prepare(from: [], to: original, state: empty)
        try journal.prepare(from: original, to: split, state: .init(origins: [2: original[1]], rebalanceDisabled: false))
        // Simulated death before the separate plan commit: the old exact layout wins.
        let reopened = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity-a")
        XCTAssertTrue(try XCTUnwrap(reopened.load(for: original)).origins.isEmpty)
        // Simulated death after the plan commit: candidate provenance wins.
        let recovered = try XCTUnwrap(reopened.load(for: split))
        XCTAssertEqual(recovered.origins[2]?.start, 100)
        XCTAssertEqual(recovered.origins[2]?.end, 999)
        XCTAssertNil(try reopened.load(for: [record(0, 0, 98), record(1, 99, 999)]))
        XCTAssertNil(try TailSplitProvenance(workDirectory: root, resourceContextHash: "different-file").load(for: split))
    }

    func testRepeatedFailedPlanCommitRetainsCommittedSlot() throws {
        let (root, original, split) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity")
        try journal.prepare(from: [], to: original, state: .init(origins: [:], rebalanceDisabled: true))
        try journal.prepare(from: original, to: split, state: .init(origins: [2: original[1]], rebalanceDisabled: false))
        let alternative = [record(0, 0, 99), record(1, 100, 599), record(3, 600, 999)]
        try journal.prepare(from: original, to: alternative, state: .init(origins: [3: original[1]], rebalanceDisabled: false))
        XCTAssertTrue(try XCTUnwrap(journal.load(for: original)).rebalanceDisabled)
        XCTAssertNotNil(try journal.load(for: alternative)?.origins[3])
        XCTAssertNil(try journal.load(for: split))
    }

    func testJournalWriteFailureDoesNotReplaceCommittedProvenance() throws {
        let (root, original, split) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity")
        try journal.prepare(from: [], to: split, state: .init(origins: [2: original[1]], rebalanceDisabled: false))
        let failing = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity", io: .init(write: { _, _ in throw CocoaError(.fileWriteOutOfSpace) }))
        XCTAssertThrowsError(try failing.prepare(from: split, to: original, state: .init(origins: [:], rebalanceDisabled: true)))
        XCTAssertNotNil(try journal.load(for: split)?.origins[2])
        XCTAssertNil(try journal.load(for: original))
    }

    func testFreshLayoutCannotInheritOldTailOrDisabledState() throws {
        let (root, original, split) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity")
        try journal.prepare(from: [], to: split, state: .init(origins: [2: original[1]], rebalanceDisabled: true))
        try journal.prepare(from: [], to: split, state: empty)
        let result = try XCTUnwrap(journal.load(for: split))
        XCTAssertTrue(result.origins.isEmpty); XCTAssertFalse(result.rebalanceDisabled)
    }

    func testInitialSegmentCannotBePromotedToSpeculativeChild() throws {
        let (root, original, _) = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = TailSplitProvenance(workDirectory: root, resourceContextHash: "identity")
        XCTAssertThrowsError(try journal.prepare(from: [], to: original, state: .init(origins: [0: record(9, 0, 999)], rebalanceDisabled: false)))
        XCTAssertNil(try journal.load(for: original))
        try Data("corrupted".utf8).write(to: root.appendingPathComponent(TailSplitProvenance.filename))
        XCTAssertNil(try journal.load(for: original))
    }
}
