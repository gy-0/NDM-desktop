import XCTest
import Darwin
@testable import NDMEngine

final class OffsetDownloadStorageTests: XCTestCase {
    func testCheckpointRecoveryIgnoresUncommittedSuffixAndPublishes() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let target = root.appendingPathComponent("result.bin")
        var storage: OffsetDownloadStorage? = try .create(taskID: 1, workDirectory: root, destinationURL: target, totalBytes: 8, resourceContextHash: "resource", ranges: [.init(id: 0, start: 0, end: 3, durablePrefix: 0), .init(id: 1, start: 4, end: 7, durablePrefix: 0)])
        try storage!.write(segmentID: 0, data: Data([1, 2]))
        try storage!.checkpoint()
        try storage!.write(segmentID: 0, data: Data([99, 99]))
        storage = nil
        let resumed = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
        XCTAssertEqual(resumed.snapshot()[0].durablePrefix, 2)
        try resumed.write(segmentID: 0, data: Data([3, 4]))
        try resumed.write(segmentID: 1, data: Data([5, 6, 7, 8]))
        try resumed.publish()
        XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        let published = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
        XCTAssertTrue(published.isPublished)
    }

    private func fixture(_ body: (URL, URL) throws -> Void) throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root, root.appendingPathComponent("result.bin"))
    }
    private func create(_ root: URL, _ target: URL, io: OffsetDownloadStorage.IO = .init()) throws -> OffsetDownloadStorage {
        try .create(taskID: 1, workDirectory: root, destinationURL: target, totalBytes: 8,
                    resourceContextHash: "resource", ranges: [.init(id: 0, start: 0, end: 7, durablePrefix: 0)], io: io)
    }
    func testShortWritesAndInterruptedWriteRetainExactPrefix() throws {
        try fixture { root, target in
            var io = OffsetDownloadStorage.IO()
            var attempts = 0
            io.write = { fd, bytes, count, offset in
                attempts += 1
                if attempts == 1 { errno = EINTR; return -1 }
                return pwrite(fd, bytes, min(2, count), offset)
            }
            let storage = try create(root, target, io: io)
            try storage.write(segmentID: 0, data: Data(1...8))
            XCTAssertEqual(attempts, 5)
            try storage.publish()
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        }
    }
    func testDiskFullAfterShortWriteCanCheckpointOnlyWrittenPrefix() throws {
        try fixture { root, target in
            var io = OffsetDownloadStorage.IO()
            var attempts = 0
            io.write = { fd, bytes, count, offset in
                attempts += 1
                if attempts > 1 { errno = ENOSPC; return -1 }
                return pwrite(fd, bytes, 2, offset)
            }
            let storage = try create(root, target, io: io)
            XCTAssertThrowsError(try storage.write(segmentID: 0, data: Data(1...8)))
            XCTAssertEqual(storage.writtenPrefix(segmentID: 0), 2)
            try storage.checkpoint()
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
            try recovered.write(segmentID: 0, data: Data(3...8))
            try recovered.publish()
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        }
    }
    func testSplitPreservesOwnedPrefixAndRejectsInventedCoverage() throws {
        try fixture { root, target in
            let storage = try create(root, target)
            try storage.write(segmentID: 0, data: Data([1, 2]))
            XCTAssertThrowsError(try storage.replacePlan([.init(id: 0, start: 0, end: 7, durablePrefix: 3)]))
            try storage.replacePlan([.init(id: 0, start: 0, end: 3, durablePrefix: 2), .init(id: 1, start: 4, end: 7, durablePrefix: 0)])
            XCTAssertThrowsError(try storage.write(segmentID: 0, data: Data([3, 4, 5])))
            try storage.write(segmentID: 0, data: Data([3, 4]))
            try storage.write(segmentID: 1, data: Data([5, 6, 7, 8]))
            try storage.publish()
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        }
    }
    func testCheckpointFailureStopsMutationAndRecoveryUsesOldPrefix() throws {
        try fixture { root, target in
            var fail = false
            var io = OffsetDownloadStorage.IO()
            io.beforeManifestCommit = { if fail { throw POSIXError(.ENOSPC) } }
            let storage = try create(root, target, io: io)
            try storage.write(segmentID: 0, data: Data([1, 2]))
            try storage.checkpoint()
            try storage.write(segmentID: 0, data: Data([99, 99]))
            fail = true
            XCTAssertThrowsError(try storage.replacePlan([.init(id: 0, start: 0, end: 3, durablePrefix: 4), .init(id: 1, start: 4, end: 7, durablePrefix: 0)]))
            XCTAssertThrowsError(try storage.write(segmentID: 0, data: Data([5])))
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
            XCTAssertEqual(recovered.snapshot().count, 1)
            XCTAssertEqual(recovered.snapshot()[0].durablePrefix, 2)
        }
    }
    func testContextMismatchAndExistingDestinationArePreserved() throws {
        try fixture { root, target in
            let storage = try create(root, target)
            try storage.write(segmentID: 0, data: Data(1...8))
            XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "changed"))
            try Data([99]).write(to: target)
            XCTAssertThrowsError(try storage.publish())
            XCTAssertEqual(try Data(contentsOf: target), Data([99]))
            XCTAssertEqual(try Data(contentsOf: storage.partialURL), Data(1...8))
        }
    }
    func testReplacedPartialAndSymlinkAreNeverWrittenOrDeleted() throws {
        for symlink in [false, true] {
            try fixture { root, target in
                let storage = try create(root, target)
                let owned = storage.partialURL
                try FileManager.default.moveItem(at: owned, to: root.appendingPathComponent("old-owned"))
                let foreign = root.appendingPathComponent("foreign")
                try Data([99]).write(to: foreign)
                if symlink { try FileManager.default.createSymbolicLink(at: owned, withDestinationURL: foreign) }
                else { try Data([99]).write(to: owned) }
                XCTAssertThrowsError(try storage.write(segmentID: 0, data: Data([1])))
                XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource"))
                XCTAssertEqual(try Data(contentsOf: owned), Data([99]))
                XCTAssertEqual(try Data(contentsOf: foreign), Data([99]))
            }
        }
    }
    func testAfterRenameFailureRecoversPublishedIdentity() throws {
        try fixture { root, target in
            var io = OffsetDownloadStorage.IO()
            io.afterRename = { throw POSIXError(.EIO) }
            let storage = try create(root, target, io: io)
            try storage.write(segmentID: 0, data: Data(1...8))
            XCTAssertThrowsError(try storage.publish())
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
            XCTAssertTrue(recovered.isPublished)
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
            try FileManager.default.moveItem(at: target, to: root.appendingPathComponent("original"))
            try Data(1...8).write(to: target)
            XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource"))
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        }
    }
    func testOfflineParentPreservesManifest() throws {
        try fixture { root, target in
            let parent = root.appendingPathComponent("volume")
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            let storage = try create(root, parent.appendingPathComponent("result"))
            try storage.write(segmentID: 0, data: Data([1]))
            try storage.checkpoint()
            let away = root.appendingPathComponent("away")
            try FileManager.default.moveItem(at: parent, to: away)
            XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource"))
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("offset-storage-v2.json").path))
            try FileManager.default.moveItem(at: away, to: parent)
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
            XCTAssertEqual(recovered.snapshot()[0].durablePrefix, 1)
        }
    }

    func testCreateCannotOverwriteRacingManifest() throws {
        try fixture { root, target in
            var winner: OffsetDownloadStorage?
            var io = OffsetDownloadStorage.IO()
            io.beforeManifestCommit = { winner = try self.create(root, target) }
            XCTAssertThrowsError(try create(root, target, io: io))
            let recovered = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource")
            XCTAssertEqual(recovered.partialURL, winner?.partialURL)
        }
    }
    func testRepeatedPublicationRejectsReplacedDestination() throws {
        try fixture { root, target in
            let storage = try create(root, target)
            try storage.write(segmentID: 0, data: Data(1...8))
            try storage.publish()
            try FileManager.default.moveItem(at: target, to: root.appendingPathComponent("original"))
            try Data([99]).write(to: target)
            XCTAssertThrowsError(try storage.publish())
            XCTAssertEqual(try Data(contentsOf: target), Data([99]))
        }
    }
    func testReplacedWorkDirectoryRejectsCheckpoint() throws {
        try fixture { root, target in
            let work = root.appendingPathComponent("work")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let storage = try create(work, target)
            try storage.write(segmentID: 0, data: Data([1]))
            try FileManager.default.moveItem(at: work, to: root.appendingPathComponent("old-work"))
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            XCTAssertThrowsError(try storage.checkpoint())
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: work.path), [])
        }
    }
    func testConcurrentWritersAndRollbackCoverage() throws {
        try fixture { root, target in
            var ranges: [OffsetDownloadStorage.Range] = []
            for id in 0..<32 {
                let start = Int64(id) * 4
                ranges.append(.init(id: Int16(id), start: start, end: start + 3, durablePrefix: 0))
            }
            let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: root, destinationURL: target,
                totalBytes: 128, resourceContextHash: "resource", ranges: ranges)
            let errorsLock = NSLock()
            var failures: [Error] = []
            DispatchQueue.concurrentPerform(iterations: 32) { id in
                do { try storage.write(segmentID: Int16(id), data: Data(repeating: UInt8(id), count: 4)) }
                catch { errorsLock.lock(); failures.append(error); errorsLock.unlock() }
            }
            XCTAssertTrue(failures.isEmpty)
            // A drained rollback can combine adjacent fully written extents.
            try storage.replacePlan([.init(id: 0, start: 0, end: 127, durablePrefix: 128)])
            try storage.publish()
            let expected = Data((0..<32).flatMap { Array(repeating: UInt8($0), count: 4) })
            XCTAssertEqual(try Data(contentsOf: target), expected)
        }
    }

    func testPublishedRetryRepeatsFailedDirectorySync() throws {
        try fixture { root, target in
            var io = OffsetDownloadStorage.IO()
            var didRename = false
            var directorySyncAttempts = 0
            io.afterRename = { didRename = true }
            io.sync = { fd in
                var info = stat()
                XCTAssertEqual(fstat(fd, &info), 0)
                if didRename && info.st_mode & S_IFMT == S_IFDIR {
                    directorySyncAttempts += 1
                    if directorySyncAttempts == 1 { throw POSIXError(.EIO) }
                }
                if fsync(fd) != 0 { throw POSIXError(.EIO) }
            }
            let storage = try create(root, target, io: io)
            try storage.write(segmentID: 0, data: Data(1...8))
            XCTAssertThrowsError(try storage.publish())
            XCTAssertEqual(directorySyncAttempts, 1)
            XCTAssertEqual(try storage.publish(), target)
            XCTAssertEqual(directorySyncAttempts, 2)
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
        }
    }

    func testOwnedCleanupRemovesIncompleteDataAndReceipt() throws {
        try fixture { root, target in
            var storage: OffsetDownloadStorage? = try create(root, target)
            let partial = storage!.partialURL
            try storage!.write(segmentID: 0, data: Data([1, 2]))
            try storage!.checkpoint()
            storage = nil // Manager must drain and release writers first.
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root), .incomplete(partial))
            try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root)
            XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root), .absent)
        }
    }
    func testCleanupPreservesPublishedFile() throws {
        try fixture { root, target in
            var storage: OffsetDownloadStorage? = try create(root, target)
            try storage!.write(segmentID: 0, data: Data(1...8))
            try storage!.publish()
            storage = nil
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root), .published(target))
            try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root)
            XCTAssertEqual(try Data(contentsOf: target), Data(1...8))
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root), .absent)
        }
    }
    func testCleanupPreservesReplacementAndReceipt() throws {
        for symlink in [false, true] {
            try fixture { root, target in
                var storage: OffsetDownloadStorage? = try create(root, target)
                let partial = storage!.partialURL
                storage = nil
                try FileManager.default.moveItem(at: partial, to: root.appendingPathComponent("old"))
                let foreign = root.appendingPathComponent("foreign")
                try Data([99]).write(to: foreign)
                if symlink { try FileManager.default.createSymbolicLink(at: partial, withDestinationURL: foreign) }
                else { try Data([99]).write(to: partial) }
                XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root))
                XCTAssertEqual(try Data(contentsOf: partial), Data([99]))
                XCTAssertEqual(try Data(contentsOf: foreign), Data([99]))
                XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("offset-storage-v2.json").path))
            }
        }
    }

    func testInterruptedCleanupRetainsDurableOwnershipAndRetries() throws {
        try fixture { root, target in
            var storage: OffsetDownloadStorage? = try create(root, target)
            let partial = storage!.partialURL
            try storage!.write(segmentID: 0, data: Data([1, 2]))
            storage = nil
            var io = OffsetDownloadStorage.IO()
            io.afterCleanupRename = { throw POSIXError(.EIO) }
            XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root, io: io))
            guard case let .cleanupPending(owned) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root) else { return XCTFail("Expected persisted cleanup ownership") }
            XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
            XCTAssertTrue(FileManager.default.fileExists(atPath: owned.path))
            XCTAssertThrowsError(try OffsetDownloadStorage.recover(taskID: 1, workDirectory: root, resourceContextHash: "resource"))
            try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root)
            XCTAssertFalse(FileManager.default.fileExists(atPath: owned.path))
            XCTAssertEqual(try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root), .absent)
        }
    }
    func testCleanupQuarantineReplacementIsPreserved() throws {
        try fixture { root, target in
            var storage: OffsetDownloadStorage? = try create(root, target)
            storage = nil
            var replaced: URL?
            var io = OffsetDownloadStorage.IO()
            io.afterCleanupRename = {
                guard case let .cleanupPending(owned) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root) else { throw POSIXError(.EIO) }
                try FileManager.default.moveItem(at: owned, to: root.appendingPathComponent("old-owned"))
                try Data([99]).write(to: owned)
                replaced = owned
            }
            XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root, io: io))
            XCTAssertEqual(try Data(contentsOf: XCTUnwrap(replaced)), Data([99]))
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("offset-storage-v2.json").path))
        }
    }
    func testZeroLengthCreationReceiptCanBeInspectedAndCleanedWithoutAllocation() throws {
        try fixture { root, target in
            var io = OffsetDownloadStorage.IO()
            io.sync = { fd in
                var value = stat()
                guard fstat(fd, &value) == 0 else { throw POSIXError(.EIO) }
                if value.st_mode & S_IFMT == S_IFDIR { throw POSIXError(.EIO) }
                guard fsync(fd) == 0 else { throw POSIXError(.EIO) }
            }
            // Manifest rename succeeds; directory sync fails before ftruncate.
            XCTAssertThrowsError(try create(root, target, io: io))
            guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: root) else { return XCTFail("Missing creation receipt") }
            XCTAssertEqual(try Data(contentsOf: partial).count, 0)
            try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root)
            XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
        }
    }
    func testCleanupOfflineDestinationKeepsReceipt() throws {
        try fixture { root, target in
            let parent = root.appendingPathComponent("volume")
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true)
            var storage: OffsetDownloadStorage? = try create(root, parent.appendingPathComponent("result"))
            storage = nil
            let away = root.appendingPathComponent("away")
            try FileManager.default.moveItem(at: parent, to: away)
            XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root))
            XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent("offset-storage-v2.json").path))
            try FileManager.default.moveItem(at: away, to: parent)
            try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root)
        }
    }
    func testCleanupRejectsSymlinkReceiptAndWrongTask() throws {
        try fixture { root, target in
            var storage: OffsetDownloadStorage? = try create(root, target)
            storage = nil
            XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 2, workDirectory: root))
            let metadata = root.appendingPathComponent("offset-storage-v2.json")
            let saved = root.appendingPathComponent("foreign-receipt")
            try FileManager.default.moveItem(at: metadata, to: saved)
            let original = try Data(contentsOf: saved)
            try FileManager.default.createSymbolicLink(at: metadata, withDestinationURL: saved)
            XCTAssertThrowsError(try OffsetDownloadStorage.removeIncomplete(taskID: 1, workDirectory: root))
            XCTAssertEqual(try Data(contentsOf: saved), original)
        }
    }
}
