import Foundation
import NDMCore

/// Read-only look inside an installer package for the app icon a download
/// row should show. Never runs scripts or copies anything to `/Applications`.
public enum PackageIconPeek: Sendable {
    /// Unpack just enough of `pkgURL` to reconstruct the primary app bundle's
    /// icon files, run `body`, then delete the scratch directory.
    public static func withStubApp<Result: Sendable>(
        pkgURL: URL,
        preferredName: String,
        _ body: @Sendable (URL) async throws -> Result
    ) async throws -> Result? {
        let temp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-pkg-peek-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temp) }

        if let stub = try extractStubApp(pkgURL: pkgURL, into: temp, preferredName: preferredName) {
            return try await body(stub)
        }
        if let stub = try expandFullStubApp(pkgURL: pkgURL, into: temp, preferredName: preferredName) {
            return try await body(stub)
        }
        return nil
    }

    /// `path="…"` values from a `PackageInfo` document.
    public static func bundlePaths(in packageInfo: String) -> [String] {
        var paths: [String] = []
        var remaining = packageInfo[...]
        let marker = "path=\""
        while let start = remaining.range(of: marker) {
            let after = remaining[start.upperBound...]
            guard let end = after.firstIndex(of: "\"") else { break }
            paths.append(String(after[..<end]))
            remaining = after[end...]
        }
        return paths
    }

    /// The payload-relative app that should represent this package in a list.
    public static func primaryAppPath(bundlePaths: [String], preferredName: String) -> String? {
        let candidates = InstallerFilter.appBundleCandidates(entries: bundlePaths)
        return InstallerPlan.preferredApp(candidates: candidates, filename: preferredName)
    }

    // MARK: - Extraction

    private static func extractStubApp(
        pkgURL: URL,
        into temp: URL,
        preferredName: String
    ) throws -> URL? {
        let unpacked = temp.appendingPathComponent("xar", isDirectory: true)
        try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
        let xar = try run(
            executable: "/usr/bin/xar",
            arguments: ["-C", unpacked.path, "-xf", pkgURL.path],
            timeout: 60
        )
        guard xar.terminationStatus == 0 else { return nil }

        for component in componentPackages(in: unpacked) {
            let infoURL = component.appendingPathComponent("PackageInfo")
            guard let xml = try? String(contentsOf: infoURL, encoding: .utf8),
                  let relative = primaryAppPath(
                    bundlePaths: bundlePaths(in: xml),
                    preferredName: preferredName
                  ) else {
                continue
            }
            let payload = component.appendingPathComponent("Payload")
            guard FileManager.default.fileExists(atPath: payload.path) else { continue }
            let extract = temp.appendingPathComponent("tree", isDirectory: true)
            try FileManager.default.createDirectory(at: extract, withIntermediateDirectories: true)
            try extractGzipPayload(payload, matching: [payloadEntry(relative, "Contents/Info.plist")], into: extract)
            let stub = appURL(relative: relative, under: extract)
            let iconName = iconFileName(in: stub) ?? "AppIcon.icns"
            try extractGzipPayload(
                payload,
                matching: [payloadEntry(relative, "Contents/Resources/\(iconName)")],
                into: extract
            )
            if !stubHasIcon(stub) {
                try extractGzipPayload(
                    payload,
                    matching: [payloadEntry(relative, "Contents/Resources/*.icns")],
                    into: extract
                )
            }
            if stubLooksUsable(stub) { return stub }
        }
        return nil
    }

    private static func expandFullStubApp(
        pkgURL: URL,
        into temp: URL,
        preferredName: String
    ) throws -> URL? {
        let expanded = temp.appendingPathComponent("full", isDirectory: true)
        let result = try run(
            executable: "/usr/sbin/pkgutil",
            arguments: ["--expand-full", pkgURL.path, expanded.path],
            timeout: 90
        )
        guard result.terminationStatus == 0 else { return nil }
        let entries = VolumeEnumerator.entries(in: expanded)
        let candidates = InstallerFilter.appBundleCandidates(entries: entries)
        guard let relative = InstallerPlan.preferredApp(
            candidates: candidates,
            filename: preferredName
        ) else {
            return nil
        }
        let stub = expanded.appendingPathComponent(relative)
        return stubLooksUsable(stub) ? stub : nil
    }

    private static func componentPackages(in root: URL) -> [URL] {
        var found: [URL] = []
        func consider(_ directory: URL) {
            let info = directory.appendingPathComponent("PackageInfo")
            let payload = directory.appendingPathComponent("Payload")
            if FileManager.default.fileExists(atPath: info.path),
               FileManager.default.fileExists(atPath: payload.path) {
                found.append(directory)
            }
        }
        consider(root)
        let items = (try? FileManager.default.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        )) ?? []
        for item in items where item.pathExtension.lowercased() == "pkg" {
            consider(item)
        }
        return found
    }

    private static func extractGzipPayload(
        _ payload: URL,
        matching patterns: [String],
        into directory: URL
    ) throws {
        guard isGzip(payload) else { return }
        let gzip = Process()
        gzip.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        gzip.arguments = ["-dc", payload.path]
        let cpio = Process()
        cpio.executableURL = URL(fileURLWithPath: "/usr/bin/cpio")
        cpio.arguments = ["-idmu"] + patterns
        cpio.currentDirectoryURL = directory
        let pipe = Pipe()
        gzip.standardOutput = pipe
        gzip.standardError = FileHandle.nullDevice
        gzip.standardInput = FileHandle.nullDevice
        cpio.standardInput = pipe
        cpio.standardOutput = FileHandle.nullDevice
        cpio.standardError = FileHandle.nullDevice
        try gzip.run()
        try cpio.run()
        cpio.waitUntilExit()
        gzip.waitUntilExit()
    }

    private static func isGzip(_ file: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
        defer { try? handle.close() }
        let magic = (try? handle.read(upToCount: 2)) ?? Data()
        return magic == Data([0x1f, 0x8b])
    }

    private static func payloadEntry(_ bundle: String, _ file: String) -> String {
        var base = bundle
        while base.hasPrefix("/") { base.removeFirst() }
        if !base.hasPrefix("./") { base = "./" + base }
        return "\(base)/\(file)"
    }

    private static func appURL(relative: String, under root: URL) -> URL {
        var path = relative
        while path.hasPrefix("./") { path.removeFirst(2) }
        return root.appendingPathComponent(path)
    }

    private static func iconFileName(in appURL: URL) -> String? {
        let info = appURL.appendingPathComponent("Contents/Info.plist")
        guard let plist = NSDictionary(contentsOf: info) else { return nil }
        if let file = plist["CFBundleIconFile"] as? String, !file.isEmpty {
            return file.lowercased().hasSuffix(".icns") ? file : "\(file).icns"
        }
        if let name = plist["CFBundleIconName"] as? String, !name.isEmpty {
            return name.lowercased().hasSuffix(".icns") ? name : "\(name).icns"
        }
        return nil
    }

    private static func stubHasIcon(_ appURL: URL) -> Bool {
        let resources = appURL.appendingPathComponent("Contents/Resources")
        let icons = (try? FileManager.default.contentsOfDirectory(at: resources, includingPropertiesForKeys: nil)) ?? []
        return icons.contains { $0.pathExtension.lowercased() == "icns" }
    }

    private static func stubLooksUsable(_ appURL: URL) -> Bool {
        let info = appURL.appendingPathComponent("Contents/Info.plist")
        guard FileManager.default.fileExists(atPath: info.path) else { return false }
        return stubHasIcon(appURL) || NSDictionary(contentsOf: info) != nil
    }

    private static func run(
        executable: String,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> DMGImageTool.ProcessResult {
        try DMGImageTool.run(arguments, executable: executable, timeout: timeout)
    }
}
