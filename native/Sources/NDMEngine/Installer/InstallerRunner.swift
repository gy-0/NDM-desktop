import Foundation
import NDMCore

/// Orchestrates a one-click install of an app from a disk image.
///
/// Behavior ported from Rapidmg 1.3.1 (reverse spec 15 §3/§6), adapted to NDM:
///
/// 1. Mount the image read-only and hidden (`DMGImageTool`).
/// 2. Enumerate the volume, prune filesystem private data, detect app bundles.
/// 3. Install: single app directly; several apps ask the caller to choose;
///    none returns `.noAppFound` and the caller handles the fallback.
/// 4. Conflict: an existing destination yields `.needsReplaceConsent` and the
///    caller re-drives with `replaceExisting: true` after a human decision.
///    Rapidmg's `remove → copy` order is kept so a half-written bundle never
///    sits where the old app used to be.
/// 5. Stamp the installed bundle's modification date to now, so the app reads
///    as freshly installed (Rapidmg `setAttributes` behavior).
/// 6. Detach unconditionally — including on error.
///
/// The caller injects the one human decision (`askChoose`); replacement is a
/// two-step re-drive so no decision needs to be bridged into sync code.
public enum InstallerRunner: Sendable {
    public enum Step: Equatable, Sendable {
        case mounting
        case enumerating
        case copying(app: String)
        case detaching
    }

    public enum Outcome: Equatable, Sendable {
        case installed(appName: String, at: URL)
        /// The destination already contains this app; the caller must ask and
        /// re-drive with `replaceExisting: true`.
        case needsReplaceConsent(appName: String)
        /// The image carries a software license agreement and the user has not
        /// accepted it yet. The caller shows its own accept dialog (Rapidmg
        /// style), then re-drives with `licenseAccepted: true` — the runner
        /// then mounts via the SLA-stripping convert path.
        case needsLicenseHandoff
        case noAppFound
    }

    /// Seam for tests: how an image's license agreement is detected.
    /// Defaults to `hdiutil imageinfo`; tests stub it because a real
    /// SLA-protected image cannot be created on modern macOS (udifrez is
    /// deprecated and broken).
    public static let defaultSLADetection: @Sendable (URL) throws -> Bool = { dmgURL in
        try DMGImageTool.hasLicenseAgreement(dmgURL: dmgURL)
    }

    static var slaDetection: @Sendable (URL) throws -> Bool = InstallerRunner.defaultSLADetection

    /// Run the whole install. Safe to call from any actor; the synchronous
    /// `hdiutil`/copy work runs on detached tasks.
    ///
    /// - Parameters:
    ///   - dmgURL: the finished download.
    ///   - destination: where apps land (defaults to `/Applications`).
    ///   - replaceExisting: pre-consented replacement (second step of the
    ///     conflict flow); skips the consent outcome.
    ///   - onStep: progress hook (called off the main actor).
    ///   - askChoose: asked when several apps are found; return the candidate
    ///     to install, or `nil` to install nothing.
    ///   - cancelToken: checked between steps.
    public static func process(
        dmgURL: URL,
        destination: URL = URL(fileURLWithPath: "/Applications", isDirectory: true),
        replaceExisting: Bool = false,
        licenseAccepted: Bool = false,
        onStep: (@Sendable (Step) -> Void)? = nil,
        askChoose: (@Sendable ([String]) async -> String?)? = nil,
        cancelToken: CancelToken? = nil
    ) async throws -> Outcome {
        func checkCancelled() throws {
            if cancelToken?.isCancelled ?? false { throw InstallerError.cancelled }
        }

        // SLA images cannot be attached directly. First run: return so the
        // caller can show its accept dialog; after acceptance the caller
        // re-drives with `licenseAccepted` and we mount via the convert path,
        // which strips the license wrapper (it lives in UDIF metadata, not in
        // the volume contents).
        let hasSLA = try await detached { try slaDetection(dmgURL) }
        var bypass: DMGImageTool.BypassMount?
        onStep?(.mounting)
        try checkCancelled()
        let mountPoint: URL
        if hasSLA {
            guard licenseAccepted else { return .needsLicenseHandoff }
            let mounted = try await detached {
                try DMGImageTool.attachBypassingLicense(dmgURL: dmgURL)
            }
            bypass = mounted
            mountPoint = mounted.mountPoint
        } else {
            mountPoint = try await detached { try DMGImageTool.attach(dmgURL: dmgURL) }
        }

        do {
            onStep?(.enumerating)
            let entries = try await detached { VolumeEnumerator.entries(in: mountPoint) }
            let kind = InstallerKind.detect(filename: dmgURL.lastPathComponent)
            var plan = InstallerPlan.make(kind: kind, entries: entries)

            // Several apps need a human choice before anything is copied. The
            // decision is awaited here, at the async level — never bridged.
            if case .chooseApp(let candidates) = plan {
                if let picked = await askChoose?(candidates), candidates.contains(picked) {
                    plan = .install(app: picked)
                } else {
                    try await finish(detach: mountPoint, bypass: bypass, onStep: onStep)
                    return .noAppFound
                }
            }

            switch plan {
            case .install(let app):
                onStep?(.copying(app: app))
                try checkCancelled()
                let result = try await detached {
                    try copy(
                        app: app,
                        mountPoint: mountPoint,
                        destination: destination,
                        replaceExisting: replaceExisting
                    )
                }
                try await finish(detach: mountPoint, bypass: bypass, onStep: onStep)
                return result
            case .noAppFound, .chooseApp, .notApplicable:
                try await finish(detach: mountPoint, bypass: bypass, onStep: onStep)
                return .noAppFound
            }
        } catch {
            try? await detached { try DMGImageTool.detach(mountPoint: mountPoint) }
            if let bypass {
                try? FileManager.default.removeItem(at: bypass.temporaryDirectory)
            }
            throw error
        }
    }

