import Foundation

/// Only known file formats establish non-webpage intent. HTML, text, and
/// extensionless endpoint downloads remain valid; this is not content sniffing.
enum HTTPFileResponsePolicy {
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
