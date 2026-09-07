import XCTest
@testable import NDMCore

final class InstallerKindTests: XCTestCase {
    func testDMGAndISOAreInstallerKinds() {
        XCTAssertEqual(InstallerKind.detect(filename: "App Installer.dmg"), .dmg)
        XCTAssertEqual(InstallerKind.detect(filename: "ubuntu-24.04.iso"), .dmg)
        XCTAssertTrue(InstallerKind.dmg.offersInstall)
    }

    func testPKGAndMPKG() {
        XCTAssertEqual(InstallerKind.detect(filename: "VMware-Fusion.pkg"), .pkg)
        XCTAssertEqual(InstallerKind.detect(filename: "suite.mpkg"), .pkg)
        XCTAssertTrue(InstallerKind.pkg.offersInstall)
    }

    func testDirectAppBundle() {
        XCTAssertEqual(InstallerKind.detect(filename: "DevUtils.app"), .appBundle)
        XCTAssertTrue(InstallerKind.appBundle.offersInstall)
    }

    func testArchiveFamily() {
        for name in ["app.zip", "app.7z", "app.tar", "app.tar.gz", "app.tgz", "app.tar.xz", "app.txz", "app.rar"] {
            XCTAssertEqual(InstallerKind.detect(filename: name), .archive, name)
        }
        XCTAssertTrue(InstallerKind.archive.offersInstall)
    }

    func testRegularFilesAreNotInstallers() {
        for name in ["movie.mp4", "song.mp3", "photo.jpg", "notes.pdf", "doc.txt", "README", ".hidden.dmg"] {
            XCTAssertEqual(InstallerKind.detect(filename: name), .notInstaller, name)
            XCTAssertFalse(InstallerKind.notInstaller.offersInstall)
        }
    }

    func testPathWithDirectoriesUsesLastComponent() {
        XCTAssertEqual(
            InstallerKind.detect(filename: "/Users/me/Downloads/App Set.dmg"),
            .dmg
        )
        XCTAssertEqual(
            InstallerKind.detect(filename: "/tmp/archive/app-v1.zip"),
            .archive
        )
    }
}
