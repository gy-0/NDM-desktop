import Foundation

/// Reading order for the post-download payoff.
///
/// The finished file and its primary actions must arrive before optional
/// automation or delivery details. Keeping this policy outside AppKit makes
/// that product hierarchy deterministic and regression-testable.
public enum CompletionPayoffSection: Sendable, Equatable {
    case fileIdentity
    case primaryActions
    case promotedActions
    case artifacts
    case deliveryNotice
    case audioStatus
}

public enum CompletionPayoffLayout: Sendable {
    public static func sections(
        hasPromotedActions: Bool,
        hasArtifacts: Bool,
        hasDeliveryNotice: Bool
    ) -> [CompletionPayoffSection] {
        var result: [CompletionPayoffSection] = [
            .fileIdentity,
            .primaryActions,
        ]
        if hasPromotedActions {
            result.append(.promotedActions)
        }
        if hasArtifacts {
            result.append(.artifacts)
        }
        if hasDeliveryNotice {
            result.append(.deliveryNotice)
        }
        result.append(.audioStatus)
        return result
    }
}
