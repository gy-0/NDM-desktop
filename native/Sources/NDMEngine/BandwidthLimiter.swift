import Foundation

/// Token-bucket style throttle matching original `NeatBandWidth` intent (0 = unlimited).
public final class BandwidthLimiter: @unchecked Sendable {
    private let lock = NSLock()
    private var bytesPerSecond: Int64
    private var windowStart = Date()
    private var windowBytes: Int64 = 0

    public init(bytesPerSecond: Int64 = 0) {
        self.bytesPerSecond = max(0, bytesPerSecond)
    }

    public func updateLimit(_ bytesPerSecond: Int64) {
        lock.lock()
        self.bytesPerSecond = max(0, bytesPerSecond)
        windowStart = Date()
        windowBytes = 0
        lock.unlock()
    }

    /// Block the calling thread until `count` bytes fit under the rate limit.
    public func consume(_ count: Int) {
        guard count > 0 else { return }
        while true {
            lock.lock()
            let limit = bytesPerSecond
            if limit <= 0 {
                lock.unlock()
                return
            }
            let now = Date()
            let elapsed = now.timeIntervalSince(windowStart)
            if elapsed >= 1.0 {
                windowStart = now
                windowBytes = 0
            }
            if windowBytes + Int64(count) <= limit {
                windowBytes += Int64(count)
                lock.unlock()
                return
            }
            let sleepFor = max(0.005, 1.0 - now.timeIntervalSince(windowStart))
            lock.unlock()
            Thread.sleep(forTimeInterval: min(sleepFor, 0.2))
        }
    }
}
