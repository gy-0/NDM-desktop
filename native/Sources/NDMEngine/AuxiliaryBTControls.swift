import Foundation
import CoreFoundation
import Darwin
import NDMCore

public enum AuxiliaryBTError: String, Error, LocalizedError, Sendable {
    case invalidRequest, invalidConfig, invalidPeers, notFound, unsupported, unavailable, staleGeneration, conflict, notPaused, allTasksMustPause, storage, unconfirmed
    public var errorDescription: String? {
        switch self {
        case .invalidRequest: return "BT 操作参数无效，请重新读取任务。"
        case .invalidConfig: return "请检查 Tracker、WebSeed 和分享策略的格式与范围。"
        case .invalidPeers: return "请填写 IP:端口，IPv6 使用 [地址]:端口；每次最多 128 个。"
        case .notFound: return "任务已不存在，请刷新任务列表。"
        case .unsupported: return "当前引擎或任务不支持这项 BT 操作。"
        case .unavailable: return "暂时无法读取 BT 引擎状态，请稍后重试。"
        case .staleGeneration: return "任务已重新创建，请刷新后重新编辑。"
        case .conflict: return "配置已由其他页面更新，请读取最新配置后重新确认。"
        case .notPaused: return "请先暂停 BT 任务，再修改配置或添加 peer。"
        case .allTasksMustPause: return "修改会话加密前，请先暂停全部 BT 任务。"
        case .storage: return "配置未能保存，请检查磁盘空间和文件权限。"
        case .unconfirmed: return "操作结果尚未确认，请刷新状态核对后重试。"
        }
    }
}
public struct AuxiliaryBTTracker: Codable, Sendable, Equatable {
    public let url: String; public let tier: Int; public let status: String
    public let failures: Int64; public let seeders: Int64; public let leechers: Int64
}
public struct AuxiliaryBTPeer: Codable, Sendable, Equatable {
    public let ip: String; public let port: Int64; public let downloadSpeed: Int64; public let uploadSpeed: Int64
    public let progress: Double; public let seeder: Bool; public let state: String; public let encryption: String
}
public struct AuxiliaryBTState: Codable, Sendable {
    public let taskID: Int64; public let generation: Int64; public let revision: Int64; public let phase: String
    public let config: AuxiliaryBTConfig; public let trackers: [AuxiliaryBTTracker]; public let peers: [AuxiliaryBTPeer]
}
public struct AuxiliaryBTReadback: Sendable {
    public let config: AuxiliaryBTConfig; public let trackers: [AuxiliaryBTTracker]; public let peers: [AuxiliaryBTPeer]
}
public struct AuxiliaryBTAddedPeers: Codable, Sendable { public let added: Int64; public let failed: Int64 }
public enum AuxiliaryBTEncryption: String, Codable, Sendable { case preferred, required, disabled }
public struct AuxiliaryBTGlobalState: Codable, Sendable {
    public let revision: Int64; public let encryption: AuxiliaryBTEncryption; public let canConfigure: Bool
}

