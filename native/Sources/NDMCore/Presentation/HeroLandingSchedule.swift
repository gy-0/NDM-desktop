import Foundation

/// Stage timings for the Hero → list-row landing morph, measured from the moment
/// the morph is requested.
///
/// Pure, because the defect it exists to prevent is pure arithmetic. Core Animation
/// groups are given a `beginTime` one frame in the future so they cannot start
/// mid-commit, but the reveal and the overlay teardown are wall-clock timers on the
/// main queue. The first version scheduled those from the *call* time while the
/// animation ran from the *begin* time, so the teardown deadline
/// (`duration + 0.02`) sat only ~3ms after the animation's real end
/// (`1/60 + duration`). One busy frame and the frozen cover was removed while still
/// fully opaque — which on screen is exactly the "pop" it was built to avoid.
///
/// Keeping the arithmetic here means the invariant ("teardown always lands clearly
/// after the last animated frame") is pinned by a test instead of by whoever edits
/// the animator next.
public struct HeroLandingSchedule: Equatable, Sendable {
    /// One frame at 60Hz — the unit the compositor actually works in.
    public static let frame: TimeInterval = 1.0 / 60.0

    /// Length of the morph itself.
    public let duration: TimeInterval
    /// How far in the future the CA group's `beginTime` is set.
    public let beginOffset: TimeInterval
    /// Fraction of the morph after which the live row takes over from the overlay.
    ///
    /// 1.0, and the handoff is performed in the same work item as the teardown so the
    /// two are atomic. Revealing earlier used to be the way to avoid a frame with
    /// nothing drawn, but it only works while the row is stationary: once the Hero
    /// strip collapses *during* the morph, the live row is still travelling, so an
    /// early reveal shows it a few points away from the overlay and the last stretch
    /// smears. At 1.0 the overlay and the row are by definition in the same place —
    /// that is what makes a shared-element morph worth doing — so the swap is free.
    public let revealFraction: Double
    /// Slack between the last animated frame and the overlay's removal.
    public let teardownMargin: TimeInterval

    /// How long the overlay takes to fade when a landing is abandoned mid-flight.
    ///
    /// Non-zero on purpose. A landing can stop being completable at any moment — a
    /// second download finishes, a filter changes, the destination row moves — and
    /// the old response was to remove the overlay instantly. Removing an opaque
    /// frozen snapshot in one frame is precisely the snap the cover exists to
    /// prevent, so abandoning has to fade out too. Short enough not to read as an
    /// animation of its own.
    public static let abortFade: TimeInterval = 5 * HeroLandingSchedule.frame

    public init(
        duration: TimeInterval = 0.46,
        beginOffset: TimeInterval = HeroLandingSchedule.frame,
        revealFraction: Double = 1.0,
        teardownMargin: TimeInterval = 3 * HeroLandingSchedule.frame
    ) {
        self.duration = max(0, duration)
        self.beginOffset = max(0, beginOffset)
        self.revealFraction = min(max(revealFraction, 0), 1)
        self.teardownMargin = max(HeroLandingSchedule.frame, teardownMargin)
    }

    /// When the morph's first animated frame lands.
    public var beginsAt: TimeInterval { beginOffset }

    /// When the morph's last animated frame lands.
    public var endsAt: TimeInterval { beginOffset + duration }

    /// When to hand the row back to the live view, mid-morph.
    public var revealAt: TimeInterval { beginOffset + duration * revealFraction }

    /// When the overlay may be removed.
    public var teardownAt: TimeInterval { endsAt + teardownMargin }

    /// Breathing room between the animation finishing and the overlay vanishing.
    /// The regression this type documents was this value going near zero.
    public var teardownSlack: TimeInterval { teardownAt - endsAt }
}
