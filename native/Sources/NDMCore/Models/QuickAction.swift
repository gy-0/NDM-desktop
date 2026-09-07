import Foundation

/// A user-configured action shown when a download finishes.
public struct QuickAction: Codable, Sendable, Equatable, Identifiable {
    public var id: UUID
    public var title: String
    public var kind: Kind
    /// SF Symbol used when a target app or sharing service has no richer icon.
    public var symbol: String
    /// Promoted actions are visible in the completion action row. All actions
    /// remain available from the overflow menu.
    public var promoted: Bool

    public enum Kind: Codable, Sendable, Equatable {
        case openWithApp(bundleID: String)
        case shareService(named: String)
        case shortcut(named: String)
    }

    public init(
        id: UUID = UUID(),
        title: String,
        kind: Kind,
        symbol: String = "bolt.fill",
        promoted: Bool = false
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.symbol = symbol
        self.promoted = promoted
    }
}
