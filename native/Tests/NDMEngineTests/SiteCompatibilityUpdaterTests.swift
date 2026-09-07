import CryptoKit
import XCTest
@testable import NDMEngine

final class SiteCompatibilityUpdaterTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-compatibility-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testSignedUpdateInstallsAndBecomesActive() async throws {
        let fixture = try makeFixture(version: "2026.07.18")
        let updater = SiteCompatibilityUpdater(
            configuration: fixture.configuration,
            supportRoot: folder,
            appVersion: "1.2.0",
            bundledTool: nil,
            fetcher: fixture.fetcher
        )

        let result = await updater.checkAndInstall()

        XCTAssertEqual(result.phase, .ready, result.diagnostic ?? "")
        XCTAssertEqual(result.source, .refreshed)
        XCTAssertEqual(result.version, "2026.07.18")
        let active = try XCTUnwrap(SiteCompatibilityToolStore.activeTool(
            configuration: fixture.configuration,
            supportRoot: folder
        ))
        XCTAssertEqual(active.version, "2026.07.18")
        XCTAssertEqual(SiteCompatibilityToolStore.reportedVersion(active.url), "2026.07.18")
    }

    func testBadSignatureNeverDownloadsOrActivatesBinary() async throws {
        var fixture = try makeFixture(version: "2026.07.18")
        let envelope = SignedSiteCompatibilityManifest(
            payload: fixture.envelope.payload,
            signature: Data(repeating: 0, count: 64).base64EncodedString()
        )
        fixture.envelopeData = try JSONEncoder().encode(envelope)
        let didRequestAsset = LockedFlag()
        let manifestURL = fixture.configuration.manifestURL
        let assetURL = fixture.payload.assetURL
        let envelopeData = fixture.envelopeData
        let binary = fixture.binary
        let updater = SiteCompatibilityUpdater(
            configuration: fixture.configuration,
            supportRoot: folder,
            appVersion: "1.2.0",
            bundledTool: nil,
            fetcher: { url in
                if url == manifestURL { return envelopeData }
                if url == assetURL {
                    didRequestAsset.set()
                    return binary
                }
                throw URLError(.badURL)
            }
        )

        let result = await updater.checkAndInstall()

        XCTAssertEqual(result.phase, .failed)
        XCTAssertFalse(didRequestAsset.value)
        XCTAssertNil(SiteCompatibilityToolStore.activeTool(
            configuration: fixture.configuration,
            supportRoot: folder
        ))
    }

    func testTamperedInstalledBinaryFallsBackInsteadOfRunning() async throws {
        let fixture = try makeFixture(version: "2026.07.18")
        let updater = SiteCompatibilityUpdater(
            configuration: fixture.configuration,
            supportRoot: folder,
            appVersion: "1.2.0",
            bundledTool: nil,
            fetcher: fixture.fetcher
        )
        _ = await updater.checkAndInstall()
        let active = try XCTUnwrap(SiteCompatibilityToolStore.activeTool(
            configuration: fixture.configuration,
            supportRoot: folder
        ))

        try Data("tampered executable".utf8).write(to: active.url, options: .atomic)
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: active.url.path
        )

        XCTAssertNil(SiteCompatibilityToolStore.activeTool(
            configuration: fixture.configuration,
            supportRoot: folder
        ))
    }

    func testNewerCompatibilityPackWaitsForRequiredAppVersion() async throws {
        let fixture = try makeFixture(
            version: "2026.07.18",
            minimumAppVersion: "2.0.0"
        )
        let didRequestAsset = LockedFlag()
        let manifestURL = fixture.configuration.manifestURL
        let assetURL = fixture.payload.assetURL
        let envelopeData = fixture.envelopeData
        let binary = fixture.binary
        let updater = SiteCompatibilityUpdater(
            configuration: fixture.configuration,
            supportRoot: folder,
            appVersion: "1.9.9",
            bundledTool: nil,
            fetcher: { url in
                if url == manifestURL { return envelopeData }
                if url == assetURL {
                    didRequestAsset.set()
                    return binary
                }
                throw URLError(.badURL)
            }
        )

        let result = await updater.checkAndInstall()

        XCTAssertEqual(result.phase, .requiresAppUpdate)
        XCTAssertEqual(result.availableVersion, "2026.07.18")
        XCTAssertFalse(didRequestAsset.value)
    }

    func testOlderConcurrentCheckCannotReplaceNewerInstalledVersion() async throws {
        let signingKey = Curve25519.Signing.PrivateKey()
        let older = try makeFixture(version: "2", signingKey: signingKey)
        let newer = try makeFixture(version: "3", signingKey: signingKey)
        let olderAssetRequested = expectation(description: "older asset download starts")
        let releaseOlderAsset = AsyncGate()
        let manifestURL = older.configuration.manifestURL
        let assetURL = older.payload.assetURL
        let olderEnvelopeData = older.envelopeData
        let olderBinary = older.binary
        let olderUpdater = SiteCompatibilityUpdater(
            configuration: older.configuration,
            supportRoot: folder,
            appVersion: "1.2.0",
            bundledTool: nil,
            fetcher: { url in
                if url == manifestURL { return olderEnvelopeData }
                if url == assetURL {
                    olderAssetRequested.fulfill()
                    await releaseOlderAsset.wait()
                    return olderBinary
                }
                throw URLError(.badURL)
            }
        )
        let newerUpdater = SiteCompatibilityUpdater(
            configuration: newer.configuration,
            supportRoot: folder,
            appVersion: "1.2.0",
            bundledTool: nil,
            fetcher: newer.fetcher
        )

        let olderCheck = Task { await olderUpdater.checkAndInstall() }
        await fulfillment(of: [olderAssetRequested], timeout: 5)

        let newerResult = await newerUpdater.checkAndInstall()
        XCTAssertEqual(newerResult.phase, .ready, newerResult.diagnostic ?? "")
        XCTAssertEqual(newerResult.version, "3")

        await releaseOlderAsset.open()
        let olderResult = await olderCheck.value

        XCTAssertEqual(olderResult.phase, .ready, olderResult.diagnostic ?? "")
        XCTAssertEqual(olderResult.version, "3")
        let active = try XCTUnwrap(SiteCompatibilityToolStore.activeTool(
            configuration: newer.configuration,
            supportRoot: folder
        ))
        XCTAssertEqual(active.version, "3")
        XCTAssertEqual(SiteCompatibilityToolStore.reportedVersion(active.url), "3")
    }

    func testManifestRejectsNonHTTPSAssetsEvenWhenSigned() throws {
        let fixture = try makeFixture(
            version: "2026.07.18",
            assetURL: URL(string: "http://updates.example/yt-dlp")!
        )
        XCTAssertThrowsError(try SiteCompatibilityToolStore.verify(
            envelopeData: fixture.envelopeData,
            publicKey: fixture.configuration.publicKey
        )) { error in
            XCTAssertEqual(error as? SiteCompatibilityUpdateError, .invalidAsset)
        }
    }

    private func makeFixture(
        version: String,
        minimumAppVersion: String = "1.0.0",
        assetURL: URL = URL(string: "https://updates.example/yt-dlp")!,
        signingKey: Curve25519.Signing.PrivateKey = .init()
    ) throws -> Fixture {
        let binary = Data("#!/bin/sh\necho \(version)\n".utf8)
        let digest = SHA256.hash(data: binary).map { String(format: "%02x", $0) }.joined()
        let payload = SiteCompatibilityPayload(
            version: version,
            publishedAt: "2026-07-18T00:00:00Z",
            minimumAppVersion: minimumAppVersion,
            assetURL: assetURL,
            sha256: digest,
            byteCount: Int64(binary.count)
        )
        let payloadEncoder = JSONEncoder()
        payloadEncoder.outputFormatting = [.sortedKeys]
        let payloadData = try payloadEncoder.encode(payload)
        let signature = try signingKey.signature(for: payloadData)
        let envelope = SignedSiteCompatibilityManifest(
            payload: payloadData.base64EncodedString(),
            signature: signature.base64EncodedString()
        )
        let envelopeEncoder = JSONEncoder()
        envelopeEncoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let envelopeData = try envelopeEncoder.encode(envelope)
        let manifestURL = URL(string: "https://updates.example/manifest.json")!
        let configuration = SiteCompatibilityConfiguration(
            manifestURL: manifestURL,
            publicKey: signingKey.publicKey.rawRepresentation
        )
        return Fixture(
            configuration: configuration,
            payload: payload,
            envelope: envelope,
            envelopeData: envelopeData,
            binary: binary,
            fetcher: { url in
                if url == manifestURL { return envelopeData }
                if url == assetURL { return binary }
                throw URLError(.badURL)
            }
        )
    }
}

private struct Fixture {
    let configuration: SiteCompatibilityConfiguration
    let payload: SiteCompatibilityPayload
    var envelope: SignedSiteCompatibilityManifest
    var envelopeData: Data
    let binary: Data
    let fetcher: SiteCompatibilityUpdater.Fetcher
}

private final class LockedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var storage = false

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func set() {
        lock.lock()
        storage = true
        lock.unlock()
    }
}

private actor AsyncGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func open() {
        guard !isOpen else { return }
        isOpen = true
        let continuations = waiters
        waiters.removeAll()
        for continuation in continuations {
            continuation.resume()
        }
    }
}
