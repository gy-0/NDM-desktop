import Foundation
import CryptoKit
import NDMCore

public enum AuxiliaryProductError: Error, LocalizedError {
    case invalidSource, staleGeneration, notFound, selectionRequired, credentialsRequired, storage, notSeeding
    public var code: String {
        switch self {
        case .invalidSource: return "invalidSource"
        case .staleGeneration: return "staleGeneration"
        case .notFound: return "notFound"
        case .selectionRequired: return "selectionRequired"
        case .credentialsRequired: return "credentialsRequired"
        case .storage: return "storage"
        case .notSeeding: return "invalidSelection"
        }
    }
    public var errorDescription: String? {
        switch self {
        case .invalidSource: return "辅助任务参数无效。"
        case .staleGeneration: return "任务已更新，请重新读取后操作。"
        case .notFound: return "辅助任务不存在。"
        case .selectionRequired: return "请先选择至少一个文件。"
        case .credentialsRequired: return "请为原 SFTP 任务补充账号和密码。"
        case .storage: return "辅助任务文件未能安全交付，已保留恢复记录。"
        case .notSeeding: return "当前任务尚无可停止做种并交付的完整文件。"
        }
    }
}

public struct AuxiliaryProductRequest: Sendable {
    public let source: AuxiliarySource
    public let credentials: AuxiliaryCredentials?
    public let directory: URL?
    public let autoStart: Bool
    public init(request: [String: Any]) throws {
        guard let raw = request["source"] as? [String: Any], let kind = raw["kind"] as? String,
              let autoStart = request["autoStart"] as? Bool else { throw AuxiliaryProductError.invalidSource }
        let source: AuxiliarySource
        switch kind {
        case "magnet":
            guard let url = raw["url"] as? String, !autoStart else { throw AuxiliaryProductError.invalidSource }
            source = .magnet(url)
        case "torrent":
            guard let text = raw["torrentData"] as? String, text.utf8.count <= 12 * 1024 * 1024,
                  let data = Data(base64Encoded: text), !autoStart else { throw AuxiliaryProductError.invalidSource }
            source = .torrent(data)
        case "sftp":
            guard let url = raw["url"] as? String, let pin = raw["hostKeySHA256"] as? String,
                  let parsed = URL(string: url), parsed.query == nil, parsed.fragment == nil,
                  !parsed.path.isEmpty, parsed.path != "/" else { throw AuxiliaryProductError.invalidSource }
            source = .sftp(url: url, hostKeySHA256: pin)
        case "ed2k":
            guard let url = raw["url"] as? String else { throw AuxiliaryProductError.invalidSource }
            source = .ed2k(url: url, serverList: nil, nodeList: nil)
        default: throw AuxiliaryProductError.invalidSource
        }
        self.source = try AuxiliaryTransfer.validateSource(source)
        self.credentials = kind == "sftp" ? try Self.credentials(request["credentials"]) : nil
        if kind != "sftp", request["credentials"] != nil { throw AuxiliaryProductError.invalidSource }
        if let rawDirectory = request["folderPath"] {
            guard let path = rawDirectory as? String, path.hasPrefix("/"), path.rangeOfCharacter(from: .controlCharacters) == nil else { throw AuxiliaryProductError.invalidSource }
            self.directory = URL(fileURLWithPath: path, isDirectory: true)
        } else { self.directory = nil }
        self.autoStart = autoStart
    }
    public static func credentials(_ value: Any?) throws -> AuxiliaryCredentials {
        guard let raw = value as? [String: Any], Set(raw.keys).isSubset(of: ["username", "password"]),
              let username = raw["username"] as? String, !username.trimmingCharacters(in: .whitespaces).isEmpty,
              username.count <= 256, username.rangeOfCharacter(from: .controlCharacters) == nil,
              let password = raw["password"] as? String, !password.isEmpty, password.count <= 4096, !password.contains("\0") else { throw AuxiliaryProductError.credentialsRequired }
        return AuxiliaryCredentials(username: username, password: password)
    }
}

