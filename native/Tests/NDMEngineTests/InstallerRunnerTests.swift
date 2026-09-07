import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

/// End-to-end one-click install tests against real disk images.
///
/// `hdiutil` is a local system tool (no network), so these run in the default
/// suite like the other local-tool tests (`say`, the local HTTP servers). The
/// volume name is UUID-scoped so a leaked mount can never collide with another
/// test.
final class InstallerRunnerTests: XCTestCase {
    private var root: URL!
    private var sources: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        guard FileManager.default.isExecutableFile(atPath: DMGImageTool.hdiutil) else {
            throw XCTSkip("hdiutil is not available on this machine")
        }
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-installer-\(UUID().uuidString)", isDirectory: true)
        sources = root.appendingPathComponent("src", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    // MARK: - Fixtures

    private func makeAppBundle(named name: String, in parent: URL, marker: String) throws {
        let bundle = parent.appendingPathComponent(name, isDirectory: true)
        let contents = bundle.appendingPathComponent("Contents", isDirectory: true)
        let macos = contents.appendingPathComponent("MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macos, withIntermediateDirectories: true)
        let executable = macos.appendingPathComponent(name.replacingOccurrences(of: ".app", with: ""))
        try Data(marker.utf8).write(to: executable)
        let info = contents.appendingPathComponent("Info.plist")
        try Data("""
        <?xml version="1.0"?><plist version="1.0"><dict>\
        <key>CFBundleExecutable</key><string>\(executable.lastPathComponent)</string>\
        <key>CFBundleIdentifier</key><string>dev.ndm.\(marker)</string></dict></plist>
        """.utf8).write(to: info)
    }

    private func makeDMG(volumeName: String, sourceDir: URL, fileName: String) throws -> URL {
        let dmgURL = root.appendingPathComponent(fileName)
        let process = Process()
        process.executableURL = URL(filePath: DMGImageTool.hdiutil)
        process.arguments = [
            "create", "-volname", volumeName,
            "-srcfolder", sourceDir.path,
            "-ov", "-format", "UDZO",
            dmgURL.path,
        ]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "hdiutil create failed")
        return dmgURL
    }

    private func destination() -> URL {
        root.appendingPathComponent("Applications", isDirectory: true)
    }

    private func assertDetached(volumeName: String) {
        let mounted = URL(fileURLWithPath: "/Volumes").appendingPathComponent(volumeName)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: mounted.path),
            "volume \(volumeName) is still mounted"
        )
    }

    // MARK: - Tests

    func testInstallsAppFromDMGAndFiltersJunk() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("one", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Fake.app", in: src, marker: "v1")
        // Junk at the volume root must never reach the destination.
        try FileManager.default.createDirectory(at: src.appendingPathComponent(".Trashes"), withIntermediateDirectories: true)
        try Data("junk".utf8).write(to: src.appendingPathComponent(".DS_Store"))

        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Fake.dmg")
        var steps: [InstallerRunner.Step] = []
        let outcome = try await InstallerRunner.process(
            dmgURL: dmg,
            destination: destination(),
            onStep: { steps.append($0) }
        )

        guard case .installed(let appName, let at) = outcome else {
            return XCTFail("expected installed, got \(outcome)")
        }
        XCTAssertEqual(appName, "Fake.app")
        let installedExecutable = at
            .appendingPathComponent("Contents").appendingPathComponent("MacOS")
            .appendingPathComponent("Fake")
        XCTAssertEqual(try? String(contentsOf: installedExecutable), "v1")
        // Junk did not leak into the destination.
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination().appendingPathComponent(".Trashes").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination().appendingPathComponent(".DS_Store").path))
        // Mount was cleaned up.
        assertDetached(volumeName: volume)
        XCTAssertTrue(steps.contains(.mounting))
        XCTAssertTrue(steps.contains(.detaching))
    }

    func testInstalledBundleGetsFreshModificationDate() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("mtime", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Fresh.app", in: src, marker: "v1")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Fresh.dmg")

        let outcome = try await InstallerRunner.process(dmgURL: dmg, destination: destination())
        guard case .installed(_, let at) = outcome else { return XCTFail() }
        let values = try at.resourceValues(forKeys: [.contentModificationDateKey])
        guard let mtime = values.contentModificationDate else { return XCTFail("no mtime") }
        XCTAssertLessThan(abs(mtime.timeIntervalSinceNow), 10, "installed bundle must read as freshly installed")
    }

    func testExistingAppNeedsConsentBeforeReplace() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("conflict", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Old.app", in: src, marker: "new")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Old.dmg")

        // Pre-existing older version with a distinctive marker.
        let dest = destination()
        try makeAppBundle(named: "Old.app", in: dest, marker: "existing")

        let outcome = try await InstallerRunner.process(dmgURL: dmg, destination: dest)
        XCTAssertEqual(outcome, .needsReplaceConsent(appName: "Old.app"))
        // The pre-existing bundle is untouched.
        let existingExecutable = dest.appendingPathComponent("Old.app/Contents/MacOS/Old")
        XCTAssertEqual(try? String(contentsOf: existingExecutable), "existing")
        assertDetached(volumeName: volume)
    }

    func testReDriveWithConsentReplacesExistingApp() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("replace", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Old.app", in: src, marker: "new-version")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Old.dmg")

        let dest = destination()
        try makeAppBundle(named: "Old.app", in: dest, marker: "old-version")

        let outcome = try await InstallerRunner.process(
            dmgURL: dmg,
            destination: dest,
            replaceExisting: true
        )

        guard case .installed(_, let at) = outcome else { return XCTFail("expected installed, got \(outcome)") }
        let newExecutable = at.appendingPathComponent("Contents/MacOS/Old")
        XCTAssertEqual(try? String(contentsOf: newExecutable), "new-version")
    }

    func testReplaceConsentNeverNeededWhenDestinationIsFresh() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("preconsent", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Pre.app", in: src, marker: "v1")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Pre.dmg")

        let outcome = try await InstallerRunner.process(dmgURL: dmg, destination: destination())
        guard case .installed(_, let at) = outcome else { return XCTFail() }
        XCTAssertEqual(try? String(contentsOf: at.appendingPathComponent("Contents/MacOS/Pre")), "v1")
    }

    func testMultipleAppsAskTheCallerToChoose() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("multi", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Alpha.app", in: src, marker: "a")
        try makeAppBundle(named: "Beta.app", in: src, marker: "b")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Multi.dmg")

        let outcome = try await InstallerRunner.process(
            dmgURL: dmg,
            destination: destination(),
            askChoose: { candidates in
                XCTAssertEqual(candidates, ["Alpha.app", "Beta.app"])
                return "Beta.app"
            }
        )

        guard case .installed(let appName, _) = outcome else { return XCTFail("expected installed, got \(outcome)") }
        XCTAssertEqual(appName, "Beta.app")
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination().appendingPathComponent("Beta.app").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination().appendingPathComponent("Alpha.app").path))
        assertDetached(volumeName: volume)
    }

    func testDeclinedChoiceInstallsNothing() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("declined", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Alpha.app", in: src, marker: "a")
        try makeAppBundle(named: "Beta.app", in: src, marker: "b")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Declined.dmg")

        let outcome = try await InstallerRunner.process(
            dmgURL: dmg,
            destination: destination(),
            askChoose: { _ in nil }
        )
        XCTAssertEqual(outcome, .noAppFound)
        assertDetached(volumeName: volume)
    }

    func testVolumeWithoutAppsFallsBackAndDetaches() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("empty", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try Data("readme".utf8).write(to: src.appendingPathComponent("readme.txt"))
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Empty.dmg")

        let outcome = try await InstallerRunner.process(dmgURL: dmg, destination: destination())
        XCTAssertEqual(outcome, .noAppFound)
        assertDetached(volumeName: volume)
    }

    func testNonImageFileThrowsMountError() async {
        let notADMG = root.appendingPathComponent("plain.txt")
        try? Data("not an image".utf8).write(to: notADMG)
        do {
            _ = try await InstallerRunner.process(dmgURL: notADMG, destination: destination())
            XCTFail("expected mount failure")
        } catch InstallerError.mountFailed {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    // MARK: - License agreement detection

    func testParseLicenseAgreementFromImageInfo() {
        let withLicense = """
        <?xml version="1.0"?><plist version="1.0"><dict>\
        <key>Properties</key><dict><key>Software License Agreement</key><true/></dict>\
        </dict></plist>
        """
        XCTAssertTrue(DMGImageTool.parseLicenseAgreement(plist: withLicense))

        let without = """
        <?xml version="1.0"?><plist version="1.0"><dict>\
        <key>Properties</key><dict><key>Software License Agreement</key><false/></dict>\
        </dict></plist>
        """
        XCTAssertFalse(DMGImageTool.parseLicenseAgreement(plist: without))
        XCTAssertFalse(DMGImageTool.parseLicenseAgreement(plist: "not a plist"))
        XCTAssertFalse(DMGImageTool.parseLicenseAgreement(plist: ""))
    }

    func testPlainImageDoesNotTriggerLicenseHandoff() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("plain", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "NoSLA.app", in: src, marker: "v1")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "NoSLA.dmg")

        let outcome = try await InstallerRunner.process(dmgURL: dmg, destination: destination())
        guard case .installed = outcome else {
            return XCTFail("expected a direct install, got \(outcome)")
        }
    }

    // MARK: - License agreement flow (stubbed detection)

    /// A real SLA image cannot be created on this macOS (udifrez is broken),
    /// so the detection seam is stubbed and the *flow* is what gets tested.
    private func withSLADetection(_ result: Bool, _ body: () async throws -> Void) async rethrows {
        defer { InstallerRunner.slaDetection = InstallerRunner.defaultSLADetection }
        InstallerRunner.slaDetection = { _ in result }
        try await body()
    }

    func testSLABecomesLicenseHandoffUntilAccepted() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("sla", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Licensed.app", in: src, marker: "v1")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Licensed.dmg")

        try await withSLADetection(true) {
            let first = try await InstallerRunner.process(dmgURL: dmg, destination: destination())
            XCTAssertEqual(first, .needsLicenseHandoff)
            // Nothing was mounted by the first pass.
            assertDetached(volumeName: volume)
        }
    }

    func testSLAAcceptedInstallsThroughTheConvertBypass() async throws {
        let volume = "NDMInst-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("sla2", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Licensed.app", in: src, marker: "v1")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Licensed.dmg")

        try await withSLADetection(true) {
            let outcome = try await InstallerRunner.process(
                dmgURL: dmg,
                destination: destination(),
                licenseAccepted: true
            )
            guard case .installed(_, let at) = outcome else {
                return XCTFail("expected install via bypass, got \(outcome)")
            }
            XCTAssertEqual(
                try? String(contentsOf: at.appendingPathComponent("Contents/MacOS/Licensed")),
                "v1"
            )
            assertDetached(volumeName: volume)
        }
    }

    func testPeeksPrimaryAppInsideDiskImage() async throws {
        let volume = "NDMPeek-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("peek", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Fake.app", in: src, marker: "icon")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Fake.dmg")

        let seen = try await DiskImagePeek.withPrimaryApp(dmgURL: dmg) { $0.lastPathComponent }
        XCTAssertEqual(seen, "Fake.app")
        assertDetached(volumeName: volume)
    }

    func testPeekPrefersFilenameMatchedAppAmongSeveral() async throws {
        let volume = "NDMPeek-\(UUID().uuidString.prefix(6))"
        let src = sources.appendingPathComponent("peek-many", isDirectory: true)
        try FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
        try makeAppBundle(named: "Helper.app", in: src, marker: "h")
        try makeAppBundle(named: "Wonder.app", in: src, marker: "w")
        let dmg = try makeDMG(volumeName: volume, sourceDir: src, fileName: "Wonder-1.2.dmg")

        let seen = try await DiskImagePeek.withPrimaryApp(dmgURL: dmg) { $0.lastPathComponent }
        XCTAssertEqual(seen, "Wonder.app")
        assertDetached(volumeName: volume)
    }

    func testPeeksAppInsidePackageDiskImage() async throws {
        guard FileManager.default.isExecutableFile(atPath: "/usr/bin/pkgbuild") else {
            throw XCTSkip("pkgbuild is not available")
        }
        let volume = "NDMPeekPkg-\(UUID().uuidString.prefix(6))"
        let appRoot = sources.appendingPathComponent("peek-pkg-app", isDirectory: true)
        try FileManager.default.createDirectory(at: appRoot, withIntermediateDirectories: true)
        try makeAppBundle(named: "EasyConnect.app", in: appRoot, marker: "vpn")
        let pkg = root.appendingPathComponent("Install EasyConnect.pkg")
        let pkgbuild = Process()
        pkgbuild.executableURL = URL(filePath: "/usr/bin/pkgbuild")
        pkgbuild.arguments = [
            "--root", appRoot.path,
            "--identifier", "com.sangfor.EasyConnect",
            "--install-location", "/Applications",
            pkg.path,
        ]
        pkgbuild.standardOutput = FileHandle.nullDevice
        pkgbuild.standardError = FileHandle.nullDevice
        try pkgbuild.run()
        pkgbuild.waitUntilExit()
        XCTAssertEqual(pkgbuild.terminationStatus, 0, "pkgbuild failed")

        let dmgSrc = sources.appendingPathComponent("peek-pkg-dmg", isDirectory: true)
        try FileManager.default.createDirectory(at: dmgSrc, withIntermediateDirectories: true)
        try FileManager.default.copyItem(
            at: pkg,
            to: dmgSrc.appendingPathComponent("Install EasyConnect.pkg")
        )
        let dmg = try makeDMG(
            volumeName: volume,
            sourceDir: dmgSrc,
            fileName: "EasyConnect_7_6_7_4.dmg"
        )
        let seen = try await DiskImagePeek.withPrimaryApp(dmgURL: dmg) { $0.lastPathComponent }
        XCTAssertEqual(seen, "EasyConnect.app")
        assertDetached(volumeName: volume)
    }

    // MARK: - Volume enumerator (no hdiutil needed)

    func testVolumeEnumeratorPrunesJunkAndStopsInsideBundles() throws {
        let volumeDir = sources.appendingPathComponent("enum", isDirectory: true)
        try FileManager.default.createDirectory(at: volumeDir, withIntermediateDirectories: true)
        try makeAppBundle(named: "Enum.app", in: volumeDir, marker: "e")
        try FileManager.default.createDirectory(
            at: volumeDir.appendingPathComponent(".Trashes"), withIntermediateDirectories: true
        )
        try Data("x".utf8).write(to: volumeDir.appendingPathComponent(".DS_Store"))

        let entries = VolumeEnumerator.entries(in: volumeDir)
        XCTAssertTrue(entries.contains("Enum.app"))
        XCTAssertFalse(entries.contains(".Trashes"))
        XCTAssertFalse(entries.contains(".DS_Store"))
        // The bundle interior is not listed as candidates.
        XCTAssertFalse(entries.contains("Enum.app/Contents"))
        XCTAssertEqual(
            InstallerFilter.appBundleCandidates(entries: entries),
            ["Enum.app"]
        )
    }
}
