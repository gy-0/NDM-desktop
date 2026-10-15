import Foundation
import NDMCore

/// The writer and planner share this ownership boundary across HTTP retries.
/// Never await or synchronously call the engine actor while holding this lock.
final class RangeTransferLease: @unchecked Sendable {
    let lock = NSRecursiveLock()
    var segment: SegmentRecord
    var completed: Int64

    init(segment: SegmentRecord, completed: Int64) {
        self.segment = segment
        self.completed = completed
    }

    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }
}
