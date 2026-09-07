import Foundation

/// Interpolates a display progress toward a truthful target so UI percentages
/// and bars ease across lumpy engine reports (merge / finalize jumps) instead
/// of snapping. Display never exceeds the current target and never goes
/// backwards while chasing; call `reset` when switching tasks.
public struct SmoothProgressTracker: Sendable, Equatable {
    public private(set) var display: Double
    public private(set) var target: Double

    /// Planned seconds remaining to reach `target` from the last target change.
    private var remainingDuration: Double
    /// When true, prefer a short settle into 100%.
    private var completing: Bool

    public init(seed: Double = 0) {
        let value = Self.clamp(seed)
        display = value
        target = value
        remainingDuration = 0
        completing = value >= 1
    }

    public var isSettled: Bool {
        remainingDuration <= 0 && abs(display - target) < 0.000_15
    }

    public mutating func reset(to value: Double = 0) {
        let clamped = Self.clamp(value)
        display = clamped
        target = clamped
        remainingDuration = 0
        completing = clamped >= 1
    }

    /// Raise the truthful target. Mid-flight increases accelerate the chase
    /// instead of queuing. Lower targets are ignored unless `allowRetreat`.
    public mutating func setTarget(
        _ value: Double,
        complete: Bool = false,
        allowRetreat: Bool = false
    ) {
        let clamped = Self.clamp(value)
        if complete || clamped >= 1 {
            target = 1
            completing = true
            let gap = max(0, target - display)
            if gap < 0.000_15 {
                display = 1
                remainingDuration = 0
            } else {
                // Finish promptly without a long fake crawl at the end.
                remainingDuration = min(0.22, max(0.1, gap * 1.4))
            }
            return
        }

        completing = false
        if !allowRetreat, clamped + 0.000_2 < target {
            return
        }
        if abs(clamped - target) < 0.000_15, !isSettled {
            return
        }
        if abs(clamped - target) < 0.000_15, isSettled {
            return
        }

        let previousTarget = target
        let wasChasing = !isSettled && display < previousTarget - 0.000_15
        target = max(clamped, allowRetreat ? clamped : max(target, clamped))
        let gap = max(0, target - display)
        guard gap > 0.000_15 else {
            display = target
            remainingDuration = 0
            return
        }

        let base = Self.duration(forGap: gap)
        if wasChasing, remainingDuration > 0.02 {
            // Catch-up: shrink leftover time so a new higher target doesn't
            // wait behind the old plan, without restarting from a full crawl.
            remainingDuration = min(base, max(0.16, remainingDuration * 0.45 + base * 0.35))
        } else {
            remainingDuration = base
        }
    }

    /// Advance the display toward the target. Returns the new display value.
    @discardableResult
    public mutating func advance(by dt: TimeInterval) -> Double {
        let step = max(0, dt)
        guard step > 0 else { return display }
        guard display < target - 0.000_15 else {
            display = target
            remainingDuration = 0
            return display
        }

        if remainingDuration <= step {
            display = target
            remainingDuration = 0
            return display
        }

        let gap = target - display
        // Exponential ease-out sized so ~95% of the gap closes in remainingDuration.
        let rate = max(completing ? 14 : 3.2, -log(0.05) / remainingDuration)
        let delta = gap * (1 - exp(-rate * step))
        display = min(target, display + delta)
        remainingDuration -= step
        if abs(display - target) < 0.000_2 {
            display = target
            remainingDuration = 0
        }
        return display
    }

    /// Seconds for a fresh chase. Small jitter stays snappy; large late-stage
    /// jumps (merge 87%→95%) get a visible glide without feeling sluggish.
    public static func duration(forGap gap: Double) -> Double {
        let g = min(1, max(0, gap))
        return min(1.05, max(0.28, 0.22 + g * 6.5))
    }

    private static func clamp(_ value: Double) -> Double {
        min(1, max(0, value))
    }
}
