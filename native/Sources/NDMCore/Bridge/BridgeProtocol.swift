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

public struct ParsedBridgeMessage: Sendable, Equatable {
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
