import Foundation
import NDMCore

/// Writes a transcript's two artifacts beside the delivered media file.
///
/// This is the step that turns C1-1…C1-4 into files a user can open. What it
/// deliberately does *not* decide is *when* transcription runs — that is a setting,
/// and it belongs with the rest of the settings work rather than being switched on
/// for everybody by the act of wiring it up.
public enum TranscriptDelivery: Sendable {
    /// Files produced for one transcript.
    public struct Output: Equatable, Sendable {
        /// Player-facing subtitles.
        public let subtitleURL: URL
        /// The readable transcript.
        public let transcriptURL: URL

        public init(subtitleURL: URL, transcriptURL: URL) {
            self.subtitleURL = subtitleURL
            self.transcriptURL = transcriptURL
        }
    }

    public enum Failure: LocalizedError, Equatable {
        case primaryMissing
        case nothingRecognised
        case writeFailed(String)

        public var errorDescription: String? {
            switch self {
            case .primaryMissing:
                return "The media file is no longer where it was delivered"
            case .nothingRecognised:
                return "No speech was recognised, so nothing was written"
            case .writeFailed(let detail):
                return "The transcript could not be saved: \(detail)"
            }
        }
    }

    /// Where a transcript's subtitles go when `Movie.srt` is already taken.
    ///
    /// The shipped convention is a language-free `Movie.srt` so players discover it
    /// without language rules (see `YtDlpTool.normalizeSubtitleSidecar`), and that
    /// convention is kept rather than forked into a second, suffixed one. But a
    /// video can already carry a subtitle downloaded from the site, and overwriting
    /// someone's real subtitle with a machine transcript would be indefensible —
    /// so the transcript steps aside under a name that says what it is. Numbering
    /// (`Movie (2).srt`) was rejected for this: it tells the user there are two
    /// files without telling them which is which.
    static let transcribedSubtitleMarker = "transcribed"

    /// Compute the destination names without writing anything. Pure, so the naming
    /// rules are testable without a filesystem.
    public static func destinations(
        primary: URL,
        exists: (URL) -> Bool
    ) -> Output {
        let folder = primary.deletingLastPathComponent()
        let stem = primary.deletingPathExtension().lastPathComponent

        let plainSubtitle = folder.appendingPathComponent("\(stem).srt")
        let subtitle: URL
        if exists(plainSubtitle) {
            subtitle = DownloadFilename.uniqueURL(
                folder.appendingPathComponent("\(stem).\(transcribedSubtitleMarker).srt"),
                exists: exists
            )
        } else {
            subtitle = plainSubtitle
        }

        // The transcript shares the primary's name exactly, matching how every other
        // sidecar here is named; the extension already says what it is.
        let transcript = DownloadFilename.uniqueURL(
            folder.appendingPathComponent("\(stem).txt"),
            exists: exists
        )
        return Output(subtitleURL: subtitle, transcriptURL: transcript)
    }

    /// Serialize `segments` and write both artifacts next to `primary`.
    ///
    /// Never overwrites: an existing subtitle from the site outranks a machine
    /// transcript.
    @discardableResult
    public static func write(
        segments: [TranscriptSegment],
        besidePrimary primary: URL,
        subtitleOptions: TranscriptDocument.SubtitleOptions = .default,
        fileManager: FileManager = .default
    ) throws -> Output {
        guard fileManager.fileExists(atPath: primary.path) else {
            throw Failure.primaryMissing
        }
        let srt = TranscriptDocument.srt(from: segments, options: subtitleOptions)
        let text = TranscriptDocument.plainText(from: segments)
        guard !srt.isEmpty, !text.isEmpty else {
            throw Failure.nothingRecognised
        }

        let output = destinations(
            primary: primary,
            exists: { fileManager.fileExists(atPath: $0.path) }
        )
        do {
            try Data(srt.utf8).write(to: output.subtitleURL, options: .atomic)
        } catch {
            throw Failure.writeFailed(error.localizedDescription)
        }
        do {
            try Data(text.utf8).write(to: output.transcriptURL, options: .atomic)
        } catch {
            // Leave no half-delivery behind: a subtitle with no transcript would
            // look like a complete result.
            try? fileManager.removeItem(at: output.subtitleURL)
            throw Failure.writeFailed(error.localizedDescription)
        }
        return output
    }

    // MARK: - Journey

    /// The stage a transcript run is in, mapped onto the delivery journey the rest
    /// of the app already shows. No second progress bar: transcription is the last
    /// stretch of one monotone journey, and language preparation is a named stage
    /// inside it rather than a stall.
    public enum Stage: Equatable, Sendable {
        case preparingLanguage(LanguageAssetReadiness)
        case reading(fraction: Double?)
        case writing

        /// Existing phase vocabulary; `subtitles` is what the journey already calls
        /// this part of delivery.
        public var phase: DownloadPhase {
            switch self {
            case .preparingLanguage: return .preparing
            case .reading: return .subtitles
            case .writing: return .finalizing
            }
        }

        /// Determinate progress, or nil when there is nothing honest to report.
        public var fraction: Double? {
            switch self {
            case .preparingLanguage(let readiness): return readiness.fraction
            case .reading(let fraction): return fraction
            case .writing: return nil
            }
        }

        public func title(languageName: String) -> String {
            switch self {
            case .preparingLanguage(let readiness):
                return readiness.title(languageName: languageName)
            case .reading:
                return L10n.t("Reading the speech", "正在识别语音")
            case .writing:
                return L10n.t("Saving the transcript", "正在保存文稿")
            }
        }
    }
}
