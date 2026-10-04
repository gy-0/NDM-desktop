import Foundation
import XCTest
import NDMCore
@testable import NDMEngine

final class SmartFinalizeTransactionalNamingTests: XCTestCase {
    func testLongUnicodeSmartNamesAndTheirCollisionsCanActuallyBeWritten() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-unicode-naming-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for (index, character) in ["文", "👨‍👩‍👧‍👦"].enumerated() {
            let raw = String(repeating: character, count: 180) + ".m3u8"
            let requested = DownloadFilename.sanitizeNewDownload(raw)
            let expected = SmartFinalize.availableOutputURL(in: root,
                stem: (requested as NSString).deletingPathExtension, extension: "mp4")
            try Data([9]).write(to: expected)
            let original = root.appendingPathComponent("source-\(index).mp4")
            try Data([1, 2]).write(to: original)
            let result = try SmartFinalize.applySmartNaming(primary: original,
                pageTitle: nil, requestedFilename: raw)
            XCTAssertLessThanOrEqual(result.primaryURL.lastPathComponent.utf8.count, 255)
            XCTAssertTrue(result.primaryURL.lastPathComponent.hasSuffix(" (2).mp4"))
            XCTAssertEqual(try Data(contentsOf: result.primaryURL), Data([1, 2]))
            XCTAssertEqual(try Data(contentsOf: expected), Data([9]))
            let stem = result.primaryURL.deletingPathExtension().lastPathComponent
                .replacingOccurrences(of: " (2)", with: "")
            XCTAssertTrue(stem.allSatisfy { String($0) == character })
            let suggestion = SmartFinalize.suggestedFilename(pageTitle: raw,
                fallback: "source.mp4", ext: "mp4")
            XCTAssertLessThanOrEqual(suggestion.utf8.count, 247)
            XCTAssertTrue(suggestion.hasSuffix(".mp4"))
        }
    }

    func testReviewedNameWinsOverPageTitleAndKeepsActualContainer() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-reviewed-naming-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("server-title.mp4")
        let occupied = root.appendingPathComponent("My selection.mp4")
        try Data([1]).write(to: original)
        try Data([2]).write(to: occupied)
        let result = try SmartFinalize.applySmartNaming(primary: original,
            pageTitle: "Original source title", requestedFilename: "My selection.m3u8")
        XCTAssertTrue(result.primaryURL.lastPathComponent.hasPrefix("My selection"))
        XCTAssertEqual(result.primaryURL.pathExtension, "mp4")
        XCTAssertNotEqual(result.primaryURL, occupied)
        XCTAssertEqual(try Data(contentsOf: occupied), Data([2]))
        XCTAssertEqual(try Data(contentsOf: result.primaryURL), Data([1]))
    }

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

    func testOffsetNamingRetriesAnExclusiveCollisionAndCarriesSidecars() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-naming-race-\(UUID())")
        let work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("token.mp4")
        let subtitle = root.appendingPathComponent("token.en.srt")
        try Data([5]).write(to: subtitle)
        let storage = try OffsetDownloadStorage.create(taskID: 992, workDirectory: work,
            destinationURL: original, totalBytes: 4, resourceContextHash: "naming-race",
            ranges: [.init(id: 0, start: 0, end: 3, durablePrefix: 0)])
        try storage.write(segmentID: 0, data: Data([1, 2, 3, 4]))
        _ = try storage.publish()
        var attempts = 0
        var occupied: URL?
        let result = try SmartFinalize.applySmartNaming(primary: original, pageTitle: "Lecture",
            primaryRenamer: { _, destination in
                attempts += 1
                if attempts == 1 {
                    occupied = destination
                    try Data([9]).write(to: destination)
                }
                _ = try OffsetDownloadStorage.renamePublished(taskID: 992, workDirectory: work, to: destination)
            })
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(occupied)), Data([9]))
        XCTAssertEqual(result.primaryURL.lastPathComponent, "Lecture (2).mp4")
        XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 992, workDirectory: work), .published(result.primaryURL))
        XCTAssertEqual(try Data(contentsOf: result.primaryURL), Data([1, 2, 3, 4]))
        XCTAssertEqual(result.sidecarURLs.map(\.lastPathComponent), ["Lecture (2).en.srt"])
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
