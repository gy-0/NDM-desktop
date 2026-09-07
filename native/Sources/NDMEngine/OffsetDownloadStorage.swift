import Foundation
import Darwin

/// V2 backend only; legacy engine selection is deliberately unchanged.
/// Lock order: external transfer lease -> storage. Never calls a lease or actor.
/// The storage lock serializes writes, checkpoints, plan changes and publication.
final class OffsetDownloadStorage: @unchecked Sendable {
    struct Range: Codable, Equatable {
        var id: Int16
        var start: Int64
        var end: Int64
        var durablePrefix: Int64
        var length: Int64 { end - start + 1 }
    }
    enum Failure: Error { case invalidManifest, identityMismatch, invalidWrite, incomplete, published }
    struct IO {
        var write: (Int32, UnsafeRawPointer, Int, off_t) -> Int = { Darwin.pwrite($0, $1, $2, $3) }
        var sync: (Int32) throws -> Void = { if Darwin.fsync($0) != 0 { throw posixError() } }
        var beforeManifestCommit: () throws -> Void = {}
        var afterRename: () throws -> Void = {}
        var beforeRename: () throws -> Void = {}
        var afterCleanupRename: () throws -> Void = {}
    }
    private struct Identity: Codable, Equatable {
        var device: Int64
        var inode: UInt64
        var birthSeconds: Int64
        var birthNanoseconds: Int64
        init(_ info: stat) {
            device = Int64(info.st_dev); inode = UInt64(info.st_ino)
            birthSeconds = Int64(info.st_birthtimespec.tv_sec)
            birthNanoseconds = Int64(info.st_birthtimespec.tv_nsec)
        }
    }
    private struct Manifest: Codable {
        var version = 2
        var taskID: Int64
        var totalBytes: Int64
        var resourceContextHash: String
        var parentPath: String
        var parent: Identity
        var partialName: String
        var destinationName: String
        var file: Identity
        var ranges: [Range]
        var publishing = false
        var cleanupName: String?
        var previousDestinationName: String?
    }
    private static let manifestName = "offset-storage-v2.json"
    private let lock = NSLock()
    private var manifest: Manifest
    private var written: [Int16: Int64]
    private let descriptor: Int32
    private let parentDescriptor: Int32
    private let workDescriptor: Int32
    private let io: IO
    private let workPath: String
    private let workIdentity: Identity
    private var published = false
    private var requiresRecovery = false
    var isPublished: Bool { locked { published } }
    var partialURL: URL { locked { URL(fileURLWithPath: manifest.parentPath).appendingPathComponent(manifest.partialName) } }

    var totalBytes: Int64 { locked { manifest.totalBytes } }
    var destinationURL: URL { locked { URL(fileURLWithPath: manifest.parentPath).appendingPathComponent(manifest.destinationName) } }
    func verifiedAllocatedBytes() throws -> Int64 {
        try locked {
            try verifyPaths(published: published)
            let blocks = Int64(try Self.info(descriptor).st_blocks)
            let (bytes, overflow) = blocks.multipliedReportingOverflow(by: 512)
            return overflow ? manifest.totalBytes : min(manifest.totalBytes, max(0, bytes))
        }
    }
    /// The engine holds the affected lease lock. Other ranges may keep writing;
    /// capture their latest prefixes under our lock, not in separate snapshots.
    func replacePlanPreservingWritten(_ ranges: [Range]) throws {
        try locked {
            let next = ranges.map { range -> Range in
                var result = range
                if let old = manifest.ranges.first(where: { $0.id == range.id && $0.start == range.start }) {
                    result.durablePrefix = min(range.length, written[old.id] ?? 0)
                } else { result.durablePrefix = 0 }
                return result
            }
            try replacePlanLocked(next)
        }
    }

