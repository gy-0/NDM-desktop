import CryptoKit
import Foundation
import NDMCore

/// Release-configured trust root for NDM's reviewed site-compatibility feed.
/// The private signing key never ships in the app.
public struct SiteCompatibilityConfiguration: Sendable, Equatable {
    public let manifestURL: URL
    public let publicKey: Data

    public init(manifestURL: URL, publicKey: Data) {
        self.manifestURL = manifestURL
        self.publicKey = publicKey
    }

    public static func fromBundle(_ bundle: Bundle = .main) -> Self? {
        guard let rawURL = bundle.object(forInfoDictionaryKey: "NDMSiteCompatibilityManifestURL") as? String,
              let url = URL(string: rawURL),
              url.scheme?.lowercased() == "https",
              let rawKey = bundle.object(forInfoDictionaryKey: "NDMSiteCompatibilityPublicKey") as? String,
              let key = Data(base64Encoded: rawKey),
              key.count == 32 else {
            return nil
        }
        return Self(manifestURL: url, publicKey: key)
    }
}

/// The signed, human-reviewable description of one compatibility binary.
/// `payload` is encoded separately in the envelope so signature verification
/// never depends on JSON key ordering or whitespace.
/// Mirrored by the standalone signing script
/// Scripts/sign-site-compatibility-manifest.swift, which cannot import this
/// module — keep field names and types in sync when changing this type.
public struct SiteCompatibilityPayload: Codable, Sendable, Equatable {
    public let schemaVersion: Int
    public let version: String
    public let publishedAt: String
    public let minimumAppVersion: String
    public let platform: String
    public let assetURL: URL
    public let sha256: String
    public let byteCount: Int64

    public init(
        schemaVersion: Int = 1,
        version: String,
        publishedAt: String,
        minimumAppVersion: String,
        platform: String = "macos-universal",
        assetURL: URL,
        sha256: String,
        byteCount: Int64
    ) {
        self.schemaVersion = schemaVersion
        self.version = version
        self.publishedAt = publishedAt
        self.minimumAppVersion = minimumAppVersion
        self.platform = platform
        self.assetURL = assetURL
        self.sha256 = sha256
        self.byteCount = byteCount
    }
}

public struct SignedSiteCompatibilityManifest: Codable, Sendable, Equatable {
    public let payload: String
    public let signature: String

    public init(payload: String, signature: String) {
        self.payload = payload
        self.signature = signature
    }
}

public enum SiteCompatibilitySource: String, Codable, Sendable, Equatable {
    case bundled
    case refreshed
}

public enum SiteCompatibilityPhase: String, Codable, Sendable, Equatable {
    case ready
    case checking
    case installing
    case requiresAppUpdate
    case failed
}

public struct SiteCompatibilitySnapshot: Sendable, Equatable {
    public let phase: SiteCompatibilityPhase
    public let version: String?
    public let source: SiteCompatibilitySource
    public let lastChecked: Date?
    public let availableVersion: String?
    public let diagnostic: String?

    public init(
        phase: SiteCompatibilityPhase,
        version: String?,
        source: SiteCompatibilitySource,
        lastChecked: Date? = nil,
        availableVersion: String? = nil,
        diagnostic: String? = nil
    ) {
        self.phase = phase
        self.version = version
        self.source = source
        self.lastChecked = lastChecked
        self.availableVersion = availableVersion
        self.diagnostic = diagnostic
    }
}

public enum SiteCompatibilityUpdateError: Error, LocalizedError, Equatable {
    case malformedManifest
    case invalidSignature
    case unsupportedManifest
    case invalidAsset
    case checksumMismatch
    case sizeMismatch
    case versionMismatch
    case installationFailed

    public var errorDescription: String? {
        switch self {
        case .malformedManifest: return "The compatibility manifest is malformed."
        case .invalidSignature: return "The compatibility manifest signature is invalid."
        case .unsupportedManifest: return "This compatibility update is not supported by this app."
        case .invalidAsset: return "The compatibility update points to an invalid asset."
        case .checksumMismatch: return "The compatibility update failed its integrity check."
        case .sizeMismatch: return "The compatibility update has an unexpected size."
        case .versionMismatch: return "The compatibility update reports an unexpected version."
        case .installationFailed: return "The compatibility update could not be installed."
        }
    }
}

