import Foundation

// Matches the MIT-adapted shared/directoryRules.ts contract. Original extension
// and first-match semantics: Motrix Next fileCategory.ts, 83dcd3c6 (THIRD_PARTY.md).

public struct DownloadDirectoryRule: Codable, Sendable {
    public var id: String
    public var name: String
    public var enabled: Bool
    public var directory: String
    public var hosts: [String]
    public var pathGlobs: [String]
    public var extensions: [String]
}

public struct DownloadDirectoryRules: Codable, Sendable {
    public var version: Int
    public var enabled: Bool
    public var rules: [DownloadDirectoryRule]
    public static let disabled = DownloadDirectoryRules(version: 1, enabled: false, rules: [])

    public static func decode(_ data: Data) throws -> Self {
        guard data.count <= 64 * 1024 + 1024 else { throw DirectoryRuleError.invalidConfiguration }
        let configuration = try JSONDecoder().decode(Self.self, from: data)
        guard configuration.version == 1, configuration.rules.count <= 32,
              Set(configuration.rules.map(\.id)).count == configuration.rules.count else { throw DirectoryRuleError.invalidConfiguration }
        var patternCharacters = 0
        for rule in configuration.rules {
            guard rule.id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil,
                  !rule.name.isEmpty, rule.name.unicodeScalars.count <= 80,
                  !rule.directory.isEmpty, rule.directory.utf16.count <= 4096,
                  rule.directory.rangeOfCharacter(from: .controlCharacters) == nil,
                  !rule.hosts.isEmpty || !rule.pathGlobs.isEmpty || !rule.extensions.isEmpty else { throw DirectoryRuleError.invalidConfiguration }
            for patterns in [rule.hosts, rule.pathGlobs, rule.extensions] {
                guard patterns.count <= 8, patterns.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 256 && $0.rangeOfCharacter(from: .controlCharacters) == nil }) else { throw DirectoryRuleError.invalidConfiguration }
                patternCharacters += patterns.reduce(0) { $0 + $1.utf16.count }
            }
        }
        guard patternCharacters <= 8192 else { throw DirectoryRuleError.invalidConfiguration }
        return configuration
    }

    /// `*` matches any sequence and `?` exactly one Unicode scalar. No regex execution.
    public static func glob(_ pattern: String, matches value: String) -> Bool {
        guard pattern.utf16.count <= 256, value.utf16.count <= 4096 else { return false }
        let pattern = Array(pattern.unicodeScalars), value = Array(value.unicodeScalars)
        var row = [Bool](repeating: false, count: value.count + 1)
        row[0] = true
        for token in pattern {
            var next = [Bool](repeating: false, count: value.count + 1)
            if token == "*" { next[0] = row[0] }
            for index in value.indices {
                next[index + 1] = token == "*" ? row[index + 1] || next[index]
                    : row[index] && (token == "?" || token == value[index])
            }
            row = next
        }
        return row[value.count]
    }

    public func directory(url raw: String, filename: String?, explicit: URL?, fallback: URL) -> URL {
        if let explicit { return explicit }
        guard enabled, let url = URL(string: raw), ["http", "https", "ftp"].contains(url.scheme?.lowercased() ?? ""), let rawHost = url.host else { return fallback }
        var host = rawHost.lowercased()
        if host.hasSuffix(".") { host.removeLast() }
        let path = url.path(percentEncoded: true)
        let name = filename?.isEmpty == false ? filename! : path.components(separatedBy: "/").last ?? ""
        let decodedName = name.removingPercentEncoding ?? name
        let ext = (decodedName as NSString).pathExtension.lowercased()
        for rule in rules where rule.enabled && Self.isPOSIXDirectory(rule.directory) {
            let hostsMatch = rule.hosts.isEmpty || rule.hosts.contains { Self.glob($0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")), matches: host) }
            let pathMatches = rule.pathGlobs.isEmpty || rule.pathGlobs.contains { Self.glob($0, matches: path) }
            let extensionMatches = rule.extensions.isEmpty || rule.extensions.contains { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == ext }
            if hostsMatch && pathMatches && extensionMatches { return URL(fileURLWithPath: rule.directory, isDirectory: true) }
        }
        return fallback
    }

    private static func isPOSIXDirectory(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasPrefix("//") && path == path.trimmingCharacters(in: .whitespacesAndNewlines)
            && !path.components(separatedBy: CharacterSet(charactersIn: "/\\")).contains(where: { $0 == "." || $0 == ".." })
    }
}

public enum DirectoryRuleError: Error, LocalizedError {
    case invalidConfiguration
    public var errorDescription: String? { "下载目录规则无法读取，请在设置中检查并重新保存。现有任务和文件已保留。" }
}

/// Loading errors affect new destination decisions, never existing task data.
public final class DownloadDirectoryRuleStore: @unchecked Sendable {
    private let path: URL
    private let lock = NSLock()
    private var current: Result<DownloadDirectoryRules, Error> = .success(.disabled)
    public init(path: URL) { self.path = path; try? reload() }
    public func reload() throws {
        lock.lock(); defer { lock.unlock() }
        do {
            if !FileManager.default.fileExists(atPath: path.path) { current = .success(.disabled); return }
            let size = try path.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
            guard size.isRegularFile == true, let count = size.fileSize, count <= 64 * 1024 + 1024 else { throw DirectoryRuleError.invalidConfiguration }
            current = .success(try DownloadDirectoryRules.decode(Data(contentsOf: path)))
        } catch { current = .failure(DirectoryRuleError.invalidConfiguration); throw DirectoryRuleError.invalidConfiguration }
    }
    public func directory(url: String, filename: String?, explicit: URL?, fallback: URL) throws -> URL {
        if let explicit { return explicit }
        lock.lock(); defer { lock.unlock() }
        return try current.get().directory(url: url, filename: filename, explicit: nil, fallback: fallback)
    }
}
