import Foundation
import NDMCore

/// Timing/thresholds for smart connection tuning. Tests inject tiny values.
public struct AutoTuneConfig: Sendable {
    /// Connections to open before the first measurement.
    public var startConnections: Int
    /// Pause after (re)planning before sampling, letting sockets ramp up.
    public var settleNanos: UInt64
    /// Length of each throughput sample.
    public var windowNanos: UInt64
    /// Skip tuning entirely for files smaller than this — not worth the churn.
    public var minTotalBytes: Int64
    /// Stop probing when this little is left; finishing beats experimenting.
    public var minRemainingBytes: Int64

    public init(
        startConnections: Int = 2,
        settleNanos: UInt64 = 1_000_000_000,
        windowNanos: UInt64 = 2_500_000_000,
        minTotalBytes: Int64 = 32 << 20,
        minRemainingBytes: Int64 = 8 << 20
    ) {
        self.startConnections = startConnections
        self.settleNanos = settleNanos
        self.windowNanos = windowNanos
        self.minTotalBytes = minTotalBytes
        self.minRemainingBytes = minRemainingBytes
    }

    public static let `default` = AutoTuneConfig()
}

/// Pure decision logic: start low, double while it pays off, stop honestly.
public enum SmartConnectionTuner {
    /// A doubling must deliver at least this much to count as a win.
    public static let minGain = 1.25

    /// Conservative setup estimate from recent response-header latencies.
    ///
    /// Tail stealing pays for a fresh TCP/TLS/proxy round. A fixed desktop-LAN
    /// constant makes the final seconds worse on slow origins, while the 75th
    /// percentile follows the slower useful samples without allowing one
    /// extreme timeout to dominate every later decision.
    public static func connectionSetupSeconds(
        samples: [Double],
        fallback: Double = 0.75
    ) -> Double {
        let valid = samples
            .filter { $0.isFinite && $0 > 0 }
            .map { min(10, max(0.05, $0)) }
            .sorted()
        guard !valid.isEmpty else {
            return min(10, max(0.1, fallback))
        }
        let rank = max(1, Int(ceil(Double(valid.count) * 0.75)))
        return valid[min(valid.count - 1, rank - 1)]
    }

    /// The next connection count to try, or nil when probing should stop
    /// (cap reached, or the last doubling didn't pay off).
    public static func nextConnections(cap: Int, steps: [ConnectionTuning.Step]) -> Int? {
        guard let last = steps.last, last.connections < cap else { return nil }
        if steps.count >= 2 {
            let prev = steps[steps.count - 2]
            guard prev.bytesPerSecond > 0,
                  last.bytesPerSecond / prev.bytesPerSecond >= minGain else { return nil }
        }
        return min(last.connections * 2, cap)
    }

    /// When the last doubling regressed or was flat, the count to fall back to.
    public static func revertTarget(steps: [ConnectionTuning.Step]) -> Int? {
        guard steps.count >= 2 else { return nil }
        let prev = steps[steps.count - 2]
        let last = steps[steps.count - 1]
        guard prev.bytesPerSecond > 0 else { return nil }
        return last.bytesPerSecond / prev.bytesPerSecond < minGain ? prev.connections : nil
    }

    /// Honest conclusion once probing ends.
    public static func outcome(cap: Int, steps: [ConnectionTuning.Step]) -> ConnectionTuning.Outcome {
        guard steps.count >= 2 else { return .settled }
        var anyGain = false
        var lastGain = 0.0
        for i in 1..<steps.count {
            let prev = steps[i - 1]
            guard prev.bytesPerSecond > 0 else { continue }
            lastGain = steps[i].bytesPerSecond / prev.bytesPerSecond
            if lastGain >= minGain { anyGain = true }
        }
        if let last = steps.last, last.connections >= cap, lastGain >= minGain {
            return .cappedByLimit
        }
        if !anyGain { return .noBenefit }
        return .settled
    }
}
