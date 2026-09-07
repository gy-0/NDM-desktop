import Foundation
import NDMCore
import Speech

/// Readiness and one-off preparation of a language's on-device speech assets.
///
/// Everything here was established by probing the real framework, because two of
/// its behaviours are not what the names suggest:
///
/// - `AssetInventory.status(forModules:)` returned `.supported` for `zh_CN` on a
///   machine where `zh_CN` *is* installed. It therefore cannot answer "is this
///   ready", and `SpeechTranscriber.installedLocales` is used instead.
/// - `AssetInventory.assetInstallationRequest(supporting:)` returns nil when
///   nothing needs installing, and **throws** for an unsupported language rather
///   than returning nil. The throw is a statement about support, not a failure.
///
/// Creating a request also reserves the locale for that request's lifetime, and
/// `AssetInventory.maximumReservedLocales` was 5, so requests are created only
/// when a download is actually intended — never speculatively to test readiness.
@available(macOS 26, *)
public struct SpeechLanguageAssets: Sendable {
    public init() {}

    /// Cheap and side-effect free: no installation request is created.
    public static func readiness(
        forLocaleIdentifier identifier: String
    ) async -> LanguageAssetReadiness {
        let normalized = TranscriptionWorkflow.normalized(identifier)
        let installed = await SpeechTranscriber.installedLocales
        let supported = await SpeechTranscriber.supportedLocales
        return LanguageAssetReadiness.from(
            isInstalled: installed.contains { TranscriptionWorkflow.normalized($0.identifier) == normalized },
            isSupported: supported.contains { TranscriptionWorkflow.normalized($0.identifier) == normalized }
        )
    }

    public enum PreparationFailure: LocalizedError, Equatable {
        case unsupportedLanguage
        /// Could not be prepared right now for a reason that is not about support —
        /// most often the system's reservation budget, which is small and shared.
        case temporarilyUnavailable(String)
        case downloadFailed(String)

        public var errorDescription: String? {
            switch self {
            case .unsupportedLanguage:
                return "This Mac cannot read speech in that language"
            case .temporarilyUnavailable(let detail):
                return "The language could not be prepared right now: \(detail)"
            case .downloadFailed(let detail):
                return "Preparing the language failed: \(detail)"
            }
        }
    }

    /// Download and install what the language needs, reporting real progress.
    ///
    /// Returns immediately when nothing is needed. `onProgress` receives nil while
    /// the system's progress is still indeterminate — a freshly created request
    /// reports a zero total, and turning that into "0%" would be a fabricated
    /// number in a place the user is already waiting.
    public func prepare(
        localeIdentifier: String,
        cancelToken: CancelToken? = nil,
        onProgress: (@Sendable (Double?) -> Void)? = nil
    ) async throws {
        if cancelToken?.isCancelled == true { return }

        // Check readiness before creating anything. Two reasons, both learned the hard
        // way: `readiness` and this method must agree (they used to disagree, one
        // saying ready while the other said unsupported), and creating an installation
        // request reserves a locale against a budget measured at five — so the common
        // case of an already-installed language must never spend one.
        switch await Self.readiness(forLocaleIdentifier: localeIdentifier) {
        case .ready:
            return
        case .unsupported:
            throw PreparationFailure.unsupportedLanguage
        case .needsPreparation, .preparing:
            break
        }

        let transcriber = SpeechTranscriber(
            locale: Locale(identifier: localeIdentifier),
            preset: .timeIndexedTranscriptionWithAlternatives
        )

        let request: AssetInstallationRequest?
        do {
            request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber])
        } catch {
            // Do not report every throw as "unsupported". Measured error codes: 4 is an
            // unsupported configuration, while 11 came back once the reservation budget
            // was exhausted after five requests. Telling someone their language is
            // unsupported when the truth is "not right now" sends them somewhere there
            // is no fix.
            let nsError = error as NSError
            if nsError.code == 4 {
                throw PreparationFailure.unsupportedLanguage
            }
            throw PreparationFailure.temporarilyUnavailable(error.localizedDescription)
        }
        guard let request else { return }  // already installed

        onProgress?(nil)
        let progress = request.progress
        let reporter = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                if Task.isCancelled { return }
                // Only report a figure once the system has one; isIndeterminate and
                // a zero total both mean "no honest number yet".
                if progress.isIndeterminate || progress.totalUnitCount <= 0 {
                    onProgress?(nil)
                } else {
                    onProgress?(progress.fractionCompleted)
                }
            }
        }
        defer { reporter.cancel() }

        do {
            try await request.downloadAndInstall()
        } catch {
            throw PreparationFailure.downloadFailed(error.localizedDescription)
        }
        onProgress?(1.0)
    }
}