    private init(manifest: Manifest, descriptor: Int32, parent: Int32, work: Int32, workPath: String, workIdentity: Identity, io: IO, published: Bool = false) {
        self.manifest = manifest; self.descriptor = descriptor
        parentDescriptor = parent; workDescriptor = work; self.io = io
        self.workPath = workPath; self.workIdentity = workIdentity
        written = Dictionary(uniqueKeysWithValues: manifest.ranges.map { ($0.id, $0.durablePrefix) })
        self.published = published
    }
    deinit { Darwin.close(descriptor); Darwin.close(parentDescriptor); Darwin.close(workDescriptor) }
    private func locked<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
    private static func posixError() -> POSIXError { POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    private static func info(_ fd: Int32) throws -> stat { var result = stat(); guard fstat(fd, &result) == 0 else { throw posixError() }; return result }
    private static func directory(_ path: String) throws -> Int32 {
        let fd = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw posixError() }; return fd
    }
    private static func validName(_ name: String) -> Bool { !name.isEmpty && name != "." && name != ".." && !name.contains("/") && !name.contains("\0") }
    private static func validate(_ ranges: [Range], total: Int64) throws {
        guard total > 0, !ranges.isEmpty, Set(ranges.map(\.id)).count == ranges.count else { throw Failure.invalidManifest }
        var next: Int64 = 0
        for range in ranges.sorted(by: { $0.start < $1.start }) {
            guard range.start == next, range.end >= range.start, range.end < total,
                  range.durablePrefix >= 0, range.durablePrefix <= range.length else { throw Failure.invalidManifest }
            next = range.end + 1
        }
        guard next == total else { throw Failure.invalidManifest }
    }
    static func create(taskID: Int64, workDirectory: URL, destinationURL: URL, totalBytes: Int64,
                       resourceContextHash: String, ranges: [Range], io: IO = IO()) throws -> OffsetDownloadStorage {
        try validate(ranges, total: totalBytes)
        guard ranges.allSatisfy({ $0.durablePrefix == 0 }), !resourceContextHash.isEmpty,
              validName(destinationURL.lastPathComponent) else { throw Failure.invalidManifest }
        let parentPath = destinationURL.deletingLastPathComponent().standardizedFileURL.path
        let parent = try directory(parentPath)
        var work: Int32 = -1, fd: Int32 = -1
        var transferred = false
        do {
            work = try directory(workDirectory.path)
            var existing = stat()
            if fstatat(work, manifestName, &existing, AT_SYMLINK_NOFOLLOW) == 0 { throw POSIXError(.EEXIST) }
            guard errno == ENOENT else { throw posixError() }
            if fstatat(parent, destinationURL.lastPathComponent, &existing, AT_SYMLINK_NOFOLLOW) == 0 { throw POSIXError(.EEXIST) }
            guard errno == ENOENT else { throw posixError() }
            let name = ".ndm-offset-\(taskID)-\(UUID().uuidString).partial"
            fd = openat(parent, name, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw posixError() }
            let state = Manifest(taskID: taskID, totalBytes: totalBytes, resourceContextHash: resourceContextHash,
                                 parentPath: parentPath, parent: Identity(try info(parent)), partialName: name,
                                 destinationName: destinationURL.lastPathComponent, file: Identity(try info(fd)), ranges: ranges)
            let storage = OffsetDownloadStorage(manifest: state, descriptor: fd, parent: parent, work: work, workPath: workDirectory.path, workIdentity: Identity(try info(work)), io: io)
            // Ownership metadata exists before any large file allocation or payload.
            fd = -1; work = -1; transferred = true
            try storage.persist(state, exclusive: true)
            guard ftruncate(storage.descriptor, totalBytes) == 0 else { throw posixError() }
            return storage
        } catch {
            if fd >= 0 { Darwin.close(fd) }
            if work >= 0 { Darwin.close(work) }
            if !transferred { Darwin.close(parent) }
            // No payload file is deleted without a verified ownership receipt.
            throw error
        }
    }
    static func recover(taskID: Int64, workDirectory: URL, resourceContextHash: String, io: IO = IO()) throws -> OffsetDownloadStorage {
        let work = try directory(workDirectory.path)
        var parent: Int32 = -1, fd: Int32 = -1
        do {
            let metadata = openat(work, manifestName, O_RDONLY | O_NOFOLLOW)
            guard metadata >= 0 else { throw posixError() }
            let handle = FileHandle(fileDescriptor: metadata, closeOnDealloc: true)
            defer { try? handle.close() }
            let metaInfo = try info(metadata)
            guard metaInfo.st_mode & S_IFMT == S_IFREG, metaInfo.st_size <= 4 * 1024 * 1024 else { throw Failure.invalidManifest }
            var state = try JSONDecoder().decode(Manifest.self, from: try handle.readToEnd() ?? Data())
            guard state.version == 2, state.taskID == taskID, state.resourceContextHash == resourceContextHash,
                  !resourceContextHash.isEmpty, state.parentPath.hasPrefix("/"), validName(state.partialName),
                  state.partialName.hasPrefix(".ndm-offset-\(taskID)-"), state.partialName.hasSuffix(".partial"),
                  validName(state.destinationName), state.partialName != state.destinationName else { throw Failure.identityMismatch }
            try validate(state.ranges, total: state.totalBytes)
            guard state.cleanupName == nil else { throw Failure.incomplete }
            parent = try directory(state.parentPath)
            guard Identity(try info(parent)) == state.parent else { throw Failure.identityMismatch }
            var published = false
            fd = openat(parent, state.partialName, O_RDWR | O_NOFOLLOW)
            if fd < 0 {
                guard errno == ENOENT, state.publishing else { throw posixError() }
                guard case let .published(found) = try inspect(taskID: taskID, workDirectory: workDirectory) else { throw Failure.identityMismatch }
                fd = openat(parent, found.lastPathComponent, O_RDONLY | O_NOFOLLOW)
                state.destinationName = found.lastPathComponent
                published = true
            }
            guard fd >= 0 else { throw posixError() }
            let file = try info(fd)
            guard file.st_mode & S_IFMT == S_IFREG, Identity(file) == state.file,
                  file.st_size <= state.totalBytes else { throw Failure.identityMismatch }
            for range in state.ranges where range.durablePrefix > 0 {
                guard file.st_size >= range.start + range.durablePrefix else { throw Failure.invalidManifest }
            }
            if published {
                guard state.ranges.allSatisfy({ $0.durablePrefix == $0.length }) else { throw Failure.incomplete }
            } else {
                guard ftruncate(fd, state.totalBytes) == 0 else { throw posixError() }
            }
            return OffsetDownloadStorage(manifest: state, descriptor: fd, parent: parent, work: work, workPath: workDirectory.path, workIdentity: Identity(try info(work)), io: io, published: published)
        } catch {
            if fd >= 0 { Darwin.close(fd) }; if parent >= 0 { Darwin.close(parent) }; Darwin.close(work)
            throw error
        }
    }

