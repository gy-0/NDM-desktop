import Foundation

/// Shared cancel flag readable from URLSession callbacks (off the engine actor).
public final class CancelToken: @unchecked Sendable {
    private let lock = NSLock()
    private var _cancelled = false
    private var _paused = false
    private var cancellationHandlers: [UUID: @Sendable () -> Void] = [:]

    public init() {}

    public var isCancelled: Bool {
        lock.lock(); defer { lock.unlock() }
        return _cancelled
    }

    public var isPaused: Bool {
        lock.lock(); defer { lock.unlock() }
        return _paused
    }

    public func cancel() {
        let handlers: [@Sendable () -> Void]
        lock.lock()
        _cancelled = true
        handlers = Array(cancellationHandlers.values)
        lock.unlock()
        handlers.forEach { $0() }
    }

    public func pause() {
        let handlers: [@Sendable () -> Void]
        lock.lock()
        _paused = true
        _cancelled = true
        handlers = Array(cancellationHandlers.values)
        lock.unlock()
        handlers.forEach { $0() }
    }

    public func reset() {
        lock.lock()
        _cancelled = false
        _paused = false
        lock.unlock()
    }

    /// Register an immediate cancellation hook (used to cancel a stalled URLSession task,
    /// instead of waiting for another body callback to observe the flag).
    @discardableResult
    public func registerCancellationHandler(_ handler: @escaping @Sendable () -> Void) -> UUID {
        let id = UUID()
        let callImmediately: Bool
        lock.lock()
        callImmediately = _cancelled
        if !callImmediately {
            cancellationHandlers[id] = handler
        }
        lock.unlock()
        if callImmediately { handler() }
        return id
    }

    public func removeCancellationHandler(_ id: UUID) {
        lock.lock()
        cancellationHandlers[id] = nil
        lock.unlock()
    }
}
