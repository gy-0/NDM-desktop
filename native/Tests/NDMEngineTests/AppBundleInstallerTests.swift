import Darwin
import Foundation
import XCTest
@testable import NDMEngine

final class AppBundleInstallerTests: XCTestCase {
    private var root: URL!
    private var source: URL!
    private var destination: URL!
    private let fm = FileManager.default

    override func setUpWithError() throws {
        root = fm.temporaryDirectory.appendingPathComponent("ndm-app-copy-\(UUID().uuidString)")
        source = root.appendingPathComponent("source/Sample.app")
        destination = root.appendingPathComponent("Applications")
        try fm.createDirectory(at: source, withIntermediateDirectories: true)
        try Data("new".utf8).write(to: source.appendingPathComponent("version"))
        try fm.createSymbolicLink(atPath: source.appendingPathComponent("current").path, withDestinationPath: "version")
    }

    override func tearDownWithError() throws { try? fm.removeItem(at: root) }

    private var target: URL { destination.appendingPathComponent("Sample.app") }

    private func existingApp() throws {
        try fm.createDirectory(at: target, withIntermediateDirectories: true)
        try Data("old".utf8).write(to: target.appendingPathComponent("version"))
    }

    private func nestedError(_ code: Int32) -> NSError {
        NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError,
                userInfo: [NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(code))])
    }

    func testTransientReadFailureRestartsCleanCopyAndPreservesSymlinks() throws {
        var attempts = 0
        let outcome = try AppBundleInstaller.install(source: source, destination: destination,
            replaceExisting: false, copyItem: { from, to in
                attempts += 1
                XCTAssertFalse(self.fm.fileExists(atPath: to.path))
                if attempts == 1 {
                    try self.fm.createDirectory(at: to, withIntermediateDirectories: true)
                    try Data("partial".utf8).write(to: to.appendingPathComponent("partial"))
                    throw self.nestedError(EIO)
                }
                try self.fm.copyItem(at: from, to: to)
            }, wait: { _ in })
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(outcome, .installed(appName: "Sample.app", at: target))
        XCTAssertFalse(fm.fileExists(atPath: target.appendingPathComponent("partial").path))
        XCTAssertEqual(try fm.destinationOfSymbolicLink(atPath: target.appendingPathComponent("current").path), "version")
    }

    func testRepeatedCopyFailurePreservesOldAppAndRemovesPartialStaging() throws {
        try existingApp()
        var attempts = 0
        XCTAssertThrowsError(try AppBundleInstaller.install(source: source, destination: destination,
            replaceExisting: true, copyItem: { _, to in
                attempts += 1
                XCTAssertEqual(try String(contentsOf: self.target.appendingPathComponent("version")), "old")
                try self.fm.createDirectory(at: to, withIntermediateDirectories: true)
                throw self.nestedError(EIO)
            }, wait: { _ in })) { error in
                XCTAssertEqual(error.localizedDescription, "复制应用时发生读写错误。请重试安装。")
            }
        XCTAssertEqual(attempts, 3)
        XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("version")), "old")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: destination.path), ["Sample.app"])
    }

    func testPermissionFailureIsNotRetried() throws {
        var attempts = 0
        XCTAssertThrowsError(try AppBundleInstaller.install(source: source, destination: destination,
            replaceExisting: false, copyItem: { _, _ in
                attempts += 1
                throw self.nestedError(EACCES)
            }, wait: { _ in XCTFail("must not retry permission failures") })) { error in
                XCTAssertEqual(error.localizedDescription, "无法写入安装位置。请检查文件夹权限。")
            }
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: destination.path), [])
    }

    func testReplacementPublishesCompleteBundleAndRemovesOldContents() throws {
        try existingApp()
        try Data("old-only".utf8).write(to: target.appendingPathComponent("old-only"))
        let outcome = try AppBundleInstaller.install(source: source, destination: destination,
            replaceExisting: true, copyItem: { from, to in
                try self.fm.copyItem(at: from, to: to)
                XCTAssertEqual(try String(contentsOf: self.target.appendingPathComponent("version")), "old")
            })
        XCTAssertEqual(outcome, .installed(appName: "Sample.app", at: target))
        XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("version")), "new")
        XCTAssertFalse(fm.fileExists(atPath: target.appendingPathComponent("old-only").path))
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: destination.path), ["Sample.app"])
    }

    func testAppAppearingDuringCopyIsNotOverwrittenWithoutConsent() throws {
        let outcome = try AppBundleInstaller.install(source: source, destination: destination,
            replaceExisting: false, copyItem: { from, to in
                try self.fm.copyItem(at: from, to: to)
                try self.existingApp()
            })
        XCTAssertEqual(outcome, .needsReplaceConsent(appName: "Sample.app"))
        XCTAssertEqual(try String(contentsOf: target.appendingPathComponent("version")), "old")
        XCTAssertEqual(try fm.contentsOfDirectory(atPath: destination.path), ["Sample.app"])
    }

    func testReplacementConsentAlsoWorksWhenOldAppIsAlreadyGone() throws {
        let outcome = try AppBundleInstaller.install(source: source, destination: destination, replaceExisting: true)
        XCTAssertEqual(outcome, .installed(appName: "Sample.app", at: target))
    }
}
