import XCTest
@testable import NDMEngine

final class YtDlpPreviewNoticeTests: XCTestCase {
    func testPreparedExtractionRemovesNestedSessionCredentials() throws {
        let original: [String: Any] = ["title": "Fixture", "http_headers": ["User-Agent": "fixture", "Cookie": "top-secret"],
            "formats": [["url": "https://cdn.example/video.mp4", "cookies": "format-secret",
                "http_headers": ["Authorization": "bearer-secret", "Referer": "https://example.test/watch"]]]]
        let cleaned = YtDlpTool.extractionWithoutCredentials(original)
        let text = String(decoding: try JSONSerialization.data(withJSONObject: cleaned), as: UTF8.self)
        for secret in ["top-secret", "format-secret", "bearer-secret"] { XCTAssertFalse(text.contains(secret)) }
        XCTAssertTrue(text.contains("User-Agent"))
        XCTAssertTrue(text.contains("Referer"))
        XCTAssertTrue(text.contains("video.mp4"))
    }

    func testSamePageDifferentSessionsNeverOverwritePreparedExtraction() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tool = root.appendingPathComponent("fixture-tool")
        func writeTool(_ title: String) throws {
            let json: [String: Any] = ["id": "fixture", "title": title, "formats": []]
            let output = String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self)
            try Data(("#!/bin/sh\nprintf '%s' '" + output + "'\n").utf8).write(to: tool)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tool.path)
        }
        let cache = root.appendingPathComponent("cache")
        try writeTool("Profile A")
        let first = try await YtDlpTool.probe(url: "https://fixture.invalid/watch", usingExecutable: tool.path, cacheDirectory: cache)
        try writeTool("Profile B")
        let second = try await YtDlpTool.probe(url: "https://fixture.invalid/watch", usingExecutable: tool.path, cacheDirectory: cache)
        XCTAssertNotEqual(first.infoJSONPath, second.infoJSONPath)
        let original = try String(contentsOfFile: XCTUnwrap(first.infoJSONPath), encoding: .utf8)
        XCTAssertTrue(original.contains("Profile A"))
        XCTAssertFalse(original.contains("Profile B"))
    }

    private func probe(extractor: String = "BiliBiliBangumi", title: String = "Fixture", warning: String) async throws -> YtDlpProbe {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tool = root.appendingPathComponent("fixture-tool")
        let json: [String: Any] = ["extractor_key": extractor, "id": "42", "title": title, "duration": 3,
            "formats": [["format_id": "18", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "height": 720, "width": 1280, "url": "https://fixture.invalid/video.mp4"]]]
        let output = String(data: try JSONSerialization.data(withJSONObject: json), encoding: .utf8)!
        func quote(_ text: String) -> String { "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let split = warning.index(warning.startIndex, offsetBy: warning.count / 2)
        let script = "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" != '--no-warnings' ] || exit 7; done\nprintf '%s' " + quote(output)
            + "\nprintf '%s' " + quote(String(warning[..<split])) + " >&2\nsleep 0.05\nprintf '%s' " + quote(String(warning[split...])) + " >&2\n"
        try Data(script.utf8).write(to: tool)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tool.path)
        let result = try await YtDlpTool.probe(url: "https://fixture.invalid/ep42", usingExecutable: tool.path, cacheDirectory: root.appendingPathComponent("cache"))
        XCTAssertTrue(result.infoJSONPath?.hasPrefix(root.appendingPathComponent("cache").path + "/") == true)
        return result
    }
    func testFragmentedPreviewWarningWithoutNewlineKeepsSuccessfulFormats() async throws {
        let result = try await probe(warning: "WARNING: [BiliBiliBangumi] Only preview format is available, you have to become a premium member to access full video.")
        XCTAssertEqual(result.availabilityNotice, .previewOnly)
        XCTAssertEqual(result.title, "Fixture")
        XCTAssertFalse(result.formats.isEmpty)
    }
    func testUnrelatedWarningsShortDurationAndTitleCannotInventPreview() async throws {
        for warning in ["", "WARNING: premium-only formats unavailable", "WARNING: Login required for subtitles"] {
            let result = try await probe(title: "Only preview format is available,", warning: warning)
            XCTAssertNil(result.availabilityNotice)
            XCTAssertEqual(result.durationSeconds, 3)
        }
        let other = try await probe(extractor: "Youtube", warning: "WARNING: [BiliBiliBangumi] Only preview format is available, membership required")
        XCTAssertNil(other.availabilityNotice)
    }
    func testExactExtractorAndUpstreamWarningPrefixAreRequired() {
        let json: [String: Any] = ["extractor_key": "BiliBiliBangumi", "id": "42"]
        XCTAssertNil(YtDlpTool.availabilityNotice(json: json, stderr: "WARNING: [BiliBiliBangumi] 43: Only preview format is available,"))
        XCTAssertNil(YtDlpTool.availabilityNotice(json: json, stderr: "Title contains Only preview format is available,"))
    }

    func testPreflightCacheRetainsStructuredNoticeWhenReopened() async throws {
        actor Counter { var value = 0; func increment() { value += 1 } }
        let counter = Counter()
        let metadata = YtDlpProbe(title: "Preview", durationSeconds: 3,
            formats: [YtDlpFormat(id: "18", label: "720p", height: 720)], availabilityNotice: .previewOnly)
        let store = MediaPreflightStore(
            expand: { ExpandedShortLink(originalURL: $0, resolvedURL: $0, didExpand: false) },
            probe: { _ in await counter.increment(); return metadata }, probeCollection: { _ in nil })
        let first = try await store.result(for: "https://fixture.invalid/ep42")
        let reopened = try await store.result(for: "https://fixture.invalid/ep42")
        XCTAssertEqual(first.probe.availabilityNotice, .previewOnly)
        XCTAssertEqual(reopened.probe.availabilityNotice, .previewOnly)
        let count = await counter.value
        XCTAssertEqual(count, 1)
    }
}
