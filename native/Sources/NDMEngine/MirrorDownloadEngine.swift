import Foundation
import CryptoKit
import NDMCore

public enum MirrorDownloadError: Error, LocalizedError {
    case invalidSources, credentialsAcrossOrigins, sourceChanged, partialPreserved(String), exhausted(String)
    public var errorDescription: String? {
        switch self {
        case .invalidSources: return "镜像任务只支持最多 32 个有效 HTTP/HTTPS 地址和普通 GET 文件下载。"
        case .credentialsAcrossOrigins: return "跨站镜像不能携带登录凭据、Cookie、Referer、Origin 或来源页面；请分别创建任务。"
        case .sourceChanged: return "镜像来源与已保存的下载记录不一致。请保留原任务，或明确选择重新下载。"
        case .partialPreserved(let detail): return "当前镜像已保存续传数据，已保留进度。继续下载会重试此来源；选择重新下载后才会重新尝试镜像。\(detail)"
        case .exhausted(let detail): return "所有镜像都未能开始下载。\(detail)"
        }
    }
}

public enum MirrorDownloadPolicy {
    public static func validate(primary: String, mirrors: [String], headers: [String] = [], pageURL: String? = nil,
                                username: String? = nil, password: String? = nil) throws {
        guard !mirrors.isEmpty else { return }
        let sources = [primary] + mirrors
        guard sources.count <= 32 else { throw MirrorDownloadError.invalidSources }
        let urls = try sources.map { raw -> URL in
            guard raw.range(of: "^https?://", options: [.regularExpression, .caseInsensitive]) != nil,
                  raw.rangeOfCharacter(from: .whitespacesAndNewlines.union(.controlCharacters)) == nil,
                  !raw.contains("\\"), let url = URL(string: raw), url.host?.isEmpty == false,
                  ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { throw MirrorDownloadError.invalidSources }
            return url
        }
        func origin(_ url: URL) -> String { "\(url.scheme!.lowercased())://\(url.host!.lowercased()):\(url.port ?? (url.scheme!.lowercased() == "https" ? 443 : 80))" }
        if Set(urls.map(origin)).count > 1 {
            let sensitive = headers.contains { header in
                let name = header.split(separator: ":", maxSplits: 1).first.map(String.init)?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
                return ["authorization", "proxy-authorization", "cookie", "referer", "origin"].contains(name)
            }
            guard !sensitive, pageURL?.isEmpty != false, username?.isEmpty != false, password?.isEmpty != false,
                  urls.allSatisfy({ $0.user == nil && $0.password == nil }) else { throw MirrorDownloadError.credentialsAcrossOrigins }
        }
    }
}

