import XCTest
@testable import NDMEngine

final class YtDlpConfigurationIsolationTests: XCTestCase {
    func testOperationalArgumentsPreserveExplicitChoices() {
        for arguments in [["-J", "--no-download", "https://fixture.invalid/video"],
                          ["-J", "--flat-playlist", "--playlist-end", "100", "https://fixture.invalid/list"],
                          ["--plugin-dirs", "/tmp/explicit-plugins", "--cookies-from-browser", "firefox", "-f", "18", "-o", "/tmp/explicit.mp4", "--load-info-json", "/tmp/info.json"],
                          ["--version"]] {
            let actual = YtDlpTool.executionArguments(arguments)
            XCTAssertEqual(actual.first, "--ignore-config")
            XCTAssertEqual(Array(actual.dropFirst()), arguments)
        }
    }
    func testActualBundledToolIgnoresTemporaryUserConfiguration() throws {
        let checkout = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let bundled = checkout.appendingPathComponent("Vendor/Tools/yt-dlp")
        guard FileManager.default.isExecutableFile(atPath: bundled.path) else { throw XCTSkip("Bundled yt-dlp not prepared") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let tool = root.appendingPathComponent("yt-dlp")
        try FileManager.default.copyItem(at: bundled, to: tool)
        // PyInstaller onedir runtime is read-only; the executable/config locations stay isolated.
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("_internal"),
                                                   withDestinationURL: bundled.deletingLastPathComponent().appendingPathComponent("_internal"))
        let configuration = root.appendingPathComponent("config/yt-dlp")
        try FileManager.default.createDirectory(at: configuration, withIntermediateDirectories: true)
        // Stop subsequent system config loading even in the baseline run.
        let sentinel = "NDM-ISOLATED-CONFIG-SENTINEL"
        try Data("--ignore-config\n--output \(sentinel)\n".utf8).write(to: configuration.appendingPathComponent("config"))
        let info = root.appendingPathComponent("info.json")
        try Data(#"{"id":"fixture","title":"fixture","extractor":"fixture","webpage_url":"https://fixture.invalid","url":"http://127.0.0.1:1/f.mp4","ext":"mp4"}"#.utf8).write(to: info)
        let inspectArguments = ["--skip-download", "--no-check-formats", "--print", "filename", "--load-info-json", info.path]
        func run(_ arguments: [String]) throws -> String {
            let process = Process()
            process.executableURL = tool
            process.arguments = arguments
            process.currentDirectoryURL = root
            process.environment = ["PATH": "/usr/bin:/bin", "HOME": root.path, "CFFIXED_USER_HOME": root.path,
                                   "XDG_CONFIG_HOME": root.appendingPathComponent("config").path, "TMPDIR": root.path]
            let out = Pipe(), err = Pipe()
            process.standardOutput = out; process.standardError = err
            try process.run()
            let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
            DispatchQueue.global().asyncAfter(deadline: .now() + 15, execute: timeout)
            defer { timeout.cancel() }
            let bytes = out.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0)
            return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        XCTAssertEqual(try run(inspectArguments), sentinel, "Fixture must prove automatic config loading")
        let protected = try run(YtDlpTool.executionArguments(inspectArguments))
        XCTAssertFalse(protected.isEmpty)
        XCTAssertNotEqual(protected, sentinel, "NDM must not inherit even a valid user option")
        XCTAssertEqual(try run(YtDlpTool.executionArguments(["--output", "NDM-EXPLICIT"] + inspectArguments)), "NDM-EXPLICIT")
    }
}
