import Foundation

/// Resolves where a newly created task should land.
///
/// A per-download choice is exact: choosing a project folder must not silently
/// append the global category subfolder. Without an override, the app keeps the
/// user's global organization preference.
public enum DownloadDestinationPolicy: Sendable {
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
