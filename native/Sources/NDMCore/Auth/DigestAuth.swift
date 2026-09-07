import Foundation
import CryptoKit

/// HTTP Digest (MD5 and SHA-256 / auth qop) — counterpart to original `NeatAuthDigest`.
public enum DigestAuth {
    public enum Failure: Error, LocalizedError {
        case unsupportedAlgorithm(String)
        case unsupportedQop(String)
        case nonceCountExhausted
        public var errorDescription: String? {
            switch self {
            case .unsupportedAlgorithm(let value): return "Unsupported HTTP Digest algorithm: \(value)"
            case .unsupportedQop(let value): return "Unsupported HTTP Digest qop: \(value)"
            case .nonceCountExhausted: return "HTTP Digest nonce count exhausted"
            }
        }
    }

    public struct Challenge: Equatable, Sendable {
        public var realm: String
        public var nonce: String
        public var opaque: String?
        public var qop: String?
        public var algorithm: String
        public var isProxy: Bool

        public init(
            realm: String,
            nonce: String,
            opaque: String? = nil,
            qop: String? = nil,
            algorithm: String = "MD5",
            isProxy: Bool = false
        ) {
            self.realm = realm
            self.nonce = nonce
            self.opaque = opaque
            self.qop = qop
            self.algorithm = algorithm
            self.isProxy = isProxy
        }
    }

    public static func parseChallenge(from wwwAuthenticate: String, isProxy: Bool = false) -> Challenge? {
        let lower = wwwAuthenticate.lowercased()
        guard lower.trimmingCharacters(in: .whitespaces).hasPrefix("digest ") else { return nil }
        func value(_ key: String) -> String? {
            // key="value" or key=value
            let pattern = #"(?:^|[,\s])\#(key)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^\s,]+))"#
            guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
                return nil
            }
            let range = NSRange(wwwAuthenticate.startIndex..., in: wwwAuthenticate)
            guard let m = re.firstMatch(in: wwwAuthenticate, range: range) else { return nil }
            for i in 1..<m.numberOfRanges {
                if let r = Range(m.range(at: i), in: wwwAuthenticate) {
                    let raw = String(wwwAuthenticate[r])
                    return raw.replacingOccurrences(of: #"\\(.)"#, with: "$1", options: .regularExpression)
                }
            }
            return nil
        }
        guard let realm = value("realm"), let nonce = value("nonce") else { return nil }
        return Challenge(
            realm: realm,
            nonce: nonce,
            opaque: value("opaque"),
            qop: value("qop").map { raw in
                let values = raw.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
                return values.contains("auth") ? "auth" : raw
            },
            algorithm: value("algorithm") ?? "MD5",
            isProxy: isProxy
        )
    }

    public static func authorizationHeader(
        challenge: Challenge,
        username: String,
        password: String,
        method: String,
        uri: String,
        nc: String = "00000001",
        cnonce: String = randomCnonce()
    ) throws -> String {
        try validate(challenge)
        let hash: (String) -> String = challenge.algorithm.uppercased() == "SHA-256" ? sha256Hex : md5Hex
        let ha1 = hash("\(username):\(challenge.realm):\(password)")
        let ha2 = hash("\(method):\(uri)")
        let response: String
        if challenge.qop != nil {
            let q = "auth"
            response = hash("\(ha1):\(challenge.nonce):\(nc):\(cnonce):\(q):\(ha2)")
            var parts = [
                "Digest username=\"\(escaped(username))\"",
                "realm=\"\(escaped(challenge.realm))\"",
                "nonce=\"\(escaped(challenge.nonce))\"",
                "uri=\"\(escaped(uri))\"",
                "algorithm=\(challenge.algorithm)",
                "response=\"\(response)\"",
                "qop=\(q)",
                "nc=\(nc)",
                "cnonce=\"\(escaped(cnonce))\"",
            ]
            if let opaque = challenge.opaque {
                parts.append("opaque=\"\(escaped(opaque))\"")
            }
            return parts.joined(separator: ", ")
        } else {
            response = hash("\(ha1):\(challenge.nonce):\(ha2)")
            var parts = [
                "Digest username=\"\(escaped(username))\"",
                "realm=\"\(escaped(challenge.realm))\"",
                "nonce=\"\(escaped(challenge.nonce))\"",
                "uri=\"\(escaped(uri))\"",
                "algorithm=\(challenge.algorithm)",
                "response=\"\(response)\"",
            ]
            if let opaque = challenge.opaque {
                parts.append("opaque=\"\(escaped(opaque))\"")
            }
            return parts.joined(separator: ", ")
        }
    }

    private static func escaped(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
    }

    public static func validate(_ challenge: Challenge) throws {
        guard ["MD5", "SHA-256"].contains(challenge.algorithm.uppercased()) else { throw Failure.unsupportedAlgorithm(challenge.algorithm) }
        if let qop = challenge.qop, qop.lowercased() != "auth" { throw Failure.unsupportedQop(qop) }
    }

    public static func randomCnonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public static func sha256Hex(_ s: String) -> String {
        SHA256.hash(data: Data(s.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public static func md5Hex(_ s: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
