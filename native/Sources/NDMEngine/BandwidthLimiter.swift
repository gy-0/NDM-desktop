import Foundation

/// Token-bucket style throttle matching original `NeatBandWidth` intent (0 = unlimited).
public final class BandwidthLimiter: @unchecked Sendable {
    private let lock = NSLock()
    private var bytesPerSecond: Int64
    private var windowStart = ProcessInfo.processInfo.systemUptime
    private var windowBytes: Int64 = 0

    public init(bytesPerSecond: Int64 = 0) {
        self.bytesPerSecond = max(0, bytesPerSecond)
    }

    public func updateLimit(_ bytesPerSecond: Int64) {
        lock.lock()
        self.bytesPerSecond = max(0, bytesPerSecond)
        windowStart = ProcessInfo.processInfo.systemUptime
        windowBytes = 0
        lock.unlock()
    }

    /// Account for a callback across as many windows as needed. All workers
    /// share this quota. False means cancellation, so the caller must not write.
    @discardableResult
    public func consume(_ count: Int, isCancelled: () -> Bool = { false }) -> Bool {
        var remaining = Int64(max(0, count))
        while remaining > 0 {
            if isCancelled() { return false }
            lock.lock()
            let limit = bytesPerSecond
            if limit <= 0 {
                lock.unlock()
                return !isCancelled()
            }
            let now = ProcessInfo.processInfo.systemUptime
            let elapsed = now - windowStart
            if elapsed >= 1.0 {
                windowStart = now
                windowBytes = 0
            }
            let granted = min(remaining, max(0, limit - windowBytes))
            windowBytes += granted
            remaining -= granted
            let sleepFor = min(0.05, max(0.001, 1.0 - (now - windowStart)))
            lock.unlock()
            if remaining > 0 { Thread.sleep(forTimeInterval: sleepFor) }
        }
        return !isCancelled()
    }
}
