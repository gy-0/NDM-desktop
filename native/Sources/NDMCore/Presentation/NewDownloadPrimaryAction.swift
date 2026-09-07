import Foundation

/// Makes the New Download sheet's primary button describe the next step.
/// A generic “Continue” hides whether Return will start a file transfer or
/// open the media-quality picker, which makes the highest-intent action feel
/// unpredictable.
public enum NewDownloadPrimaryAction: Equatable, Sendable {
    case unavailable
    case downloadFile
    case chooseQuality
    case downloadPrepared(quality: String, container: String)
    case downloadAgain
}

public enum NewDownloadPrimaryActionPolicy {
    public static func action(
        hasDownloadableLink: Bool,
        requiresQualityChoice: Bool,
        hasDuplicate: Bool,
        preparedQuality: String? = nil,
        preparedContainer: String? = nil
    ) -> NewDownloadPrimaryAction {
        guard hasDownloadableLink else { return .unavailable }
        if hasDuplicate { return .downloadAgain }
        if let preparedQuality, let preparedContainer {
            return .downloadPrepared(
                quality: preparedQuality,
                container: preparedContainer
            )
        }
        return requiresQualityChoice ? .chooseQuality : .downloadFile
    }
}
