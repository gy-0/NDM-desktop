import Foundation
import NDMCore

/// A two-slot companion journal: publish candidate provenance before changing
/// the transfer plan, retaining the entry for the still-committed plan. A process
/// interruption on either side of the plan write therefore has an exact match.
/// This does not upgrade legacy segment storage to power-loss durability.
struct TailSplitProvenance {
    static let filename = "tail-split-provenance.json"
    struct State {
        var origins: [Int16: SegmentRecord]
        var rebalanceDisabled: Bool
    }
    struct IO {
        var write: (Data, URL) throws -> Void = { try $0.write(to: $1, options: .atomic) }
    }
    private struct Geometry: Codable, Equatable {
        var id: Int16
        var start: Int64
        var end: Int64
        init(_ record: SegmentRecord) { id = record.segmentId; start = record.start; end = record.end }
        var record: SegmentRecord { .init(order: 0, segmentId: id, nextId: SegmentRecord.endOfList, start: start, end: end) }
    }
    private struct Origin: Codable {
        var child: Int16
        var parent: Geometry
    }
    private struct Entry: Codable {
        var plan: [Geometry]
        var origins: [Origin]
        var rebalanceDisabled: Bool
    }
    private struct Journal: Codable {
        var version: Int = 1
        var resourceContextHash: String
        var previous: Entry?
        var candidate: Entry
    }
    private let url: URL
    private let resourceContextHash: String
    private let io: IO
    init(workDirectory: URL, resourceContextHash: String, io: IO = .init()) {
        url = workDirectory.appendingPathComponent(Self.filename)
        self.resourceContextHash = resourceContextHash
        self.io = io
    }

    func load(for records: [SegmentRecord]) throws -> State? {
        guard !resourceContextHash.isEmpty, let entry = try matching(records) else { return nil }
        return state(entry, records: records)
    }

    /// An empty current plan denotes a genuinely fresh transfer. Never inherit
    /// an old entry even if the new geometry happens to be identical.
    func prepare(from current: [SegmentRecord], to next: [SegmentRecord], state: State) throws {
        guard !resourceContextHash.isEmpty, validPlan(next) else { throw Failure.invalidPlan }
        let candidate = Entry(plan: geometry(next), origins: state.origins.sorted { $0.key < $1.key }
            .map { Origin(child: $0.key, parent: Geometry($0.value)) }, rebalanceDisabled: state.rebalanceDisabled)
        guard self.state(candidate, records: next) != nil else { throw Failure.invalidProvenance }
        let previous = current.isEmpty ? nil : try matching(current)
        let data = try JSONEncoder().encode(Journal(resourceContextHash: resourceContextHash, previous: previous, candidate: candidate))
        try io.write(data, url)
    }

    enum Failure: Error { case invalidPlan, invalidProvenance }

    private func matching(_ records: [SegmentRecord]) throws -> Entry? {
        guard validPlan(records) else { return nil }
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return nil }
        // Unknown/corrupt advisory metadata cannot authorize a range rollback.
        guard let journal = try? JSONDecoder().decode(Journal.self, from: data),
              journal.version == 1, journal.resourceContextHash == resourceContextHash else { return nil }
        let plan = geometry(records)
        if journal.candidate.plan == plan, state(journal.candidate, records: records) != nil { return journal.candidate }
        if let previous = journal.previous, previous.plan == plan, state(previous, records: records) != nil { return previous }
        return nil
    }

    private func state(_ entry: Entry, records: [SegmentRecord]) -> State? {
        var origins: [Int16: SegmentRecord] = [:]
        for origin in entry.origins {
            let parent = origin.parent.record
            guard origins[origin.child] == nil, parent.segmentId >= 0, parent.segmentId != origin.child,
                  parent.start >= 0, parent.end >= parent.start, parent.end < Int64.max,
                  SegmentFileFormat.rollbackTailSplit(existing: records, failedSegmentID: origin.child, originalParent: parent) != nil else { return nil }
            origins[origin.child] = parent
        }
        return State(origins: origins, rebalanceDisabled: entry.rebalanceDisabled)
    }

    private func geometry(_ records: [SegmentRecord]) -> [Geometry] {
        records.sorted { $0.start == $1.start ? $0.segmentId < $1.segmentId : $0.start < $1.start }.map(Geometry.init)
    }
    private func validPlan(_ records: [SegmentRecord]) -> Bool {
        guard !records.isEmpty, Set(records.map(\.segmentId)).count == records.count else { return false }
        let ordered = geometry(records)
        guard ordered.allSatisfy({ $0.id >= 0 && $0.start >= 0 && $0.end >= $0.start && $0.end < Int64.max }) else { return false }
        return zip(ordered, ordered.dropFirst()).allSatisfy { $0.end + 1 == $1.start }
    }
}