/// Downloads only NDM-reviewed, Ed25519-signed compatibility manifests. The
/// app-bundled binary always remains available as the zero-network fallback.
public actor SiteCompatibilityUpdater {
    public typealias Fetcher = @Sendable (URL) async throws -> Data

    private let configuration: SiteCompatibilityConfiguration
    private let supportRoot: URL
    private let appVersion: String
    private let bundledTool: URL?
    private let fetcher: Fetcher
    private var transientSnapshot: SiteCompatibilitySnapshot?
    private var inFlightCheck: InFlightCheck?
    private var nextCheckID: UInt64 = 0

    private struct InFlightCheck {
        let id: UInt64
        let task: Task<SiteCompatibilitySnapshot, Never>
    }

    /// Pass nil to disable bundled-tool fallback. Production discovery belongs
    /// to configured(), so explicit dependencies remain isolated from the host.
    public init(
        configuration: SiteCompatibilityConfiguration,
        supportRoot: URL = DownloadStore.defaultSupportDirectory,
        appVersion: String = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleShortVersionString"
        ) as? String ?? "0",
        bundledTool: URL? = nil,
        fetcher: @escaping Fetcher = { url in
            let (temporaryURL, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
            let attributes = try FileManager.default.attributesOfItem(atPath: temporaryURL.path)
            let size = (attributes[.size] as? NSNumber)?.int64Value ?? -1
            guard (0...(256 * 1024 * 1024)).contains(size) else {
                throw SiteCompatibilityUpdateError.sizeMismatch
            }
            return try Data(contentsOf: temporaryURL, options: .mappedIfSafe)
        }
    ) {
        self.configuration = configuration
        self.supportRoot = supportRoot
        self.appVersion = appVersion
        self.bundledTool = bundledTool
        self.fetcher = fetcher
    }

    public static func configured(
        supportRoot: URL = DownloadStore.defaultSupportDirectory,
        bundle: Bundle = .main
    ) -> SiteCompatibilityUpdater? {
        guard let configuration = SiteCompatibilityConfiguration.fromBundle(bundle) else {
            return nil
        }
        return SiteCompatibilityUpdater(
            configuration: configuration,
            supportRoot: supportRoot,
            appVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0",
            bundledTool: BundledToolLocator.bundledExecutable(named: ["yt-dlp", "yt-dlp_macos"])
        )
    }

    public func snapshot() -> SiteCompatibilitySnapshot {
        transientSnapshot ?? resolvedSnapshot(lastChecked: persistedState()?.lastChecked)
    }

    /// At launch, a successful check is reused for one day. A manual check
    /// always calls `checkAndInstall()` directly.
    @discardableResult
    public func refreshIfNeeded(interval: TimeInterval = 24 * 60 * 60) async -> SiteCompatibilitySnapshot {
        if let lastChecked = persistedState()?.lastChecked,
           Date().timeIntervalSince(lastChecked) < interval {
            return resolvedSnapshot(lastChecked: lastChecked)
        }
        return await checkAndInstall()
    }

    @discardableResult
    public func checkAndInstall() async -> SiteCompatibilitySnapshot {
        if let inFlightCheck {
            return await inFlightCheck.task.value
        }

        nextCheckID &+= 1
        let checkID = nextCheckID
        let task = Task { [self] in
            await performCheckAndInstall()
        }
        inFlightCheck = InFlightCheck(id: checkID, task: task)
        let result = await task.value
        if inFlightCheck?.id == checkID {
            inFlightCheck = nil
        }
        return result
    }

    private func performCheckAndInstall() async -> SiteCompatibilitySnapshot {
        let previous = resolvedSnapshot(lastChecked: persistedState()?.lastChecked)
        transientSnapshot = SiteCompatibilitySnapshot(
            phase: .checking,
            version: previous.version,
            source: previous.source,
            lastChecked: previous.lastChecked
        )

        do {
            let envelopeData = try await fetcher(configuration.manifestURL)
            let verified = try SiteCompatibilityToolStore.verify(
                envelopeData: envelopeData,
                publicKey: configuration.publicKey
            )

            // The actor is reentrant at every fetch. Re-resolve from disk after
            // each suspension so an updater sharing this support root cannot
            // make a completed newer installation look stale.
            let current = resolvedSnapshot(lastChecked: persistedState()?.lastChecked)
            if let currentVersion = current.version,
               VersionOrdering.compare(currentVersion, verified.payload.version) != .orderedAscending {
                return complete { now in resolvedSnapshot(lastChecked: now) }
            }

            guard VersionOrdering.compare(appVersion, verified.payload.minimumAppVersion) != .orderedAscending else {
                return complete { now in
                    SiteCompatibilitySnapshot(
                        phase: .requiresAppUpdate,
                        version: current.version,
                        source: current.source,
                        lastChecked: now,
                        availableVersion: verified.payload.version
                    )
                }
            }

            transientSnapshot = SiteCompatibilitySnapshot(
                phase: .installing,
                version: current.version,
                source: current.source,
                lastChecked: current.lastChecked,
                availableVersion: verified.payload.version
            )
            let binary = try await fetcher(verified.payload.assetURL)

            let currentAfterDownload = resolvedSnapshot(lastChecked: persistedState()?.lastChecked)
            if let currentVersion = currentAfterDownload.version,
               VersionOrdering.compare(currentVersion, verified.payload.version) != .orderedAscending {
                return complete { now in resolvedSnapshot(lastChecked: now) }
            }

            try SiteCompatibilityToolStore.install(
                binary: binary,
                envelopeData: envelopeData,
                verified: verified,
                configuration: configuration,
                supportRoot: supportRoot
            )
            return complete { now in resolvedSnapshot(lastChecked: now) }
        } catch {
            return complete { now in
                let fallback = resolvedSnapshot(lastChecked: now)
                return SiteCompatibilitySnapshot(
                    phase: .failed,
                    version: fallback.version,
                    source: fallback.source,
                    lastChecked: now,
                    diagnostic: String(describing: error)
                )
            }
        }
    }

    /// Every terminal path of a check persists the check time, publishes the
    /// snapshot, and returns it; keeping that in one place prevents drift.
    private func complete(
        _ build: (Date) -> SiteCompatibilitySnapshot
    ) -> SiteCompatibilitySnapshot {
        let now = Date()
        persist(lastChecked: now)
        let result = build(now)
        transientSnapshot = result
        return result
    }

    private func resolvedSnapshot(lastChecked: Date?) -> SiteCompatibilitySnapshot {
        if let active = SiteCompatibilityToolStore.activeTool(
            configuration: configuration,
            supportRoot: supportRoot
        ) {
            return SiteCompatibilitySnapshot(
                phase: .ready,
                version: active.version,
                source: .refreshed,
                lastChecked: lastChecked
            )
        }
        return SiteCompatibilitySnapshot(
            phase: .ready,
            version: bundledTool.flatMap(SiteCompatibilityToolStore.reportedVersion),
            source: .bundled,
            lastChecked: lastChecked
        )
    }

    private struct PersistedState: Codable {
        let lastChecked: Date
    }

    private var stateURL: URL {
        SiteCompatibilityToolStore.root(supportRoot: supportRoot)
            .appendingPathComponent("state.json")
    }

    private func persistedState() -> PersistedState? {
        guard let data = try? Data(contentsOf: stateURL) else { return nil }
        return try? JSONDecoder().decode(PersistedState.self, from: data)
    }

    private func persist(lastChecked: Date) {
        let root = SiteCompatibilityToolStore.root(supportRoot: supportRoot)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(PersistedState(lastChecked: lastChecked)) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }
}

