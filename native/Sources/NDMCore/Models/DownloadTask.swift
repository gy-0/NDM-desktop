import Foundation

/// Mirrors the conceptual fields of original `downloads` table.
public struct DownloadTask: Identifiable, Codable, Sendable, Equatable {
    public var id: Int64
    public var url: String
    public var method: String
    public var filename: String
    public var linkType: String
    public var fileSize: Int64
    public var category: DownloadCategory
    public var status: DownloadStatus
    public var bandwidthLimit: Int64
    public var connections: Int
    public var lastTry: Date?
    public var firstTry: Date?
    public var completedAt: Date?
    /// When a `.waiting` task should start on its own.
    ///
    /// Nil means "waiting for a slot" — the existing queue behaviour. Non-nil means
    /// "waiting for a clock", which is a different kind of waiting and the only new
    /// state this feature introduces.
    public var startAt: Date?
    public var userAgent: String?
    public var resumable: Bool
    public var pageURL: String?
    public var pageTitle: String?
    /// Remote preview image discovered during media probing. The desktop shell
    /// may prefer a local Quick Look thumbnail once the file exists.
    public var thumbnailURL: String?
    public var hitTitle: String?
    public var mimeType: String?
    public var errorText: String?
    public var alternateURL: String?
    public var postData: Data?
    public var folderPath: String?
    public var headers: [String]
    /// Stable `DeliveryNote.storageKey` for a delivery that succeeded but is not
    /// what the user asked for. Nil on a clean delivery.
    public var deliveryNote: String?

    public init(
        id: Int64 = 0,
        url: String,
        method: String = "GET",
        filename: String = "",
        linkType: String = "normal",
        fileSize: Int64 = 0,
        category: DownloadCategory = .misc,
        status: DownloadStatus = .incomplete,
        bandwidthLimit: Int64 = 0,
        connections: Int = 32,
        lastTry: Date? = nil,
        firstTry: Date? = nil,
        completedAt: Date? = nil,
        startAt: Date? = nil,
        userAgent: String? = nil,
        resumable: Bool = false,
        pageURL: String? = nil,
        pageTitle: String? = nil,
        thumbnailURL: String? = nil,
        hitTitle: String? = nil,
        mimeType: String? = nil,
        errorText: String? = nil,
        alternateURL: String? = nil,
        postData: Data? = nil,
        folderPath: String? = nil,
        headers: [String] = [],
        deliveryNote: String? = nil
    ) {
        self.id = id
        self.url = url
        self.method = method
        self.filename = filename
        self.linkType = linkType
        self.fileSize = fileSize
        self.category = category
        self.status = status
        self.bandwidthLimit = bandwidthLimit
        self.connections = connections
        self.lastTry = lastTry
        self.firstTry = firstTry
        self.completedAt = completedAt
        self.startAt = startAt
        self.userAgent = userAgent
        self.resumable = resumable
        self.pageURL = pageURL
        self.pageTitle = pageTitle
        self.thumbnailURL = thumbnailURL
        self.hitTitle = hitTitle
        self.mimeType = mimeType
        self.errorText = errorText
        self.alternateURL = alternateURL
        self.postData = postData
        self.folderPath = folderPath
        self.headers = headers
        self.deliveryNote = deliveryNote
    }

    /// Final file URL when the download manager has persisted a destination.
    public var destinationFileURL: URL? {
        guard let folderPath, !folderPath.isEmpty, !filename.isEmpty else { return nil }
        return URL(fileURLWithPath: folderPath, isDirectory: true)
            .appendingPathComponent(filename, isDirectory: false)
    }

    /// One canonical recency value for every surface that presents task
    /// activity. A retry can make an old database row the newest thing the
    /// user did; a later completion can then advance it once more.
    public var mostRecentActivity: Date? {
        [lastTry, completedAt, firstTry].compactMap { $0 }.max()
    }
}

public enum DownloadStatus: String, Codable, Sendable, CaseIterable {
    case incomplete
    case complete
    case paused
    case downloading
    case error
    case waiting
}

public enum DownloadCategory: String, Codable, Sendable, CaseIterable {
    case video
    case audio
    case document
    case compressed
    case application
    case image
    case misc

    public static func infer(filename: String, mimeType: String?) -> DownloadCategory {
        let ext = (filename as NSString).pathExtension.lowercased()
        if let mimeType {
            if mimeType.hasPrefix("video/") { return .video }
            if mimeType.hasPrefix("audio/") { return .audio }
            if mimeType.hasPrefix("image/") { return .image }
            if mimeType.contains("zip") || mimeType.contains("rar") || mimeType.contains("7z") {
                return .compressed
            }
            if mimeType.contains("pdf") || mimeType.contains("msword") || mimeType.contains("text") {
                return .document
            }
        }
        switch ext {
        case "mp4", "mkv", "avi", "mov", "webm", "ts", "flv", "m3u8": return .video
        case "mp3", "m4a", "aac", "wav", "flac", "ogg": return .audio
        case "pdf", "doc", "docx", "txt", "epub", "rtf": return .document
        case "zip", "rar", "7z", "tar", "gz", "iso": return .compressed
        case "exe", "msi", "pkg", "apk", "dmg": return .application
        case "jpg", "jpeg", "png", "gif", "webp", "svg": return .image
        default: return .misc
        }
    }
}
