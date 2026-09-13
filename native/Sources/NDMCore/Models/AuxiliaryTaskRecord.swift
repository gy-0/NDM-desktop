import Foundation

/// Protocol intent and last verified manifest belong to the existing download
/// row. Authentication is deliberately absent from this Codable type.
public struct AuxiliaryTaskRecord: Codable, Sendable, Equatable {
    public var kind: String
    public var url: String?
    public var torrentData: Data?
    public var hostKeySHA256: String?
    public var generation: Int64
    public var phase: String
    public var completedBytes: Int64
    public var payloadCompleted: Bool
    public var published: Bool
    public var stopSeedingRequested: Bool
    public var selectedFiles: [Int]?
    public var files: [AuxiliaryTaskFile]
    public var errorCode: String?
    public var bt: AuxiliaryBTRecord?
    public init(kind: String, url: String? = nil, torrentData: Data? = nil, hostKeySHA256: String? = nil,
                generation: Int64 = 0, phase: String = "paused", completedBytes: Int64 = 0,
                payloadCompleted: Bool = false, published: Bool = false, stopSeedingRequested: Bool = false, selectedFiles: [Int]? = nil,
                files: [AuxiliaryTaskFile] = [], errorCode: String? = nil, bt: AuxiliaryBTRecord? = nil) {
        self.kind = kind; self.url = url; self.torrentData = torrentData; self.hostKeySHA256 = hostKeySHA256
        self.generation = generation; self.phase = phase; self.completedBytes = completedBytes
        self.payloadCompleted = payloadCompleted; self.published = published
        self.stopSeedingRequested = stopSeedingRequested
        self.selectedFiles = selectedFiles; self.files = files; self.errorCode = errorCode; self.bt = bt
    }
    public var engineKind: String { kind == "torrent" || kind == "magnet" ? "bittorrent" : kind }
}

public struct AuxiliaryTaskFile: Codable, Sendable, Equatable {
    public var index: Int
    public var relativePath: String
    public var length: Int64
    public var completedLength: Int64
    public var selected: Bool
    public init(index: Int, relativePath: String, length: Int64, completedLength: Int64, selected: Bool) {
        self.index = index; self.relativePath = relativePath; self.length = length
        self.completedLength = completedLength; self.selected = selected
    }
}
