import XCTest
@testable import NDMCore
@testable import NDMEngine

final class TranscriptDeliveryNamingTests: XCTestCase {
    private let primary = URL(fileURLWithPath: "/Videos/A Better Download.mp4")

    private func destinations(taken: Set<String> = []) -> TranscriptDelivery.Output {
        TranscriptDelivery.destinations(primary: primary) { taken.contains($0.path) }
    }

    /// The shipped convention is a language-free `Movie.srt` so players find it
    /// without language rules. Transcription keeps that rather than forking into a
    /// second, suffixed convention.
    func testSubtitleUsesThePlainNameWhenFree() {
        XCTAssertEqual(
            destinations().subtitleURL.lastPathComponent,
            "A Better Download.srt"
        )
    }

    /// A subtitle downloaded from the site outranks a machine transcript; the
    /// transcript steps aside instead of overwriting it.
    func testAnExistingSubtitleIsNeverOverwritten() {
        let output = destinations(taken: ["/Videos/A Better Download.srt"])
        XCTAssertNotEqual(output.subtitleURL.lastPathComponent, "A Better Download.srt")
    }

    /// Numbering would say "there are two" without saying which is which, so the
    /// stepped-aside name states what it is.
    func testTheSteppedAsideNameSaysWhatItIs() {
        let output = destinations(taken: ["/Videos/A Better Download.srt"])
        XCTAssertEqual(
            output.subtitleURL.lastPathComponent,
            "A Better Download.transcribed.srt"
        )
    }

    func testASecondTranscriptNumbersRatherThanOverwrites() {
        let output = destinations(taken: [
            "/Videos/A Better Download.srt",
            "/Videos/A Better Download.transcribed.srt",
        ])
        XCTAssertEqual(
            output.subtitleURL.lastPathComponent,
            "A Better Download.transcribed (2).srt"
        )
    }

    func testTranscriptSharesThePrimaryName() {
        XCTAssertEqual(
            destinations().transcriptURL.lastPathComponent,
            "A Better Download.txt"
        )
    }

    func testAnExistingTranscriptIsNumberedNotOverwritten() {
        let output = destinations(taken: ["/Videos/A Better Download.txt"])
        XCTAssertEqual(output.transcriptURL.lastPathComponent, "A Better Download (2).txt")
    }

    /// Both artifacts must sit in the same folder as the media, or the completion
    /// stack will not associate them with it.
    func testBothArtifactsLandBesideTheMedia() {
        let output = destinations()
        XCTAssertEqual(output.subtitleURL.deletingLastPathComponent().path, "/Videos")
        XCTAssertEqual(output.transcriptURL.deletingLastPathComponent().path, "/Videos")
    }
}

final class TranscriptDeliveryWriteTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-delivery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makePrimary(_ name: String = "Talk.mp4") throws -> URL {
        let url = root.appendingPathComponent(name)
        try Data("not really a video".utf8).write(to: url)
        return url
    }

    private let segments = [
        TranscriptSegment(start: 0, end: 2.4, text: "这是第一句"),
        TranscriptSegment(start: 2.4, end: 5.0, text: "这是第二句"),
    ]

    func testWritesBothArtifacts() throws {
        let primary = try makePrimary()
        let output = try TranscriptDelivery.write(segments: segments, besidePrimary: primary)

        let srt = try String(contentsOf: output.subtitleURL, encoding: .utf8)
        XCTAssertTrue(srt.hasPrefix("1\n"))
        XCTAssertTrue(srt.contains(" --> "))
        XCTAssertTrue(srt.contains("这是第一句"))

        let text = try String(contentsOf: output.transcriptURL, encoding: .utf8)
        XCTAssertFalse(text.contains("-->"), "a transcript carries no timing")
        XCTAssertTrue(text.contains("这是第一句"))
    }

    /// The whole point of writing beside the media: the existing completion stack
    /// must pick both files up as sidecars with no changes to how it discovers them.
    func testArtifactsJoinTheCompletionStack() throws {
        let primary = try makePrimary()
        _ = try TranscriptDelivery.write(segments: segments, besidePrimary: primary)

        let stack = try XCTUnwrap(SmartFinalize.completionStack(primary: primary))
        let names = stack.sidecars.map(\.url.lastPathComponent).sorted()
        XCTAssertEqual(names, ["Talk.srt", "Talk.txt"])
        XCTAssertTrue(
            stack.sidecars.contains { $0.kind == .subtitle },
            "the subtitle must be recognised as one"
        )
        XCTAssertEqual(
            stack.primary.url.lastPathComponent,
            "Talk.mp4",
            "the media stays the primary; the transcript is not a separate result"
        )
    }

    func testAnExistingSubtitleSurvivesUntouched() throws {
        let primary = try makePrimary()
        let existing = root.appendingPathComponent("Talk.srt")
        try Data("1\n00:00:00,000 --> 00:00:01,000\nfrom the site\n\n".utf8).write(to: existing)

        let output = try TranscriptDelivery.write(segments: segments, besidePrimary: primary)

        XCTAssertEqual(
            try String(contentsOf: existing, encoding: .utf8),
            "1\n00:00:00,000 --> 00:00:01,000\nfrom the site\n\n",
            "the site's own subtitle must not be replaced by a machine transcript"
        )
        XCTAssertNotEqual(output.subtitleURL, existing)
        XCTAssertTrue(FileManager.default.fileExists(atPath: output.subtitleURL.path))
    }

    func testMissingPrimaryIsRefused() throws {
        let absent = root.appendingPathComponent("gone.mp4")
        XCTAssertThrowsError(
            try TranscriptDelivery.write(segments: segments, besidePrimary: absent)
        ) { error in
            XCTAssertEqual(error as? TranscriptDelivery.Failure, .primaryMissing)
        }
    }

    /// Silence must not produce two empty files that look like a finished result.
    func testNoRecognisedSpeechWritesNothing() throws {
        let primary = try makePrimary()
        XCTAssertThrowsError(
            try TranscriptDelivery.write(segments: [], besidePrimary: primary)
        ) { error in
            XCTAssertEqual(error as? TranscriptDelivery.Failure, .nothingRecognised)
        }
        let contents = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertEqual(contents, ["Talk.mp4"], "no partial artifacts may be left behind")
    }

    func testBlankSegmentsCountAsNothingRecognised() throws {
        let primary = try makePrimary()
        XCTAssertThrowsError(
            try TranscriptDelivery.write(
                segments: [TranscriptSegment(start: 0, end: 1, text: "   ")],
                besidePrimary: primary
            )
        ) { error in
            XCTAssertEqual(error as? TranscriptDelivery.Failure, .nothingRecognised)
        }
    }
}

