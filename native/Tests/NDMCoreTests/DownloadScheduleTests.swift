import XCTest
@testable import NDMCore

final class DownloadScheduleTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func task(
        _ id: Int64,
        status: DownloadStatus = .waiting,
        startAt: Date? = nil
    ) -> DownloadTask {
        DownloadTask(
            id: id,
            url: "https://example.test/\(id)",
            filename: "f\(id).bin",
            status: status,
            startAt: startAt
        )
    }

    // MARK: - Due

    func testAScheduledTaskBecomesDueAtItsMoment() {
        let t = task(1, startAt: now)
        XCTAssertEqual(DownloadSchedule.due(in: [t], now: now).map(\.id), [1])
    }

    func testAFutureAppointmentIsNotDue() {
        let t = task(1, startAt: now.addingTimeInterval(60))
        XCTAssertTrue(DownloadSchedule.due(in: [t], now: now).isEmpty)
    }

    /// A task with no `startAt` is waiting for a free slot, not for a clock. The
    /// scheduler must not start it, or it would bypass the queue entirely.
    func testAnUnscheduledWaitingTaskIsNeverDue() {
        XCTAssertTrue(DownloadSchedule.due(in: [task(1)], now: now).isEmpty)
    }

    func testOnlyWaitingTasksAreConsidered() {
        let past = now.addingTimeInterval(-60)
        let candidates = [
            task(1, status: .downloading, startAt: past),
            task(2, status: .complete, startAt: past),
            task(3, status: .paused, startAt: past),
            task(4, status: .error, startAt: past),
            task(5, status: .waiting, startAt: past),
        ]
        XCTAssertEqual(DownloadSchedule.due(in: candidates, now: now).map(\.id), [5])
    }

    /// Missed appointments start in the order they were asked for, not in whatever
    /// order the database happened to return.
    func testOverdueTasksKeepTheirRequestedOrder() {
        let tasks = [
            task(3, startAt: now.addingTimeInterval(-10)),
            task(1, startAt: now.addingTimeInterval(-300)),
            task(2, startAt: now.addingTimeInterval(-100)),
        ]
        XCTAssertEqual(DownloadSchedule.due(in: tasks, now: now).map(\.id), [1, 2, 3])
    }

    // MARK: - Next wake-up

    func testNextWakeUpIsTheEarliestFutureAppointment() {
        let tasks = [
            task(1, startAt: now.addingTimeInterval(600)),
            task(2, startAt: now.addingTimeInterval(120)),
            task(3, startAt: now.addingTimeInterval(-5)),
        ]
        XCTAssertEqual(
            DownloadSchedule.nextWakeUp(in: tasks, now: now),
            now.addingTimeInterval(120)
        )
    }

    func testNothingScheduledMeansNoTimer() {
        XCTAssertNil(DownloadSchedule.nextWakeUp(in: [task(1)], now: now))
        XCTAssertNil(DownloadSchedule.nextWakeUp(in: [], now: now))
    }

    /// Already-due work is handled by `due`, so it must not also produce a wake-up —
    /// a timer with a non-positive delay is a busy loop.
    func testAnOverdueTaskDoesNotAskForAWakeUp() {
        let t = task(1, startAt: now.addingTimeInterval(-1))
        XCTAssertNil(DownloadSchedule.nextWakeUp(in: [t], now: now))
    }

    // MARK: - Classification and input

    func testIsScheduledDistinguishesClockWaitingFromQueueWaiting() {
        XCTAssertTrue(DownloadSchedule.isScheduled(task(1, startAt: now.addingTimeInterval(60)), now: now))
        XCTAssertFalse(DownloadSchedule.isScheduled(task(2), now: now))
        XCTAssertFalse(
            DownloadSchedule.isScheduled(task(3, startAt: now.addingTimeInterval(-60)), now: now),
            "already due is not still scheduled"
        )
    }

    /// Picking 09:00 at 09:05 means "now", not "never".
    func testAPastTimeIsClampedToNow() {
        XCTAssertEqual(DownloadSchedule.normalized(now.addingTimeInterval(-3600), now: now), now)
        let future = now.addingTimeInterval(3600)
        XCTAssertEqual(DownloadSchedule.normalized(future, now: now), future)
    }
}
