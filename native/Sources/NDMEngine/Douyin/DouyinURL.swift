// Adapted and modified from MIT-licensed douyin-downloader.
// Pinned upstream references and full license: licenses/douyin/NOTICE.md.
import Foundation

/// A parsed Douyin link. Douyin spreads one product across several URL shapes
/// (share short links, modal query parameters, note/gallery aliases), so the
/// classifier is the single place that decides what a pasted address means.
public enum DouyinLink: Equatable, Sendable {
    case short
    case video(awemeID: String)
    case gallery(noteID: String)
    case user(secUID: String)
    case collection(mixID: String)
    case music(musicID: String)
    case live(roomID: String)
    case liveReplay(episodeID: String)
}

public enum DouyinURL {
    /// Share-sheet short hosts that need a redirect expansion before parsing.
    static let shortHosts: Set<String> = ["v.douyin.com", "v.iesdouyin.com"]

    static func isDouyin(_ raw: String) -> Bool {
        guard let host = URL(string: raw)?.host?.lowercased() else { return false }
        return isDouyinHost(host)
    }

    static func isDouyinHost(_ host: String) -> Bool {
        let host = host.lowercased()
        if host == "douyin.com" || host.hasSuffix(".douyin.com") { return true }
        if host == "iesdouyin.com" || host.hasSuffix(".iesdouyin.com") { return true }
        if host == "amemv.com" || host.hasSuffix(".amemv.com") { return true }
        return false
    }

    static func parse(_ raw: String) -> DouyinLink? {
        guard let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host?.lowercased(),
              isDouyinHost(host) else { return nil }
        if shortHosts.contains(host) { return .short }
        let path = components.path

        if host == "live.douyin.com", let room = firstMatch(path, #"^/(\d+)/?$"#) {
            return .live(roomID: room)
        }
        if host == "webcast.amemv.com",
           let room = firstMatch(path, #"^/douyin/webcast/reflow/(\d+)/?$"#) {
            return .live(roomID: room)
        }

        if let awemeID = queryValue(components, named: "modal_id"), isDigits(awemeID) {
            return .video(awemeID: awemeID)
        }
        if let awemeID = firstMatch(path, #"/video/(\d+)"#) {
            return .video(awemeID: awemeID)
        }
        if let noteID = firstMatch(path, #"/(?:note|gallery|slides)/(\d+)"#) {
            return .gallery(noteID: noteID)
        }
        if let secUID = firstMatch(path, #"/user/([A-Za-z0-9_-]+)"#) {
            return .user(secUID: secUID)
        }
        if let mixID = firstMatch(path, #"/(?:collection|mix)/(\d+)"#) {
            return .collection(mixID: mixID)
        }
        if let musicID = firstMatch(path, #"/music/(\d+)"#) {
            return .music(musicID: musicID)
        }
        if let episodeID = firstMatch(path, #"^/vsdetail/(\d+)(?:/|$)"#) {
            return .liveReplay(episodeID: episodeID)
        }
        if let roomID = firstMatch(path, #"/(?:follow/|share/)?live/(\d+)/?$"#) {
            return .live(roomID: roomID)
        }
        return nil
    }

    /// The aweme identity behind video and gallery links; everything that
    /// resolves through the shared detail endpoint uses this.
    static func awemeID(for link: DouyinLink) -> String? {
        switch link {
        case .video(let awemeID): return awemeID
        case .gallery(let noteID): return noteID
        default: return nil
        }
    }

    private static func firstMatch(_ value: String, _ pattern: String) -> String? {
        guard let expression = try? NSRegularExpression(pattern: pattern),
              let match = expression.firstMatch(
                in: value,
                range: NSRange(value.startIndex..., in: value)
              ),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: value) else { return nil }
        return String(value[range])
    }

    private static func queryValue(_ components: URLComponents, named name: String) -> String? {
        components.queryItems?.first { $0.name.lowercased() == name }?.value
    }

    private static func isDigits(_ value: String) -> Bool {
        !value.isEmpty && value.allSatisfy { $0.isNumber }
    }
}
