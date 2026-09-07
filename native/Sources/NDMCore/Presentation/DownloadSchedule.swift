import Foundation

/// Which scheduled downloads are due, and when to look again.
///
/// Every download manager surveyed has scheduling and NDM did not — it is the one
/// feature all five competitors share that was missing (see `docs/DEMAND.md`). The
/// reason people want it is mundane and real: start a large queue overnight, stay
/// off the connection while the household is using it.
///
/// The state it adds is deliberately small. A task waiting on a clock is still
/// `.waiting`; it just also has a `startAt`. "Waiting for a slot" and "waiting for a
/// time" are then distinguishable without a new status, and everything that already
/// understands `.waiting` — the sidebar count, the batch bar, resume-after-relaunch
/// — keeps working untouched.
///
/// Pure, so the part that decides whether your download starts tonight is covered by
/// tests rather than by watching a clock.
public enum DownloadSchedule {
    /// Scheduled tasks whose moment has arrived, oldest appointment first.
    ///
    /// Ordering matters: if three downloads were all scheduled for 02:00 and the app
    /// was asleep until 06:00, they should start in the order they were asked for,
    /// not in database order.
    public static func due(in tasks: [DownloadTask], now: Date) -> [DownloadTask] {
        tasks
            .filter { task in
                guard task.status == .waiting, let startAt = task.startAt else { return false }
                return startAt <= now
            }
            .sorted { ($0.startAt ?? .distantPast) < ($1.startAt ?? .distantPast) }
    }

    /// The next moment worth waking for, or nil when nothing is scheduled.
    ///
    /// Used to size the timer instead of polling every second: a download scheduled
    /// for 3am should not cost 10,800 wake-ups to get there.
    public static func nextWakeUp(in tasks: [DownloadTask], now: Date) -> Date? {
        tasks
            .compactMap { task -> Date? in
                guard task.status == .waiting, let startAt = task.startAt else { return nil }
                return startAt > now ? startAt : nil
            }
            .min()
    }

    /// Whether a task is waiting on a clock rather than on a free slot.
    public static func isScheduled(_ task: DownloadTask, now: Date) -> Bool {
        guard task.status == .waiting, let startAt = task.startAt else { return false }
        return startAt > now
    }

    /// Clamp a user-picked time to something the scheduler can honour.
    ///
    /// A time already in the past means "as soon as possible", which is what a user
    /// who picked 09:00 at 09:05 almost certainly meant — better than silently never
    /// starting, and better than refusing the input.
    public static func normalized(_ requested: Date, now: Date) -> Date {
        max(requested, now)
    }
}
