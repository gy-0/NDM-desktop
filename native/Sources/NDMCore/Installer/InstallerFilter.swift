import Foundation

/// Entry filtering for installer volumes and archives.
///
/// Ported from the behavior of Rapidmg 1.3.1 (reverse spec 15 §5): when an
/// HFS+/APFS volume or a disk image is enumerated, the filesystem surfaces
/// private metadata (journal, fsevents, Spotlight, Trashes, Finder metadata)
/// that must never be copied into `/Applications` alongside an app bundle.
/// The exact name set below is the one Rapidmg's `FUN_10001aacc` filter
/// matches against archive/directory entry paths.
public enum InstallerFilter: Sendable {
    /// Names that mark an entry as filesystem private data, to be skipped.
    ///
    /// Matched against each path component, so an entry nested anywhere under
    /// e.g. `.Trashes/` is excluded too — matching Rapidmg's suffix/prefix
    /// checks against full entry paths.
    public static let junkNames: Set<String> = [
        ".fseventsd",
        ".Trashes",
        ".Trash",
        ".journal",
        ".journal_info_block",
        ".DS_Store",
        "[HFS+ Private Data]",
        ".HFS+ Private Directory Data",
    ]

    /// Whether an entry path should be skipped as filesystem private data.
    public static func isJunkEntry(path: String) -> Bool {
        let components = path.split(separator: "/").map(String.init)
        return components.contains { component in
            junkNames.contains(component) || junkNames.contains("/" + component)
        }
    }

    /// Whether a path component is an app bundle directory (`.app` suffix).
    public static func isAppBundle(name: String) -> Bool {
        name.lowercased().hasSuffix(".app")
    }

    /// Whether a path component is an installer package (`.pkg` / `.mpkg`).
    public static func isPackage(name: String) -> Bool {
        let lower = name.lowercased()
        return lower.hasSuffix(".pkg") || lower.hasSuffix(".mpkg")
    }

    /// Installer packages among archive entries, stopping at the first `.pkg`
    /// and ignoring packages nested inside an app bundle.
    public static func packageCandidates(entries: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for entry in entries {
            guard !isJunkEntry(path: entry) else { continue }
            let components = entry.split(separator: "/", omittingEmptySubsequences: true)
            var pkgIndex: Int?
            for (index, component) in components.enumerated() {
                let name = String(component)
                if isAppBundle(name: name) { break }
                if isPackage(name: name) {
                    pkgIndex = index
                    break
                }
            }
            guard let pkgIndex else { continue }
            let candidate = components[0...pkgIndex].joined(separator: "/")
            guard !seen.contains(candidate) else { continue }
            seen.insert(candidate)
            result.append(candidate)
        }
        return result
    }

    /// Top-level app bundles among archive entries.
    ///
    /// An archive entry can be `Foo.app`, `Foo.app/Contents/...`, or
    /// `Some Folder/Bar.app/Contents/...`. The candidate is the path up to and
    /// including the first component that is an app bundle — exactly what
    /// should land in `/Applications` (the executor strips the common prefix).
    public static func appBundleCandidates(entries: [String]) -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for entry in entries {
            guard !isJunkEntry(path: entry) else { continue }
            let components = entry.split(separator: "/", omittingEmptySubsequences: true)
            guard let bundleIndex = components.firstIndex(where: { isAppBundle(name: String($0)) })
            else { continue }
            let candidate = components[0...bundleIndex].joined(separator: "/")
            guard !seen.contains(candidate) else { continue }
            seen.insert(candidate)
            result.append(candidate)
        }
        // Preserve archive order for a stable picker.
        return result
    }
}