    enum Inspection: Equatable {
        case absent
        case incomplete(URL)
        case published(URL)
        case cleanupPending(URL)
        case partialMissing
    }

    /// Persist both names before an exclusive same-directory rename.
    @discardableResult static func renamePublished(taskID: Int64, workDirectory: URL, to destination: URL, io: IO = IO()) throws -> URL {
        guard let receipt = try CleanupReceipt.load(taskID: taskID, workDirectory: workDirectory),
              case let .published(current) = try receipt.inspect() else { throw Failure.incomplete }
        guard destination.deletingLastPathComponent().standardizedFileURL.path == receipt.state.parentPath,
              validName(destination.lastPathComponent),
              destination.lastPathComponent != receipt.state.partialName,
              destination.lastPathComponent != receipt.state.cleanupName else { throw Failure.identityMismatch }
        if destination == current { try io.sync(receipt.parent); return current }
        var next = receipt.state
        next.previousDestinationName = current.lastPathComponent
        next.destinationName = destination.lastPathComponent
        try receipt.verifyDirectories()
        try persistMetadata(next, workDescriptor: receipt.work, io: io, expectedIdentity: receipt.metadataIdentity)
        receipt.state = next
        try receipt.verifyDirectories()
        guard try receipt.isOwned(current.lastPathComponent) else { throw Failure.identityMismatch }
        try io.beforeRename()
        guard renameatx_np(receipt.parent, current.lastPathComponent, receipt.parent, destination.lastPathComponent, UInt32(RENAME_EXCL)) == 0 else { throw posixError() }
        guard try receipt.isOwned(destination.lastPathComponent),
              try receipt.fileInfo(destination.lastPathComponent)?.st_size == next.totalBytes else {
            _ = renameatx_np(receipt.parent, destination.lastPathComponent, receipt.parent, current.lastPathComponent, UInt32(RENAME_EXCL))
            throw Failure.identityMismatch
        }
        try io.afterRename()
        try io.sync(receipt.parent)
        return destination
    }

