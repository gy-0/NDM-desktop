import Foundation

/// A completed healthy range may take over a disconnected range before its
/// original worker's cooldown expires. Each completion grants at most one
/// takeover; repeated failures alone never produce a busy retry loop.
final class RangeRetryHandoff: @unchecked Sendable {
    private let lock = NSLock()
    private var available = 0
    private var waiting = 0

    var hasWaiter: Bool { lock.withLock { waiting > 0 } }
    func beginWait() { lock.withLock { waiting += 1 } }
    func endWait() { lock.withLock { waiting -= 1 } }
    func offer() { lock.withLock { available += 1 } }
    func take() -> Bool {
        lock.withLock {
            guard available > 0 else { return false }
            available -= 1
            return true
        }
    }
}
