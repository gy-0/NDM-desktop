/// Content-height contract for the native New Download sheet.
///
/// The preview card is fixed-height, while the recognition and component rows
/// appear only when they have something useful to say. Keeping those states
/// explicit prevents a compact sheet from carrying a large, empty lower half.
public enum NewDownloadSheetLayout {
    public static let compactHeight = 214
    public static let previewHeight = 316

    private static let statusRowHeight = 19
    private static let hintRowHeight = 31

    public static func contentHeight(
        hasPreview: Bool,
        showsStatus: Bool,
        showsHint: Bool
    ) -> Int {
        guard hasPreview else { return compactHeight }
        return previewHeight
            + (showsStatus ? statusRowHeight : 0)
            + (showsHint ? hintRowHeight : 0)
    }
}