    /// Read-only: never preallocates a partial or trusts its length as progress.
    static func inspect(taskID: Int64, workDirectory: URL) throws -> Inspection {
        guard let receipt = try CleanupReceipt.load(taskID: taskID, workDirectory: workDirectory) else { return .absent }
        return try receipt.inspect()
    }

    /// Retire a completion receipt without ever cleaning an incomplete payload.
    /// The manager must hold its task lifecycle lock and drain writers first.
    static func retirePublished(taskID: Int64, workDirectory: URL, io: IO = IO()) throws {
        guard let receipt = try CleanupReceipt.load(taskID: taskID, workDirectory: workDirectory) else { return }
        guard case .published = try receipt.inspect() else { throw Failure.incomplete }
        try io.sync(receipt.parent)
        try receipt.removeMetadata(io: io)
    }

    /// Manager must drain/release all task writers before entering this API and
    /// serialize it with start/restart by task generation. No directory scans.
    /// Published destinations are NEVER removed. Any uncertain ownership or
    /// unavailable volume leaves the receipt for a later retry.
    static func removeIncomplete(taskID: Int64, workDirectory: URL, io: IO = IO()) throws {
        guard let receipt = try CleanupReceipt.load(taskID: taskID, workDirectory: workDirectory) else { return }
        var state = receipt.state
        let status = try receipt.inspect()
        switch status {
        case .absent: return
        case .published, .partialMissing:
            // Retry directory durability before retiring the only receipt.
            try io.sync(receipt.parent)
            try receipt.removeMetadata(io: io)
            return
        case .incomplete, .cleanupPending: break
        }
        if state.cleanupName == nil {
            state.cleanupName = ".ndm-offset-cleanup-\(taskID)-\(UUID().uuidString).partial"
            try receipt.verifyDirectories()
            try persistMetadata(state, workDescriptor: receipt.work, io: io, expectedIdentity: receipt.metadataIdentity)
            receipt.state = state
            try receipt.refreshMetadataIdentity()
        }
        let cleanup = state.cleanupName!
        if try receipt.fileInfo(cleanup) == nil {
            // Move first, then validate identity at the new name. A path swap
            // between inspection and rename cannot authorize deleting a foreign
            // inode. The persisted cleanup name makes a crash here resumable.
            try receipt.verifyDirectories()
            guard renameatx_np(receipt.parent, state.partialName, receipt.parent, cleanup, UInt32(RENAME_EXCL)) == 0 else { throw posixError() }
            guard try receipt.isOwned(cleanup) else {
                // Never overwrite a concurrently created replacement at source.
                // If restoration cannot succeed, preserve both paths and receipt.
                _ = renameatx_np(receipt.parent, cleanup, receipt.parent, state.partialName, UInt32(RENAME_EXCL))
                throw Failure.identityMismatch
            }
            try io.sync(receipt.parent)
            try io.afterCleanupRename()
        }
        try receipt.verifyDirectories()
        guard try receipt.isOwned(cleanup) else { throw Failure.identityMismatch }
        guard unlinkat(receipt.parent, cleanup, 0) == 0 else { throw posixError() }
        try io.sync(receipt.parent)
        try receipt.removeMetadata(io: io)
    }