final class TranscriptDeliveryStageTests: XCTestCase {
    /// Transcription is the last stretch of the one journey the app already shows,
    /// not a second progress bar competing with it.
    func testStagesMapOntoTheExistingJourneyVocabulary() {
        XCTAssertEqual(
            TranscriptDelivery.Stage.preparingLanguage(.needsPreparation).phase,
            .preparing
        )
        XCTAssertEqual(TranscriptDelivery.Stage.reading(fraction: 0.5).phase, .subtitles)
        XCTAssertEqual(TranscriptDelivery.Stage.writing.phase, .finalizing)
    }

    func testUnknownProgressStaysUnknownRatherThanBecomingZero() {
        XCTAssertNil(TranscriptDelivery.Stage.reading(fraction: nil).fraction)
        XCTAssertEqual(TranscriptDelivery.Stage.reading(fraction: 0.25).fraction, 0.25)
        XCTAssertNil(
            TranscriptDelivery.Stage.preparingLanguage(.needsPreparation).fraction,
            "a download that has not started has no honest fraction"
        )
        XCTAssertEqual(
            TranscriptDelivery.Stage.preparingLanguage(.preparing(fraction: 0.6)).fraction,
            0.6
        )
    }

    func testEveryStageHasWordingAndNoJargon() {
        let stages: [TranscriptDelivery.Stage] = [
            .preparingLanguage(.needsPreparation),
            .preparingLanguage(.preparing(fraction: 0.2)),
            .reading(fraction: nil),
            .writing,
        ]
        for stage in stages {
            let title = stage.title(languageName: "中文")
            XCTAssertFalse(title.isEmpty)
            let lowered = title.lowercased()
            for jargon in ["speech", "srt", "ffmpeg", "locale", "model", "api", "asset"] {
                XCTAssertFalse(
                    lowered.contains(jargon),
                    "\(stage) exposes \(jargon.debugDescription)"
                )
            }
        }
    }
}

/// The full closure: real speech in, two openable files beside the media, both
/// picked up by the completion stack. Nothing is mocked between the microphone
/// format and the bytes on disk.
final class TranscriptDeliveryEndToEndTests: XCTestCase {
    func testRealSpeechBecomesSubtitlesAndATranscriptBesideTheMedia() async throws {
        guard #available(macOS 26, *) else {
            throw XCTSkip("on-device transcription requires macOS 26 or later")
        }
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-e2e-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        // `say` writes AIFF; the engine reads it the same way it reads a download.
        let media = root.appendingPathComponent("讲座录音.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = [
            "-v", "Meijia", "-o", media.path,
            "这是第一句话。这是第二句话。这是第三句话。",
        ]
        say.standardError = Pipe()
        try say.run()
        say.waitUntilExit()
        guard say.terminationStatus == 0,
              FileManager.default.fileExists(atPath: media.path) else {
            throw XCTSkip("no Chinese voice installed for `say`")
        }

        let environment = await SpeechTranscriptionEngine.environment()
        guard let locale = TranscriptionWorkflow.match(
            tag: "zh-Hans",
            in: environment.supportedLocaleIdentifiers
        ) else {
            throw XCTSkip("this system cannot transcribe Chinese")
        }
        let readiness = await SpeechLanguageAssets.readiness(forLocaleIdentifier: locale)
        guard readiness.isReady else {
            throw XCTSkip("Chinese would need a language download; not triggering one in tests")
        }

        let segments = try await SpeechTranscriptionEngine().transcribe(
            fileURL: media,
            localeIdentifier: locale
        )
        let output = try TranscriptDelivery.write(segments: segments, besidePrimary: media)

        let srt = try String(contentsOf: output.subtitleURL, encoding: .utf8)
        XCTAssertTrue(srt.hasPrefix("1\n"), "must be valid SubRip")
        XCTAssertTrue(srt.contains(" --> "))
        XCTAssertTrue(srt.hasSuffix("\n\n"))

        let transcript = try String(contentsOf: output.transcriptURL, encoding: .utf8)
        XCTAssertFalse(transcript.isEmpty)
        XCTAssertFalse(transcript.contains("-->"))

        // The sidecars must share the media's name, CJK and all.
        XCTAssertEqual(output.subtitleURL.lastPathComponent, "讲座录音.srt")
        XCTAssertEqual(output.transcriptURL.lastPathComponent, "讲座录音.txt")

        let stack = try XCTUnwrap(SmartFinalize.completionStack(primary: media))
        XCTAssertEqual(
            stack.sidecars.map(\.url.lastPathComponent).sorted(),
            ["讲座录音.srt", "讲座录音.txt"],
            "both artifacts must arrive as sidecars of one result"
        )
    }
}
