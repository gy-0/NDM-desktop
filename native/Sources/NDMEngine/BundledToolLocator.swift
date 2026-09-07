import Foundation

/// Release builds ship the media toolchain inside the app. PATH lookups remain
/// only as a developer fallback; end users never need Homebrew or Terminal.
enum BundledToolLocator {
    static func bundledExecutable(named names: [String]) -> URL? {
        let roots = bundledRoots()
        guard let path = find(
            names,
            bundledRoots: roots,
            developerFallbacks: [],
            allowDeveloperFallbacks: false
        ) else { return nil }
        return URL(fileURLWithPath: path)
    }

    static func find(_ names: [String], developerFallbacks: [String] = []) -> String? {
        let roots = bundledRoots()

        return find(
            names,
            bundledRoots: roots,
            developerFallbacks: developerFallbacks,
            allowDeveloperFallbacks: developerFallbacksEnabled
        )
    }

    private static func bundledRoots() -> [URL] {
        var roots: [URL] = []
        if let override = ProcessInfo.processInfo.environment["NDM_TOOL_DIR"], !override.isEmpty {
            roots.append(URL(fileURLWithPath: override, isDirectory: true))
        }
        if let resources = Bundle.main.resourceURL {
            roots.append(resources.appendingPathComponent("Tools", isDirectory: true))
            roots.append(resources.appendingPathComponent("bin", isDirectory: true))
        }
        roots.append(
            Bundle.main.bundleURL
                .appendingPathComponent("Contents/Resources/Tools", isDirectory: true)
        )
        let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        roots.append(exeDir.appendingPathComponent("Tools", isDirectory: true))
        roots.append(exeDir.appendingPathComponent("../Tools", isDirectory: true))
        roots.append(exeDir.appendingPathComponent("../Resources/Tools", isDirectory: true))
#if DEBUG
        roots.append(URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Vendor/Tools", isDirectory: true))
#endif
        return roots
    }

    /// Explicit roots make the release contract testable without depending on
    /// the test runner's own bundle layout.
    static func find(
        _ names: [String],
        bundledRoots: [URL],
        developerFallbacks: [String],
        allowDeveloperFallbacks: Bool
    ) -> String? {
        for root in bundledRoots {
            for name in names {
                let path = root.appendingPathComponent(name).path
                if FileManager.default.isExecutableFile(atPath: path) { return path }
            }
        }
        if allowDeveloperFallbacks {
            for path in developerFallbacks where FileManager.default.isExecutableFile(atPath: path) {
                return path
            }
            let systemDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            for dir in systemDirs {
                for name in names {
                    let path = "\(dir)/\(name)"
                    if FileManager.default.isExecutableFile(atPath: path) { return path }
                }
            }
        }
        return nil
    }

    private static var developerFallbacksEnabled: Bool {
#if DEBUG
        true
#else
        false
#endif
    }
}
