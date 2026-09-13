import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class AuxiliaryPublicationTests: XCTestCase {
    private func fixture() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-aux-publication-\(UUID())")
        let source = root.appendingPathComponent("work/auxiliary-files"), destination = root.appendingPathComponent("downloads")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: root) }
        return (root, source, destination)
    }
    func testMultipleFilesPublishAsOneDirectoryAndReplayTheSameOwnedRename() throws {
        let (_, source, destination) = try fixture(), work = source.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: source.appendingPathComponent("nested"), withIntermediateDirectories: false)
        try Data([1, 2]).write(to: source.appendingPathComponent("nested/one.bin"))
        try Data([3, 4]).write(to: source.appendingPathComponent("nested/two.bin"))
        let existing = destination.appendingPathComponent("bundle")
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: false)
        try Data([9]).write(to: existing.appendingPathComponent("keep"))
        let files = [AuxiliaryTaskFile(index: 1, relativePath: "nested/one.bin", length: 2, completedLength: 2, selected: true),
                     AuxiliaryTaskFile(index: 2, relativePath: "nested/two.bin", length: 2, completedLength: 2, selected: true)]
        let output = try AuxiliaryPublication.publish(taskID: 1, generation: 0, filesDirectory: source, files: files, destination: destination, preferredName: "bundle", workDirectory: work, token: CancelToken())
        XCTAssertNotEqual(output, existing)
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("nested/one.bin")), Data([1, 2]))
        XCTAssertEqual(try Data(contentsOf: output.appendingPathComponent("nested/two.bin")), Data([3, 4]))
        XCTAssertEqual(try Data(contentsOf: existing.appendingPathComponent("keep")), Data([9]))
        let replay = try AuxiliaryPublication.publish(taskID: 1, generation: 0, filesDirectory: source, files: files, destination: destination, preferredName: "bundle", workDirectory: work, token: CancelToken())
        // Foundation may add a directory trailing slash when resolving an
        // existing receipt; ownership is the same filesystem object.
        XCTAssertEqual(replay.standardizedFileURL.path, output.standardizedFileURL.path)
        let originalIdentity = try output.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
        let replayIdentity = try replay.resourceValues(forKeys: [.fileResourceIdentifierKey]).fileResourceIdentifier
        XCTAssertEqual(originalIdentity as? NSObject, replayIdentity as? NSObject)
        XCTAssertThrowsError(try AuxiliaryPublication.publishedURL(taskID: 1, generation: 1, workDirectory: work))
    }
    func testReplacedPublishedFileIsNeverAdoptedOrRemovedAsOwned() throws {
        let (_, source, destination) = try fixture(), work = source.deletingLastPathComponent()
        try Data([1]).write(to: source.appendingPathComponent("one.bin"))
        let files = [AuxiliaryTaskFile(index: 1, relativePath: "one.bin", length: 1, completedLength: 1, selected: true)]
        let output = try AuxiliaryPublication.publish(taskID: 2, generation: 0, filesDirectory: source, files: files, destination: destination, preferredName: "one.bin", workDirectory: work, token: CancelToken())
        let original = destination.appendingPathComponent("moved-original.bin")
        try FileManager.default.moveItem(at: output, to: original)
        try Data([8]).write(to: output)
        XCTAssertThrowsError(try AuxiliaryPublication.publishedURL(taskID: 2, generation: 0, workDirectory: work))
        XCTAssertEqual(try Data(contentsOf: output), Data([8]))
        XCTAssertEqual(try Data(contentsOf: original), Data([1]))
    }
    func testUnsafeSourceAndPausedCopyNeverPublishPayload() throws {
        let (root, source, destination) = try fixture(), work = source.deletingLastPathComponent()
        try Data([1]).write(to: root.appendingPathComponent("outside"))
        try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("link"), withDestinationURL: root)
        let unsafe = [AuxiliaryTaskFile(index: 1, relativePath: "link/outside", length: 1, completedLength: 1, selected: true)]
        XCTAssertThrowsError(try AuxiliaryPublication.publish(taskID: 3, generation: 0, filesDirectory: source, files: unsafe, destination: destination, preferredName: "outside", workDirectory: work, token: CancelToken()))
        try AuxiliaryPublication.cleanStaging(taskID: 3, generation: 0, workDirectory: work)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("outside")), Data([1]))
        let token = CancelToken(); token.pause()
        XCTAssertThrowsError(try AuxiliaryPublication.publish(taskID: 4, generation: 0, filesDirectory: source, files: unsafe, destination: destination, preferredName: "outside", workDirectory: work, token: token))
    }
}
