import Foundation
import Darwin

/// Durable ownership receipt for the one output candidate a task may assemble.
/// File names alone never establish ownership of a leftover download.
struct MergeStagingReceipt: Codable, Equatable {
    let version: Int
    let taskID: Int64
    let path: String
    let device: Int64
    let parentInode: UInt64
    let inode: UInt64
    let birthSeconds: Int64
    let birthNanoseconds: Int64

    static func location(in workDirectory: URL) -> URL {
        workDirectory.appendingPathComponent("merge-staging.json")
    }

    static func register(taskID: Int64, staging: URL, descriptor: Int32, in workDirectory: URL) throws -> Self {
        var info = stat()
        guard fstat(descriptor, &info) == 0 else { throw posixError() }
        guard info.st_mode & S_IFMT == S_IFREG else { throw CocoaError(.fileWriteInvalidFileName) }
        let canonical = staging.resolvingSymlinksInPath()
        var parent = stat()
        guard lstat(canonical.deletingLastPathComponent().path, &parent) == 0,
              parent.st_mode & S_IFMT == S_IFDIR else { throw posixError() }
        let receipt = Self(version: 1, taskID: taskID,
                           path: canonical.path,
                           device: Int64(info.st_dev), parentInode: UInt64(parent.st_ino), inode: UInt64(info.st_ino),
                           birthSeconds: Int64(info.st_birthtimespec.tv_sec),
                           birthNanoseconds: Int64(info.st_birthtimespec.tv_nsec))
        guard try receipt.matchesCurrentFile() else { throw CocoaError(.fileWriteFileExists) }
        do {
            try JSONEncoder().encode(receipt).write(to: location(in: workDirectory), options: .atomic)
        } catch {
            // Only the empty file proven to be ours can be reclaimed here.
            // Registration happens before truncate or the first payload write.
            try? receipt.removeOwnedFile()
            throw error
        }
        return receipt
    }

    /// Called before the next run's storage budget/probe. A receipt from a prior
    /// process is sufficient; no in-memory writer object or directory scan is used.
    static func recover(taskID: Int64, in workDirectory: URL) throws {
        let file = location(in: workDirectory)
        let descriptor = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW)
        if descriptor < 0 {
            if errno == ENOENT { return }
            throw posixError()
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        let data = try handle.readToEnd() ?? Data()
        let receipt = try JSONDecoder().decode(Self.self, from: data)
        guard receipt.version == 1, receipt.taskID == taskID,
              receipt.path.hasPrefix("/"),
              URL(fileURLWithPath: receipt.path).lastPathComponent.hasPrefix(".ndm-merge-\(taskID)-"),
              receipt.path.hasSuffix(".partial") else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try receipt.removeOwnedFile()
        // Missing/replaced files are never chased or deleted. Discard only the
        // now-obsolete receipt in this task's private support directory.
        guard Darwin.unlink(file.path) == 0 || errno == ENOENT else { throw posixError() }
    }

    func finish(in workDirectory: URL) throws {
        // After successful rename the old staging path is absent, so this clears
        // only the receipt. It never names or unlinks the published destination.
        try Self.recover(taskID: taskID, in: workDirectory)
    }

    private func matchesCurrentFile() throws -> Bool {
        // ENOENT on an unmounted/moved destination is not evidence that our
        // candidate was removed. Keep the only receipt until its parent returns.
        var parent = stat()
        guard lstat(URL(fileURLWithPath: path).deletingLastPathComponent().path, &parent) == 0,
              parent.st_mode & S_IFMT == S_IFDIR,
              Int64(parent.st_dev) == device, UInt64(parent.st_ino) == parentInode else {
            throw POSIXError(.ENODEV)
        }
        var info = stat()
        guard lstat(path, &info) == 0 else {
            if errno == ENOENT { return false }
            throw Self.posixError()
        }
        return info.st_mode & S_IFMT == S_IFREG
            && Int64(info.st_dev) == device && UInt64(info.st_ino) == inode
            && Int64(info.st_birthtimespec.tv_sec) == birthSeconds
            && Int64(info.st_birthtimespec.tv_nsec) == birthNanoseconds
    }

    private func removeOwnedFile() throws {
        guard try matchesCurrentFile() else { return }
        guard Darwin.unlink(path) == 0 || errno == ENOENT else { throw Self.posixError() }
    }

    private static func posixError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