extension AuxiliaryTaskRecord {
    public init(source: AuxiliarySource) throws {
        switch try AuxiliaryTransfer.validateSource(source) {
        case .magnet(let url): self.init(kind: "magnet", url: url)
        case .torrent(let data): self.init(kind: "torrent", torrentData: data)
        case .sftp(let url, let pin): self.init(kind: "sftp", url: url, hostKeySHA256: pin)
        case .ed2k(let url, _, _): self.init(kind: "ed2k", url: url)
        case .loopbackHTTPFixture(let url): self.init(kind: "fixture", url: url)
        }
    }
    public func source() throws -> AuxiliarySource {
        switch kind {
        case "magnet": guard let url else { throw AuxiliaryProductError.invalidSource }; return .magnet(url)
        case "torrent": guard let torrentData else { throw AuxiliaryProductError.invalidSource }; return .torrent(torrentData)
        case "sftp": guard let url, let hostKeySHA256 else { throw AuxiliaryProductError.invalidSource }; return .sftp(url: url, hostKeySHA256: hostKeySHA256)
        case "ed2k": guard let url else { throw AuxiliaryProductError.invalidSource }; return .ed2k(url: url, serverList: nil, nodeList: nil)
        case "fixture": guard let url else { throw AuxiliaryProductError.invalidSource }; return .loopbackHTTPFixture(url)
        default: throw AuxiliaryProductError.invalidSource
        }
    }
    var displayURL: String { url ?? "ndm-torrent:" + SHA256.hash(data: torrentData ?? Data()).map { String(format: "%02x", $0) }.joined() }
    var initialFilename: String {
        switch kind {
        case "magnet": return DownloadFilename.sanitize(URLComponents(string: url ?? "")?.queryItems?.first { $0.name == "dn" }?.value ?? "磁力下载")
        case "torrent": return "种子下载"
        case "ed2k": return DownloadFilename.sanitize(url?.components(separatedBy: "|").dropFirst(2).first?.removingPercentEncoding ?? "ED2K 下载")
        default: return DownloadFilename.sanitize(URL(string: url ?? "")?.lastPathComponent ?? "下载文件")
        }
    }
}

public struct AuxiliaryTaskStatus: Codable, Sendable {
    public let taskID: Int64
    public let generation: Int64
    public let kind: String
    public let phase: String
    public let totalBytes: Int64
    public let completedBytes: Int64
    public let downloadSpeed: Int64
    public let uploadSpeed: Int64
    public let payloadCompleted: Bool
    public let files: [AuxiliaryTaskFile]
    public let errorCode: String?
    init(task: DownloadTask, live: AuxiliarySnapshot?) throws {
        guard let record = task.auxiliary else { throw AuxiliaryProductError.notFound }
        self.taskID = task.id; self.generation = record.generation; self.kind = record.engineKind
        self.phase = record.published ? "complete" : live?.phase == .complete ? "checking" : live?.phase.rawValue ?? (task.status == .incomplete ? "paused" : record.phase)
        self.totalBytes = live?.totalBytes ?? task.fileSize; self.completedBytes = live?.completedBytes ?? record.completedBytes
        self.downloadSpeed = live?.downloadSpeed ?? 0; self.uploadSpeed = live?.uploadSpeed ?? 0
        self.payloadCompleted = record.payloadCompleted; self.files = record.files; self.errorCode = record.errorCode
    }
}

enum AuxiliaryBundledEngine {
    static let version = "2.7.5"
    static let sourceCommit = "a9784ea8e36ae83f360ff5157b60c72eb8d96375"
    #if arch(arm64)
    static let target = "macos-arm64"
    static let digest = "c36268f2ab67614ad8737586adab7fc1e1df85e0aef55421bd45f778f0868343"
    #else
    static let target = "macos-x86_64"
    static let digest = "c94d4bed9f1d8270320e17d3af1fa72d5fd4040efd5ee8a87c6d75d47aa6c5b4"
    #endif
    static func daemon(supportRoot: URL) throws -> AuxiliaryDaemon {
        var candidates: [URL] = []
        if let tools = ProcessInfo.processInfo.environment["NDM_TOOL_DIR"] { candidates.append(URL(fileURLWithPath: tools).appendingPathComponent("aria2-next")) }
        if let resources = Bundle.main.resourceURL {
            candidates += [resources.appendingPathComponent("tools/aria2-next"), resources.appendingPathComponent("Tools/aria2-next")]
        }
        let executableDirectory = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        candidates += [executableDirectory.appendingPathComponent("../tools/aria2-next"), executableDirectory.appendingPathComponent("../Resources/tools/aria2-next")]
        if let bundled = BundledToolLocator.bundledExecutable(named: ["aria2-next"]) { candidates.append(bundled) }
        guard let executable = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0.path) }) else { throw AuxiliaryDaemonError.unavailable }
        let manifest = executable.deletingLastPathComponent().appendingPathComponent("aria2-next-manifest.json")
        guard let data = try? Data(contentsOf: manifest), data.count <= 65536,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["version"] as? String == version, value["target"] as? String == target,
              value["sourceCommit"] as? String == sourceCommit, value["binarySHA256"] as? String == digest else { throw AuxiliaryDaemonError.binaryMismatch }
        let environment = ProcessInfo.processInfo.environment
        return AuxiliaryDaemon(configuration: .init(executableURL: executable, stateDirectory: supportRoot.appendingPathComponent("auxiliary-engine"), expectedSHA256: digest,
            peerDiscoveryEnabled: environment["NDM_AUXILIARY_PEER_DISCOVERY"] != "0",
            loopbackTransfersOnly: environment["NDM_AUXILIARY_LOOPBACK_ONLY"] == "1"))
    }
}
