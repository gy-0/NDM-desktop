import Foundation

/// A fact about a *successful* delivery that the user still needs to know.
///
/// Distinct from `DownloadDiagnostic`, which describes failures. A download can
/// finish, produce an openable file, and still not be what the user expected —
/// and quietly handing it over is how a download manager loses trust. The note is
/// persisted alongside the task (`DownloadTask.deliveryNote`) as a stable key, so
/// presentation can re-localize it at render time.
public enum DeliveryNote: Equatable, Sendable {
    /// A separate audio rendition was downloaded, but the delivered file carries
    /// no audio track. The video is still worth keeping — it is what the site
    /// offered — but calling it a clean success would be a lie.
    case audioTrackMissing

    /// Stable identifier written to storage. Never localize this.
    public var storageKey: String {
        switch self {
        case .audioTrackMissing: return "note.audioTrackMissing"
        }
    }

    public init?(storageKey: String?) {
        switch storageKey?.trimmingCharacters(in: .whitespacesAndNewlines) {
        case DeliveryNote.audioTrackMissing.storageKey:
            self = .audioTrackMissing
        default:
            return nil
        }
    }

    public var title: String {
        switch self {
        case .audioTrackMissing:
            return L10n.t("This video has no audio track", "该视频不含音轨")
        }
    }

    /// One sentence a non-technical user can act on. No codec names, no ffmpeg.
    public var detail: String {
        switch self {
        case .audioTrackMissing:
            return L10n.t(
                "The site served audio as a separate track and it was not written into the finished file. The picture was saved.",
                "站点将音频单独提供，但未能写入最终文件。画面已保存。"
            )
        }
    }
}
