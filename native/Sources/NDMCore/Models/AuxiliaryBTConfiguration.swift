import Foundation

public struct AuxiliaryBTTrackerConfig: Codable, Sendable, Equatable {
    public var url: String
    public var tier: Int
    public init(url: String, tier: Int) { self.url = url; self.tier = tier }
}

public struct AuxiliaryBTConfig: Codable, Sendable, Equatable {
    public var trackers: [AuxiliaryBTTrackerConfig]
    public var webSeeds: [String]
    public var seedRatio: Double
    public var seedMinutes: Int64?
    public var uploadLimit: Int64
    public var peerExchange: Bool
    public init(trackers: [AuxiliaryBTTrackerConfig] = [], webSeeds: [String] = [], seedRatio: Double = 1,
                seedMinutes: Int64? = nil, uploadLimit: Int64 = 0, peerExchange: Bool = true) {
        self.trackers = trackers; self.webSeeds = webSeeds; self.seedRatio = seedRatio
        self.seedMinutes = seedMinutes; self.uploadLimit = uploadLimit; self.peerExchange = peerExchange
    }
    enum CodingKeys: String, CodingKey { case trackers, webSeeds, seedRatio, seedMinutes, uploadLimit, peerExchange }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(trackers, forKey: .trackers); try c.encode(webSeeds, forKey: .webSeeds)
        try c.encode(seedRatio, forKey: .seedRatio); try c.encode(uploadLimit, forKey: .uploadLimit); try c.encode(peerExchange, forKey: .peerExchange)
        if let seedMinutes { try c.encode(seedMinutes, forKey: .seedMinutes) } else { try c.encodeNil(forKey: .seedMinutes) }
    }
}

/// Durable desired configuration. A pending revision is reconciled and read
/// back before the UI receives a success ACK or the task can start again.
public struct AuxiliaryBTRecord: Codable, Sendable, Equatable {
    public var revision: Int64
    public var config: AuxiliaryBTConfig
    public var pending: Bool
    public init(revision: Int64 = 0, config: AuxiliaryBTConfig, pending: Bool = false) {
        self.revision = revision; self.config = config; self.pending = pending
    }
}
