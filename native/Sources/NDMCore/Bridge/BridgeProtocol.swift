import Foundation

/// Host WebSocket constants for the local browser-extension bridge.
public enum BridgeConstants {
    public static let host = "127.0.0.1"
    /// Dedicated NDM bridge port. The original Neat Download Manager owns
    /// 10007, so reusing it prevents both apps from running side by side.
    public static let port: UInt16 = 51_873
    public static let legacyNeatPort: UInt16 = 10_007
    public static let path = "/ndm/download"
    public static let subprotocol = "ndm.open.v1"
    public static let maxMessageBytes = 118_784

    public static var endpoint: String {
        "ws://\(host):\(port)\(path)"
    }

    public static let waiting = "waiting"
    public static let noWaiting = "nowaiting"
    public static let showPanelChromeOn = "ShowPanelChrome=1"
    public static let showPanelChromeOff = "ShowPanelChrome=0"
    public static let showPanelFoxOn = "ShowPanelFox=1"
    public static let showPanelFoxOff = "ShowPanelFox=0"
    public static let showPanelEdgeOn = "ShowPanelEdge=1"
    public static let showPanelEdgeOff = "ShowPanelEdge=0"
    public static let focusApp = "NDMControl: focus"

    /// Push media-panel visibility to all browser clients (Chrome/Firefox/Edge).
    public static func showPanelMessages(enabled: Bool) -> [String] {
        if enabled {
            return [showPanelChromeOn, showPanelFoxOn, showPanelEdgeOn]
        }
        return [showPanelChromeOff, showPanelFoxOff, showPanelEdgeOff]
    }
}

/// Extension → host text protocol (CRLF key:value lines).
public enum BridgeMessageParser {
    public static func parse(_ raw: String) throws -> ParsedBridgeMessage {
        if raw.utf8.count > BridgeConstants.maxMessageBytes {
            throw BridgeParseError.tooLarge
        }
        var msg = ParsedBridgeMessage()
        var body = raw
        let postKey = "__0NeatPostData9__:"
        if let r = body.range(of: postKey) {
            msg.postData = String(body[r.upperBound...])
            body = String(body[..<r.lowerBound])
        }
        for line in body.components(separatedBy: "\r\n") where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value = String(value.dropFirst()) }
            switch key {
            case "1": msg.method = value
            case "2": msg.url = value
            case "3": msg.filename = value
            case "4": msg.pageTitle = value
            case "5": msg.pageURL = value
            case "6": msg.ltype = value.isEmpty ? "normal" : value
            case "7": msg.fileSize = Int(value) ?? 0
            case "8": msg.contentType = value
            case "9": msg.userAgent = value
            case "10": msg.reqContentType = value
            case "11": msg.contentDisposition = value
            case "12": msg.alternateURL = value
            default:
                let lower = key.lowercased()
                if lower == "origin" { msg.origin = value }
                else if lower == "referer" { msg.referer = value }
                else if lower == "cookie" { msg.cookies = value }
                else if lower == "urla" { msg.alternateURL = value }
                else if lower.hasPrefix("x-") { msg.extraHeaders[key] = value }
                else if !key.isEmpty && key.first?.isNumber != true {
                    msg.extraHeaders[key] = value
                }
            }
        }
        guard !msg.url.isEmpty else { throw BridgeParseError.missingURL }
        return msg
    }
}

public struct ParsedBridgeMessage: Sendable, Equatable, Encodable {
    public var method = "GET"
    public var url = ""
    public var filename = ""
    public var pageTitle = ""
    public var pageURL = ""
    public var ltype = "normal"
    public var fileSize = 0
    public var contentType = ""
    public var userAgent = ""
    public var reqContentType = ""
    public var contentDisposition = ""
    public var origin = ""
    public var referer = ""
    public var cookies = ""
    public var postData: String?
    public var extraHeaders: [String: String] = [:]
    /// Second URL for MKV dual-track (audio) — protocol `urla` / field `12`.
    public var alternateURL = ""

    public init() {}
}

public enum BridgeParseError: Error {
    case tooLarge
    case missingURL
}

/// Correlation belongs to the bridge envelope, never to origin HTTP headers.
public struct ParsedRelayDownload: Sendable {
    public let requestID: String
    public let message: ParsedBridgeMessage
}

public struct BridgeDurableReceipt: Sendable, Codable, Equatable {
    public enum Status: String, Sendable, Codable { case accepted, rejected, deleted }
    public let status: Status
    public let taskID: Int64?
    public let error: String?
    public init(status: Status, taskID: Int64? = nil, error: String? = nil) {
        self.status = status; self.taskID = taskID; self.error = error
    }
}

public enum BridgeDurableProtocol {
    public static let requestPrefix = "NDMRelayDownload:"
    public static let receiptPrefix = "NDMRelayReceipt:"
    public enum Failure: Error { case malformed }
    public static func validRequestID(_ value: String) -> Bool {
        (16...128).contains(value.utf8.count) && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95
        }
    }
    /// Only returns a correlation ID from a bounded, well-formed envelope.
    public static func requestID(in raw: String) -> String? {
        guard let object = object(raw), let id = object["requestId"] as? String, validRequestID(id) else { return nil }
        return id
    }
    public static func parse(_ raw: String) throws -> ParsedRelayDownload {
        guard let object = object(raw), Set(object.keys) == ["requestId", "payload"],
              let id = object["requestId"] as? String, validRequestID(id),
              let payload = object["payload"] as? String else { throw Failure.malformed }
        return ParsedRelayDownload(requestID: id, message: try BridgeMessageParser.parse(payload))
    }
    private static func object(_ raw: String) -> [String: Any]? {
        guard raw.hasPrefix(requestPrefix), raw.utf8.count <= BridgeConstants.maxMessageBytes else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(raw.dropFirst(requestPrefix.count).utf8))) as? [String: Any]
    }
    public static func encodeReceipt(requestID: String, receipt: BridgeDurableReceipt) throws -> String {
        guard validRequestID(requestID) else { throw Failure.malformed }
        var object: [String: Any] = ["requestId": requestID, "status": receipt.status.rawValue]
        if let id = receipt.taskID { object["taskId"] = id }
        if let error = receipt.error {
            // Error codes only. Never expose arbitrary native error text or credentials.
            object["error"] = !error.isEmpty && error.utf8.count <= 128 && error.utf8.allSatisfy {
                (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
            } ? error : "internal-error"
        }
        return receiptPrefix + String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
    }
}
