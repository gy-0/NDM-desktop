import Foundation
import Darwin
import CryptoKit
import NDMCore

/// A stopped helper supplies bytes only. A durable identity receipt binds the
/// hidden candidate and the exclusive final rename to this task generation.
enum AuxiliaryPublication {
    private struct Identity: Codable, Equatable {
        let device: Int64
        let inode: UInt64
        let birth: Int64
        let birthNS: Int64
        let directory: Bool
        init(_ info: stat) throws {
            let type = info.st_mode & S_IFMT
            guard type == S_IFREG || type == S_IFDIR else { throw AuxiliaryProductError.storage }
            device = Int64(info.st_dev); inode = UInt64(info.st_ino)
            birth = Int64(info.st_birthtimespec.tv_sec); birthNS = Int64(info.st_birthtimespec.tv_nsec)
            directory = type == S_IFDIR
        }
        static func read(_ path: URL) throws -> Self {
            var info = stat(); guard lstat(path.path, &info) == 0 else { throw POSIXError(.ENOENT) }
            return try Self(info)
        }
    }
    private struct Receipt: Codable {
        let version: Int
        let taskID: Int64
        let generation: Int64
        let manifestHash: String
        let parent: String
        let parentIdentity: Identity
        let stagingName: String
        var finalName: String
        let identity: Identity
        let files: [AuxiliaryTaskFile]
    }
    private static func location(_ work: URL) -> URL { work.appendingPathComponent("auxiliary-publication.json") }
    private static func hash(_ files: [AuxiliaryTaskFile]) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(files)).map { String(format: "%02x", $0) }.joined()
    }
    private static func write(_ receipt: Receipt, work: URL) throws {
        try JSONEncoder().encode(receipt).write(to: location(work), options: .atomic)
        let handle = try FileHandle(forWritingTo: location(work)); try handle.synchronize(); try handle.close()
        let fd = open(work.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw AuxiliaryProductError.storage }; defer { close(fd) }
        guard fsync(fd) == 0 else { throw AuxiliaryProductError.storage }
    }
    private static func read(taskID: Int64, generation: Int64, work: URL) throws -> Receipt? {
        let path = location(work)
        let fd = open(path.path, O_RDONLY | O_NOFOLLOW)
        if fd < 0 { if errno == ENOENT { return nil }; throw AuxiliaryProductError.storage }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 16 * 1024 * 1024,
              let data = try handle.readToEnd(), let receipt = try? JSONDecoder().decode(Receipt.self, from: data),
              receipt.version == 1, receipt.taskID == taskID, receipt.generation == generation,
              receipt.parent.hasPrefix("/"), receipt.stagingName.hasPrefix(".ndm-aux-\(taskID)-"), receipt.stagingName.hasSuffix(".partial"),
              !receipt.stagingName.contains("/"), !receipt.finalName.contains("/"), !receipt.finalName.isEmpty,
              receipt.finalName != ".", receipt.finalName != ".." else { throw AuxiliaryProductError.storage }
        guard try Identity.read(URL(fileURLWithPath: receipt.parent)) == receipt.parentIdentity else { throw AuxiliaryProductError.storage }
        return receipt
    }
    static func publishedURL(taskID: Int64, generation: Int64, workDirectory: URL) throws -> URL? {
        guard let receipt = try read(taskID: taskID, generation: generation, work: workDirectory) else { return nil }
        let final = URL(fileURLWithPath: receipt.parent).appendingPathComponent(receipt.finalName)
        guard FileManager.default.fileExists(atPath: final.path) else { return nil }
        guard try Identity.read(final) == receipt.identity else { throw AuxiliaryProductError.storage }
        return final
    }
    static func cleanStaging(taskID: Int64, generation: Int64, workDirectory: URL) throws {
        guard let receipt = try read(taskID: taskID, generation: generation, work: workDirectory) else { return }
        let staging = URL(fileURLWithPath: receipt.parent).appendingPathComponent(receipt.stagingName)
        guard FileManager.default.fileExists(atPath: staging.path) else { return }
        guard try Identity.read(staging) == receipt.identity else { throw AuxiliaryProductError.storage }
        try FileManager.default.removeItem(at: staging)
    }
    static func publish(taskID: Int64, generation: Int64, filesDirectory: URL, files: [AuxiliaryTaskFile],
                        destination: URL, preferredName: String, workDirectory: URL, token: CancelToken, expectedED2KHash: String? = nil) throws -> URL {
        let selected = files.filter(\.selected)
        guard !selected.isEmpty, selected.allSatisfy({ $0.completedLength == $0.length }) else { throw AuxiliaryProductError.storage }
        if let expectedED2KHash {
            guard selected.count == 1, expectedED2KHash.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else { throw AuxiliaryProductError.storage }
        }
        let originalHash = try hash(selected)
        let manifestHash = expectedED2KHash.map { SHA256.hash(data: Data("\(originalHash):\($0)".utf8)).map { String(format: "%02x", $0) }.joined() } ?? originalHash
        if let receipt = try read(taskID: taskID, generation: generation, work: workDirectory) {
            guard receipt.manifestHash == manifestHash else { throw AuxiliaryProductError.storage }
            if let published = try publishedURL(taskID: taskID, generation: generation, workDirectory: workDirectory) { return published }
            try cleanStaging(taskID: taskID, generation: generation, workDirectory: workDirectory)
        }
        try check(token)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let parent = destination.resolvingSymlinksInPath()
        let directory = selected.count > 1
        let name = DownloadFilename.sanitize(directory ? preferredName : (selected[0].relativePath as NSString).lastPathComponent)
        let final = DownloadFilename.uniqueURL(parent.appendingPathComponent(name.isEmpty ? "下载文件" : name, isDirectory: directory))
        let staging = parent.appendingPathComponent(".ndm-aux-\(taskID)-\(UUID().uuidString).partial", isDirectory: directory)
        if directory { try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        else {
            let fd = open(staging.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard fd >= 0 else { throw AuxiliaryProductError.storage }; close(fd)
        }
        var receipt = Receipt(version: 1, taskID: taskID, generation: generation, manifestHash: manifestHash,
            parent: parent.path, parentIdentity: try Identity.read(parent), stagingName: staging.lastPathComponent,
            finalName: final.lastPathComponent, identity: try Identity.read(staging), files: selected)
        // Registration precedes the first payload copy. Keep this receipt on all
        // failures, including cancellation and a lost database completion ACK.
        try write(receipt, work: workDirectory)
        for file in selected {
            let relative = try AuxiliaryTransfer.validateRelativePath(file.relativePath, filesDirectory: filesDirectory, allowMissing: false)
            let target = directory ? staging.appendingPathComponent(relative) : staging
            if directory { try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true) }
            try copy(relative: relative, from: filesDirectory, to: target, length: file.length, existingEmpty: !directory, token: token, expectedED2KHash: expectedED2KHash)
        }
        try check(token)
        var candidate = final
        for _ in 0..<100 {
            receipt.finalName = candidate.lastPathComponent
            try write(receipt, work: workDirectory)
            guard try Identity.read(staging) == receipt.identity else { throw AuxiliaryProductError.storage }
            if renamex_np(staging.path, candidate.path, UInt32(RENAME_EXCL)) == 0 {
                let fd = open(parent.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
                guard fd >= 0 else { throw AuxiliaryProductError.storage }; defer { close(fd) }
                guard fsync(fd) == 0 else { throw AuxiliaryProductError.storage }
                return candidate
            }
            guard errno == EEXIST else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            candidate = DownloadFilename.uniqueURL(final)
        }
        throw AuxiliaryProductError.storage
    }
    private static func check(_ token: CancelToken) throws {
        if token.isPaused { throw EngineError.paused }
        if token.isCancelled { throw EngineError.cancelled }
    }
    private static func copy(relative: String, from root: URL, to target: URL, length: Int64, existingEmpty: Bool, token: CancelToken, expectedED2KHash: String?) throws {
        var directory = open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directory >= 0 else { throw AuxiliaryProductError.storage }
        defer { close(directory) }
        let parts = relative.split(separator: "/").map(String.init)
        for part in parts.dropLast() {
            let next = openat(directory, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard next >= 0 else { throw AuxiliaryProductError.storage }
            close(directory); directory = next
        }
        let inputFD = openat(directory, parts.last!, O_RDONLY | O_NOFOLLOW)
        guard inputFD >= 0 else { throw AuxiliaryProductError.storage }
        let input = FileHandle(fileDescriptor: inputFD, closeOnDealloc: true); defer { try? input.close() }
        var before = stat(); guard fstat(inputFD, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size == length else { throw AuxiliaryProductError.storage }
        let outputFD = open(target.path, O_WRONLY | O_NOFOLLOW | (existingEmpty ? 0 : O_CREAT | O_EXCL), 0o600)
        guard outputFD >= 0 else { throw AuxiliaryProductError.storage }
        let output = FileHandle(fileDescriptor: outputFD, closeOnDealloc: true); defer { try? output.close() }
        var outputInfo = stat(); guard fstat(outputFD, &outputInfo) == 0, outputInfo.st_mode & S_IFMT == S_IFREG, outputInfo.st_size == 0 else { throw AuxiliaryProductError.storage }
        var copied: Int64 = 0
        var checksum: AuxiliaryED2KChecksum? = expectedED2KHash == nil ? nil : .init()
        while copied < length {
            try check(token)
            guard let data = try input.read(upToCount: Int(min(1024 * 1024, length - copied))), !data.isEmpty else { throw AuxiliaryProductError.storage }
            checksum?.update(data)
            try output.write(contentsOf: data); copied += Int64(data.count)
        }
        var after = stat()
        guard fstat(inputFD, &after) == 0, after.st_size == before.st_size,
              after.st_mtimespec.tv_sec == before.st_mtimespec.tv_sec, after.st_mtimespec.tv_nsec == before.st_mtimespec.tv_nsec,
              (try input.read(upToCount: 1) ?? Data()).isEmpty else { throw AuxiliaryProductError.storage }
        if let expectedED2KHash { guard checksum?.finish() == expectedED2KHash else { throw AuxiliaryProductError.storage } }
        try output.synchronize()
    }
}