    /// Detach after notifying the step hook; deletes the SLA-stripped temp
    /// image when the mount went through the bypass path.
    private static func finish(
        detach mountPoint: URL,
        bypass: DMGImageTool.BypassMount?,
        onStep: (@Sendable (Step) -> Void)?
    ) async throws {
        onStep?(.detaching)
        try await detached { try DMGImageTool.detach(mountPoint: mountPoint) }
        if let bypass {
            try? FileManager.default.removeItem(at: bypass.temporaryDirectory)
        }
    }

    /// Copy one app bundle into `destination` (sync, off the main actor).
    private static func copy(
        app: String,
        mountPoint: URL,
        destination: URL,
        replaceExisting: Bool
    ) throws -> Outcome {
        let source = mountPoint.appendingPathComponent(app)
        let name = (app as NSString).lastPathComponent
        let destURL = destination.appendingPathComponent(name, isDirectory: true)

        guard FileManager.default.fileExists(atPath: source.path) else {
            throw InstallerError.appNotFound(app: app)
        }

        if FileManager.default.fileExists(atPath: destURL.path), !replaceExisting {
            return .needsReplaceConsent(appName: name)
        }
        if replaceExisting {
            // Rapidmg's order: remove first, then copy.
            try FileManager.default.removeItem(at: destURL)
        }

        var isDirectory: ObjCBool = false
        let destExists = FileManager.default.fileExists(
            atPath: destination.path, isDirectory: &isDirectory
        )
        if !destExists || !isDirectory.boolValue {
            try FileManager.default.createDirectory(
                at: destination, withIntermediateDirectories: true
            )
        }

        do {
            try FileManager.default.copyItem(at: source, to: destURL)
        } catch {
            // Roll back a partial copy so the destination never holds a broken
            // bundle that Launch Services would surface.
            try? FileManager.default.removeItem(at: destURL)
            throw InstallerError.copyFailed(detail: error.localizedDescription)
        }

        // Freshly-installed semantics (Rapidmg `setAttributes` behavior).
        try? FileManager.default.setAttributes(
            [.modificationDate: Date()],
            ofItemAtPath: destURL.path
        )
        return .installed(appName: name, at: destURL)
    }

    /// Runs synchronous work off the calling actor.
    private static func detached<Result>(
        _ body: @escaping @Sendable () throws -> Result
    ) async throws -> Result {
        try await Task.detached(priority: .userInitiated) {
            try body()
        }.value
    }
}
