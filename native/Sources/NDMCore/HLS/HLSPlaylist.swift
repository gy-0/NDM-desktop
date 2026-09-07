import Foundation

/// Minimal HLS playlist model (master + media) for `ltype=hls` path.
public enum HLSPlaylist {
    public struct Media: Equatable, Sendable {
        public var version: Int
        public var targetDuration: Double
        public var mediaSequence: Int
        public var endList: Bool
        public var segments: [Segment]

        /// Informational: the first key the playlist declares. Derived rather than
        /// stored so it cannot drift from what the segments actually say. Keys
        /// rotate mid-playlist, so decryption must always use `Segment.key` — a
        /// single playlist-wide key silently produces garbage for every segment it
        /// does not belong to.
        public var key: EncryptionKey? { segments.first?.key }

        /// Whether any segment is AES-128 encrypted.
        public var hasEncryptedSegments: Bool {
            segments.contains { $0.key?.isAES128 == true }
        }

        public init(
            version: Int = 3,
            targetDuration: Double = 0,
            mediaSequence: Int = 0,
            endList: Bool = false,
            segments: [Segment] = []
        ) {
            self.version = version
            self.targetDuration = targetDuration
            self.mediaSequence = mediaSequence
            self.endList = endList
            self.segments = segments
        }
    }

    public struct Segment: Equatable, Sendable, Identifiable {
        public var id: Int
        public var uri: String
        public var duration: Double
        public var byteRange: ByteRange?
        /// The key in force at this segment's position, or nil when it is clear.
        public var key: EncryptionKey?

        public init(
            id: Int,
            uri: String,
            duration: Double,
            byteRange: ByteRange? = nil,
            key: EncryptionKey? = nil
        ) {
            self.id = id
            self.uri = uri
            self.duration = duration
            self.byteRange = byteRange
            self.key = key
        }
    }

    public struct ByteRange: Equatable, Sendable {
        public var length: Int64
        public var offset: Int64?
        public init(length: Int64, offset: Int64? = nil) {
            self.length = length
            self.offset = offset
        }
    }

    public struct EncryptionKey: Equatable, Sendable {
        public var method: String
        public var uri: String?
        public var ivHex: String?

        public init(method: String, uri: String? = nil, ivHex: String? = nil) {
            self.method = method
            self.uri = uri
            self.ivHex = ivHex
        }

        public var isAES128: Bool { method.uppercased() == "AES-128" }
    }

    public struct Variant: Equatable, Sendable {
        public var bandwidth: Int
        public var resolution: String?
        public var codecs: String?
        public var uri: String
        /// The AUDIO group this video stream references, if its audio is a
        /// separate rendition (X/Twitter, many CDNs). nil = self-contained.
        public var audioGroupID: String?

        public init(bandwidth: Int, resolution: String? = nil, codecs: String? = nil, uri: String, audioGroupID: String? = nil) {
            self.bandwidth = bandwidth
            self.resolution = resolution
            self.codecs = codecs
            self.uri = uri
            self.audioGroupID = audioGroupID
        }
    }

    /// A separate audio-only rendition declared with `#EXT-X-MEDIA:TYPE=AUDIO`.
    public struct AudioRendition: Equatable, Sendable {
        public var groupID: String
        public var uri: String?
        public var isDefault: Bool
        public init(groupID: String, uri: String?, isDefault: Bool) {
            self.groupID = groupID
            self.uri = uri
            self.isDefault = isDefault
        }
    }

    public struct Master: Equatable, Sendable {
        public var variants: [Variant]
        public var audioRenditions: [AudioRendition]
        public init(variants: [Variant] = [], audioRenditions: [AudioRendition] = []) {
            self.variants = variants
            self.audioRenditions = audioRenditions
        }

        /// Prefer highest bandwidth (original / typical player default).
        public var preferredVariant: Variant? {
            variants.max(by: { $0.bandwidth < $1.bandwidth })
        }

        /// The audio-rendition URI a variant should be muxed with, if any.
        /// Prefers the group's DEFAULT rendition, else the first with a URI.
        public func audioURI(for variant: Variant) -> String? {
            guard let group = variant.audioGroupID else { return nil }
            let inGroup = audioRenditions.filter { $0.groupID == group && $0.uri != nil }
            return (inGroup.first(where: \.isDefault) ?? inGroup.first)?.uri
        }
    }

    public enum Kind: Equatable, Sendable {
        case master(Master)
        case media(Media)
    }

    public static func parse(_ text: String) throws -> Kind {
        let lines = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }

        guard let first = lines.first(where: { !$0.isEmpty }), first.hasPrefix("#EXTM3U") else {
            throw HLSError.notPlaylist
        }

