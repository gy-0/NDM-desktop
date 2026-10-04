import Foundation

/// Only known file formats establish non-webpage intent. HTML, text, and
/// extensionless endpoint downloads remain valid; this is not content sniffing.
enum HTTPFileResponsePolicy {
    struct ContentRange: Equatable {
        let start: Int64
        let end: Int64
        let total: Int64?
        var length: Int64 { end - start + 1 }
    }

    /// Parse a single satisfied byte range. A missing/invalid total cannot be
    /// replaced with Content-Length, which describes only this response body.
    static func contentRange(_ value: String?) -> ContentRange? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              value.lowercased().hasPrefix("bytes ") else { return nil }
        let fields = value.dropFirst(6).split(separator: "/", omittingEmptySubsequences: false)
        guard fields.count == 2 else { return nil }
        let bounds = fields[0].split(separator: "-", omittingEmptySubsequences: false)
        func decimal(_ field: Substring) -> Int64? {
            guard !field.isEmpty, field.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
            return Int64(field)
        }
        guard bounds.count == 2, let start = decimal(bounds[0]), let end = decimal(bounds[1]),
              start <= end, end < Int64.max else { return nil }
        let total: Int64?
        if fields[1] == "*" { total = nil }
        else {
            guard let parsed = decimal(fields[1]), parsed > end else { return nil }
            total = parsed
        }
        return ContentRange(start: start, end: end, total: total)
    }

    /// URLSession decodes content codings before delivering bytes. A byte range
    /// over gzip/br cannot be appended at the encoded representation's offsets.
    static func hasIdentityEncoding(_ response: HTTPURLResponse) -> Bool {
        guard let encoding = response.value(forHTTPHeaderField: "Content-Encoding") else { return true }
        return encoding.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "identity"
    }

    static func requiresFileResponse(filename: String) -> Bool {
        let extensions: Set<String> = ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "zst",
            "pdf", "epub", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "dmg", "pkg", "exe", "msi", "apk", "iso", "bin",
            "mp4", "mkv", "mov", "webm", "avi", "mp3", "m4a", "flac", "wav", "ogg",
            "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff"]
        return extensions.contains((filename as NSString).pathExtension.lowercased())
    }

    static func isHTML(_ mimeType: String?) -> Bool {
        let mime = mimeType?.split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return mime == "text/html" || mime == "application/xhtml+xml"
    }
}
