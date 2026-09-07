import Foundation

/// A quiet, local-only candidate for the Magic Inbox surface.
///
/// Resolution and duplicate suppression live in Core so every future surface
/// (main toolbar, menu bar, Shortcuts) can make the same conservative choice.
public enum ClipboardDownloadOfferResolver {
    public static func offer(
        for rawText: String,
        existingTasks: [DownloadTask]
    ) -> SharedLinkResolution? {
        guard let resolution = SharedLinkResolver.resolve(rawText) else { return nil }
        guard DuplicateDownloadMatcher.bestMatch(
            for: [resolution.urlString],
            in: existingTasks
        ) == nil else {
            return nil
        }
        return resolution
    }
}
