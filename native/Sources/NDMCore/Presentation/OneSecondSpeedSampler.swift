import Foundation

/// Produces a truthful transfer-rate target from actual byte movement over the
/// previous one-second window. Animation is intentionally left to the UI.
public struct OneSecondSpeedSampler: Sendable {
    private var baselineBytes: Int64?
    private var baselineUptime: TimeInterval?

    public init() {}

    public mutating func consume(
        completedBytes: Int64,
        reset: Bool = false,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> Double? {
        let bytes = max(0, completedBytes)
        if reset || baselineBytes == nil || baselineUptime == nil {
            baselineBytes = bytes
            baselineUptime = now
            return nil
        }

        let elapsed = now - (baselineUptime ?? now)
        guard elapsed >= 1 else { return nil }
        let delta = max(0, bytes - (baselineBytes ?? bytes))
        baselineBytes = bytes
        baselineUptime = now
        return Double(delta) / elapsed
    }

    public mutating func clear() {
        baselineBytes = nil
        baselineUptime = nil
    }
}

public enum SpeedNumeralFormatting {
    public static func parts(_ bytesPerSecond: Double) -> (value: String, unit: String) {
        let kb = bytesPerSecond / 1024
        if kb < 1000 {
            return (String(format: kb < 100 ? "%.1f" : "%.0f", max(0, kb)), "KB/s")
        }
        let mb = kb / 1024
        if mb < 1000 {
            return (String(format: mb < 100 ? "%.1f" : "%.0f", mb), "MB/s")
        }
        return (String(format: "%.2f", mb / 1024), "GB/s")
    }
}
