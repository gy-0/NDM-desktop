import Foundation
import UniformTypeIdentifiers

/// Picks a user-facing download filename that keeps a real extension.
///
/// GitHub / CDN URLs often end in `master`, bare UUIDs, or `download` with the
/// true name only in `Content-Disposition` / `Content-Type`. Using the last path
/// component alone produces extensionless junk in Finder.
public enum DownloadFilename {
    /// Build the best available on-disk name.
    public static func resolve(
        preferred: String? = nil,
        contentDispositionName: String? = nil,
        url: URL,
        mimeType: String? = nil,
        pageTitle: String? = nil
    ) -> String {
        let normalizedPreferred = normalizedCandidate(preferred)
        let normalizedDisposition = normalizedCandidate(contentDispositionName)
        let normalizedURLName = normalizedCandidate(url.lastPathComponent)

        // DownloadManager initially seeds `preferred` from the URL path. Once
        // the HTTP response supplies a real Content-Disposition name, that
        // URL-derived placeholder must yield (for example, `download.php` ->
        // `Report.pdf`). A different preferred name is explicit/user-provided
        // and remains authoritative.
        let preferredIsURLDerived = normalizedPreferred != nil
            && normalizedPreferred?.caseInsensitiveCompare(normalizedURLName ?? "") == .orderedSame
        let dispositionIsCredible = normalizedDisposition.map {
            isUseful($0) || isPlausibleStem($0)
        } ?? false
        let dispositionOverridesURL = preferredIsURLDerived && dispositionIsCredible

        let candidates: [String] = ([
            normalizedPreferred,
            normalizedDisposition,
            synthesizedArchiveName(from: url),
            normalizedURLName,
            pageTitle.flatMap { titleStem($0) },
        ]).compactMap { $0 }

        // Prefer names that already look like real files; otherwise keep a
        // human stem (page title) and let ensureExtension attach the type.
        let base = (dispositionOverridesURL ? normalizedDisposition : nil)
            ?? candidates.first(where: isUseful(_:))
            ?? candidates.first(where: isPlausibleStem(_:))
            ?? synthesizedArchiveName(from: url).map(sanitize)
            ?? "download"
        return ensureExtension(base, mimeType: mimeType, url: url)
    }

    /// True when a name is worth keeping (has an extension or looks intentional).
    public static func isUseful(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let stem = (trimmed as NSString).deletingPathExtension
        let ext = (trimmed as NSString).pathExtension
        if stem.isEmpty { return false }
        if looksLikeOpaqueToken(stem) { return false }
        let lower = stem.lowercased()
        if uselessStems.contains(lower) { return false }
        // Extensionless CDN tokens / branch names are not useful final names.
        return !ext.isEmpty
    }

    /// Human-readable stem we can still attach an extension to.
    private static func isPlausibleStem(_ name: String) -> Bool {
        let stem = (name as NSString).deletingPathExtension
        guard !stem.isEmpty, stem.count >= 2 else { return false }
        if looksLikeOpaqueToken(stem) { return false }
        if uselessStems.contains(stem.lowercased()) { return false }
        return true
    }

    /// Append a MIME / URL-derived extension when the name has none.
    public static func ensureExtension(
        _ name: String,
        mimeType: String?,
        url: URL? = nil
    ) -> String {
        let trimmed = sanitize(name)
        guard !trimmed.isEmpty else {
            let ext = extensionForMIME(mimeType) ?? extensionFromURL(url) ?? "bin"
            return "download.\(ext)"
        }
        if !(trimmed as NSString).pathExtension.isEmpty {
            return trimmed
        }
        if let ext = extensionForMIME(mimeType) ?? extensionFromURL(url) {
            return "\(trimmed).\(ext)"
        }
        return trimmed
    }

    /// Finder-style numbering for a name that is already taken: `Report.pdf`,
    /// `Report (2).pdf`, `Report (3).pdf`.
    ///
    /// Shared so that everything producing a file beside an existing one numbers it
    /// the same way. Overwriting is never an option here — a second copy is
    /// recoverable, a destroyed original is not.
    public static func uniqueURL(
        _ url: URL,
        exists: (URL) -> Bool = { FileManager.default.fileExists(atPath: $0.path) }
    ) -> URL {
        guard exists(url) else { return url }
        let folder = url.deletingLastPathComponent()
        let ext = url.pathExtension
        let stem = url.deletingPathExtension().lastPathComponent
        var index = 2
        while true {
            let name = ext.isEmpty ? "\(stem) (\(index))" : "\(stem) (\(index)).\(ext)"
            let candidate = folder.appendingPathComponent(name)
            if !exists(candidate) { return candidate }
            index += 1
            // A folder cannot realistically hold this many collisions; refuse to
            // spin rather than loop forever on a pathological filesystem.
            if index > 10_000 { return candidate }
        }
    }

