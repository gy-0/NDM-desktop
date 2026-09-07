import XCTest
@testable import NDMCore

final class InstallerSourceDispositionTests: XCTestCase {
    func testDefaultIsAsk() {
        XCTAssertEqual(InstallerSourceDisposition.defaultValue, .ask)
    }

    func testSourceActionMapping() {
        XCTAssertNil(InstallerSourceDisposition.ask.sourceAction)
        XCTAssertNil(InstallerSourceDisposition.keep.sourceAction)
        XCTAssertEqual(
            InstallerSourceDisposition.trash.sourceAction,
            .moveToTrash
        )
        XCTAssertEqual(InstallerSourceDisposition.delete.sourceAction, .delete)
    }

    func testRememberingTrashPersistsTrash() {
        XCTAssertEqual(
            InstallerSourceDisposition.disposition(
                choosing: .moveToTrash, remember: true, current: .ask
            ),
            .trash
        )
    }

    func testRememberingKeepKeepsCurrentDisposition() {
        XCTAssertEqual(
            InstallerSourceDisposition.disposition(
                choosing: nil, remember: true, current: .ask
            ),
            .ask
        )
    }

    func testNotRememberingLeavesCurrentUntouched() {
        XCTAssertEqual(
            InstallerSourceDisposition.disposition(
                choosing: .moveToTrash, remember: false, current: .ask
            ),
            .ask
        )
        XCTAssertEqual(
            InstallerSourceDisposition.disposition(
                choosing: .delete, remember: false, current: .keep
            ),
            .keep
        )
    }

    func testAllCasesPersistByRawValue() {
        for disposition in InstallerSourceDisposition.allCases {
            XCTAssertEqual(
                InstallerSourceDisposition(rawValue: disposition.rawValue),
                disposition
            )
        }
    }
}
