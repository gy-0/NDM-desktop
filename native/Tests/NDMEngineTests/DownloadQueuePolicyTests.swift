import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class DownloadQueuePolicyTests: XCTestCase {
    func testPreferredOrderFiltersStaleEntriesAndAppendsNewTasksWithoutReorderingPausedOnes() {
        let rows = [queued(5), queued(2), queued(3, status: .paused), queued(4), queued(1)]
        XCTAssertEqual(DownloadQueuePolicy.ordinaryWaiting(in: rows, isCollectionEntry: { _ in false },
            preferredOrder: [99, 4, 3, 2, 4]).map(\.id), [4, 2, 1, 5])
    }
    private func queued(_ id: Int64, status: DownloadStatus = .waiting,
                        startAt: Date? = nil, awaitingDestination: Bool = false) -> DownloadTask {
        DownloadTask(id: id, url: "http://localhost/\(id).bin", status: status,
            lastTry: Date(timeIntervalSince1970: Double(id)), startAt: startAt,
            awaitingDestination: awaitingDestination)
    }

    func testCreationOrderDoesNotFollowRecencyOrInputOrder() {
        let rows = [queued(30), queued(10), queued(20)]
        XCTAssertEqual(DownloadQueuePolicy.ordinaryWaiting(in: rows,
            isCollectionEntry: { _ in false }).map(\.id), [10, 20, 30])
    }

    func testNewerArrivalsCannotDisplaceTheOldestReadyTask() {
        var rows = [queued(10)]
        for id in Int64(11)...110 {
            rows.insert(queued(id), at: 0)
            XCTAssertEqual(DownloadQueuePolicy.ordinaryWaiting(in: rows,
                isCollectionEntry: { _ in false }).first?.id, 10)
        }
    }

    func testAppointmentsPauseDestinationAndCollectionsStayOutsideOrdinaryQueue() {
        let rows = [
            queued(1, status: .paused), queued(2, status: .incomplete),
            queued(3, startAt: Date(timeIntervalSince1970: 1)),
            queued(4, startAt: .distantFuture), queued(5, awaitingDestination: true),
            queued(6), queued(7, status: .complete), queued(8)
        ]
        XCTAssertEqual(DownloadQueuePolicy.ordinaryWaiting(in: rows,
            isCollectionEntry: { $0.id == 6 }).map(\.id), [8])
    }
}