    public static func sanitize(_ raw: String) -> String {
        let invalid = CharacterSet(charactersIn: "/\\:?%*|\"<>\n\r\t")
        var cleaned = raw
            .components(separatedBy: invalid)
            .joined(separator: "-")
            .replacingOccurrences(of: "  +", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip a lone trailing dot left by bad templates (`name.`).
        while cleaned.hasSuffix(".") { cleaned.removeLast() }
        if cleaned.count > 180 { cleaned = String(cleaned.prefix(180)) }
        return cleaned
    }

    // MARK: - Internals

    private static func normalizedCandidate(_ raw: String?) -> String? {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else { return nil }
        let cleaned = sanitize(trimmed)
        return cleaned.isEmpty ? nil : cleaned
    }

    private static let uselessStems: Set<String> = [
        "master", "main", "head", "develop", "dev", "trunk",
        "download", "downloads", "file", "files", "get", "index",
        "raw", "blob", "latest", "release", "releases", "asset",
        "data", "binary", "payload", "content", "attachment",
    ]

    private static func looksLikeOpaqueToken(_ stem: String) -> Bool {
        // UUID
        if stem.range(
            of: #"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"#,
            options: .regularExpression
        ) != nil {
            return true
        }
        // Long hex / base64-ish CDN tokens
        if stem.count >= 32,
           stem.range(of: #"^[0-9a-fA-F]+$"#, options: .regularExpression) != nil {
            return true
        }
        if stem.count >= 40,
           stem.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression) != nil,
           stem.rangeOfCharacter(from: .decimalDigits) != nil {
            return true
        }
        return false
    }

    /// `codeload.github.com/owner/repo/zip/refs/heads/master` → `repo-master.zip`
    private static func synthesizedArchiveName(from url: URL) -> String? {
        let host = url.host?.lowercased() ?? ""
        let parts = url.pathComponents.filter { $0 != "/" }
        guard host.contains("github") || host == "codeload.github.com" else { return nil }

        // /owner/repo/zip/refs/heads/<ref>
        if let zipIdx = parts.firstIndex(of: "zip"),
           zipIdx >= 2,
           parts.count > zipIdx + 1 {
            let repo = parts[zipIdx - 1]
            let ref = parts.last ?? "source"
            return "\(repo)-\(ref).zip"
        }
        // /owner/repo/archive/refs/heads/<ref>.zip (already has ext — last component)
        if parts.contains("archive"), let last = parts.last, last.lowercased().hasSuffix(".zip") {
            return last
        }
        // /owner/repo/releases/download/tag/file.ext
        if let downloadIdx = parts.firstIndex(of: "download"),
           downloadIdx + 1 < parts.count - 1,
           let file = parts.last,
           !(file as NSString).pathExtension.isEmpty {
            return file
        }
        return nil
    }

    private static func titleStem(_ title: String) -> String? {
        let cleaned = sanitize(title)
        guard !cleaned.isEmpty else { return nil }
        return String(cleaned.prefix(80))
    }

    /// Extensions that name a *playlist*, never the media a download delivers.
    /// Attaching one produces a file whose bytes are a real video but which macOS
    /// will not open — the delivered name has to describe the payload.
    private static let playlistExtensions: Set<String> = ["m3u8", "m3u", "mpd"]

    private static func extensionFromURL(_ url: URL?) -> String? {
        guard let url else { return nil }
        let ext = url.pathExtension.lowercased()
        if ext.isEmpty || playlistExtensions.contains(ext) { return nil }
        return ext
    }

    private static func extensionForMIME(_ mimeType: String?) -> String? {
        guard var mime = mimeType?.trimmingCharacters(in: .whitespacesAndNewlines),
              !mime.isEmpty else { return nil }
        if let semi = mime.firstIndex(of: ";") {
            mime = String(mime[..<semi]).trimmingCharacters(in: .whitespaces)
        }
        let lower = mime.lowercased()
        switch lower {
        case "application/zip", "application/x-zip-compressed": return "zip"
        case "application/gzip", "application/x-gzip": return "gz"
        case "application/x-tar": return "tar"
        case "application/x-7z-compressed": return "7z"
        case "application/x-rar-compressed", "application/vnd.rar": return "rar"
        case "application/x-apple-diskimage": return "dmg"
        case "application/x-iso9660-image": return "iso"
        case "application/pdf": return "pdf"
        case "application/octet-stream": return nil
        case "video/mp4": return "mp4"
        case "video/webm": return "webm"
        case "video/quicktime": return "mov"
        case "audio/mpeg": return "mp3"
        case "audio/mp4", "audio/aac": return "m4a"
        case "image/png": return "png"
        case "image/jpeg": return "jpg"
        case "image/webp": return "webp"
        case "text/html": return "html"
        case "text/plain": return "txt"
        case "application/json": return "json"
        default:
            break
        }
        if let type = UTType(mimeType: lower),
           let ext = type.preferredFilenameExtension,
           !ext.isEmpty {
            return ext
        }
        return nil
    }
}