struct VerifiedSiteCompatibilityManifest {
    let envelope: SignedSiteCompatibilityManifest
    let payloadData: Data
    let payload: SiteCompatibilityPayload
}

struct ActiveSiteCompatibilityTool {
    let url: URL
    let version: String
}

enum SiteCompatibilityToolStore {
    private struct Selection: Codable {
        let version: String
    }

    private final class ResolutionCache: @unchecked Sendable {
        private let lock = NSLock()
        private var key: String?
        private var value: ActiveSiteCompatibilityTool?

        func read(key candidate: String) -> (hit: Bool, value: ActiveSiteCompatibilityTool?) {
            lock.lock()
            defer { lock.unlock() }
            guard key == candidate else { return (false, nil) }
            return (true, value)
        }

        func write(key candidate: String, value: ActiveSiteCompatibilityTool?) {
            lock.lock()
            self.key = candidate
            self.value = value
            lock.unlock()
        }
    }

    private static let resolutionCache = ResolutionCache()
    private static let installationLock = NSLock()

    static func root(supportRoot: URL) -> URL {
        supportRoot.appendingPathComponent("SiteCompatibility", isDirectory: true)
    }

    static func activeTool(
        configuration: SiteCompatibilityConfiguration,
        supportRoot: URL
    ) -> ActiveSiteCompatibilityTool? {
        let root = root(supportRoot: supportRoot)
        let pointer = root.appendingPathComponent("current.json")
        guard let pointerData = try? Data(contentsOf: pointer),
              let selection = try? JSONDecoder().decode(Selection.self, from: pointerData),
              safeVersion(selection.version) else {
            return nil
        }
        let directory = root
            .appendingPathComponent("versions", isDirectory: true)
            .appendingPathComponent(selection.version, isDirectory: true)
        let envelopeURL = directory.appendingPathComponent("manifest.json")
        let toolURL = directory.appendingPathComponent("yt-dlp")
        let toolAttributes = try? FileManager.default.attributesOfItem(atPath: toolURL.path)
        let manifestAttributes = try? FileManager.default.attributesOfItem(atPath: envelopeURL.path)
        let cacheKey = [
            pointer.path,
            selection.version,
            fileIdentity(toolAttributes),
            fileIdentity(manifestAttributes),
            configuration.publicKey.base64EncodedString(),
        ].joined(separator: "|")
        let cached = resolutionCache.read(key: cacheKey)
        if cached.hit { return cached.value }

        guard let envelopeData = try? Data(contentsOf: envelopeURL),
              let verified = try? verify(
                envelopeData: envelopeData,
                publicKey: configuration.publicKey
              ),
              verified.payload.version == selection.version,
              FileManager.default.isExecutableFile(atPath: toolURL.path),
              sha256(toolURL) == verified.payload.sha256.lowercased(),
              reportedVersion(toolURL) == verified.payload.version else {
            resolutionCache.write(key: cacheKey, value: nil)
            return nil
        }
        let active = ActiveSiteCompatibilityTool(url: toolURL, version: selection.version)
        resolutionCache.write(key: cacheKey, value: active)
        return active
    }