public enum AuxiliaryBTValidation {
    static let safeInteger: Int64 = 9_007_199_254_740_991
    static func clean(_ value: String, max: Int) -> Bool {
        !value.isEmpty && value.utf8.count <= max && !value.unicodeScalars.contains { $0.value <= 32 || (127...159).contains($0.value) }
    }
    static func sourceURL(_ value: String, tracker: Bool) throws {
        guard clean(value, max: 8192), value.range(of: tracker ? "^(https?|udp)://" : "^https?://", options: .regularExpression) != nil,
              let components = URLComponents(string: value), let host = components.host, !host.isEmpty,
              components.fragment == nil, components.port == nil || (1...65535).contains(components.port!) else { throw AuxiliaryBTError.invalidConfig }
    }
    public static func config(_ value: AuxiliaryBTConfig) throws -> AuxiliaryBTConfig {
        guard value.trackers.count <= 256, value.webSeeds.count <= 128, value.seedRatio.isFinite, (0...1_000_000).contains(value.seedRatio),
              value.seedMinutes == nil || (0...35_791_394).contains(value.seedMinutes!), (0...2_147_483_647).contains(value.uploadLimit) else { throw AuxiliaryBTError.invalidConfig }
        var output = value, seen = Set<String>()
        output.trackers = try value.trackers.filter { tracker in
            try sourceURL(tracker.url, tracker: true)
            guard (0...255).contains(tracker.tier) else { throw AuxiliaryBTError.invalidConfig }
            return seen.insert(tracker.url).inserted
        }
        let tiers = Array(Set(output.trackers.map(\.tier))).sorted()
        output.trackers = output.trackers.map { .init(url: $0.url, tier: tiers.firstIndex(of: $0.tier)!) }
        seen = []
        output.webSeeds = try value.webSeeds.filter { url in try sourceURL(url, tracker: false); return seen.insert(url).inserted }
        return output
    }
    public static func parseConfig(_ value: Any?) throws -> AuxiliaryBTConfig {
        guard let dict = value as? [String: Any], Set(dict.keys) == Set(["trackers", "webSeeds", "seedRatio", "seedMinutes", "uploadLimit", "peerExchange"]),
              let trackers = dict["trackers"] as? [[String: Any]], trackers.allSatisfy({ Set($0.keys) == Set(["url", "tier"]) }),
              JSONSerialization.isValidJSONObject(dict), let data = try? JSONSerialization.data(withJSONObject: dict),
              let decoded = try? JSONDecoder().decode(AuxiliaryBTConfig.self, from: data) else { throw AuxiliaryBTError.invalidConfig }
        return try config(decoded)
    }
    public static func peers(_ values: [String]) throws -> [String] {
        guard !values.isEmpty, values.count <= 128 else { throw AuxiliaryBTError.invalidPeers }
        var seen = Set<String>(), output: [String] = []
        for value in values {
            guard clean(value, max: 80) else { throw AuxiliaryBTError.invalidPeers }
            let host: String, portText: String, normalized: String
            if value.hasPrefix("["), let end = value.firstIndex(of: "]"), value[value.index(after: end)...].hasPrefix(":") {
                host = String(value[value.index(after: value.startIndex)..<end]); portText = String(value[value.index(end, offsetBy: 2)...])
                var address = in6_addr(); guard inet_pton(AF_INET6, host, &address) == 1 else { throw AuxiliaryBTError.invalidPeers }
                var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN)); guard inet_ntop(AF_INET6, &address, &buffer, socklen_t(buffer.count)) != nil else { throw AuxiliaryBTError.invalidPeers }
                normalized = "[\(String(cString: buffer))]"
            } else {
                let pieces = value.split(separator: ":", omittingEmptySubsequences: false)
                guard pieces.count == 2 else { throw AuxiliaryBTError.invalidPeers }
                host = String(pieces[0]); portText = String(pieces[1])
                let octets = host.split(separator: ".", omittingEmptySubsequences: false)
                guard octets.count == 4, octets.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isNumber) && $0.count <= 3 && Int($0).map { (0...255).contains($0) } == true }) else { throw AuxiliaryBTError.invalidPeers }
                normalized = octets.map { String(Int($0)!) }.joined(separator: ".")
            }
            guard !portText.isEmpty, portText.count <= 5, portText.allSatisfy(\.isNumber), let port = Int(portText), (1...65535).contains(port) else { throw AuxiliaryBTError.invalidPeers }
            let peer = "\(normalized):\(port)"; if seen.insert(peer).inserted { output.append(peer) }
        }
        return output
    }
    static func readback(options: AuxiliaryJSON, status: AuxiliaryJSON, trackers rawTrackers: AuxiliaryJSON, peers rawPeers: AuxiliaryJSON) throws -> AuxiliaryBTReadback {
        guard let trackers = rawTrackers.array, trackers.count <= 256, let peers = rawPeers.array, peers.count <= 1000,
              let seeds = status["bittorrent"]?["webSeeds"]?.array, seeds.count <= 128 else { throw AuxiliaryRPCError.invalidResponse }
        let normalizedTrackers: [AuxiliaryBTTracker] = try trackers.map {
            guard let url = $0["url"]?.string, let tier = $0["tier"]?.integer, (0...255).contains(tier),
                  let state = $0["status"]?.string, clean(state, max: 64), let failures = $0["failures"]?.integer, failures >= 0,
                  let seeders = $0["seeders"]?.integer, seeders >= -1, let leechers = $0["leechers"]?.integer, leechers >= -1 else { throw AuxiliaryRPCError.invalidResponse }
            try sourceURL(url, tracker: true)
            return AuxiliaryBTTracker(url: url, tier: Int(tier), status: state, failures: failures, seeders: seeders, leechers: leechers)
        }
        let normalizedPeers: [AuxiliaryBTPeer] = try peers.map {
            guard let ip = $0["ip"]?.string, let port = $0["port"]?.integer, (1...65535).contains(port),
                  let down = $0["downloadSpeed"]?.integer, (0...safeInteger).contains(down), let up = $0["uploadSpeed"]?.integer, (0...safeInteger).contains(up),
                  let progress = $0["progress"]?.double, progress.isFinite, (0...1).contains(progress), let seeder = $0["seeder"]?.boolean,
                  let state = $0["state"]?.string, clean(state, max: 32), let encryption = $0["encryption"]?.string, clean(encryption, max: 32) else { throw AuxiliaryRPCError.invalidResponse }
            _ = try self.peers(["\(ip.contains(":") ? "[\(ip)]" : ip):\(port)"])
            return AuxiliaryBTPeer(ip: ip, port: port, downloadSpeed: down, uploadSpeed: up, progress: progress, seeder: seeder, state: state, encryption: encryption)
        }
        guard let ratio = options["seed-ratio"]?.double, let upload = options["max-upload-limit"]?.integer,
              let pex = options["enable-peer-exchange"]?.boolean else { throw AuxiliaryRPCError.invalidResponse }
        let minutes: Int64?
        if let value = options["seed-time"] {
            guard let number = value.double, number.isFinite, number.rounded() == number, (0...35_791_394).contains(number) else { throw AuxiliaryRPCError.invalidResponse }
            minutes = Int64(number)
        } else { minutes = nil }
        let urls = try seeds.map { guard let url = $0.string else { throw AuxiliaryRPCError.invalidResponse }; return url }
        guard let announceList = status["bittorrent"]?["announceList"]?.array, announceList.count <= 256 else { throw AuxiliaryRPCError.invalidResponse }
        var configuredTrackers: [AuxiliaryBTTrackerConfig] = []
        for (tier, raw) in announceList.enumerated() {
            guard let list = raw.array, configuredTrackers.count + list.count <= 256 else { throw AuxiliaryRPCError.invalidResponse }
            for entry in list { guard let url = entry.string else { throw AuxiliaryRPCError.invalidResponse }; configuredTrackers.append(.init(url: url, tier: tier)) }
        }
        let config = try config(.init(trackers: configuredTrackers, webSeeds: urls,
            seedRatio: ratio, seedMinutes: minutes, uploadLimit: upload, peerExchange: pex))
        return AuxiliaryBTReadback(config: config, trackers: normalizedTrackers, peers: normalizedPeers)
    }
    static func equivalent(_ left: AuxiliaryBTConfig, _ right: AuxiliaryBTConfig) -> Bool {
        left.seedRatio == right.seedRatio && left.seedMinutes == right.seedMinutes && left.uploadLimit == right.uploadLimit && left.peerExchange == right.peerExchange &&
        left.trackers.sorted { ($0.url, $0.tier) < ($1.url, $1.tier) } == right.trackers.sorted { ($0.url, $0.tier) < ($1.url, $1.tier) } && left.webSeeds.sorted() == right.webSeeds.sorted()
    }
}

extension AuxiliaryJSON {
    var double: Double? {
        switch self { case .number(let value): return value; case .string(let value): return Double(value); default: return nil }
    }
}