/// Automatic fallback is deliberately limited to a source that has not created
/// payload, segment metadata or ownership receipts. All existing storage and
/// cleanup contracts therefore remain at the original task work-directory root.
public actor MirrorDownloadEngine {
    private struct Selection: Codable { let sourcesHash: String; let index: Int }
    private let taskID: Int64
    private var request: DownloadRequest
    private let sources: [URL]
    private let workDirectory: URL
    private let httpProxy: ProxySettings?
    private let socksProxy: SocksProxySettings?
    private let autoTuneConnections: Bool
    private let capacityProvider: @Sendable (URL) -> Int64?
    private let sameVolumeProvider: @Sendable (URL, URL) -> Bool
    private let reserveDestination: (@Sendable (URL) async throws -> URL)?
    private var effectiveBandwidth: Int64
    private var active: DownloadEngine?
    private let token = CancelToken()

    public init(taskID: Int64, request: DownloadRequest, mirrors: [String], workDirectory: URL,
                httpProxy: ProxySettings? = nil, socksProxy: SocksProxySettings? = nil,
                globalBandwidthLimit: Int64 = 0, autoTuneConnections: Bool = false,
                capacityProvider: @escaping @Sendable (URL) -> Int64? = { VolumeCapacity.availableBytes(at: $0) },
                sameVolumeProvider: @escaping @Sendable (URL, URL) -> Bool = { VolumeCapacity.areOnSameVolume($0, $1) },
                reserveDestination: (@Sendable (URL) async throws -> URL)? = nil) throws {
        try MirrorDownloadPolicy.validate(primary: request.url.absoluteString, mirrors: mirrors,
            headers: request.headers.map { "\($0.key): \($0.value)" }, pageURL: request.pageURL?.absoluteString,
            username: request.username, password: request.password)
        guard request.method.uppercased() == "GET", request.body == nil else { throw MirrorDownloadError.invalidSources }
        self.reserveDestination = reserveDestination
        self.taskID = taskID; self.request = request; self.workDirectory = workDirectory
        self.sources = [request.url] + mirrors.compactMap(URL.init(string:))
        self.httpProxy = httpProxy; self.socksProxy = socksProxy
        self.effectiveBandwidth = request.bandwidthLimitBytesPerSecond > 0 ? request.bandwidthLimitBytesPerSecond : globalBandwidthLimit
        self.autoTuneConnections = autoTuneConnections; self.capacityProvider = capacityProvider; self.sameVolumeProvider = sameVolumeProvider
    }

    nonisolated func requestPause() { token.pause() }
    public func pause() async { token.pause(); active?.requestPause(); await active?.pause() }
    public func cancel() async { token.cancel(); active?.requestPause(); await active?.cancel() }
    public func applyConnectionsCount(_ count: Int) async throws {
        request.connections = count
        try await active?.applyConnectionsCount(count)
    }
    public func applyBandwidthLimit(_ bytesPerSecond: Int64) async {
        effectiveBandwidth = bytesPerSecond
        await active?.applyBandwidthLimit(bytesPerSecond)
    }
    public func currentProgress() async -> DownloadProgress {
        if let active { return await active.currentProgress() }
        return DownloadProgress(taskID: taskID, status: token.isPaused ? .paused : .waiting,
            currentConnections: request.connections, effectiveBandwidthLimitBytesPerSecond: effectiveBandwidth)
    }

    private func checkStopped() throws {
        if token.isPaused { throw EngineError.paused }
        if token.isCancelled || Task.isCancelled { throw EngineError.cancelled }
    }

    private func hasNoTransferArtifacts() throws -> Bool {
        let names = try FileManager.default.contentsOfDirectory(atPath: workDirectory.path)
        return names.allSatisfy { ["LogFile.txt", "mirror-source.json", "redownload-destination.json"].contains($0) }
    }

    public func start() async throws -> URL {
        try checkStopped()
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        let marker = workDirectory.appendingPathComponent("mirror-source.json")
        let sourceData = try JSONEncoder().encode(sources.map(\.absoluteString))
        let hash = SHA256.hash(data: sourceData).map { String(format: "%02x", $0) }.joined()
        let first: Int
        if FileManager.default.fileExists(atPath: marker.path) {
            guard let selection = try? JSONDecoder().decode(Selection.self, from: Data(contentsOf: marker)),
                  selection.sourcesHash == hash, sources.indices.contains(selection.index) else { throw MirrorDownloadError.sourceChanged }
            first = selection.index
        } else {
            guard try hasNoTransferArtifacts() else { throw MirrorDownloadError.sourceChanged }
            first = 0
        }
        var lastError: Error = MirrorDownloadError.invalidSources
        for index in Array(first..<sources.count) + Array(0..<first) {
            try checkStopped()
            try JSONEncoder().encode(Selection(sourcesHash: hash, index: index)).write(to: marker, options: .atomic)
            var sourceRequest = request
            sourceRequest.url = sources[index]
            sourceRequest.bandwidthLimitBytesPerSecond = effectiveBandwidth
            let engine = DownloadEngine(taskID: taskID, request: sourceRequest, workDirectory: workDirectory,
                httpProxy: httpProxy, socksProxy: socksProxy, globalBandwidthLimit: effectiveBandwidth,
                autoTuneConnections: autoTuneConnections, capacityProvider: capacityProvider, sameVolumeProvider: sameVolumeProvider, reserveDestination: reserveDestination)
            active = engine
            do { return try await engine.start() }
            catch {
                try checkStopped()
                lastError = error
                // A completed source attempt has drained its writers. Neither
                // progress counters nor zero file sizes prove safe ownership.
                guard try hasNoTransferArtifacts() else { throw MirrorDownloadError.partialPreserved(error.localizedDescription) }
            }
        }
        throw MirrorDownloadError.exhausted(lastError.localizedDescription)
    }
}
