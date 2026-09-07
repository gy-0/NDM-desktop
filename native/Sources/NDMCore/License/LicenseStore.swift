import Foundation
import CryptoKit

/// A validated Pro license.
public struct License: Equatable, Sendable {
    public let email: String
    /// nil = perpetual. Licenses include one year of updates; expiry gates
    /// update entitlement server-side later, not app functionality.
    public let expiry: Date?
    public let raw: String

    public init(email: String, expiry: Date?, raw: String) {
        self.email = email
        self.expiry = expiry
        self.raw = raw
    }
}

public enum LicenseError: Error, Equatable {
    case invalidFormat
    case badSignature
    case expired
    case persistenceFailed
}

/// Offline-verifiable license keys (Ed25519-signed), persisted locally.
///
/// Key format: `NDMP1.<base64url(payload JSON)>.<base64url(signature)>`
/// payload: `{"email":"…","exp":"2027-07-16"}` (`exp` optional = perpetual).
/// The signing private key lives with the vendor (never in the app or repo).
public enum LicenseStore {
    public static let didChangeNotification = Notification.Name("NDMProLicenseDidChange")
    /// Production license verification key (Ed25519 public key).
    public static let productionPublicKeyBase64 = "fXaJf4nrGzOrrGapr6P7m6KEJZd2PlW/Zsl8tpRbbeA="

    public static let keyPrefix = "NDMP1"
    private static let defaultsKey = "ProLicenseKey"

    // MARK: - Feature gates

    /// Free tier is genuinely usable — 4 connections already beats a browser.
    public static let freeMaxConnections = 4
    public static let proMaxConnections = 32

    public static func connectionsCap(isPro: Bool) -> Int {
        isPro ? proMaxConnections : freeMaxConnections
    }

    // MARK: - Validation

    public static func parse(
        key: String,
        publicKeyBase64: String = productionPublicKeyBase64,
        now: Date = Date()
    ) throws -> License {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == keyPrefix,
              let payloadData = base64urlDecode(String(parts[1])),
              let signature = base64urlDecode(String(parts[2])) else {
            throw LicenseError.invalidFormat
        }
        guard let publicKeyData = Data(base64Encoded: publicKeyBase64),
              let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData),
              publicKey.isValidSignature(signature, for: payloadData) else {
            throw LicenseError.badSignature
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: payloadData) else {
            throw LicenseError.invalidFormat
        }
        var expiry: Date?
        if let exp = payload.exp {
            guard let date = Self.dayFormatter.date(from: exp) else {
                throw LicenseError.invalidFormat
            }
            if date < now {
                throw LicenseError.expired
            }
            expiry = date
        }
        return License(email: payload.email, expiry: expiry, raw: trimmed)
    }

    /// Vendor-side key generation (used by tooling/tests; the private key
    /// never ships with the app).
    public static func makeKey(
        email: String,
        expiry: Date?,
        privateKey: Curve25519.Signing.PrivateKey
    ) throws -> String {
        let payload = Payload(email: email, exp: expiry.map(Self.dayFormatter.string(from:)))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(payload)
        let signature = try privateKey.signature(for: data)
        return [keyPrefix, base64urlEncode(data), base64urlEncode(signature)].joined(separator: ".")
    }

    // MARK: - Persistence

    public static func activate(_ key: String) throws -> License {
        guard let defaults else { throw LicenseError.persistenceFailed }
        return try activate(
            key,
            publicKeyBase64: productionPublicKeyBase64,
            defaults: defaults
        )
    }

    static func activate(
        _ key: String,
        publicKeyBase64: String,
        defaults: UserDefaults
    ) throws -> License {
        let license = try parse(key: key, publicKeyBase64: publicKeyBase64)
        defaults.set(license.raw, forKey: defaultsKey)
        // The quality picker may continue on the very next main-loop turn.
        // Force this tiny preference write through before announcing success so
        // a newly activated 1440p/4K choice cannot immediately hit the gate again.
        defaults.synchronize()
        guard defaults.string(forKey: defaultsKey) == license.raw else {
            throw LicenseError.persistenceFailed
        }
        NotificationCenter.default.post(name: didChangeNotification, object: license)
        return license
    }

    public static func deactivate() {
        defaults?.removeObject(forKey: defaultsKey)
        NotificationCenter.default.post(name: didChangeNotification, object: nil)
    }

    /// The persisted license, re-validated on every load.
    public static func current() -> License? {
        guard let defaults else { return nil }
        return current(publicKeyBase64: productionPublicKeyBase64, defaults: defaults)
    }

    static func current(publicKeyBase64: String, defaults: UserDefaults) -> License? {
        guard let raw = defaults.string(forKey: defaultsKey) else { return nil }
        return try? parse(key: raw, publicKeyBase64: publicKeyBase64)
    }

    public static var isPro: Bool { current() != nil }

    // MARK: - Internals

    private struct Payload: Codable {
        var email: String
        var exp: String?
    }

    private static var defaults: UserDefaults? {
        // The app's bundle identifier is already the standard defaults domain.
        // Passing that same identifier to `suiteName:` is rejected by macOS and
        // made successful activations disappear on the next read.
        .standard
    }

    private static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static func base64urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func base64urlDecode(_ string: String) -> Data? {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64.append("=") }
        return Data(base64Encoded: base64)
    }
}
