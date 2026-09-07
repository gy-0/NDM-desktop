import XCTest
@testable import NDMCore

final class InstallerPlanTests: XCTestCase {
    func testSingleAppBecomesDirectInstall() {
        let plan = InstallerPlan.make(
            kind: .dmg,
            entries: ["Foo.app", "Foo.app/Contents/MacOS/Foo", ".DS_Store"]
        )
        XCTAssertEqual(plan, .install(app: "Foo.app"))
        XCTAssertEqual(plan.destinationName, "Foo.app")
    }

    func testNestedSingleAppInstallKeepsDestinationName() {
        let plan = InstallerPlan.make(
            kind: .dmg,
            entries: ["Some Folder/Bar.app/Contents/Info.plist"]
        )
        XCTAssertEqual(plan, .install(app: "Some Folder/Bar.app"))
        XCTAssertEqual(plan.destinationName, "Bar.app")
    }

    func testMultipleAppsBecomeAChoice() {
        let plan = InstallerPlan.make(
            kind: .archive,
            entries: ["One.app", "One.app/Contents", "Two.app", "Two.app/Contents"]
        )
        XCTAssertEqual(plan, .chooseApp(candidates: ["One.app", "Two.app"]))
    }

    func testNoAppFoundFallsBack() {
        let plan = InstallerPlan.make(
            kind: .dmg,
            entries: ["readme.txt", "Setup.exe", ".Trashes/501/x"]
        )
        XCTAssertEqual(plan, .noAppFound)
    }

    func testEmptyEntriesFallBack() {
        XCTAssertEqual(InstallerPlan.make(kind: .pkg, entries: []), .noAppFound)
    }

    func testNonInstallerIsNotApplicable() {
        XCTAssertEqual(
            InstallerPlan.make(kind: .notInstaller, entries: ["Foo.app"]),
            .notApplicable
        )
    }

    func testJunkOnlyVolumeFallsBack() {
        let plan = InstallerPlan.make(
            kind: .dmg,
            entries: [".fseventsd", ".journal_info_block", ".HFS+ Private Directory Data"]
        )
        XCTAssertEqual(plan, .noAppFound)
    }

    func testPreferredAppMatchesImageFilename() {
        XCTAssertEqual(
            InstallerPlan.preferredApp(
                candidates: ["Helper.app", "Wonder.app", "Uninstall Wonder.app"],
                filename: "Wonder-1.2.dmg"
            ),
            "Wonder.app"
        )
    }

    func testPreferredAppSkipsUninstallerWhenNothingMatches() {
        XCTAssertEqual(
            InstallerPlan.preferredApp(
                candidates: ["Uninstall Foo.app", "Foo.app"],
                filename: "archive.dmg"
            ),
            "Foo.app"
        )
    }

    func testPreferredAppSingleCandidate() {
        XCTAssertEqual(
            InstallerPlan.preferredApp(candidates: ["Only.app"], filename: "Other.dmg"),
            "Only.app"
        )
        XCTAssertNil(InstallerPlan.preferredApp(candidates: [], filename: "Empty.dmg"))
    }
}
