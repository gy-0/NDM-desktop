import Foundation

/// Errors surfaced by the one-click installer.
///
/// Separate from `EngineError` because these describe a different surface: not
/// a download that failed, but a local install that could not be completed.
public enum InstallerError: Error, LocalizedError, Equatable {
    /// The system disk-image service returned no usable mount point.
    case mountFailed(detail: String)
    /// The mounted volume could not be read.
    case enumerationFailed(detail: String)
    /// The chosen app bundle is missing from the mounted volume.
    case appNotFound(app: String)
    /// The copy step failed (permission, disk full, locked file…).
    case copyFailed(detail: String)
    /// The system disk-image service could not eject the mounted volume.
    case detachFailed(detail: String)
    /// The destination directory does not exist and could not be created.
    case destinationUnavailable(detail: String)
    /// Cancelled by the user or the owning window.
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .mountFailed(let d): return "Could not mount the disk image. \(d)"
        case .enumerationFailed(let d): return "Could not read the disk image. \(d)"
        case .appNotFound(let a): return "The app “\(a)” was not found in the disk image."
        case .copyFailed(let d): return "Could not copy the app. \(d)"
        case .detachFailed(let d): return "The disk image could not be unmounted. \(d)"
        case .destinationUnavailable(let d): return "The destination folder is not available. \(d)"
        case .cancelled: return "The install was cancelled."
        }
    }
}

/// Thin wrapper around macOS' system disk-image tools for one-click install.
///
/// Ported from the *behavior* of Rapidmg 1.3.1 (reverse spec 15). Rapidmg
/// extracts DMGs with an embedded 7-Zip and never mounts; NDM is not sandboxed,
/// so the system tools present on every supported macOS are the lighter,
/// dependency-free equivalent. macOS 26 deprecated `hdiutil attach`; mounting
/// now goes through `diskutil image attach`, while `hdiutil` remains for image
/// metadata and conversion operations that diskutil does not cover.
public enum DMGImageTool: Sendable {
    struct ProcessResult: Sendable {
        let terminationStatus: Int32
        let standardOutput: String
        let standardError: String
    }

    public static let hdiutil = "/usr/bin/hdiutil"
    public static let diskutil = "/usr/sbin/diskutil"

    /// Mount the image read-only and hidden from Finder; returns the mount point.
    /// The caller must call `detach` (preferably via `withMountedImage`).
    ///
    /// Retries transient failures: the disk-images helper daemon occasionally
    /// answers "resource temporarily unavailable" when several attaches land
    /// in quick succession (Rapidmg's `attachHandleBusy` behavior).
    public static func attach(dmgURL: URL, timeout: TimeInterval = 60) throws -> URL {
        try attachImage(
            executable: diskutil,
            arguments: ["image", "attach", "--plist", "--readOnly", "--nobrowse", dmgURL.path],
            timeout: timeout
        )
    }

