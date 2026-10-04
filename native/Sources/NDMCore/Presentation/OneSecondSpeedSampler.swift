import Foundation

/// Produces a truthful transfer-rate target from actual byte movement over the
/// previous one-second window. One short startup sample avoids displaying zero
/// throughout a fast transfer. Animation is intentionally left to the UI.
public struct OneSecondSpeedSampler: Sendable {
    private var baselineBytes: Int64?
    private var baselineUptime: TimeInterval?
    private var startupSampleEmitted = false

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
            startupSampleEmitted = false
            return nil
        }

        let elapsed = now - (baselineUptime ?? now)
        let delta = max(0, bytes - (baselineBytes ?? bytes))
        guard elapsed >= 1 else {
            // Use actual new bytes and elapsed time, never the restored total or
            // the engine's instantaneous rate. Keep the baseline for the full
            // first-second sample and cache only one early target for observers.
            guard !startupSampleEmitted, elapsed >= 0.2, delta > 0 else { return nil }
            startupSampleEmitted = true
            return Double(delta) / elapsed
        }
        startupSampleEmitted = startupSampleEmitted || delta > 0
        baselineBytes = bytes
        baselineUptime = now
        return Double(delta) / elapsed
    }

    public mutating func clear() {
        baselineBytes = nil
        baselineUptime = nil
        startupSampleEmitted = false
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
