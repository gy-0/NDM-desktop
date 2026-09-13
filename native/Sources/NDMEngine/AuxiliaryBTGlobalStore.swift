import Foundation
import Darwin

struct AuxiliaryBTGlobalRecord: Codable {
    var version = 1
    var revision: Int64 = 0
    var encryption: AuxiliaryBTEncryption = .preferred
    var pending = false
}
struct AuxiliaryBTGlobalStore {
    let directory: URL
    private var file: URL { directory.appendingPathComponent("ndm-bt-global.json") }
    func read() throws -> AuxiliaryBTGlobalRecord {
        let fd = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        if fd < 0 { if errno == ENOENT { return .init() }; throw AuxiliaryBTError.storage }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true); defer { try? handle.close() }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= 4096,
              let bytes = try handle.readToEnd(), let record = try? JSONDecoder().decode(AuxiliaryBTGlobalRecord.self, from: bytes),
              record.version == 1, (0...AuxiliaryBTValidation.safeInteger).contains(record.revision) else { throw AuxiliaryBTError.storage }
        return record
    }
    func write(_ record: AuxiliaryBTGlobalRecord) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = directory.appendingPathComponent(".ndm-bt-global-\(UUID()).tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw AuxiliaryBTError.storage }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: JSONEncoder().encode(record)); try handle.synchronize(); try handle.close()
        guard rename(temporary.path, file.path) == 0 else { throw AuxiliaryBTError.storage }
        let parent = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parent >= 0 else { throw AuxiliaryBTError.storage }; defer { close(parent) }
        guard fsync(parent) == 0 else { throw AuxiliaryBTError.storage }
    }
}
