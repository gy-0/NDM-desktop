import XCTest
import NDMCore
@testable import NDMEngine

final class RepresentationStorageContextTests: XCTestCase {
    func testChangedRemoteRepresentationCannotReuseDurableOffsetCheckpoint() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: URL(string: "https://example.invalid/file")!, destinationDirectory: root)
        let old = HTTPRepresentationIdentity(request: request, totalBytes: 10, validator: .etag("old"))
        let new = HTTPRepresentationIdentity(request: request, totalBytes: 10, validator: .etag("new"))
        do {
            let storage = try OffsetDownloadStorage.create(taskID: 42, workDirectory: root,
                destinationURL: root.appendingPathComponent("output"), totalBytes: 10,
                resourceContextHash: old.storageContextHash,
                ranges: [.init(id: 0, start: 0, end: 9, durablePrefix: 0)])
            _ = try storage.write(segmentID: 0, data: Data([1, 2, 3]))
            try storage.checkpoint()
        }
        XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 42, workDirectory: root,
                             resourceContextHash: new.storageContextHash))
        let recovered = try OffsetDownloadStorage.recover(taskID: 42, workDirectory: root,
                                                          resourceContextHash: old.storageContextHash)
        XCTAssertEqual(recovered.snapshot().first?.durablePrefix, 3)
        XCTAssertEqual(try Data(contentsOf: recovered.partialURL).prefix(3), Data([1, 2, 3]))
    }

    func testCheckpointIdentityChangesWithRepresentationAndRequestContext() throws {
        let request = DownloadRequest(url: URL(string: "https://example.invalid/file")!,
                                      destinationDirectory: FileManager.default.temporaryDirectory)
        let original = HTTPRepresentationIdentity(request: request, totalBytes: 100, validator: .etag("old"))
        let replaced = HTTPRepresentationIdentity(request: request, totalBytes: 100, validator: .etag("new"))
        XCTAssertEqual(original.requestFingerprint, replaced.requestFingerprint)
        XCTAssertNotEqual(original.storageContextHash, replaced.storageContextHash)
        XCTAssertNotEqual(original.storageContextHash,
                          HTTPRepresentationIdentity(request: request, totalBytes: 101, validator: .etag("old")).storageContextHash)
        XCTAssertNotEqual(original.storageContextHash,
                          HTTPRepresentationIdentity(request: request, totalBytes: 100, validator: .lastModified("old")).storageContextHash)
        let another = DownloadRequest(url: URL(string: "https://example.invalid/another")!,
                                      destinationDirectory: FileManager.default.temporaryDirectory)
        XCTAssertNotEqual(original.storageContextHash,
                          HTTPRepresentationIdentity(request: another, totalBytes: 100, validator: .etag("old")).storageContextHash)
        let recovered = try JSONDecoder().decode(HTTPRepresentationIdentity.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(original.storageContextHash, recovered.storageContextHash)
    }
}
