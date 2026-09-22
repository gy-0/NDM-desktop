import Foundation

/// Resolves where a newly created task should land.
///
/// A per-download choice is exact: choosing a project folder must not silently
/// append the global category subfolder. Without an override, the app keeps the
/// user's global organization preference.
public enum DownloadDestinationPolicy: Sendable {
    /// Read the nearest existing directory without creating a missing mount or
    /// category folder. Unknown capability is not treated as a negative result.
    public static func supportsExclusiveRenaming(at directory: URL) -> Bool? {
        var current = directory.standardizedFileURL
        while !FileManager.default.fileExists(atPath: current.path), current.path != "/" {
            current.deleteLastPathComponent()
        }
        return try? current.resourceValues(forKeys: [.volumeSupportsExclusiveRenamingKey]).volumeSupportsExclusiveRenaming
    }

    public static func directory(
        defaultDirectory: URL,
        override: URL?,
        category: DownloadCategory,
        organizeByCategory: Bool
    ) -> URL {
        if let override {
            return override.standardizedFileURL
        }
        guard organizeByCategory else {
            return defaultDirectory.standardizedFileURL
        }
        return defaultDirectory
            .appendingPathComponent(category.rawValue.capitalized, isDirectory: true)
            .standardizedFileURL
    }
}
