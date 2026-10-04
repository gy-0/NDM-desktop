import Foundation
import NDMCore

/// The writer and planner share this ownership boundary across HTTP retries.
/// Never await or synchronously call the engine actor while holding this lock.
final class RangeTransferLease: @unchecked Sendable {
    let lock = NSRecursiveLock()
    var segment: SegmentRecord
    var completed: Int64
    private var sampleStartedAt: TimeInterval?
    private var sampleStartedBytes: Int64 = 0

    // Called under the writer lock; restored bytes are not throughput samples.
    func resetTransferSample() { sampleStartedAt = nil }
    func recordTransferSample(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if sampleStartedAt == nil { sampleStartedAt = now; sampleStartedBytes = completed }
    }
    func canBenefitFromTailSplit(setupSeconds: Double, now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        let remaining = max(0, segment.length - completed)
        guard let began = sampleStartedAt, now - began >= 0.05, completed > sampleStartedBytes else {
            // No useful body-rate sample yet: avoid turning a small response
            // wait into another response wait. Large stalled ranges may hedge.
            return remaining > 2 * 1024 * 1024
        }
        let rate = Double(completed - sampleStartedBytes) / (now - began)
        // With the parent retained, halving a tail saves at most half its time
        // at the observed rate. Require that saving to cover a fresh response.
        return Double(remaining) / rate > 2 * max(0.1, setupSeconds)
    }

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
