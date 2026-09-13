import NDMCore

/// Automatic ordinary downloads keep their creation order independently of the
/// library's recency sort. Explicit starts and collection ordering belong to the
/// manager; neither is inferred from timestamps that change on retry/completion.
enum DownloadQueuePolicy {
    static func ordinaryWaiting(
        in tasks: [DownloadTask],
        isCollectionEntry: (DownloadTask) -> Bool
    ) -> [DownloadTask] {
        tasks.filter {
            $0.status == .waiting
                && $0.startAt == nil
                && $0.awaitingDestination != true
                && !isCollectionEntry($0)
        }.sorted { $0.id < $1.id }
    }
}
