import Foundation
import XCTest
@testable import NDMEngine

final class SmartFinalizeTransactionalNamingTests: XCTestCase {
    func testCustomPrimaryRenamePreservesSuffixAndSidecarRules() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-transaction-naming-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("token.mp4")
        let subtitle = root.appendingPathComponent("token.en.srt")
        let occupied = root.appendingPathComponent("Lecture.mp4")
        try Data([1]).write(to: original)
        try Data([2]).write(to: subtitle)
        try Data([3]).write(to: occupied)
        var destinations: [URL] = []
        let result = try SmartFinalize.applySmartNaming(primary: original, pageTitle: "Lecture", primaryRenamer: { source, destination in
            XCTAssertEqual(source, original)
            destinations.append(destination)
            try FileManager.default.moveItem(at: source, to: destination)
        })
        XCTAssertEqual(destinations, [result.primaryURL])
        XCTAssertNotEqual(result.primaryURL, occupied)
        XCTAssertEqual(result.primaryURL.pathExtension, "mp4")
        XCTAssertEqual(try Data(contentsOf: occupied), Data([3]))
        XCTAssertEqual(try Data(contentsOf: result.primaryURL), Data([1]))
        XCTAssertEqual(result.sidecarURLs.count, 1)
        XCTAssertEqual(try Data(contentsOf: result.sidecarURLs[0]), Data([2]))
        XCTAssertTrue(result.sidecarURLs[0].lastPathComponent.hasPrefix(result.primaryURL.deletingPathExtension().lastPathComponent))
    }

    func testTransactionFailureIsNotSwallowedAndSidecarsDoNotMove() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-transaction-naming-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("token.mp4")
        let subtitle = root.appendingPathComponent("token.en.srt")
        try Data([1]).write(to: original)
        try Data([2]).write(to: subtitle)
        XCTAssertThrowsError(try SmartFinalize.applySmartNaming(primary: original, pageTitle: "Lecture", primaryRenamer: { _, _ in
            throw POSIXError(.EIO)
        }))
        XCTAssertTrue(FileManager.default.fileExists(atPath: original.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: subtitle.path))
    }
    func testOffsetReceiptTracksSmartNameAndRetiresWithoutRemovingMedia() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-offset-naming-\(UUID())")
        let work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("token.mp4")
        let storage = try OffsetDownloadStorage.create(taskID: 991, workDirectory: work,
            destinationURL: original, totalBytes: 4, resourceContextHash: "naming-fixture",
            ranges: [.init(id: 0, start: 0, end: 3, durablePrefix: 0)])
        try storage.write(segmentID: 0, data: Data([1, 2, 3, 4]))
        _ = try storage.publish()
        let result = try SmartFinalize.applySmartNaming(primary: original, pageTitle: "Lecture", primaryRenamer: { _, destination in
            _ = try OffsetDownloadStorage.renamePublished(taskID: 991, workDirectory: work, to: destination)
        })
        XCTAssertNotEqual(result.primaryURL, original)
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 991, workDirectory: work), .published(result.primaryURL))
        try OffsetDownloadStorage.retirePublished(taskID: 991, workDirectory: work)
        XCTAssertEqual(try Data(contentsOf: result.primaryURL), Data([1, 2, 3, 4]))
    }

}
