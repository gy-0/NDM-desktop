import Foundation
import NDMCore

/// Recursively lists a mounted volume's entries for the installer plan.
///
/// The listing is exactly what the plan layer feeds into
/// `InstallerFilter.appBundleCandidates`: every path where an app bundle could
/// live, with filesystem private data pruned up front so it can never become a
/// candidate (reverse spec 15 §5). Descent stops inside `.app` bundles — their
/// interiors are never install candidates.
public enum VolumeEnumerator: Sendable {
    public static func entries(in volume: URL) -> [String] {
        var result: [String] = []
        walk(volume, prefix: "", into: &result)
        return result
    }

    private static func walk(_ directory: URL, prefix: String, into result: inout [String]) {
        let items = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey],
            options: []
        )) ?? []
        // Stable order: the picker and tests depend on it.
        for item in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let name = item.lastPathComponent
            guard !InstallerFilter.isJunkEntry(path: name) else { continue }
            let relative = prefix.isEmpty ? name : "\(prefix)/\(name)"
            result.append(relative)
            let values = try? item.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let isDirectory = values?.isDirectory ?? false
            let isSymlink = values?.isSymbolicLink ?? false
            if isDirectory, !isSymlink,
               !InstallerFilter.isAppBundle(name: name),
               !InstallerFilter.isPackage(name: name) {
                walk(item, prefix: relative, into: &result)
            }
        }
    }
}
