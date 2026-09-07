import AVFoundation
import CoreMedia
import Foundation
import NDMCore
import Speech

/// Turns an audio or video file into timed speech, entirely on this machine.
///
/// Scope is deliberately narrow: file in, `[TranscriptSegment]` out. Whether a file
/// *should* be transcribed and in which language is `TranscriptionWorkflow`'s job
/// (C1-1); turning segments into subtitles or a transcript is
/// `TranscriptDocument`'s (C1-2). Keeping those out of here is what lets both be
/// tested without a system new enough to run this.
///
/// Segments are emitted one per recogniser result, not per word. Word-level
/// timings do exist — Chinese comes back one run per character — but a cue per
/// character is unusable, and `TranscriptDocument.subtitleCues` already merges
/// short neighbours properly. If full-text search ever needs to jump to an exact
/// second, the finer timings can be surfaced then.
@available(macOS 26, *)
public struct SpeechTranscriptionEngine: Sendable {
    public enum Failure: LocalizedError, Equatable {
        case unreadableAudio(String)
        case noCompatibleAudioFormat
        case audioConversionFailed(String)
        case cancelled

        public var errorDescription: String? {
            switch self {
            case .unreadableAudio(let detail):
                return "The audio could not be read: \(detail)"
            case .noCompatibleAudioFormat:
                return "No audio format this Mac can transcribe"
            case .audioConversionFailed(let detail):
                return "The audio could not be prepared: \(detail)"
            case .cancelled:
                return "Transcription was cancelled"
            }
        }
    }

    /// Frames read per pass. Small enough that cancellation is observed promptly,
    /// large enough not to pay conversion overhead per sample.
    private static let framesPerChunk = AVAudioFrameCount(8192)

    public init() {}

    // MARK: - Capability reporting

    /// The only seam between `TranscriptionWorkflow`'s pure rules and the real
    /// system. Everything the planner needs to know, read once.
    public static func environment(
        preferredLanguages: [String] = Locale.preferredLanguages
    ) async -> TranscriptionWorkflow.Environment {
        let supported = await SpeechTranscriber.supportedLocales
        let installed = await SpeechTranscriber.installedLocales
        return TranscriptionWorkflow.Environment(
            isSupportedByOS: true,
            supportedLocaleIdentifiers: supported.map(\.identifier),
            installedLocaleIdentifiers: installed.map(\.identifier),
            preferredLanguages: preferredLanguages
        )
    }

    // MARK: - Transcription

    /// Transcribe `fileURL` in `localeIdentifier`.
    ///
    /// `onProgress` receives the analyzer's own `Foundation.Progress` fraction, so
    /// nothing here invents a percentage.
    public func transcribe(
        fileURL: URL,
        localeIdentifier: String,
        cancelToken: CancelToken? = nil,
        onProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> [TranscriptSegment] {
        // Checked before anything is built: an analyzer that receives zero buffers
        // blocks in `start` forever, so a run that is already cancelled must never
        // reach one. Measured, not assumed.
        if cancelToken?.isCancelled == true {
            throw Failure.cancelled
        }

        let file: AVAudioFile
        do {
            file = try AVAudioFile(forReading: fileURL)
        } catch {
            throw Failure.unreadableAudio(error.localizedDescription)
        }

        // Same hazard: a valid but empty file would deliver no buffers. Silence
        // contains no speech, so this is an empty result rather than an error.
        guard file.length > 0 else { return [] }

        let transcriber = SpeechTranscriber(
            locale: Locale(identifier: localeIdentifier),
            // Time-indexed, or there is nothing to build subtitles from.
            preset: .timeIndexedTranscriptionWithAlternatives
        )
        guard let analysisFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
            compatibleWith: [transcriber],
            considering: file.processingFormat
        ) else {
            throw Failure.noCompatibleAudioFormat
        }
        guard let converter = AVAudioConverter(from: file.processingFormat, to: analysisFormat) else {
            throw Failure.audioConversionFailed("unsupported source format")
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if let onProgress {
            try? await analyzer.prepareToAnalyze(in: analysisFormat) { progress in
                onProgress(progress.fractionCompleted)
            }
        }

        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()

        // Collect before feeding: the results sequence must already be awaited when
        // the analyzer starts producing, or early results are dropped.
        let collector = Task { () -> [TranscriptSegment] in
            var segments: [TranscriptSegment] = []
            for try await result in transcriber.results {
                let text = String(result.text.characters)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                segments.append(TranscriptSegment(
                    start: CMTimeGetSeconds(result.range.start),
                    end: CMTimeGetSeconds(result.range.end),
                    text: text
                ))
            }
            return segments
        }

        let feeder = Task.detached {
            defer { continuation.finish() }
            while !(cancelToken?.isCancelled ?? false) {
                guard let input = AVAudioPCMBuffer(
                    pcmFormat: file.processingFormat,
                    frameCapacity: Self.framesPerChunk
                ) else { return }
                do {
                    try file.read(into: input, frameCount: Self.framesPerChunk)
                } catch {
                    return
                }
                guard input.frameLength > 0 else { return }
                guard let converted = Self.convert(
                    input,
                    with: converter,
                    to: analysisFormat
                ) else { return }
                if converted.frameLength > 0 {
                    continuation.yield(AnalyzerInput(buffer: converted))
                }
            }
        }

        do {
            // Returns once the input sequence is exhausted, so cancellation can be
            // judged here with all the audio already accounted for.
            try await analyzer.start(inputSequence: stream)
        } catch {
            feeder.cancel()
            collector.cancel()
            throw Failure.audioConversionFailed(error.localizedDescription)
        }

        if cancelToken?.isCancelled == true {
            await analyzer.cancelAndFinishNow()
            // The results sequence does not end on cancelAndFinishNow — measured —
            // so awaiting the collector here would hang. Cancel it instead.
            collector.cancel()
            throw Failure.cancelled
        }

        do {
            // Only this ends the results sequence, which is what lets the collector
            // below return.
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            collector.cancel()
            throw Failure.audioConversionFailed(error.localizedDescription)
        }

        let segments = try await collector.value
        // Results arrive in order here, but the sort costs nothing and removes an
        // assumption that only holds by convention.
        return segments.sorted {
            $0.start == $1.start ? $0.end < $1.end : $0.start < $1.start
        }
    }

    /// Resample one buffer into the analyzer's format.
    ///
    /// `convert(to:error:withInputFrom:)` may ask for input repeatedly; the flag
    /// makes the second ask report "no more for now" rather than handing over the
    /// same buffer twice, which would duplicate audio.
    private static func convert(
        _ input: AVAudioPCMBuffer,
        with converter: AVAudioConverter,
        to format: AVAudioFormat
    ) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 1024
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else {
            return nil
        }
        var error: NSError?
        var supplied = false
        converter.convert(to: output, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        return error == nil ? output : nil
    }
}
