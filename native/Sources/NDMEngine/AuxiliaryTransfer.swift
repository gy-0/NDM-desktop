import Foundation
import CryptoKit
import Darwin
import NDMCore

public enum AuxiliarySource: Codable, Sendable, Equatable {
    case magnet(String)
    case torrent(Data)
    case sftp(url: String, hostKeySHA256: String)
    case ed2k(url: String, serverList: String?, nodeList: String?)
    /// Exposed only for isolated adapter fixtures; production routes HTTP natively.
    case loopbackHTTPFixture(String)
    public var kind: String {
        switch self { case .magnet, .torrent: return "bittorrent"; case .sftp: return "sftp"; case .ed2k: return "ed2k"; case .loopbackHTTPFixture: return "fixture" }
    }
}

public struct AuxiliaryCredentials: Sendable {
    public let username: String
    public let password: String?
    public let privateKeyURL: URL?
    public init(username: String, password: String? = nil, privateKeyURL: URL? = nil) {
        self.username = username; self.password = password; self.privateKeyURL = privateKeyURL
    }
}

public enum AuxiliaryPhase: String, Codable, Sendable {
    case metadata, awaitingSelection, checking, downloading, paused, seeding, complete, error, removed
}
public struct AuxiliaryArtifact: Codable, Sendable, Equatable {
    public let index: Int
    public let relativePath: String
    public let length: Int64
    public let completedLength: Int64
    public let selected: Bool
}
public struct AuxiliarySnapshot: Sendable, Equatable {
    public let taskID: Int64
    public let generation: Int64
    public let gid: String
    public let engineStatus: String
    public let phase: AuxiliaryPhase
    public let totalBytes: Int64
    public let completedBytes: Int64
    public let downloadSpeed: Int64
    public let uploadSpeed: Int64
    public let payloadCompleted: Bool
    public let files: [AuxiliaryArtifact]
    public let errorCode: String?
}

public enum AuxiliaryTransferError: Error, LocalizedError, Sendable {
    case invalidSource, hostPinRequired, credentialsRequired, bindingMismatch, invalidJournal, unsafeArtifact, emptySelection, invalidSelection, removed, unownedFiles
    public var errorDescription: String? {
        switch self {
        case .invalidSource: return "辅助下载来源无效或缺少协议参数。"
        case .hostPinRequired: return "SFTP 必须提供服务器公钥的 SHA-256 指纹。"
        case .credentialsRequired: return "请提供 SFTP 用户名和密码或私钥，再继续原任务。"
        case .bindingMismatch: return "辅助任务的来源、代次或目录与原记录不一致。"
        case .invalidJournal: return "辅助任务恢复记录无法验证，已保留现有文件。"
        case .unsafeArtifact: return "辅助引擎返回了越界路径或不安全的文件，已停止交付。"
        case .emptySelection: return "至少选择一个文件；空选择不会被当成全部文件。"
        case .invalidSelection: return "所选文件不在已确认的元数据清单中。"
        case .removed: return "辅助任务已移除；不会自动重新创建。"
        case .unownedFiles: return "辅助任务目录已有未登记文件，请保留它们并选择新的任务目录。"
        }
    }
}

private struct AuxiliaryJournal: Codable {
    var version = 1
    let taskID: Int64
    let generation: Int64
    let gid: String
    let sourceHash: String
    var selectedFiles: [Int]?
    var bandwidthLimit: Int64 = 0
    var requestedRunning = false
    var removed = false
    var files: [AuxiliaryArtifact] = []
    var btConfig: AuxiliaryBTConfig?
}

private final class AuxiliaryJournalStore: @unchecked Sendable {
    private static let lock = NSLock()
    let file: URL
    let taskID: Int64
    let generation: Int64
    let sourceHash: String
    init(file: URL, taskID: Int64, generation: Int64, sourceHash: String) {
        self.file = file; self.taskID = taskID; self.generation = generation; self.sourceHash = sourceHash
    }
    func loadOrCreate(filesDirectory: URL) throws -> AuxiliaryJournal {
        Self.lock.lock(); defer { Self.lock.unlock() }
        if FileManager.default.fileExists(atPath: file.path) { return try readUnlocked() }
        let existing = try FileManager.default.contentsOfDirectory(atPath: filesDirectory.path)
        guard existing.isEmpty else { throw AuxiliaryTransferError.unownedFiles }
        let gid = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16).lowercased()
        let record = AuxiliaryJournal(taskID: taskID, generation: generation, gid: gid, sourceHash: sourceHash)
        try writeUnlocked(record)
        return record
    }
    func read() throws -> AuxiliaryJournal { Self.lock.lock(); defer { Self.lock.unlock() }; return try readUnlocked() }
    func update(_ body: (inout AuxiliaryJournal) throws -> Void) throws -> AuxiliaryJournal {
        Self.lock.lock(); defer { Self.lock.unlock() }
        var record = try readUnlocked(); try body(&record); try writeUnlocked(record); return record
    }
    private func readUnlocked() throws -> AuxiliaryJournal {
        guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true, (values.fileSize ?? .max) <= 4 * 1024 * 1024,
              let record = try? JSONDecoder().decode(AuxiliaryJournal.self, from: Data(contentsOf: file)), record.version == 1,
              record.gid.range(of: "^[a-f0-9]{16}$", options: .regularExpression) != nil,
              record.bandwidthLimit >= 0 else { throw AuxiliaryTransferError.invalidJournal }
        guard record.taskID == taskID, record.generation == generation, record.sourceHash == sourceHash else { throw AuxiliaryTransferError.bindingMismatch }
        return record
    }
    private func writeUnlocked(_ record: AuxiliaryJournal) throws {
        let directory = file.deletingLastPathComponent()
        let temporary = directory.appendingPathComponent(".auxiliary-\(UUID()).tmp")
        let data = try JSONEncoder().encode(record)
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw AuxiliaryTransferError.invalidJournal }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temporary) }
        try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
        guard rename(temporary.path, file.path) == 0 else { throw AuxiliaryTransferError.invalidJournal }
        let parent = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY)
        guard parent >= 0 else { throw AuxiliaryTransferError.invalidJournal }
        defer { close(parent) }
        guard fsync(parent) == 0 else { throw AuxiliaryTransferError.invalidJournal }
    }
}

