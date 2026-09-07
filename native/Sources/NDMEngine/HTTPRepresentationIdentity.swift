import Foundation
import CryptoKit
import NDMCore

/// Only strong validators can join bytes obtained by separate HTTP requests.
struct HTTPRepresentationIdentity: Codable, Equatable, Sendable {
    enum Failure: Error, LocalizedError {
        case changed
        var errorDescription: String? {
            L10n.t("The file changed or its validator disappeared during download. Retry to start a consistent copy.",
                   "下载过程中源文件已变化，或服务器未返回一致的文件标识。请重试以下载完整的新版本。")
        }
    }
    enum Validator: Codable, Equatable, Sendable {
        case etag(String)
        case lastModified(String)

        var ifRange: String {
            switch self { case .etag(let value), .lastModified(let value): return value }
        }

        static func from(_ response: HTTPURLResponse) -> Self? {
            if let tag = response.value(forHTTPHeaderField: "ETag")?.trimmingCharacters(in: .whitespaces),
               tag.hasPrefix("\""), tag.hasSuffix("\""), tag.count >= 2 {
                return .etag(tag)
            }
            // RFC 9110 8.8.2.2: dates are strong for client range requests only
            // when the origin Date is at least 60 seconds after Last-Modified.
            if response.value(forHTTPHeaderField: "ETag") == nil,
               let modified = response.value(forHTTPHeaderField: "Last-Modified"),
               let date = response.value(forHTTPHeaderField: "Date"),
               let modifiedDate = httpDate(modified), let responseDate = httpDate(date),
               responseDate.timeIntervalSince(modifiedDate) >= 60 {
                return .lastModified(modified)
            }
            return nil
        }

        func matches(_ response: HTTPURLResponse) -> Bool {
            switch self {
            case .etag(let expected): return response.value(forHTTPHeaderField: "ETag") == expected
            case .lastModified(let expected): return response.value(forHTTPHeaderField: "Last-Modified") == expected
            }
        }

        private static func httpDate(_ value: String) -> Date? {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
            return formatter.date(from: value)
        }
    }

    let version: Int
    let requestFingerprint: String
    let totalBytes: Int64
    let validator: Validator

    init(request: DownloadRequest, totalBytes: Int64, validator: Validator) {
        version = 1
        // Hash request context rather than putting URLs, cookies or credentials
        // into another plaintext metadata file. Stable ordering is essential.
        let context = [request.url.absoluteString, request.method,
                       request.body?.base64EncodedString() ?? "", request.userAgent ?? "",
                       request.username ?? "", request.password ?? "", request.pageURL?.absoluteString ?? "",
                       request.headers.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: "\n")]
        requestFingerprint = SHA256.hash(data: Data(context.joined(separator: "\u{0}").utf8)).map { String(format: "%02x", $0) }.joined()
        self.totalBytes = totalBytes
        self.validator = validator
    }

    static func file(in directory: URL) -> URL { directory.appendingPathComponent("representation.json") }
    func save(in directory: URL) throws {
        try JSONEncoder().encode(self).write(to: Self.file(in: directory), options: .atomic)
    }
    static func load(in directory: URL) -> Self? {
        guard let data = try? Data(contentsOf: file(in: directory)) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}
