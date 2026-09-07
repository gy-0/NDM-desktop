import Foundation

/// Conservative, local-only duplicate recognition for Link Lens.
///
/// Known media sites use their stable content id, so a short/share URL can
/// match the canonical page discovered later. Other URLs keep every query item
/// except well-known marketing parameters; signed download URLs therefore do
/// not get incorrectly collapsed just because their paths happen to match.
public enum DuplicateDownloadMatcher {
    public static func bestMatch(
        for urlStrings: [String],
        in tasks: [DownloadTask]
    ) -> DownloadTask? {
        let wanted = Set(urlStrings.compactMap(canonicalKey))
        guard !wanted.isEmpty else { return nil }

        return tasks
            .filter { task in
                candidateURLs(for: task)
                    .compactMap(canonicalKey)
                    .contains(where: wanted.contains)
            }
            .min { lhs, rhs in
                let lhsRank = statusRank(lhs.status)
                let rhsRank = statusRank(rhs.status)
                if lhsRank != rhsRank { return lhsRank < rhsRank }
                return lhs.id > rhs.id
            }
    }

    public static func canonicalKey(for raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              ["http", "https", "ftp"].contains(scheme),
              let rawHost = components.host?.lowercased() else { return nil }

        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        let pathParts = components.path
            .split(separator: "/")
            .map(String.init)

        if host == "youtu.be", let id = pathParts.first, !id.isEmpty {
            return "youtube:video:\(id)"
        }
        if host == "youtube.com" || host.hasSuffix(".youtube.com") {
            if let id = queryValue("v", in: components), !id.isEmpty {
                return "youtube:video:\(id)"
            }
            if let marker = pathParts.first,
               ["shorts", "live", "embed"].contains(marker.lowercased()),
               pathParts.count > 1 {
                return "youtube:video:\(pathParts[1])"
            }
            if let list = queryValue("list", in: components), !list.isEmpty {
                return "youtube:collection:\(list)"
            }
        }

        if host == "bilibili.com" || host.hasSuffix(".bilibili.com") {
            if let id = pathParts.first(where: {
                let lower = $0.lowercased()
                return lower.hasPrefix("bv") || lower.range(of: #"^av[0-9]+$"#, options: .regularExpression) != nil
            }) {
                return "bilibili:video:\(id.lowercased())"
            }
        }

        if host == "douyin.com" || host.hasSuffix(".douyin.com") {
            if let id = value(after: "video", in: pathParts) {
                return "douyin:video:\(id)"
            }
        }

        if host == "xiaohongshu.com" || host.hasSuffix(".xiaohongshu.com") {
            if let id = value(after: "explore", in: pathParts)
                ?? value(after: "item", in: pathParts) {
                return "xiaohongshu:item:\(id)"
            }
        }

        if host == "tiktok.com" || host.hasSuffix(".tiktok.com"),
           let id = value(after: "video", in: pathParts) {
            return "tiktok:video:\(id)"
        }

        components.scheme = scheme
        components.host = rawHost
        components.fragment = nil
        components.queryItems = components.queryItems?
            .filter { !isTrackingQueryName($0.name) }
            .sorted {
                if $0.name != $1.name { return $0.name < $1.name }
                return ($0.value ?? "") < ($1.value ?? "")
            }
        if components.queryItems?.isEmpty == true { components.queryItems = nil }
        if (scheme == "https" && components.port == 443)
            || (scheme == "http" && components.port == 80) {
            components.port = nil
        }
        if components.path.isEmpty { components.path = "/" }
        return components.string.map { "url:\($0)" }
    }

    private static func candidateURLs(for task: DownloadTask) -> [String] {
        var urls = [task.url]
        if let alternate = task.alternateURL, !alternate.isEmpty {
            urls.append(alternate)
        }
        // A browser page may contain many unrelated assets. Page URL is only a
        // content identity for media-page tasks and collection entries.
        if task.linkType.lowercased() == "ytdlp",
           let page = task.pageURL, !page.isEmpty {
            urls.append(page)
        }
        return urls
    }

    private static func statusRank(_ status: DownloadStatus) -> Int {
        switch status {
        case .downloading, .waiting: return 0
        case .complete: return 1
        case .paused: return 2
        case .incomplete, .error: return 3
        }
    }

    private static func queryValue(_ name: String, in components: URLComponents) -> String? {
        components.queryItems?.first { $0.name.caseInsensitiveCompare(name) == .orderedSame }?.value
    }

    private static func value(after marker: String, in parts: [String]) -> String? {
        guard let index = parts.firstIndex(where: { $0.caseInsensitiveCompare(marker) == .orderedSame }),
              parts.indices.contains(index + 1),
              !parts[index + 1].isEmpty else { return nil }
        return parts[index + 1]
    }

    private static func isTrackingQueryName(_ raw: String) -> Bool {
        let name = raw.lowercased()
        if name.hasPrefix("utm_") { return true }
        return [
            "feature", "si", "spm_id_from", "share_source", "share_medium",
            "share_plat", "share_session_id", "share_tag", "share_token",
            "is_from_webapp", "sender_device", "sender_web_id", "share_app_id",
        ].contains(name)
    }
}