        if lines.contains(where: { $0.hasPrefix("#EXT-X-STREAM-INF") }) {
            return .master(try parseMaster(lines))
        }
        return .media(try parseMedia(lines))
    }

    public static func resolveURL(_ relative: String, against base: URL) -> URL? {
        if let abs = URL(string: relative), abs.scheme != nil { return abs }
        return URL(string: relative, relativeTo: base)?.absoluteURL
    }

    // MARK: - Private

    private static func parseMaster(_ lines: [String]) throws -> Master {
        var variants: [Variant] = []
        var audioRenditions: [AudioRendition] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("#EXT-X-MEDIA:") {
                let attrs = parseAttributes(String(line.dropFirst("#EXT-X-MEDIA:".count)))
                if (attrs["TYPE"] ?? "").uppercased() == "AUDIO", let group = attrs["GROUP-ID"] {
                    audioRenditions.append(AudioRendition(
                        groupID: group,
                        uri: attrs["URI"],
                        isDefault: (attrs["DEFAULT"] ?? "").uppercased() == "YES"
                    ))
                }
            } else if line.hasPrefix("#EXT-X-STREAM-INF:") {
                let attrs = parseAttributes(String(line.dropFirst("#EXT-X-STREAM-INF:".count)))
                let bw = Int(attrs["BANDWIDTH"] ?? "0") ?? 0
                i += 1
                while i < lines.count, lines[i].isEmpty || lines[i].hasPrefix("#") {
                    if lines[i].hasPrefix("#EXT-X-STREAM-INF") { break }
                    i += 1
                }
                guard i < lines.count, !lines[i].hasPrefix("#") else { continue }
                variants.append(Variant(
                    bandwidth: bw,
                    resolution: attrs["RESOLUTION"],
                    codecs: attrs["CODECS"],
                    uri: lines[i],
                    audioGroupID: attrs["AUDIO"]
                ))
            }
            i += 1
        }
        guard !variants.isEmpty else { throw HLSError.emptyMaster }
        return Master(variants: variants, audioRenditions: audioRenditions)
    }

    private static func parseMedia(_ lines: [String]) throws -> Media {
        var media = Media()
        var pendingDuration: Double?
        var pendingRange: ByteRange?
        var segID = 0
        /// The key declared most recently, applied to each following segment.
        var currentKey: EncryptionKey?
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if line.hasPrefix("#EXT-X-VERSION:") {
                media.version = Int(line.split(separator: ":").last.map(String.init) ?? "3") ?? 3
            } else if line.hasPrefix("#EXT-X-TARGETDURATION:") {
                media.targetDuration = Double(line.split(separator: ":").last.map(String.init) ?? "0") ?? 0
            } else if line.hasPrefix("#EXT-X-MEDIA-SEQUENCE:") {
                media.mediaSequence = Int(line.split(separator: ":").last.map(String.init) ?? "0") ?? 0
                segID = media.mediaSequence
            } else if line == "#EXT-X-ENDLIST" {
                media.endList = true
            } else if line.hasPrefix("#EXT-X-KEY:") {
                // A KEY tag applies to every segment that follows it until the next
                // one, so it updates the running key rather than the playlist. Both
                // rotation and a mid-playlist METHOD=NONE (ad splices, trailing
                // clear content) depend on that.
                let attrs = parseAttributes(String(line.dropFirst("#EXT-X-KEY:".count)))
                currentKey = EncryptionKey(
                    method: attrs["METHOD"] ?? "NONE",
                    uri: attrs["URI"],
                    ivHex: attrs["IV"].map { $0.hasPrefix("0x") || $0.hasPrefix("0X") ? String($0.dropFirst(2)) : $0 }
                )
            } else if line.hasPrefix("#EXTINF:") {
                let body = String(line.dropFirst("#EXTINF:".count))
                let durStr = body.split(separator: ",", maxSplits: 1).first.map(String.init) ?? "0"
                pendingDuration = Double(durStr) ?? 0
            } else if line.hasPrefix("#EXT-X-BYTERANGE:") {
                let body = String(line.dropFirst("#EXT-X-BYTERANGE:".count))
                let parts = body.split(separator: "@")
                let length = Int64(parts[0]) ?? 0
                let offset = parts.count > 1 ? Int64(parts[1]) : nil
                pendingRange = ByteRange(length: length, offset: offset)
            } else if !line.isEmpty, !line.hasPrefix("#"), let dur = pendingDuration {
                media.segments.append(Segment(
                    id: segID,
                    uri: line,
                    duration: dur,
                    byteRange: pendingRange,
                    key: currentKey
                ))
                segID += 1
                pendingDuration = nil
                pendingRange = nil
            }
            i += 1
        }
        guard !media.segments.isEmpty else { throw HLSError.emptyMedia }
        return media
    }

    /// Parse `KEY=VAL,KEY2="VAL2"` attribute lists.
    public static func parseAttributes(_ raw: String) -> [String: String] {
        var result: [String: String] = [:]
        var i = raw.startIndex
        while i < raw.endIndex {
            while i < raw.endIndex, raw[i] == " " || raw[i] == "," { i = raw.index(after: i) }
            guard i < raw.endIndex else { break }
            guard let eq = raw[i...].firstIndex(of: "=") else { break }
            let key = String(raw[i..<eq]).trimmingCharacters(in: .whitespaces)
            var j = raw.index(after: eq)
            let value: String
            if j < raw.endIndex, raw[j] == "\"" {
                j = raw.index(after: j)
                guard let end = raw[j...].firstIndex(of: "\"") else { break }
                value = String(raw[j..<end])
                i = raw.index(after: end)
            } else {
                var end = j
                while end < raw.endIndex, raw[end] != "," { end = raw.index(after: end) }
                value = String(raw[j..<end]).trimmingCharacters(in: .whitespaces)
                i = end
            }
            result[key] = value
        }
        return result
    }
}

public enum HLSError: Error, LocalizedError, Equatable {
    case notPlaylist
    case emptyMaster
    case emptyMedia
    case unresolvedURL(String)
    case missingKey
    case decryptFailed

    public var errorDescription: String? {
        switch self {
        case .notPlaylist: return "Not a valid HLS playlist (#EXTM3U)"
        case .emptyMaster: return "Master playlist has no variants"
        case .emptyMedia: return "Media playlist has no segments"
        case .unresolvedURL(let u): return "Cannot resolve HLS URL: \(u)"
        case .missingKey: return "AES-128 key URI missing"
        case .decryptFailed: return "Failed to decrypt HLS segment"
        }
    }
}
