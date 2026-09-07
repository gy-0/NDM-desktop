import Foundation

public struct MediaToolComponentStatus: Codable, Equatable, Sendable {
    public let name: String
    public let path: String?
    public let bundled: Bool
    public let ready: Bool
    public let version: String?
}

public struct MediaToolchainReport: Codable, Equatable, Sendable {
    public let ready: Bool
    public let allBundled: Bool
    public let components: [MediaToolComponentStatus]
}

/// Headless release check used by packaging and notarization jobs. The normal
/// product UI never exposes these implementation names to end users.
public enum MediaToolchain {
    public static func inspect() -> MediaToolchainReport {
        let tools: [(name: String, path: String?, args: [String])] = [
            ("yt-dlp", YtDlpTool.find(), ["--version"]),
            ("ffmpeg", FFmpegTool.find(), ["-version"]),
            (
                "deno",
                BundledToolLocator.find(
                    ["deno"],
                    developerFallbacks: ["/opt/homebrew/bin/deno", "/usr/local/bin/deno"]
                ),
                ["--version"]
            ),
        ]
        let roots = bundledToolRoots()
        let components = tools.map { tool -> MediaToolComponentStatus in
            guard let path = tool.path else {
                return MediaToolComponentStatus(
                    name: tool.name,
                    path: nil,
                    bundled: false,
                    ready: false,
                    version: nil
                )
            }
            let result = runVersion(path: path, arguments: tool.args)
            return MediaToolComponentStatus(
                name: tool.name,
                path: path,
                bundled: isInside(path: path, roots: roots),
                ready: result.ready,
                version: result.version
            )
        }
        return MediaToolchainReport(
            ready: components.allSatisfy(\.ready),
            allBundled: components.allSatisfy(\.bundled),
            components: components
        )
    }

    static func isInside(path: String, roots: [URL]) -> Bool {
        let candidate = URL(fileURLWithPath: path).standardizedFileURL.path
        return roots.contains { root in
            let raw = root.standardizedFileURL.path
            let prefix = raw.hasSuffix("/") ? String(raw.dropLast()) : raw
            return candidate == prefix || candidate.hasPrefix(prefix + "/")
        }
    }

    private static func bundledToolRoots() -> [URL] {
        var roots: [URL] = []
        if let resources = Bundle.main.resourceURL {
            roots.append(resources.appendingPathComponent("Tools", isDirectory: true))
        }
        roots.append(
            Bundle.main.bundleURL
                .appendingPathComponent("Contents/Resources/Tools", isDirectory: true)
        )
        return roots
    }

    private static func runVersion(path: String, arguments: [String]) -> (ready: Bool, version: String?) {
        guard let probe = ToolVersionProbe.run(toolAt: URL(fileURLWithPath: path), arguments: arguments) else {
            return (false, nil)
        }
        return (probe.exitStatus == 0, probe.firstLine)
    }
}

/// Shared sandboxed `--version`-style probe. The pipe is drained to EOF before
/// waiting for exit so a chatty tool can never deadlock against a full pipe buffer.
enum ToolVersionProbe {
    struct Result {
        let exitStatus: Int32
        let firstLine: String?
    }

    static func run(toolAt tool: URL, arguments: [String]) -> Result? {
        let process = Process()
        process.executableURL = tool
        process.arguments = arguments
        process.environment = [
            "HOME": FileManager.default.temporaryDirectory.path,
            "TMPDIR": FileManager.default.temporaryDirectory.path,
            "PATH": "/usr/bin:/bin",
            "LC_ALL": "C",
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let firstLine = String(data: data, encoding: .utf8)?
                .split(whereSeparator: { $0.isNewline })
                .map(String.init)
                .first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Result(exitStatus: process.terminationStatus, firstLine: firstLine)
        } catch {
            return nil
        }
    }
}
