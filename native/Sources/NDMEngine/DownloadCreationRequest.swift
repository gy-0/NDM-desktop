import Foundation
import NDMCore

public enum DownloadCreationRequest {
    /// Bind the final RPC, not a transient resolved media URL or current app
    /// defaults. Authentication may be refreshed without changing the intent.
    public static func intent(from request: [String: Any]) throws -> DownloadCreationIntent? {
        guard let raw = request["creationKey"], !(raw is NSNull) else { return nil }
        guard let key = raw as? String else { throw DownloadCreationError.invalidKey }
        let op = request["op"] as? String ?? ""
        if op == "addMedia", request["collectionScope"] as? String == "all" {
            throw DownloadCreationError.collectionUnsupported
        }
        let fields = ["op", "url", "filename", "folderPath", "connections", "pageURL", "pageTitle",
                      "thumbnailURL", "formatID", "ltype", "method", "body", "postData", "autoStart",
                      "container", "subtitleLanguage", "collectionScope", "cookieBrowser"]
        var payload: [String: Any] = [:]
        for field in fields {
            if let value = request[field], !(value is NSNull) { payload[field] = value }
        }
        // Omitted/empty mirror lists retain legacy receipt hashes. Nonempty
        // lists are part of the immutable file intent, including their order.
        if let mirrors = request["mirrors"] as? [String], !mirrors.isEmpty { payload["mirrors"] = mirrors }
        if op == "auxiliaryCreate", let source = request["source"] as? [String: Any] { payload["source"] = source }
        if let headers = request["headers"] as? [String] {
            let stableHeaders = headers.filter { line in
                let name = line.split(separator: ":", maxSplits: 1).first.map(String.init)?
                    .trimmingCharacters(in: .whitespaces).lowercased()
                return name != "cookie" && name != "authorization" && name != "proxy-authorization"
            }
            if !stableHeaders.isEmpty { payload["headers"] = stableHeaders }
        }
        return try DownloadCreationIntent(key: key, payload: payload)
    }
}
