import Foundation

/// Changes only the top-level URL seed list of the helper admission. Every
/// other value, including the complete raw info dictionary, stays byte-for-byte
/// identical; the durable source and its hash are never rewritten.
enum AuxiliaryBTMetainfo {
    static func replacingWebSeeds(_ data: Data, with urls: [String]) throws -> Data {
        guard data.count <= 8 * 1024 * 1024 else { throw AuxiliaryBTError.invalidConfig }
        let bytes = [UInt8](data); var offset = 0, entries = 0
        func string() throws -> (String?, Range<Int>) {
            let start = offset
            guard offset < bytes.count, (48...57).contains(bytes[offset]) else { throw AuxiliaryBTError.invalidConfig }
            var length = 0, digits = 0
            while offset < bytes.count, (48...57).contains(bytes[offset]) {
                digits += 1; guard digits <= 8 else { throw AuxiliaryBTError.invalidConfig }
                length = length * 10 + Int(bytes[offset] - 48); offset += 1
            }
            guard offset < bytes.count, bytes[offset] == 58, length <= bytes.count - offset - 1 else { throw AuxiliaryBTError.invalidConfig }
            offset += 1; let content = offset..<(offset + length); offset += length
            return (String(bytes: bytes[content], encoding: .utf8), start..<offset)
        }
        func value(depth: Int) throws {
            entries += 1; guard depth <= 64, entries <= 500_000, offset < bytes.count else { throw AuxiliaryBTError.invalidConfig }
            switch bytes[offset] {
            case 100, 108:
                let dictionary = bytes[offset] == 100; offset += 1
                while offset < bytes.count, bytes[offset] != 101 {
                    if dictionary { _ = try string() }
                    try value(depth: depth + 1)
                }
                guard offset < bytes.count else { throw AuxiliaryBTError.invalidConfig }; offset += 1
            case 105:
                offset += 1; let start = offset
                while offset < bytes.count, bytes[offset] != 101 {
                    guard (48...57).contains(bytes[offset]) || offset == start && bytes[offset] == 45 else { throw AuxiliaryBTError.invalidConfig }
                    offset += 1
                }
                guard offset > start, offset < bytes.count else { throw AuxiliaryBTError.invalidConfig }; offset += 1
            default: _ = try string()
            }
        }
        guard bytes.first == 100 else { throw AuxiliaryBTError.invalidConfig }; offset = 1
        var members: [(String, Data)] = [], keys = Set<String>()
        while offset < bytes.count, bytes[offset] != 101 {
            let (key, _) = try string()
            guard let key, keys.insert(key).inserted else { throw AuxiliaryBTError.invalidConfig }
            let start = offset; try value(depth: 1)
            if key != "url-list" { members.append((key, Data(bytes[start..<offset]))) }
        }
        guard offset == bytes.count - 1, bytes[offset] == 101, keys.contains("info") else { throw AuxiliaryBTError.invalidConfig }
        func encoded(_ text: String) -> Data { Data("\(text.utf8.count):".utf8) + Data(text.utf8) }
        members.append(("url-list", Data([108]) + urls.reduce(Data()) { $0 + encoded($1) } + Data([101])))
        return Data([100]) + members.sorted { $0.0.utf8.lexicographicallyPrecedes($1.0.utf8) }.reduce(Data()) { $0 + encoded($1.0) + $1.1 } + Data([101])
    }
    static func replacingMagnetWebSeeds(_ magnet: String, with urls: [String]) throws -> String {
        guard let question = magnet.firstIndex(of: "?") else { throw AuxiliaryBTError.invalidConfig }
        let preserved = magnet[magnet.index(after: question)...].split(separator: "&", omittingEmptySubsequences: false).filter {
            String($0.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)[0]).removingPercentEncoding?.lowercased() != "ws"
        }.map(String.init)
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return String(magnet[...question]) + (preserved + urls.map { "ws=" + $0.addingPercentEncoding(withAllowedCharacters: allowed)! }).joined(separator: "&")
    }
}
