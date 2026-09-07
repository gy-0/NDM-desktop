import XCTest
@testable import NDMCore

final class InstallerFilterTests: XCTestCase {
    /// The exact Rapidmg skip list (reverse spec 15 §5) must all be junk.
    func testRapidmgJunkNameSetIsComplete() {
        let expected: Set<String> = [
            ".fseventsd", ".Trashes", ".Trash", ".journal",
            ".journal_info_block", ".DS_Store",
            "[HFS+ Private Data]", ".HFS+ Private Directory Data",
        ]
        XCTAssertEqual(InstallerFilter.junkNames, expected)
    }

    func testTopLevelJunkEntries() {
        for name in InstallerFilter.junkNames {
            XCTAssertTrue(InstallerFilter.isJunkEntry(path: name), name)
        }
    }

    func testNestedJunkIsSkipped() {
        XCTAssertTrue(InstallerFilter.isJunkEntry(path: ".Trashes/501/Whatever"))
        XCTAssertTrue(InstallerFilter.isJunkEntry(path: "Foo.app/.fseventsd/20260806"))
        XCTAssertTrue(InstallerFilter.isJunkEntry(path: "/.journal_info_block"))
    }

    func testOrdinaryEntriesAreNotJunk() {
        for path in ["Foo.app", "Foo.app/Contents/MacOS/Foo", "readme.txt", "Tools/Helper.app"] {
            XCTAssertFalse(InstallerFilter.isJunkEntry(path: path), path)
        }
    }

    func testAppBundleDetection() {
        XCTAssertTrue(InstallerFilter.isAppBundle(name: "Foo.app"))
        XCTAssertTrue(InstallerFilter.isAppBundle(name: "foo.APP"))
        XCTAssertFalse(InstallerFilter.isAppBundle(name: "Foo.appx"))
        XCTAssertFalse(InstallerFilter.isAppBundle(name: "Foo"))
        XCTAssertFalse(InstallerFilter.isAppBundle(name: "Foo.AppleScript"))
    }

    func testSingleAppCandidate() {
        let entries = [
            "Foo.app",
            "Foo.app/Contents/Info.plist",
            "Foo.app/Contents/MacOS/Foo",
            "readme.txt",
        ]
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: entries),
            ["Foo.app"]
        )
    }

    func testNestedAppCandidateUsesFirstComponent() {
        let entries = ["Some Folder/Bar.app/Contents/Info.plist"]
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: entries),
            ["Some Folder/Bar.app"]
        )
    }

    func testMultipleAppsKeepArchiveOrderAndDedupe() {
        let entries = [
            "A.app",
            "A.app/Contents/MacOS/A",
            "B.app/Contents/Info.plist",
            "A.app/Contents/Resources/x.png",
            "C.app",
        ]
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: entries),
            ["A.app", "B.app", "C.app"]
        )
    }

    func testJunkEntriesNeverBecomeCandidates() {
        let entries = [
            ".Trashes/501/A.app",
            ".fseventsd/2026",
            ".DS_Store",
            "Real.app",
            ".HFS+ Private Directory Data/.journal_info_block",
        ]
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: entries),
            ["Real.app"]
        )
    }

    func testEmptyAndJunkOnlyInputs() {
        XCTAssertEqual(InstallerFilter.appBundleCandidates(entries: []), [])
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: [".DS_Store", ".Trashes"]),
            []
        )
    }

    func testPackageDetection() {
        XCTAssertTrue(InstallerFilter.isPackage(name: "Install EasyConnect.pkg"))
        XCTAssertTrue(InstallerFilter.isPackage(name: "Foo.mpkg"))
        XCTAssertTrue(InstallerFilter.isPackage(name: "FOO.PKG"))
        XCTAssertFalse(InstallerFilter.isPackage(name: "Foo.app"))
        XCTAssertFalse(InstallerFilter.isPackage(name: "Foo.pkgx"))
    }

    func testPackageCandidatesIgnoreNestedAndJunk() {
        let entries = [
            "Install EasyConnect.pkg",
            ".Trashes/Install.pkg",
            "Foo.app/Contents/Resources/helper.pkg",
            "Nested/Setup.pkg",
        ]
        XCTAssertEqual(
            InstallerFilter.packageCandidates(entries: entries),
            ["Install EasyConnect.pkg", "Nested/Setup.pkg"]
        )
    }
}
