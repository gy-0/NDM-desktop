import CoreGraphics

/// Where a list should be scrolled after a structural reload.
///
/// Pure arithmetic, kept out of the view controller because the two cases are easy
/// to conflate and the difference is what the user feels as "the list jumped".
public enum ListScrollTarget: Equatable, Sendable {
    /// Hold an anchor row at the same distance from the viewport top.
    ///
    /// For a reload that must not change what is under the user's eye: keeping only
    /// the pixel offset would silently change which task sits there.
    case anchor(rowMinY: CGFloat, offset: CGFloat)

    /// Bring a row fully into view, moving as little as possible.
    ///
    /// A "reveal" is not "put it at the top". Forcing offset 0 scrolls the whole
    /// list whenever the row is not already near the top — under a name sort a
    /// finished download can land anywhere — and that lurch is indistinguishable
    /// from a bug. When the row is already visible this scrolls nothing at all,
    /// which is the common case (row 0, user at the top) and must stay free.
    case reveal(rowMinY: CGFloat, rowHeight: CGFloat)
}

/// The measurements a scroll decision needs, and nothing else.
public struct ListScrollGeometry: Equatable, Sendable {
    public let currentY: CGFloat
    public let viewportHeight: CGFloat
    public let contentHeight: CGFloat

    public init(currentY: CGFloat, viewportHeight: CGFloat, contentHeight: CGFloat) {
        self.currentY = currentY
        self.viewportHeight = max(0, viewportHeight)
        self.contentHeight = max(0, contentHeight)
    }

    /// Largest scroll offset that still shows content, i.e. the bottom stop.
    public var maximumY: CGFloat { max(0, contentHeight - viewportHeight) }

    /// Resolved scroll offset, already clamped to the scrollable range.
    ///
    /// One value, applied once. Deliberately never a first guess plus a later
    /// correction: two sets in a row is what produced a visible down-then-up.
    public func scrollY(for target: ListScrollTarget) -> CGFloat {
        switch target {
        case .anchor(let rowMinY, let offset):
            return clamp(rowMinY + offset)
        case .reveal(let rowMinY, let rowHeight):
            let rowMaxY = rowMinY + max(0, rowHeight)
            if rowMinY < currentY { return clamp(rowMinY) }
            if rowMaxY > currentY + viewportHeight { return clamp(rowMaxY - viewportHeight) }
            return clamp(currentY)
        }
    }

    /// True when resolving `target` would not move the list at all. Lets a caller
    /// skip the scroll entirely rather than setting the same value again.
    public func isSettled(for target: ListScrollTarget) -> Bool {
        abs(scrollY(for: target) - currentY) < 0.5
    }

    private func clamp(_ value: CGFloat) -> CGFloat {
        min(max(0, value), maximumY)
    }
}
