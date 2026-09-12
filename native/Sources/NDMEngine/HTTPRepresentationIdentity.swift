import Foundation
import CryptoKit
import NDMCore

/// Only strong validators can join bytes obtained by separate HTTP requests.
struct HTTPRepresentationIdentity: Codable, Equatable, Sendable {
    enum Failure: Error, LocalizedError {
        case changed
        var errorDescription: String? {
            L10n.t("The saved download cannot be safely resumed. Existing files were kept. Add a new download to start again.",
                   "无法确认已保存的下载能安全接续，现有文件已保留。请新建下载任务以重新下载。")
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
    let redirectedResourceFingerprint: String?

    init(request: DownloadRequest, totalBytes: Int64, validator: Validator, redirectedResourceURL: URL? = nil) {
        version = redirectedResourceURL == nil ? 1 : 2
        requestFingerprint = Self.fingerprint(for: request)
        self.totalBytes = totalBytes
        self.validator = validator
        redirectedResourceFingerprint = redirectedResourceURL.map {
            SHA256.hash(data: Data($0.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        }
    }

    static func fingerprint(for request: DownloadRequest) -> String {
        // Hash request context rather than putting URLs, cookies or credentials
        // into another plaintext metadata file. Stable ordering is essential.
        let context = [request.url.absoluteString, request.method,
                       request.body?.base64EncodedString() ?? "", request.userAgent ?? "",
                       request.username ?? "", request.password ?? "", request.pageURL?.absoluteString ?? "",
                       request.headers.sorted { $0.key < $1.key }.map { "\($0.key):\($0.value)" }.joined(separator: "\n")]
        return SHA256.hash(data: Data(context.joined(separator: "\u{0}").utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Bind offset checkpoints to both request context and the exact representation.
    /// The request fingerprint alone is unchanged when an origin replaces a file.
    var storageContextHash: String {
        let validatorFields: [String]
        switch validator {
        case .etag(let value): validatorFields = ["etag", value]
        case .lastModified(let value): validatorFields = ["last-modified", value]
        }
        // Length-prefix each UTF-8 field so separators inside validators cannot collide.
        var fields = ["ndm-offset-representation", String(version), requestFingerprint,
                      String(totalBytes)] + validatorFields
        // Preserve version 1 hashes for ordinary non-redirected downloads. Old
        // redirected receipts have no target binding and cannot adopt version 2.
        if let redirectedResourceFingerprint { fields.append(redirectedResourceFingerprint) }
        var data = Data()
        for field in fields {
            let bytes = Data(field.utf8)
            data.append(Data("\(bytes.count):".utf8))
            data.append(bytes)
        }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
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
