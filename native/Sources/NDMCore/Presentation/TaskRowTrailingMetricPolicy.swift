/// Decides whether a task row has enough horizontal room for its trailing
/// metric without sacrificing the filename.
public enum TaskRowTrailingMetricPolicy {
    /// Below this width a completed file's size is redundant with the open
    /// inspector and should yield to the task's identity.
    public static let minimumStaticMetricWidth = 360.0

    public static func showsTrailingMetric(
        rowWidth: Double,
        interfaceScale: Double,
        isDownloading: Bool
    ) -> Bool {
        // Live progress/speed is time-sensitive and remains visible even in a
        // compact row. Static size can safely move to the inspector.
        guard !isDownloading else { return true }
        let scale = max(0.5, interfaceScale)
        return rowWidth >= minimumStaticMetricWidth * scale
    }
}
