import NDMCore

/// Automatic ordinary downloads keep their creation order independently of the
/// library's recency sort. Explicit starts and collection ordering belong to the
/// manager; neither is inferred from timestamps that change on retry/completion.
enum DownloadQueuePolicy {
    static func ordinaryWaiting(
        in tasks: [DownloadTask],
        isCollectionEntry: (DownloadTask) -> Bool,
        preferredOrder: [Int64] = []
    ) -> [DownloadTask] {
        let ranks = Dictionary(preferredOrder.enumerated().map { ($1, $0) }, uniquingKeysWith: min)
        return tasks.filter {
            $0.status == .waiting
                && $0.startAt == nil
                && $0.awaitingDestination != true
                && !isCollectionEntry($0)
        }.sorted {
            let left = ranks[$0.id] ?? Int.max, right = ranks[$1.id] ?? Int.max
            return left == right ? $0.id < $1.id : left < right
        }
    }
}