    private final class CleanupReceipt {
        var state: Manifest
        let work: Int32
        let parent: Int32
        let workPath: String
        let workIdentity: Identity
        var metadataIdentity: Identity
        init(state: Manifest, work: Int32, parent: Int32, workPath: String, workIdentity: Identity, metadataIdentity: Identity) {
            self.state = state; self.work = work; self.parent = parent; self.workPath = workPath
            self.workIdentity = workIdentity; self.metadataIdentity = metadataIdentity
        }
        deinit { Darwin.close(work); Darwin.close(parent) }
        static func load(taskID: Int64, workDirectory: URL) throws -> CleanupReceipt? {
            let work: Int32
            do { work = try directory(workDirectory.path) }
            catch let error as POSIXError where error.code == .ENOENT { return nil }
            var parent: Int32 = -1
            do {
                let metadata = openat(work, manifestName, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
                if metadata < 0 {
                    if errno == ENOENT { Darwin.close(work); return nil }
                    throw posixError()
                }
                let handle = FileHandle(fileDescriptor: metadata, closeOnDealloc: true)
                defer { try? handle.close() }
                let meta = try info(metadata)
                guard meta.st_mode & S_IFMT == S_IFREG, meta.st_size <= 4 * 1024 * 1024 else { throw Failure.invalidManifest }
                let state = try JSONDecoder().decode(Manifest.self, from: try handle.readToEnd() ?? Data())
                guard state.version == 2, state.taskID == taskID, !state.resourceContextHash.isEmpty,
                      state.parentPath.hasPrefix("/"), validName(state.partialName),
                      state.partialName.hasPrefix(".ndm-offset-\(taskID)-"), state.partialName.hasSuffix(".partial"),
                      validName(state.destinationName), state.destinationName != state.partialName else { throw Failure.identityMismatch }
                if let previous = state.previousDestinationName {
                    guard validName(previous), previous != state.partialName else { throw Failure.invalidManifest }
                }
                if let cleanup = state.cleanupName {
                    guard validName(cleanup), cleanup.hasPrefix(".ndm-offset-cleanup-\(taskID)-"), cleanup.hasSuffix(".partial"),
                          cleanup != state.partialName, cleanup != state.destinationName else { throw Failure.invalidManifest }
                }
                try validate(state.ranges, total: state.totalBytes)
                parent = try directory(state.parentPath)
                guard Identity(try info(parent)) == state.parent else { throw Failure.identityMismatch }
                return CleanupReceipt(state: state, work: work, parent: parent, workPath: workDirectory.path,
                                      workIdentity: Identity(try info(work)), metadataIdentity: Identity(meta))
            } catch {
                if parent >= 0 { Darwin.close(parent) }; Darwin.close(work); throw error
            }
        }
        func verifyDirectories() throws {
            let currentWork = try directory(workPath)
            defer { Darwin.close(currentWork) }
            let currentParent = try directory(state.parentPath)
            defer { Darwin.close(currentParent) }
            guard Identity(try info(currentWork)) == workIdentity,
                  Identity(try info(currentParent)) == state.parent else { throw Failure.identityMismatch }
        }
        func fileInfo(_ name: String) throws -> stat? {
            var value = stat()
            if fstatat(parent, name, &value, AT_SYMLINK_NOFOLLOW) == 0 { return value }
            if errno == ENOENT { return nil }
            throw posixError()
        }
        func isOwned(_ name: String) throws -> Bool {
            guard let value = try fileInfo(name) else { return false }
            return value.st_mode & S_IFMT == S_IFREG && Identity(value) == state.file
        }
        func inspect() throws -> Inspection {
            try verifyDirectories()
            let base = URL(fileURLWithPath: state.parentPath)
            if let cleanup = state.cleanupName, try fileInfo(cleanup) != nil {
                guard try isOwned(cleanup) else { throw Failure.identityMismatch }
                return .cleanupPending(base.appendingPathComponent(cleanup))
            }
            if try fileInfo(state.partialName) != nil {
                guard try isOwned(state.partialName) else { throw Failure.identityMismatch }
                return .incomplete(base.appendingPathComponent(state.partialName))
            }
            if state.publishing {
                var sawCandidate = false
                for name in [state.destinationName, state.previousDestinationName].compactMap({ $0 }) {
                    if let file = try fileInfo(name) {
                        sawCandidate = true
                        if try isOwned(name), file.st_size == state.totalBytes,
                           state.ranges.allSatisfy({ $0.durablePrefix == $0.length }) {
                            return .published(base.appendingPathComponent(name))
                        }
                    }
                }
                if sawCandidate { throw Failure.identityMismatch }
            }
            return .partialMissing
        }
        func refreshMetadataIdentity() throws {
            var metadata = stat()
            guard fstatat(work, manifestName, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_mode & S_IFMT == S_IFREG else { throw Failure.identityMismatch }
            metadataIdentity = Identity(metadata)
        }
        func removeMetadata(io: IO) throws {
            try verifyDirectories()
            var metadata = stat()
            guard fstatat(work, manifestName, &metadata, AT_SYMLINK_NOFOLLOW) == 0,
                  metadata.st_mode & S_IFMT == S_IFREG, Identity(metadata) == metadataIdentity else { throw Failure.identityMismatch }
            guard unlinkat(work, manifestName, 0) == 0 else { throw posixError() }
            try io.sync(work)
        }
    }

    /// Committed prefixes only. Use writtenPrefix for current live progress.
    func snapshot() -> [Range] { locked { manifest.ranges } }
    func writtenPrefix(segmentID: Int16) -> Int64? { locked { written[segmentID] } }
    @discardableResult func write(segmentID: Int16, data: Data) throws -> Int {
        try locked {
            guard !requiresRecovery else { throw Failure.identityMismatch }
            guard !published, !manifest.publishing else { throw Failure.published }
            guard let range = manifest.ranges.first(where: { $0.id == segmentID }), let prefix = written[segmentID],
                  Int64(data.count) <= range.length - prefix else { throw Failure.invalidWrite }
            try verifyPaths()
            return try data.withUnsafeBytes { bytes in
                var done = 0
                while done < bytes.count {
                    let count = io.write(descriptor, bytes.baseAddress!.advanced(by: done), bytes.count - done, range.start + prefix + Int64(done))
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0, count <= bytes.count - done else { throw Self.posixError() }
                    done += count
                    written[segmentID] = prefix + Int64(done)
                }
                return done
            }
        }
    }
    func checkpoint() throws { try locked { try checkpointLocked() } }
    private func checkpointLocked() throws {
        guard !requiresRecovery else { throw Failure.identityMismatch }
        guard !published else { return }
        try verifyPaths()
        try io.sync(descriptor)
        var next = manifest
        next.ranges = manifest.ranges.map { range in var result = range; result.durablePrefix = written[range.id]!; return result }
        try commit(next); manifest = next
    }
    /// Call only while affected leases are locked/drained. Prefixes may retain or
    /// discard written coverage, but cannot promote unwritten bytes to durable.
    func replacePlan(_ ranges: [Range]) throws {
        try locked { try replacePlanLocked(ranges) }
    }
    private func replacePlanLocked(_ ranges: [Range]) throws {
            guard !requiresRecovery else { throw Failure.identityMismatch }
            guard !published, !manifest.publishing else { throw Failure.published }
            try Self.validate(ranges, total: manifest.totalBytes)
            for range in ranges where range.durablePrefix > 0 {
                var position = range.start
                let end = range.start + range.durablePrefix
                for old in manifest.ranges.sorted(by: { $0.start < $1.start }) {
                    let ownedEnd = old.start + written[old.id]!
                    if old.start <= position && ownedEnd > position { position = min(end, ownedEnd) }
                    if position == end { break }
                }
                guard position == end else { throw Failure.invalidWrite }
            }
            try verifyPaths(); try io.sync(descriptor)
            var next = manifest; next.ranges = ranges
            try commit(next)
            manifest = next; written = Dictionary(uniqueKeysWithValues: ranges.map { ($0.id, $0.durablePrefix) })
    }
    @discardableResult func publish() throws -> URL {
        try locked {
            let destination = URL(fileURLWithPath: manifest.parentPath).appendingPathComponent(manifest.destinationName)
            if published {
                try verifyPaths(published: true)
                try io.sync(parentDescriptor)
                return destination
            }
            try checkpointLocked()
            guard manifest.ranges.allSatisfy({ $0.durablePrefix == $0.length }) else { throw Failure.incomplete }
            var next = manifest; next.publishing = true
            try commit(next); manifest = next
            try verifyPaths()
            guard renameatx_np(parentDescriptor, manifest.partialName, parentDescriptor, manifest.destinationName, UInt32(RENAME_EXCL)) == 0 else { throw Self.posixError() }
            published = true
            // Keep the publishing receipt: recovery verifies destination inode,
            // including a crash before the task database records completion.
            try io.afterRename()
            try io.sync(parentDescriptor)
            return destination
        }
    }
    private func verifyPaths(published: Bool = false) throws {
        try verifyWorkPath()
        let current = try Self.directory(manifest.parentPath)
        defer { Darwin.close(current) }
        guard Identity(try Self.info(current)) == manifest.parent else { throw Failure.identityMismatch }
        var file = stat()
        guard fstatat(parentDescriptor, published ? manifest.destinationName : manifest.partialName, &file, AT_SYMLINK_NOFOLLOW) == 0 else { throw Self.posixError() }
        guard file.st_mode & S_IFMT == S_IFREG, Identity(file) == manifest.file else { throw Failure.identityMismatch }
    }
    private func commit(_ state: Manifest) throws {
        do { try persist(state) }
        catch {
            // A failed directory sync may follow a successful metadata rename.
            // Stop all further mutation until recovery reconciles durable state.
            requiresRecovery = true
            throw error
        }
    }
    private func verifyWorkPath() throws {
        let current = try Self.directory(workPath)
        defer { Darwin.close(current) }
        guard Identity(try Self.info(current)) == workIdentity else { throw Failure.identityMismatch }
    }
    private func persist(_ state: Manifest, exclusive: Bool = false) throws {
        try verifyWorkPath()
        try Self.persistMetadata(state, workDescriptor: workDescriptor, io: io, exclusive: exclusive)
    }
    private static func persistMetadata(_ state: Manifest, workDescriptor: Int32, io: IO, exclusive: Bool = false, expectedIdentity: Identity? = nil) throws {
        try io.beforeManifestCommit()
        if let expectedIdentity {
            var current = stat()
            guard fstatat(workDescriptor, manifestName, &current, AT_SYMLINK_NOFOLLOW) == 0,
                  current.st_mode & S_IFMT == S_IFREG, Identity(current) == expectedIdentity else { throw Failure.identityMismatch }
        }
        let name = ".offset-manifest-\(UUID().uuidString).next"
        let fd = openat(workDescriptor, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Self.posixError() }
        defer { Darwin.close(fd); _ = unlinkat(workDescriptor, name, 0) }
        let bytes = try JSONEncoder().encode(state)
        try bytes.withUnsafeBytes { buffer in
            var done = 0
            while done < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: done), buffer.count - done)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw Self.posixError() }; done += count
            }
        }
        try io.sync(fd)
        let renamed = exclusive
            ? renameatx_np(workDescriptor, name, workDescriptor, Self.manifestName, UInt32(RENAME_EXCL))
            : renameat(workDescriptor, name, workDescriptor, Self.manifestName)
        guard renamed == 0 else { throw Self.posixError() }
        try io.sync(workDescriptor)
    }
}