public actor AuxiliaryTransfer {
    public let taskID: Int64
    public let generation: Int64
    public let filesDirectory: URL
    private let source: AuxiliarySource
    private let daemon: AuxiliaryDaemon
    private let credentials: AuxiliaryCredentials?
    private let proxyPlan: AuxiliaryProxyPlan
    private let filename: String?
    private let journal: AuxiliaryJournalStore
    private var initialBTConfig: AuxiliaryBTConfig?
    private var operationTail: Task<Void, Never>?

    public init(taskID: Int64, generation: Int64, source: AuxiliarySource, workDirectory: URL,
                daemon: AuxiliaryDaemon, credentials: AuxiliaryCredentials? = nil, filename: String? = nil, btConfig: AuxiliaryBTConfig? = nil, proxyPlan: AuxiliaryProxyPlan = .direct) throws {
        guard taskID > 0, generation >= 0 else { throw AuxiliaryTransferError.invalidSource }
        if let filename { _ = try Self.validateRelativePath(filename, filesDirectory: workDirectory, allowMissing: true); guard !filename.contains("/") else { throw AuxiliaryTransferError.unsafeArtifact } }
        let normalized = try Self.validateSource(source)
        try proxyPlan.validate(kind: source.kind)
        self.proxyPlan = proxyPlan
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let files = workDirectory.appendingPathComponent("auxiliary-files", isDirectory: true)
        if FileManager.default.fileExists(atPath: files.path) {
            let values = try files.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw AuxiliaryTransferError.unsafeArtifact }
        } else { try FileManager.default.createDirectory(at: files, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        struct Intent: Encodable { let source: AuxiliarySource; let filename: String?; let directory: String }
        let intent = try encoder.encode(Intent(source: normalized, filename: filename, directory: files.standardizedFileURL.resolvingSymlinksInPath().path))
        let hash = SHA256.hash(data: intent).map { String(format: "%02x", $0) }.joined()
        self.taskID = taskID; self.generation = generation; self.source = normalized
        self.daemon = daemon; self.credentials = credentials; self.filename = filename; self.filesDirectory = files
        self.initialBTConfig = try btConfig.map(AuxiliaryBTValidation.config)
        self.journal = AuxiliaryJournalStore(file: workDirectory.appendingPathComponent("auxiliary-task.json"), taskID: taskID, generation: generation, sourceHash: hash)
    }

    private func serialized<T: Sendable>(_ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = operationTail
        let next = Task { await previous?.value; return try await body() }
        operationTail = Task { _ = try? await next.value }
        return try await next.value
    }
    public func prepare() async throws -> AuxiliarySnapshot { try await serialized { try await self.prepareUnlocked() } }
    /// Returns an admission/state ACK; completion is observed through snapshots.
    public func start() async throws -> AuxiliarySnapshot { try await serialized { try await self.startUnlocked() } }
    public func pause() async throws -> AuxiliarySnapshot {
        try await serialized {
            let prepared = try await self.prepareUnlocked()
            _ = try self.journal.update { $0.requestedRunning = false }
            if ![.complete, .removed, .error].contains(prepared.phase) {
                let rpc = try await self.daemon.rpcClient()
                _ = try await rpc.call("aria2.forcePause", parameters: [.string(prepared.gid)])
                try await self.waitForStoppedUnlocked(gid: prepared.gid, rpc: rpc, removing: false)
            }
            return try await self.snapshotUnlocked()
        }
    }
    /// Stops engine ownership; deletion/publication belongs to DownloadManager.
    public func cancel() async throws {
        try await serialized {
            let record = try self.journal.loadOrCreate(filesDirectory: self.filesDirectory)
            _ = try self.journal.update { $0.requestedRunning = false; $0.removed = true }
            let rpc = try await self.daemon.rpcClient()
            let existing: AuxiliaryJSON
            do { existing = try await rpc.call("aria2.tellStatus", parameters: [.string(record.gid)]) }
            catch let error as AuxiliaryRPCError where error.isTaskNotFound { return }
            let method = ["complete", "error", "removed"].contains(existing["status"]?.string ?? "") ? "aria2.removeDownloadResult" : "aria2.forceRemove"
            _ = try await rpc.call(method, parameters: [.string(record.gid)])
            try await self.waitForStoppedUnlocked(gid: record.gid, rpc: rpc, removing: true)
            // A removed result may remain queryable; no file is deleted.
        }
    }
    public func applyBandwidthLimit(_ bytesPerSecond: Int64) async throws {
        guard bytesPerSecond >= 0 else { throw AuxiliaryTransferError.invalidSource }
        try await serialized {
            let prepared = try await self.prepareUnlocked()
            _ = try self.journal.update { $0.bandwidthLimit = bytesPerSecond }
            if ["complete", "error", "removed"].contains(prepared.engineStatus) { return }
            let rpc = try await self.daemon.rpcClient()
            _ = try await rpc.call("aria2.changeOption", parameters: [.string(prepared.gid), .object(["max-download-limit": .string(String(bytesPerSecond))])])
        }
    }
    public func selectFiles(_ indices: [Int]) async throws -> AuxiliarySnapshot {
        guard !indices.isEmpty else { throw AuxiliaryTransferError.emptySelection }
        return try await serialized {
            let snapshot = try await self.prepareUnlocked()
            guard self.source.kind == "bittorrent", Set(indices).count == indices.count,
                  indices.allSatisfy({ index in snapshot.files.contains { $0.index == index } }) else { throw AuxiliaryTransferError.invalidSelection }
            let rpc = try await self.daemon.rpcClient()
            if snapshot.engineStatus == "active" || snapshot.engineStatus == "waiting" {
                _ = try await rpc.call("aria2.forcePause", parameters: [.string(snapshot.gid)])
                try await self.waitForStoppedUnlocked(gid: snapshot.gid, rpc: rpc, removing: false)
            }
            _ = try self.journal.update { $0.selectedFiles = indices.sorted(); $0.requestedRunning = false }
            _ = try await rpc.call("aria2.changeOption", parameters: [.string(snapshot.gid), .object(["select-file": .string(indices.sorted().map(String.init).joined(separator: ","))])])
            return try await self.snapshotUnlocked()
        }
    }
    public func currentSnapshot() async throws -> AuxiliarySnapshot { try await serialized { try await self.prepareUnlocked() } }
    /// Authentication is volatile. Drop only the helper's admission so a new
    /// transfer object can replay the same GID and partial bytes with new login
    /// values; this is not a user removal and must not tombstone the journal.
    public func releaseAdmissionForCredentialRefresh() async throws {
        guard source.kind == "sftp" else { throw AuxiliaryTransferError.invalidSource }
        try await serialized {
            let record = try self.journal.loadOrCreate(filesDirectory: self.filesDirectory)
            let rpc = try await self.daemon.rpcClient()
            let raw: AuxiliaryJSON
            do { raw = try await rpc.call("aria2.tellStatus", parameters: [.string(record.gid)]) }
            catch let error as AuxiliaryRPCError where error.isTaskNotFound { return }
            if !["complete", "error", "removed"].contains(raw["status"]?.string ?? "") {
                _ = try await rpc.call("aria2.forceRemove", parameters: [.string(record.gid)])
                try await self.waitForStoppedUnlocked(gid: record.gid, rpc: rpc, removing: true)
            }
            do { _ = try await rpc.call("aria2.tellStatus", parameters: [.string(record.gid)]) }
            catch let error as AuxiliaryRPCError where error.isTaskNotFound { return }
            _ = try await rpc.call("aria2.removeDownloadResult", parameters: [.string(record.gid)])
        }
    }
    private static func btOptions(_ config: AuxiliaryBTConfig) -> [String: AuxiliaryJSON] {
        var options: [String: AuxiliaryJSON] = ["seed-ratio": .string(String(config.seedRatio)),
            "max-upload-limit": .string(String(config.uploadLimit)), "enable-peer-exchange": .string(config.peerExchange ? "true" : "false")]
        if let minutes = config.seedMinutes { options["seed-time"] = .string(String(minutes)) }
        return options
    }
    private func requireBTControls() async throws {
        guard source.kind == "bittorrent" else { throw AuxiliaryBTError.unsupported }
        let methods = try await daemon.start().methods
        guard Set(["aria2.getBtTrackers", "aria2.replaceBtTrackers", "aria2.replaceBtWebSeeds", "aria2.getPeers", "aria2.addBtPeers"]).isSubset(of: methods) else { throw AuxiliaryBTError.unsupported }
    }
    private func readBTUnlocked(gid: String, rpc: AuxiliaryRPC) async throws -> AuxiliaryBTReadback {
        let options = try await rpc.call("aria2.getOption", parameters: [.string(gid)])
        let status = try await rpc.call("aria2.tellStatus", parameters: [.string(gid)])
        let trackers = try await rpc.call("aria2.getBtTrackers", parameters: [.string(gid)])
        let peers = try await rpc.call("aria2.getPeers", parameters: [.string(gid)])
        return try AuxiliaryBTValidation.readback(options: options, status: status, trackers: trackers, peers: peers)
    }
    public func btControls() async throws -> AuxiliaryBTReadback {
        try await serialized {
            try await self.requireBTControls()
            let snapshot = try await self.prepareUnlocked()
            let rpc = try await self.daemon.rpcClient()
            return try await self.readBTUnlocked(gid: snapshot.gid, rpc: rpc)
        }
    }
    /// Manager has already committed this desired configuration and revision.
    /// The operational journal allows a missing helper admission to reproduce
    /// its limits before payload is ever unpaused.
    public func applyBTConfiguration(_ value: AuxiliaryBTConfig) async throws -> AuxiliaryBTReadback {
        let config = try AuxiliaryBTValidation.config(value)
        return try await serialized {
            try await self.requireBTControls()
            var snapshot = try await self.prepareUnlocked()
            guard snapshot.engineStatus == "paused" else { throw AuxiliaryBTError.notPaused }
            let rpc = try await self.daemon.rpcClient()
            let before = try await self.readBTUnlocked(gid: snapshot.gid, rpc: rpc)
            _ = try self.journal.update { $0.btConfig = config }
            if AuxiliaryBTValidation.equivalent(before.config, config) { return before }
            if config.seedMinutes == nil && before.config.seedMinutes != nil {
                // Empty string means zero to this fork. Removing only the
                // admission clears the option while retaining GID, selected
                // indices, metadata source and all owned partial bytes.
                try await self.releaseAdmissionUnlocked(gid: snapshot.gid, rpc: rpc)
                snapshot = try await self.prepareUnlocked()
                guard snapshot.engineStatus == "paused" else { throw AuxiliaryBTError.notPaused }
            }
            let ack = try await rpc.call("aria2.changeOption", parameters: [.string(snapshot.gid), .object(Self.btOptions(config))])
            guard ack.string == "OK" else { throw AuxiliaryBTError.unconfirmed }
            let trackerACK = try await rpc.call("aria2.replaceBtTrackers", parameters: [.string(snapshot.gid), .array(config.trackers.map { .object(["url": .string($0.url), "tier": .number(Double($0.tier))]) })])
            guard trackerACK.string == snapshot.gid else { throw AuxiliaryBTError.unconfirmed }
            let current = try await self.readBTUnlocked(gid: snapshot.gid, rpc: rpc)
            if current.config.webSeeds.sorted() != config.webSeeds.sorted() {
                do {
                    let seedACK = try await rpc.call("aria2.replaceBtWebSeeds", parameters: [.string(snapshot.gid), .array(config.webSeeds.map(AuxiliaryJSON.string))])
                    guard seedACK.string == snapshot.gid else { throw AuxiliaryBTError.unconfirmed }
                } catch let error as AuxiliaryRPCError {
                    // A reserved task has no libtorrent handle yet. Its source
                    // metainfo/URI supplies the replacement list without an
                    // unpause or a single unauthorized payload byte.
                    guard case .remote = error else { throw error }
                    try await self.releaseAdmissionUnlocked(gid: snapshot.gid, rpc: rpc)
                    snapshot = try await self.prepareUnlocked()
                    let replayACK = try await rpc.call("aria2.replaceBtTrackers", parameters: [.string(snapshot.gid), .array(config.trackers.map { .object(["url": .string($0.url), "tier": .number(Double($0.tier))]) })])
                    guard replayACK.string == snapshot.gid else { throw AuxiliaryBTError.unconfirmed }
                }
            }
            for _ in 0..<60 {
                let actual = try await self.readBTUnlocked(gid: snapshot.gid, rpc: rpc)
                if AuxiliaryBTValidation.equivalent(actual.config, config) { return actual }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            throw AuxiliaryBTError.unconfirmed
        }
    }
    private func releaseAdmissionUnlocked(gid: String, rpc: AuxiliaryRPC) async throws {
        let raw: AuxiliaryJSON
        do { raw = try await rpc.call("aria2.tellStatus", parameters: [.string(gid)]) }
        catch let error as AuxiliaryRPCError where error.isTaskNotFound { return }
        guard ["paused", "error", "complete", "removed"].contains(raw["status"]?.string ?? "") else { throw AuxiliaryBTError.notPaused }
        if raw["status"]?.string == "paused" {
            _ = try await rpc.call("aria2.forceRemove", parameters: [.string(gid)])
            try await waitForStoppedUnlocked(gid: gid, rpc: rpc, removing: true)
        }
        do { _ = try await rpc.call("aria2.tellStatus", parameters: [.string(gid)]) }
        catch let error as AuxiliaryRPCError where error.isTaskNotFound { return }
        _ = try await rpc.call("aria2.removeDownloadResult", parameters: [.string(gid)])
    }
    public func addBTPeers(_ values: [String]) async throws -> AuxiliaryBTAddedPeers {
        let peers = try AuxiliaryBTValidation.peers(values)
        return try await serialized {
            try await self.requireBTControls()
            let snapshot = try await self.prepareUnlocked()
            guard snapshot.engineStatus == "paused" else { throw AuxiliaryBTError.notPaused }
            let rpc = try await self.daemon.rpcClient()
            let raw = try await rpc.call("aria2.addBtPeers", parameters: [.string(snapshot.gid), .array(peers.map(AuxiliaryJSON.string))])
            guard let added = raw["added"]?.integer, let failed = raw["failed"]?.integer, added >= 0, failed >= 0,
                  added + failed == Int64(peers.count) else { throw AuxiliaryBTError.unconfirmed }
            return AuxiliaryBTAddedPeers(added: added, failed: failed)
        }
    }

    /// Requires the prior verified manifest and its original journal. This
    /// method performs no RPC or admission; publication verifies the link's
    /// ED2K checksum over the actual bytes before exposing a final path.
    public func offlineED2KPublicationSnapshot(files: [AuxiliaryTaskFile]) throws -> AuxiliarySnapshot {
        guard case .ed2k(let uri, _, _) = source, files.count == 1, let file = files.first,
              file.selected, file.completedLength == file.length,
              Int64(uri.components(separatedBy: "|")[3]) == file.length else { throw AuxiliaryProductError.storage }
        let record = try journal.read()
        guard !record.removed, record.files.count == 1, let known = record.files.first,
              known.index == file.index, known.relativePath == file.relativePath, known.length == file.length, known.selected else { throw AuxiliaryProductError.storage }
        _ = try Self.validateRelativePath(file.relativePath, filesDirectory: filesDirectory, allowMissing: false)
        return AuxiliarySnapshot(taskID: taskID, generation: generation, gid: record.gid, engineStatus: "paused", phase: .paused,
            totalBytes: file.length, completedBytes: file.length, downloadSpeed: 0, uploadSpeed: 0, payloadCompleted: true,
            files: [.init(index: file.index, relativePath: file.relativePath, length: file.length, completedLength: file.length, selected: true)], errorCode: nil)
    }

    public func currentProgress() async throws -> DownloadProgress {
        let snapshot = try await currentSnapshot()
        let status: DownloadStatus
        switch snapshot.phase { case .complete: status = .complete; case .error: status = .error; case .paused, .awaitingSelection, .removed: status = .paused; default: status = .downloading }
        return DownloadProgress(taskID: taskID, totalBytes: snapshot.totalBytes, completedBytes: snapshot.completedBytes,
            bytesPerSecond: Double(snapshot.downloadSpeed), status: status,
            errorDescription: snapshot.errorCode.map { "辅助引擎下载失败（代码 \($0)）。" },
            phase: snapshot.phase == .metadata || snapshot.phase == .checking ? .preparing : .transferring,
            effectiveBandwidthLimitBytesPerSecond: (try? journal.read().bandwidthLimit) ?? 0)
    }

    private func prepareUnlocked() async throws -> AuxiliarySnapshot {
        var record = try journal.loadOrCreate(filesDirectory: filesDirectory)
        if let initialBTConfig, record.btConfig != initialBTConfig { record = try journal.update { $0.btConfig = initialBTConfig } }
        self.initialBTConfig = nil
        guard !record.removed else { throw AuxiliaryTransferError.removed }
        let capabilities = try await daemon.start()
        if source.kind == "bittorrent", !capabilities.supportsBitTorrent { throw AuxiliaryDaemonError.missingCapabilities }
        if source.kind == "sftp", !capabilities.supportsSFTP { throw AuxiliaryDaemonError.missingCapabilities }
        if source.kind == "ed2k", !capabilities.supportsED2K { throw AuxiliaryDaemonError.missingCapabilities }
        let rpc = try await daemon.rpcClient()
        do { return try await snapshotUnlocked(rpc: rpc) }
        catch let error as AuxiliaryRPCError where error.isTaskNotFound {
            let options = try options(record: record)
            let response: AuxiliaryJSON
            switch source {
            case .torrent(let data):
                let admission = try record.btConfig.map { try AuxiliaryBTMetainfo.replacingWebSeeds(data, with: $0.webSeeds) } ?? data
                response = try await rpc.call("aria2.addTorrent", parameters: [.string(admission.base64EncodedString()), .array([]), .object(options)])
            case .magnet(let uri):
                let admission = try record.btConfig.map { try AuxiliaryBTMetainfo.replacingMagnetWebSeeds(uri, with: $0.webSeeds) } ?? uri
                response = try await rpc.call("aria2.addUri", parameters: [.array([.string(admission)]), .object(options)])
            case .loopbackHTTPFixture(let uri), .sftp(let uri, _), .ed2k(let uri, _, _):
                response = try await rpc.call("aria2.addUri", parameters: [.array([.string(uri)]), .object(options)])
            }
            guard response.string == record.gid else { throw AuxiliaryRPCError.invalidResponse }
            // Fixed GID replay always re-admits paused. The native queue decides
            // whether a crashed transfer is authorized to run again.
            _ = try journal.update { $0.requestedRunning = false }
            return try await snapshotUnlocked(rpc: rpc)
        }
    }

    private func startUnlocked() async throws -> AuxiliarySnapshot {
        var snapshot = try await prepareUnlocked()
        // A crash/lost changeOption ACK can leave an approved selection only in
        // the journal. Reconcile it before allowing any payload to run.
        if snapshot.phase == .awaitingSelection, let selection = try journal.read().selectedFiles {
            guard !selection.isEmpty, selection.allSatisfy({ index in snapshot.files.contains { $0.index == index } }) else { throw AuxiliaryTransferError.invalidSelection }
            let rpc = try await daemon.rpcClient()
            _ = try await rpc.call("aria2.changeOption", parameters: [.string(snapshot.gid), .object(["select-file": .string(selection.map(String.init).joined(separator: ","))])])
            snapshot = try await snapshotUnlocked(rpc: rpc)
        }
        if [.complete, .seeding, .awaitingSelection].contains(snapshot.phase) { return snapshot }
        if snapshot.engineStatus == "active" || snapshot.engineStatus == "waiting" { return snapshot }
        if snapshot.phase == .error {
            let rpc = try await daemon.rpcClient()
            _ = try await rpc.call("aria2.removeDownloadResult", parameters: [.string(snapshot.gid)])
            snapshot = try await prepareUnlocked()
        }
        try await daemon.verifyProxyPlan(proxyPlan)
        let rpc = try await daemon.rpcClient()
        if source.kind == "bittorrent", proxyPlan.mode == .socks4 {
            try proxyPlan.validateBTEndpoints(try await readBTUnlocked(gid: snapshot.gid, rpc: rpc).config)
        }
        if source.kind == "sftp", proxyPlan.mode == .http {
            let options = try await rpc.call("aria2.getOption", parameters: [.string(snapshot.gid)])
            guard options["all-proxy"]?.string == proxyPlan.uri else { throw AuxiliaryProxyError.proxyUnavailable }
        }
        _ = try journal.update { $0.requestedRunning = true }
        _ = try await rpc.call("aria2.unpause", parameters: [.string(snapshot.gid)])
        return try await snapshotUnlocked(rpc: rpc)
    }

    private func waitForStoppedUnlocked(gid: String, rpc: AuxiliaryRPC, removing: Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        repeat {
            do {
                let raw = try await rpc.call("aria2.tellStatus", parameters: [.string(gid)])
                guard raw["gid"]?.string == gid, let status = raw["status"]?.string else { throw AuxiliaryRPCError.invalidResponse }
                if ["complete", "error", "removed"].contains(status) || !removing && status == "paused" { return }
                guard ["active", "waiting", "paused"].contains(status) else { throw AuxiliaryRPCError.invalidResponse }
            } catch let error as AuxiliaryRPCError where error.isTaskNotFound && removing { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        } while Date() < deadline
        throw AuxiliaryRPCError.timeout
    }

    private func options(record: AuxiliaryJournal) throws -> [String: AuxiliaryJSON] {
        var result: [String: AuxiliaryJSON] = ["gid": .string(record.gid), "dir": .string(filesDirectory.path), "pause": .string("true"),
            "continue": .string("true"), "auto-file-renaming": .string("false"), "allow-overwrite": .string("false"),
            "max-download-limit": .string(String(record.bandwidthLimit))]
        if let filename { result["out"] = .string(filename) }
        switch source {
        case .magnet, .torrent:
            result["pause-metadata"] = .string("true")
            result["bt-metadata-only"] = .string("false")
            if let config = record.btConfig {
                result.merge(Self.btOptions(config), uniquingKeysWith: { _, new in new })
            }
            if let selected = record.selectedFiles {
                guard !selected.isEmpty else { throw AuxiliaryTransferError.emptySelection }
                result["select-file"] = .string(selected.map(String.init).joined(separator: ","))
            }
        case .sftp(_, let pin):
            if proxyPlan.mode == .http { result["all-proxy"] = .string(proxyPlan.uri) }
            result["no-proxy"] = .string("")
            guard let credentials, !credentials.username.isEmpty, credentials.username.rangeOfCharacter(from: .controlCharacters) == nil,
                  (credentials.password != nil) != (credentials.privateKeyURL != nil) else { throw AuxiliaryTransferError.credentialsRequired }
            result["ssh-host-key-sha256"] = .string(pin)
            result["sftp-user"] = .string(credentials.username)
            if let password = credentials.password { result["sftp-passwd"] = .string(password) }
            if let key = credentials.privateKeyURL { guard key.isFileURL else { throw AuxiliaryTransferError.credentialsRequired }; result["private-key"] = .string(key.path) }
        case .ed2k(_, let servers, let nodes):
            if let servers { result["ed2k-server-list"] = .string(servers) }
            if let nodes { result["ed2k-node-list"] = .string(nodes) }
        case .loopbackHTTPFixture: result["max-tries"] = .string("1")
        }
        return result
    }

    private func snapshotUnlocked(rpc provided: AuxiliaryRPC? = nil) async throws -> AuxiliarySnapshot {
        let record = try journal.read()
        let rpc: AuxiliaryRPC
        if let provided { rpc = provided } else { rpc = try await daemon.rpcClient() }
        let raw = try await rpc.call("aria2.tellStatus", parameters: [.string(record.gid)])
        let actualSelection = raw["files"]?.array?.filter { $0["selected"]?.boolean == true }.compactMap { $0["index"]?.integer }.sorted()
        let selectionMatches = record.selectedFiles.map { $0.map(Int64.init).sorted() == actualSelection } ?? false
        let snapshot = try Self.decodeSnapshot(raw, taskID: taskID, generation: generation, expectedGID: record.gid,
            filesDirectory: filesDirectory, requiresSelection: source.kind == "bittorrent" && !selectionMatches)
        // Journal the manifest, not every progress tick. Byte counts are read
        // afresh from the helper and never trusted as proof of completion.
        func identity(_ files: [AuxiliaryArtifact]) -> [AuxiliaryArtifact] {
            files.map { AuxiliaryArtifact(index: $0.index, relativePath: $0.relativePath, length: $0.length, completedLength: 0, selected: $0.selected) }
        }
        let manifest = identity(snapshot.files)
        if identity(record.files) != manifest { _ = try journal.update { $0.files = manifest } }
        return snapshot
    }

    public static func decodeSnapshot(_ raw: AuxiliaryJSON, taskID: Int64, generation: Int64, expectedGID: String,
                                      filesDirectory: URL, requiresSelection: Bool) throws -> AuxiliarySnapshot {
        guard raw["gid"]?.string == expectedGID, let status = raw["status"]?.string,
              ["active", "waiting", "paused", "complete", "error", "removed"].contains(status),
              let total = raw["totalLength"]?.integer, total >= 0,
              let completed = raw["completedLength"]?.integer, completed >= 0,
              let speed = raw["downloadSpeed"]?.integer, speed >= 0 else { throw AuxiliaryRPCError.invalidResponse }
        if let following = raw["followedBy"]?.array, !following.isEmpty { throw AuxiliaryRPCError.invalidResponse }
        let btState = raw["bittorrent"]?["state"]?.string
        let metadata = btState == "downloadingMetadata" || btState == "adding" && raw["bittorrent"]?["info"] == nil
        var files: [AuxiliaryArtifact] = []
        guard let rawFiles = raw["files"]?.array, rawFiles.count <= 100_000 else { throw AuxiliaryRPCError.invalidResponse }
        for file in rawFiles {
            if metadata && (file["path"]?.string ?? "").isEmpty { continue }
            guard let index = file["index"]?.integer, index > 0, index <= Int64(Int.max),
                  let path = file["path"]?.string, let reportedLength = file["length"]?.integer, reportedLength >= 0,
                  let have = file["completedLength"]?.integer, have >= 0,
                  let selected = file["selected"]?.boolean else { throw AuxiliaryRPCError.invalidResponse }
            // The fork's curl snapshot learns totalLength before updating its
            // FileEntry length. It reports length=0 with positive progress.
            let singleNonBT = raw["bittorrent"] == nil && rawFiles.count == 1
            let length = singleNonBT && reportedLength == 0 && total > 0 ? total : reportedLength
            guard have <= length || singleNonBT && length == 0 && status != "complete" else { throw AuxiliaryRPCError.invalidResponse }
            let relative = try relativeArtifactPath(path, filesDirectory: filesDirectory)
            files.append(AuxiliaryArtifact(index: Int(index), relativePath: relative, length: length, completedLength: have, selected: selected))
        }
        guard Set(files.map(\.index)).count == files.count, Set(files.map(\.relativePath)).count == files.count else { throw AuxiliaryTransferError.unsafeArtifact }
        let awaiting = raw["bittorrent"]?["fileSelectionState"]?.string == "awaiting" || requiresSelection && !metadata && !files.isEmpty
        let phase: AuxiliaryPhase
        if status == "error" { phase = .error }
        else if status == "removed" { phase = .removed }
        else if awaiting { phase = .awaitingSelection }
        else if metadata { phase = .metadata }
        else if status == "complete" { phase = .complete }
        else if btState == "seeding" || raw["seeder"]?.boolean == true && status == "active" { phase = .seeding }
        else if status == "paused" { phase = .paused }
        else if ["checking", "recovering"].contains(btState ?? "") { phase = .checking }
        else { phase = .downloading }
        let selected = files.filter(\.selected)
        let pausedVerifiedShare = status == "paused" && (raw["bittorrent"] != nil || raw["ed2k"] != nil && raw["seeder"]?.boolean == true)
        let canHavePayload = status == "complete" || phase == .seeding || pausedVerifiedShare
        var payloadCompleted = canHavePayload && !metadata && !awaiting && !selected.isEmpty && selected.allSatisfy { $0.completedLength == $0.length }
        if payloadCompleted {
            for artifact in selected {
                let file = filesDirectory.appendingPathComponent(artifact.relativePath)
                guard let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
                      values.isRegularFile == true, values.isSymbolicLink != true, Int64(values.fileSize ?? -1) == artifact.length else { payloadCompleted = false; break }
            }
        }
        if phase == .complete && !payloadCompleted { throw AuxiliaryTransferError.unsafeArtifact }
        let code = raw["errorCode"]?.string.flatMap { $0.range(of: "^[0-9]{1,10}$", options: .regularExpression) != nil && $0 != "0" ? $0 : nil }
        return AuxiliarySnapshot(taskID: taskID, generation: generation, gid: expectedGID, engineStatus: status, phase: phase, totalBytes: total,
            completedBytes: completed, downloadSpeed: speed, uploadSpeed: max(0, raw["uploadSpeed"]?.integer ?? 0),
            payloadCompleted: payloadCompleted, files: files, errorCode: code)
    }

    public static func validateRelativePath(_ path: String, filesDirectory: URL, allowMissing: Bool = true) throws -> String {
        if FileManager.default.fileExists(atPath: filesDirectory.path) {
            let root = try filesDirectory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard root.isDirectory == true, root.isSymbolicLink != true else { throw AuxiliaryTransferError.unsafeArtifact }
        }
        guard !path.isEmpty, path.utf8.count <= 4096, !path.hasPrefix("/"), !path.contains("\\"), !path.contains(":"),
              path.rangeOfCharacter(from: .controlCharacters) == nil else { throw AuxiliaryTransferError.unsafeArtifact }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw AuxiliaryTransferError.unsafeArtifact }
        var candidate = filesDirectory
        for part in parts {
            candidate.appendPathComponent(String(part))
            if let values = try? candidate.resourceValues(forKeys: [.isSymbolicLinkKey]) {
                guard values.isSymbolicLink != true else { throw AuxiliaryTransferError.unsafeArtifact }
            } else if !allowMissing { throw AuxiliaryTransferError.unsafeArtifact }
        }
        return path
    }
    private static func relativeArtifactPath(_ path: String, filesDirectory: URL) throws -> String {
        let relative: String
        if path.hasPrefix("/") {
            let prefix = filesDirectory.path + "/"
            guard path.hasPrefix(prefix) else { throw AuxiliaryTransferError.unsafeArtifact }
            relative = String(path.dropFirst(prefix.count))
        } else { relative = path }
        return try validateRelativePath(relative, filesDirectory: filesDirectory)
    }
    public static func validateSource(_ source: AuxiliarySource) throws -> AuxiliarySource {
        func url(_ raw: String, scheme: String) throws -> URL {
            guard raw.hasPrefix(scheme + "://"), raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  !raw.contains("\\"), let value = URL(string: raw), value.host?.isEmpty == false,
                  value.user == nil, value.password == nil else { throw AuxiliaryTransferError.invalidSource }
            return value
        }
        switch source {
        case .sftp(let raw, let rawPin):
            _ = try url(raw, scheme: "sftp")
            let pin = rawPin.hasPrefix("SHA256:") ? String(rawPin.dropFirst(7)) : rawPin
            let padded = pin + String(repeating: "=", count: (4 - pin.count % 4) % 4)
            guard let bytes = Data(base64Encoded: padded), bytes.count == 32,
                  bytes.base64EncodedString().replacingOccurrences(of: "=", with: "") == pin.replacingOccurrences(of: "=", with: "") else { throw AuxiliaryTransferError.hostPinRequired }
            return .sftp(url: raw, hostKeySHA256: bytes.base64EncodedString())
        case .magnet(let raw):
            guard raw.count <= 65536, raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  let components = URLComponents(string: raw), components.scheme == "magnet", components.user == nil, components.password == nil,
                  components.queryItems?.contains(where: { $0.name == "xt" && $0.value?.range(of: "^urn:(btih:([a-fA-F0-9]{40}|[A-Z2-7a-z]{32})|btmh:1220[a-fA-F0-9]{64})$", options: .regularExpression) != nil }) == true else { throw AuxiliaryTransferError.invalidSource }
        case .torrent(let data): guard !data.isEmpty, data.count <= 8 * 1024 * 1024 else { throw AuxiliaryTransferError.invalidSource }
        case .ed2k(let raw, let serverList, let nodeList):
            let parts = raw.components(separatedBy: "|")
            guard raw.count <= 65536, raw.rangeOfCharacter(from: .controlCharacters) == nil,
                  (6...8).contains(parts.count), parts[0].lowercased() == "ed2k://", parts[1] == "file", parts.last == "/",
                  let size = Int64(parts[3]), size >= 0, size <= 9_007_199_254_740_991,
                  parts[4].range(of: "^[a-fA-F0-9]{32}$", options: .regularExpression) != nil,
                  let name = parts[2].removingPercentEncoding, !name.isEmpty, name != ".", name != "..",
                  !name.contains("/"), !name.contains("\\"), name.rangeOfCharacter(from: .controlCharacters) == nil else { throw AuxiliaryTransferError.invalidSource }
            if parts.count > 6 {
                guard parts.count != 8 || parts[5] == "/" else { throw AuxiliaryTransferError.invalidSource }
                let sourceList = parts[parts.count - 2]
                guard sourceList.hasPrefix("sources,") else { throw AuxiliaryTransferError.invalidSource }
                let peers = sourceList.dropFirst(8).split(separator: ",", omittingEmptySubsequences: false)
                guard (1...32).contains(peers.count) else { throw AuxiliaryTransferError.invalidSource }
                for peer in peers {
                    let pair = peer.split(separator: ":", omittingEmptySubsequences: false)
                    guard pair.count == 2, let port = Int(pair[1]), (1...65535).contains(port), pair[0].count <= 253,
                          pair[0].split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                              label.count <= 63 && label.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$", options: .regularExpression) != nil
                          }) else { throw AuxiliaryTransferError.invalidSource }
                }
            }
            for path in [serverList, nodeList].compactMap({ $0 }) {
                guard path.hasPrefix("/"), path.rangeOfCharacter(from: .controlCharacters) == nil else { throw AuxiliaryTransferError.invalidSource }
            }
        case .loopbackHTTPFixture(let raw):
            let value = try url(raw, scheme: "http")
            guard value.host == "127.0.0.1" || value.host == "::1" else { throw AuxiliaryTransferError.invalidSource }
        }
        return source
    }
}
