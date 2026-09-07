import Foundation
import CryptoKit

/// HTTP Digest (MD5 / auth qop) — counterpart to original `NeatAuthDigest`.
public enum DigestAuth {
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
        guard lower.contains("digest") else { return nil }
        func value(_ key: String) -> String? {
            // key="value" or key=value
            let pattern = #"\#(key)\s*=\s*(?:"([^"]*)"|([^\s,]+))"#
            guard let re = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
                return nil
            }
            let range = NSRange(wwwAuthenticate.startIndex..., in: wwwAuthenticate)
            guard let m = re.firstMatch(in: wwwAuthenticate, range: range) else { return nil }
            for i in 1..<m.numberOfRanges {
                if let r = Range(m.range(at: i), in: wwwAuthenticate), !r.isEmpty {
                    return String(wwwAuthenticate[r])
                }
            }
            return nil
        }
        guard let realm = value("realm"), let nonce = value("nonce") else { return nil }
        return Challenge(
            realm: realm,
            nonce: nonce,
            opaque: value("opaque"),
            qop: value("qop")?.components(separatedBy: ",").first?.trimmingCharacters(in: .whitespaces),
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
    ) -> String {
        let ha1 = md5Hex("\(username):\(challenge.realm):\(password)")
        let ha2 = md5Hex("\(method):\(uri)")
        let response: String
        if let qop = challenge.qop, qop.lowercased() == "auth" || qop.lowercased().contains("auth") {
            let q = "auth"
            response = md5Hex("\(ha1):\(challenge.nonce):\(nc):\(cnonce):\(q):\(ha2)")
            var parts = [
                "Digest username=\"\(username)\"",
                "realm=\"\(challenge.realm)\"",
                "nonce=\"\(challenge.nonce)\"",
                "uri=\"\(uri)\"",
                "algorithm=\(challenge.algorithm)",
                "response=\"\(response)\"",
                "qop=\(q)",
                "nc=\(nc)",
                "cnonce=\"\(cnonce)\"",
            ]
            if let opaque = challenge.opaque {
                parts.append("opaque=\"\(opaque)\"")
            }
            return parts.joined(separator: ", ")
        } else {
            response = md5Hex("\(ha1):\(challenge.nonce):\(ha2)")
            var parts = [
                "Digest username=\"\(username)\"",
                "realm=\"\(challenge.realm)\"",
                "nonce=\"\(challenge.nonce)\"",
                "uri=\"\(uri)\"",
                "response=\"\(response)\"",
            ]
            if let opaque = challenge.opaque {
                parts.append("opaque=\"\(opaque)\"")
            }
            return parts.joined(separator: ", ")
        }
    }

    public static func randomCnonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    public static func md5Hex(_ s: String) -> String {
        let digest = Insecure.MD5.hash(data: Data(s.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
