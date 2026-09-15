import Foundation
import NDMCore

/// Bind reviewed opaque selection and destination to the existing creation
/// receipt. The transient resource URL and cookies never become receipt input.
public struct RelayPageMediaAdmission: Sendable {
    public let pageURL: String
    public let sourceToken: String
    public let mediaKey: String
    public let connections: Int?
    public let destinationDirectory: URL?
    public let filename: String?
    public let intent: DownloadCreationIntent

    public init(request: [String: Any]) throws {
        guard let pageURL = request["pageURL"] as? String, RelayPageMediaRequests.pageIdentity(pageURL) != nil,
              let sourceToken = request["sourceToken"] as? String, UUID(uuidString: sourceToken) != nil,
              let mediaKey = request["mediaKey"] as? String, (16...128).contains(mediaKey.utf8.count),
              mediaKey.range(of: "^[a-zA-Z0-9:_-]+$", options: .regularExpression) != nil,
              let key = request["creationKey"] as? String else { throw RelayPageMediaRequests.Failure.invalid }
        if let value = request["connections"], !(value is NSNull) {
            guard let count = value as? Int, (1...32).contains(count) else { throw RelayPageMediaRequests.Failure.invalid }
            connections = count
        } else { connections = nil }
        if let value = request["folderPath"], !(value is NSNull) {
            guard let path = value as? String, path.hasPrefix("/"), path.utf8.count <= 4096,
                  !path.utf8.contains(0) else { throw RelayPageMediaRequests.Failure.invalid }
            destinationDirectory = URL(fileURLWithPath: path)
        } else { destinationDirectory = nil }
        if let value = request["filename"], !(value is NSNull) {
            guard let name = value as? String, name.utf8.count <= 1024,
                  !name.unicodeScalars.contains(where: { $0.value < 32 }) else { throw RelayPageMediaRequests.Failure.invalid }
            filename = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : name
        } else { filename = nil }
        self.pageURL = pageURL; self.sourceToken = sourceToken; self.mediaKey = mediaKey
        var payload: [String: Any] = ["op": "addBrowserPageMedia", "pageURL": pageURL, "sourceToken": sourceToken, "mediaKey": mediaKey]
        if let connections { payload["connections"] = connections }
        if let destinationDirectory { payload["folderPath"] = destinationDirectory.path }
        if let filename { payload["filename"] = filename }
        intent = try DownloadCreationIntent(key: key, payload: payload)
    }

    public static func headers(from message: ParsedBridgeMessage) -> [String] {
        var headers = message.extraHeaders
        if !message.origin.isEmpty { headers["Origin"] = message.origin }
        if !message.referer.isEmpty { headers["Referer"] = message.referer }
        if !message.cookies.isEmpty { headers["Cookie"] = message.cookies }
        if !message.userAgent.isEmpty { headers["User-Agent"] = message.userAgent }
        return headers.sorted { $0.key < $1.key }.compactMap { name, value in
            guard !name.isEmpty, name.utf8.allSatisfy({ (33...126).contains($0) && $0 != 58 }),
                  !value.contains("\r"), !value.contains("\n"), !value.utf8.contains(0),
                  !["host", "connection", "content-length", "range", "proxy-authorization"].contains(name.lowercased()) else { return nil }
            return "\(name): \(value)"
        }
    }
}
