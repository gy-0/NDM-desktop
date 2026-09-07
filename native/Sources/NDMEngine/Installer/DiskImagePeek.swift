import Foundation
import NDMCore

/// Read-only look inside a disk image for the app a download row should show.
///
/// The list must not use the generic disk-image glyph: a finished `.dmg` is
/// the app the user downloaded, and the row should carry that app's icon.
/// Mount is hidden from Finder, always detached, and skipped entirely when
/// the image carries a software license agreement (peeking must not bypass it).
///
/// Some images (Sangfor EasyConnect and similar) wrap a `.pkg` instead of a
/// root `.app`. Those still have an app inside the payload; peeking unpacks
/// just the icon files and never installs.
public enum DiskImagePeek: Sendable {
    /// Mount `dmgURL`, run `body` with the primary app bundle still on the
    /// volume (or a temporary stub rebuilt from a payload `.pkg`), then
    /// detach. Returns `nil` when there is no app to show.
    public static func withPrimaryApp<Result: Sendable>(
        dmgURL: URL,
        _ body: @Sendable (URL) async throws -> Result
    ) async throws -> Result? {
        if try DMGImageTool.hasLicenseAgreement(dmgURL: dmgURL) {
            return nil
        }
        let mountPoint = try DMGImageTool.attach(dmgURL: dmgURL)
        defer { try? DMGImageTool.detach(mountPoint: mountPoint) }
        let entries = VolumeEnumerator.entries(in: mountPoint)
        let filename = dmgURL.lastPathComponent
        let plan = InstallerPlan.make(kind: .dmg, entries: entries)
        let relative: String?
        switch plan {
        case .install(let app):
            relative = app
        case .chooseApp(let candidates):
            relative = InstallerPlan.preferredApp(
                candidates: candidates,
                filename: filename
            )
        case .noAppFound, .notApplicable:
            relative = nil
        }
        if let relative {
            let appURL = mountPoint.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: appURL.path) {
                return try await body(appURL)
            }
        }
        let packages = InstallerFilter.packageCandidates(entries: entries)
        guard let pkgRelative = InstallerPlan.preferredApp(
            candidates: packages,
            filename: filename
        ) else {
            return nil
        }
        let pkgURL = mountPoint.appendingPathComponent(pkgRelative)
        guard FileManager.default.fileExists(atPath: pkgURL.path) else { return nil }
        return try await PackageIconPeek.withStubApp(
            pkgURL: pkgURL,
            preferredName: filename,
            body
        )
    }
}
