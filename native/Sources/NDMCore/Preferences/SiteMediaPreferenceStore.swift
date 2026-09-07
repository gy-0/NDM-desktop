import Foundation

/// The delivery choices a user actually made for a video site.
///
/// This intentionally stores only a canonical site key and product-level
/// choices. Page URLs, titles, cookies, browser data, and media identifiers are
/// never part of the payload.
public struct SiteMediaPreference: Codable, Equatable, Sendable {
    public enum Container: String, Codable, Equatable, Sendable {
        case compatibleMP4
        case compactMKV
    }

    public var qualityHeight: Int
    public var container: Container
    public var subtitleLanguage: String?

    public init(
        qualityHeight: Int,
        container: Container,
        subtitleLanguage: String?
    ) {
        self.qualityHeight = max(0, qualityHeight)
        self.container = container
        self.subtitleLanguage = subtitleLanguage?.isEmpty == false
            ? subtitleLanguage
            : nil
    }

    /// Resolves a remembered preference against the current page probe.
    /// Missing quality tiers fall back to the product-recommended first row;
    /// missing subtitle tracks safely turn subtitles off.
    public func resolved(
        formatHeights: [Int],
        subtitleCodes: [String]
    ) -> SiteMediaPreferenceResolution {
        let selectedFormatIndex = formatHeights.firstIndex(of: qualityHeight) ?? 0
        let availableSubtitleCodes = Set(subtitleCodes)
        let resolvedSubtitle = subtitleLanguage.flatMap {
            availableSubtitleCodes.contains($0) ? $0 : nil
        }
        return SiteMediaPreferenceResolution(
            selectedFormatIndex: selectedFormatIndex,
            container: container,
            subtitleLanguage: resolvedSubtitle
        )
    }

    /// A one-click path must never silently substitute a different result.
    /// Return a resolution only when both the remembered quality and optional
    /// subtitle track exist in the current probe exactly.
    public func exactResolution(
        formatHeights: [Int],
        subtitleCodes: [String]
    ) -> SiteMediaPreferenceResolution? {
        guard let selectedFormatIndex = formatHeights.firstIndex(of: qualityHeight) else {
            return nil
        }
        if let subtitleLanguage,
           !subtitleCodes.contains(subtitleLanguage) {
            return nil
        }
        return SiteMediaPreferenceResolution(
            selectedFormatIndex: selectedFormatIndex,
            container: container,
            subtitleLanguage: subtitleLanguage
        )
    }
}

public struct SiteMediaPreferenceResolution: Equatable, Sendable {
    public var selectedFormatIndex: Int
    public var container: SiteMediaPreference.Container
    public var subtitleLanguage: String?

    public init(
        selectedFormatIndex: Int,
        container: SiteMediaPreference.Container,
        subtitleLanguage: String?
    ) {
        self.selectedFormatIndex = selectedFormatIndex
        self.container = container
        self.subtitleLanguage = subtitleLanguage
    }
}

public enum SiteMediaPreferenceStore {
    static let storageKey = "SiteMediaPreferences.v1"

    private struct Payload: Codable {
        var version: Int
        var sites: [String: SiteMediaPreference]

        static let empty = Payload(version: 1, sites: [:])
    }

    public static func load(for hostOrURL: String) -> SiteMediaPreference? {
        load(for: hostOrURL, defaults: .standard)
    }

    static func load(
        for hostOrURL: String,
        defaults: UserDefaults
    ) -> SiteMediaPreference? {
        guard let siteKey = canonicalSiteKey(for: hostOrURL),
              let payload = loadPayload(defaults: defaults) else { return nil }
        return payload.sites[siteKey]
    }

    public static func save(
        _ preference: SiteMediaPreference,
        for hostOrURL: String
    ) {
        save(preference, for: hostOrURL, defaults: .standard)
    }

    static func save(
        _ preference: SiteMediaPreference,
        for hostOrURL: String,
        defaults: UserDefaults
    ) {
        guard let siteKey = canonicalSiteKey(for: hostOrURL) else { return }
        var payload = loadPayload(defaults: defaults) ?? .empty
        payload.version = 1
        payload.sites[siteKey] = preference
        guard let data = try? JSONEncoder().encode(payload) else { return }
        defaults.set(data, forKey: storageKey)
    }

    public static func canonicalSiteKey(for hostOrURL: String) -> String? {
        let value = hostOrURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }

        let candidate = value.contains("://") ? value : "https://\(value)"
        guard var host = URLComponents(string: candidate)?.host?.lowercased() else {
            return nil
        }
        host = host.trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if host.hasPrefix("www.") { host.removeFirst(4) }
        guard !host.isEmpty else { return nil }

        let families: [(canonical: String, aliases: [String])] = [
            ("youtube.com", ["youtube.com", "youtu.be"]),
            ("bilibili.com", ["bilibili.com", "b23.tv"]),
            ("douyin.com", ["douyin.com", "iesdouyin.com"]),
            ("xiaohongshu.com", ["xiaohongshu.com", "xhslink.com"]),
            ("tiktok.com", ["tiktok.com"]),
        ]
        for family in families where family.aliases.contains(where: {
            host == $0 || host.hasSuffix(".\($0)")
        }) {
            return family.canonical
        }
        return host
    }

    private static func loadPayload(defaults: UserDefaults) -> Payload? {
        guard let data = defaults.data(forKey: storageKey),
              let payload = try? JSONDecoder().decode(Payload.self, from: data),
              payload.version == 1 else { return nil }
        return payload
    }
}
