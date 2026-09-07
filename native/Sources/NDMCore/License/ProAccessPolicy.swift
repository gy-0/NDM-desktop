import Foundation

/// The concrete value a person just asked the app to unlock.
///
/// Upgrade UI consumes these values so it can explain the benefit in context
/// instead of showing the same generic comparison table for every gate.
public enum ProFeature: Equatable, Sendable {
    case connections(requested: Int)
    case ultraHD(height: Int)
    case collection(itemCount: Int)
    case subtitles
}

public enum ProAccessPolicy {
    /// Free keeps mainstream single-video delivery genuinely useful. Pro is
    /// reserved for work that compounds time or delivery complexity.
    public static func mediaRequirements(
        height: Int,
        collectionItemCount: Int?,
        includesSubtitles: Bool
    ) -> [ProFeature] {
        var requirements: [ProFeature] = []
        if let collectionItemCount, collectionItemCount > 1 {
            requirements.append(.collection(itemCount: collectionItemCount))
        }
        if height > 1080 {
            requirements.append(.ultraHD(height: height))
        }
        if includesSubtitles {
            requirements.append(.subtitles)
        }
        return requirements
    }
}