    static func verify(
        envelopeData: Data,
        publicKey: Data
    ) throws -> VerifiedSiteCompatibilityManifest {
        guard let envelope = try? JSONDecoder().decode(
            SignedSiteCompatibilityManifest.self,
            from: envelopeData
        ),
              let payloadData = Data(base64Encoded: envelope.payload),
              let signature = Data(base64Encoded: envelope.signature),
              let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey) else {
            throw SiteCompatibilityUpdateError.malformedManifest
        }
        guard key.isValidSignature(signature, for: payloadData) else {
            throw SiteCompatibilityUpdateError.invalidSignature
        }
        guard let payload = try? JSONDecoder().decode(
            SiteCompatibilityPayload.self,
            from: payloadData
        ) else {
            throw SiteCompatibilityUpdateError.malformedManifest
        }
        guard payload.schemaVersion == 1,
              payload.platform == "macos-universal",
              safeVersion(payload.version),
              safeVersion(payload.minimumAppVersion),
              payload.byteCount > 0,
              payload.byteCount <= 256 * 1024 * 1024,
              payload.sha256.range(
                of: "^[0-9a-fA-F]{64}$",
                options: .regularExpression
              ) != nil else {
            throw SiteCompatibilityUpdateError.unsupportedManifest
        }
        guard payload.assetURL.scheme?.lowercased() == "https",
              payload.assetURL.host != nil,
              payload.assetURL.user == nil,
              payload.assetURL.password == nil else {
            throw SiteCompatibilityUpdateError.invalidAsset
        }
        return VerifiedSiteCompatibilityManifest(
            envelope: envelope,
            payloadData: payloadData,
            payload: payload
        )
    }

    static func install(
        binary: Data,
        envelopeData: Data,
        verified: VerifiedSiteCompatibilityManifest,
        configuration: SiteCompatibilityConfiguration,
        supportRoot: URL
    ) throws {
        // Multiple updater actors can legitimately share one support root.
        // Serialize their commits and make the active pointer monotonic so a
        // slow older download can never roll back a version installed first.
        installationLock.lock()
        defer { installationLock.unlock() }
        if let selectedVersion = selectedVersion(supportRoot: supportRoot),
           VersionOrdering.compare(selectedVersion, verified.payload.version) == .orderedDescending {
            return
        }

        guard Int64(binary.count) == verified.payload.byteCount else {
            throw SiteCompatibilityUpdateError.sizeMismatch
        }
        let digest = SHA256.hash(data: binary).map { String(format: "%02x", $0) }.joined()
        guard digest == verified.payload.sha256.lowercased() else {
            throw SiteCompatibilityUpdateError.checksumMismatch
        }

        let fm = FileManager.default
        let root = root(supportRoot: supportRoot)
        let versions = root.appendingPathComponent("versions", isDirectory: true)
        try fm.createDirectory(at: versions, withIntermediateDirectories: true)
        let staging = versions.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        var stagingNeedsRemoval = true
        defer {
            if stagingNeedsRemoval { try? fm.removeItem(at: staging) }
        }

        let stagedTool = staging.appendingPathComponent("yt-dlp")
        let stagedManifest = staging.appendingPathComponent("manifest.json")
        try binary.write(to: stagedTool, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stagedTool.path)
        try envelopeData.write(to: stagedManifest, options: .atomic)
        guard reportedVersion(stagedTool) == verified.payload.version else {
            throw SiteCompatibilityUpdateError.versionMismatch
        }

        let destination = versions.appendingPathComponent(verified.payload.version, isDirectory: true)
        if fm.fileExists(atPath: destination.path) {
            try fm.removeItem(at: destination)
        }
        try fm.moveItem(at: staging, to: destination)
        stagingNeedsRemoval = false

        // Re-verify from disk before the tiny atomic pointer update makes the
        // new version active. A bad install therefore never displaces fallback.
        let destinationManifest = destination.appendingPathComponent("manifest.json")
        guard let installedEnvelope = try? Data(contentsOf: destinationManifest),
              (try? verify(envelopeData: installedEnvelope, publicKey: configuration.publicKey)) != nil,
              sha256(destination.appendingPathComponent("yt-dlp")) == verified.payload.sha256.lowercased() else {
            throw SiteCompatibilityUpdateError.installationFailed
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let pointer = try encoder.encode(Selection(version: verified.payload.version))
        try pointer.write(to: root.appendingPathComponent("current.json"), options: .atomic)
    }

    private static func selectedVersion(supportRoot: URL) -> String? {
        let pointer = root(supportRoot: supportRoot).appendingPathComponent("current.json")
        guard let data = try? Data(contentsOf: pointer),
              let selection = try? JSONDecoder().decode(Selection.self, from: data),
              safeVersion(selection.version) else {
            return nil
        }
        return selection.version
    }

    static func reportedVersion(_ tool: URL) -> String? {
        guard FileManager.default.isExecutableFile(atPath: tool.path) else { return nil }
        guard let probe = ToolVersionProbe.run(toolAt: tool, arguments: ["--version"]),
              probe.exitStatus == 0 else { return nil }
        return probe.firstLine
    }

    private static func sha256(_ url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        do {
            while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty {
                hasher.update(data: data)
            }
        } catch {
            return nil
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private static let safeVersionExpression = try! NSRegularExpression(
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
    )

    private static func safeVersion(_ value: String) -> Bool {
        let range = NSRange(value.startIndex..., in: value)
        return safeVersionExpression.firstMatch(in: value, range: range) != nil
    }

    private static func fileIdentity(_ attributes: [FileAttributeKey: Any]?) -> String {
        let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? -1
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
        return "\(modified):\(size)"
    }
}

enum VersionOrdering {
    static func compare(_ lhs: String, _ rhs: String) -> ComparisonResult {
        let left = lhs.split(whereSeparator: { ".-_".contains($0) }).map(String.init)
        let right = rhs.split(whereSeparator: { ".-_".contains($0) }).map(String.init)
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : "0"
            let b = index < right.count ? right[index] : "0"
            let result: ComparisonResult
            if let ai = Int(a), let bi = Int(b) {
                result = ai == bi ? .orderedSame : (ai < bi ? .orderedAscending : .orderedDescending)
            } else {
                result = a.compare(b, options: [.numeric, .caseInsensitive])
            }
            if result != .orderedSame { return result }
        }
        return .orderedSame
    }
}