    /// Eject the volume; falls back to a force detach for a busy read-only mount.
    public static func detach(mountPoint: URL, timeout: TimeInterval = 60) throws {
        let normal = try run(["eject", mountPoint.path], executable: diskutil, timeout: timeout)
        if normal.terminationStatus == 0 { return }
        // Finder, Quick Look, and scanner processes can briefly retain a mount.
        // Forcing is safe here because NDM always mounts the image read-only.
        let forced = try run(["detach", mountPoint.path, "-force", "-quiet"], timeout: timeout)
        guard forced.terminationStatus == 0 else {
            throw InstallerError.detachFailed(
                detail: forced.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
    }

    /// Mount, run `body`, and always detach — including when `body` throws.
    public static func withMountedImage<Result>(
        dmgURL: URL,
        timeout: TimeInterval = 60,
        _ body: (URL) throws -> Result
    ) throws -> Result {
        let mountPoint = try attach(dmgURL: dmgURL, timeout: timeout)
        do {
            let result = try body(mountPoint)
            try detach(mountPoint: mountPoint, timeout: timeout)
            return result
        } catch {
            try? detach(mountPoint: mountPoint, timeout: timeout)
            throw error
        }
    }

    // MARK: License-agreement bypass

    /// A mount obtained through `attachBypassingLicense`.
    public struct BypassMount: Sendable {
        public let mountPoint: URL
        /// The converted UDTO image in a private temp directory; delete the
        /// parent directory after detaching.
        public let temporaryImage: URL

        public var temporaryDirectory: URL {
            temporaryImage.deletingLastPathComponent()
        }
    }

    /// Mount an SLA-protected image by stripping the license wrapper first.
    ///
    /// The license agreement lives in the UDIF metadata, not in the volume
    /// contents. Converting the image to raw UDTO (`hdiutil convert -format
    /// UDTO`) produces a bare partition image that carries no SLA — the
    /// community-verified way to mount such images non-interactively. The
    /// converted image lives in a temp directory the caller must delete after
    /// detaching (see `BypassMount.temporaryDirectory`).
    public static func attachBypassingLicense(
        dmgURL: URL, timeout: TimeInterval = 90
    ) throws -> BypassMount {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-install-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let stripped = tempDir.appendingPathComponent("stripped.cdr")

        let convert = try run(
            ["convert", "-quiet", dmgURL.path, "-format", "UDTO", "-o", stripped.path],
            timeout: timeout
        )
        guard convert.terminationStatus == 0 else {
            try? FileManager.default.removeItem(at: tempDir)
            throw InstallerError.mountFailed(
                detail: convert.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }
        let mountPoint = try attachImage(
            executable: diskutil,
            arguments: ["image", "attach", "--plist", "--readOnly", "--nobrowse", stripped.path],
            timeout: timeout
        )
        return BypassMount(mountPoint: mountPoint, temporaryImage: stripped)
    }

    /// Whether the image carries a software license agreement.
    ///
    /// `hdiutil attach` refuses (or interactively prompts on) SLA-protected
    /// images, so the caller routes them through `attachBypassingLicense`
    /// after the user accepts — the same dialog-first flow as Rapidmg.
    public static func hasLicenseAgreement(
        dmgURL: URL, timeout: TimeInterval = 60
    ) throws -> Bool {
        let result = try run(["imageinfo", "-plist", dmgURL.path], timeout: timeout)
        guard result.terminationStatus == 0 else { return false }
        return parseLicenseAgreement(plist: result.standardOutput)
    }

    /// `hdiutil imageinfo -plist` reports the license under `Properties`.
    static func parseLicenseAgreement(plist: String) -> Bool {
        guard let data = plist.data(using: .utf8),
              let root = try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil
              ) as? [String: Any],
              let properties = root["Properties"] as? [String: Any] else {
            return false
        }
        return properties["Software License Agreement"] as? Bool == true
    }

    // MARK: - Parsing

    /// Attach an image path with several attempts against transient
    /// "resource temporarily unavailable" failures from the helper daemon.
    /// Under test load the daemon can stay saturated for a couple of seconds,
    /// so the backoff grows past that (Rapidmg's `attachHandleBusy` behavior).
    private static func attachImage(
        executable: String,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> URL {
        var lastDetail = "disk image attach failed"
        let backoff: [TimeInterval] = [0.8, 1.6, 3.0]
        for attempt in 0...backoff.count {
            let result = try run(arguments, executable: executable, timeout: timeout)
            if result.terminationStatus == 0,
               let mountPoint = parseMountPoint(plist: result.standardOutput) {
                return URL(fileURLWithPath: mountPoint, isDirectory: true)
            }
            let detail = result.standardError.trimmingCharacters(in: .whitespacesAndNewlines)
            if !detail.isEmpty { lastDetail = detail }
            if attempt < backoff.count {
                Thread.sleep(forTimeInterval: backoff[attempt])
            }
        }
        throw InstallerError.mountFailed(detail: lastDetail)
    }

    /// `diskutil image attach --plist` reports mount points in `system-entities`.
    static func parseMountPoint(plist: String) -> String? {
        guard let data = plist.data(using: .utf8),
              let root = try? PropertyListSerialization.propertyList(
                  from: data, options: [], format: nil
              ) as? [String: Any],
              let entities = root["system-entities"] as? [[String: Any]] else {
            return nil
        }
        for entity in entities {
            if let mountPoint = entity["mount-point"] as? String {
                return mountPoint
            }
        }
        return nil
    }

    // MARK: - Process plumbing

    static func run(
        _ arguments: [String],
        executable: String = hdiutil,
        timeout: TimeInterval
    ) throws -> ProcessResult {
        let stdoutURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hdiutil-out-\(UUID().uuidString)")
        let stderrURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-hdiutil-err-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: stdoutURL.path, contents: nil)
        FileManager.default.createFile(atPath: stderrURL.path, contents: nil)
        defer {
            try? FileManager.default.removeItem(at: stdoutURL)
            try? FileManager.default.removeItem(at: stderrURL)
        }

        let outHandle = try FileHandle(forWritingTo: stdoutURL)
        let errHandle = try FileHandle(forWritingTo: stderrURL)
        defer {
            try? outHandle.close()
            try? errHandle.close()
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = outHandle
        process.standardError = errHandle
        process.standardInput = FileHandle.nullDevice
        try process.run()

        let startedAt = Date()
        while process.isRunning, Date().timeIntervalSince(startedAt) < timeout {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
        try? outHandle.synchronize()
        try? errHandle.synchronize()
        return ProcessResult(
            terminationStatus: process.terminationStatus,
            standardOutput: (try? String(contentsOf: stdoutURL, encoding: .utf8)) ?? "",
            standardError: (try? String(contentsOf: stderrURL, encoding: .utf8)) ?? ""
        )
    }
}
