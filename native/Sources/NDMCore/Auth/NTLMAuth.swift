import Foundation
import CryptoKit

/// HTTP NTLM (NTLMv2) — counterpart to original `NeatAuthNTLM` (`FUN_10001e61c` Type1 / `FUN_10001e6a8` Type3).
public enum NTLMAuth {
    /// Flags from original Type1 builder: Unicode|OEM|RequestTarget|NTLM|AlwaysSign|NTLM2Key
    public static let type1Flags: UInt32 = 0x0008_8207

    public struct Type2: Equatable, Sendable {
        public var serverChallenge: Data // 8 bytes
        public var flags: UInt32
        public var targetName: String
        public var targetInfo: Data

        public init(serverChallenge: Data, flags: UInt32, targetName: String = "", targetInfo: Data = Data()) {
            self.serverChallenge = serverChallenge
            self.flags = flags
            self.targetName = targetName
            self.targetInfo = targetInfo
        }
    }

    public static func isNTLMChallenge(_ header: String?) -> Bool {
        guard let header else { return false }
        return header.lowercased().contains("ntlm")
    }

    /// Extract base64 blob after `NTLM ` if present.
    public static func ntlmToken(from header: String?) -> Data? {
        guard let header else { return nil }
        // May be "NTLM", "NTLM <b64>", or combined with Digest — find NTLM token.
        let parts = header.split(whereSeparator: { $0 == "," || $0 == "\n" }).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        for part in parts {
            let lower = part.lowercased()
            guard lower.hasPrefix("ntlm") else { continue }
            let rest = part.dropFirst(4).trimmingCharacters(in: .whitespaces)
            if rest.isEmpty { return nil }
            return Data(base64Encoded: rest)
        }
        // Single-scheme header: "NTLM xxx"
        if let range = header.range(of: "NTLM", options: .caseInsensitive) {
            let after = header[range.upperBound...].trimmingCharacters(in: .whitespaces)
            if after.isEmpty { return nil }
            let token = after.split(separator: ",").first.map(String.init)?
                .trimmingCharacters(in: .whitespaces) ?? ""
            if token.isEmpty { return nil }
            return Data(base64Encoded: token)
        }
        return nil
    }

    public static func type1Message(flags: UInt32 = type1Flags) -> Data {
        // Match original 32-byte Type1: signature + type + flags + empty domain/host buffers.
        var data = Data()
        data.append(contentsOf: Array("NTLMSSP".utf8))
        data.append(0)
        appendUInt32(&data, 1)
        appendUInt32(&data, flags)
        // Domain security buffer (empty @ offset 32)
        appendSecBuf(&data, length: 0, offset: 32)
        // Workstation security buffer (empty @ offset 32)
        appendSecBuf(&data, length: 0, offset: 32)
        return data
    }

    public static func type1AuthorizationHeader(isProxy: Bool = false) -> String {
        let prefix = isProxy ? "Proxy-Authorization" : "Authorization"
        _ = prefix
        return "NTLM \(type1Message().base64EncodedString())"
    }

    public static func parseType2(from header: String?) -> Type2? {
        guard let blob = ntlmToken(from: header), blob.count >= 32 else { return nil }
        guard blob.starts(with: Array("NTLMSSP\0".utf8)) else { return nil }
        let type = readUInt32(blob, 8)
        guard type == 2 else { return nil }
        let targetLen = Int(readUInt16(blob, 12))
        let targetOff = Int(readUInt32(blob, 16))
        let flags = readUInt32(blob, 20)
        let challenge = blob.subdata(in: 24..<32)
        var targetName = ""
        if targetLen > 0, targetOff + targetLen <= blob.count {
            let raw = blob.subdata(in: targetOff..<(targetOff + targetLen))
            if flags & 0x1 != 0 { // Unicode
                targetName = String(data: raw, encoding: .utf16LittleEndian) ?? ""
            } else {
                targetName = String(data: raw, encoding: .isoLatin1) ?? ""
            }
        }
        var targetInfo = Data()
        if blob.count >= 48 {
            let infoLen = Int(readUInt16(blob, 40))
            let infoOff = Int(readUInt32(blob, 44))
            if infoLen > 0, infoOff + infoLen <= blob.count {
                targetInfo = blob.subdata(in: infoOff..<(infoOff + infoLen))
            }
        }
        return Type2(
            serverChallenge: challenge,
            flags: flags,
            targetName: targetName,
            targetInfo: targetInfo
        )
    }

    /// Split `DOMAIN\user` or `user@domain` into (user, domain).
    public static func splitUserDomain(_ username: String) -> (user: String, domain: String) {
        if let idx = username.firstIndex(of: "\\") {
            let domain = String(username[..<idx])
            let user = String(username[username.index(after: idx)...])
            return (user, domain)
        }
        if let idx = username.firstIndex(of: "@") {
            let user = String(username[..<idx])
            let domain = String(username[username.index(after: idx)...])
            return (user, domain)
        }
        return (username, "")
    }

    public static func type3AuthorizationHeader(
        type2: Type2,
        username: String,
        password: String,
        workstation: String = "NDM",
        clientChallenge: Data? = nil,
        timestamp: Data? = nil,
        isProxy: Bool = false
    ) -> String {
        _ = isProxy
        let (user, domainFromUser) = splitUserDomain(username)
        let domain = domainFromUser.isEmpty ? type2.targetName : domainFromUser
        let cc = clientChallenge ?? randomBytes(8)
        let ts = timestamp ?? windowsFileTimeNow()
        let ntResponse = ntlmV2Response(
            password: password,
            user: user,
            domain: domain,
            serverChallenge: type2.serverChallenge,
            clientChallenge: cc,
            timestamp: ts,
            targetInfo: type2.targetInfo
        )
        // LMv2: HMAC_MD5(ResponseKeyLM, serverChallenge||clientChallenge) || clientChallenge
        let responseKeyLM = ntowfV2(password: password, user: user, domain: domain)
        var lmMsg = type2.serverChallenge
        lmMsg.append(cc)
        var lmResponse = hmacMD5(key: responseKeyLM, data: lmMsg)
        lmResponse.append(cc)

        let domainUTF16 = utf16LE(domain)
        let userUTF16 = utf16LE(user)
        let workstationUTF16 = utf16LE(workstation)

        // Header size: 64 bytes (with session key buffer + flags), then payload.
        let headerLen = 64
        var offset = headerLen
        let lmOff = offset; offset += lmResponse.count
        let ntOff = offset; offset += ntResponse.count
        let domOff = offset; offset += domainUTF16.count
        let userOff = offset; offset += userUTF16.count
        let wsOff = offset; offset += workstationUTF16.count

        var msg = Data()
        msg.append(contentsOf: Array("NTLMSSP".utf8))
        msg.append(0)
        appendUInt32(&msg, 3)
        appendSecBuf(&msg, length: lmResponse.count, offset: lmOff)
        appendSecBuf(&msg, length: ntResponse.count, offset: ntOff)
        appendSecBuf(&msg, length: domainUTF16.count, offset: domOff)
        appendSecBuf(&msg, length: userUTF16.count, offset: userOff)
        appendSecBuf(&msg, length: workstationUTF16.count, offset: wsOff)
        appendSecBuf(&msg, length: 0, offset: offset) // session key empty
        appendUInt32(&msg, type2.flags & type1Flags | 0x0000_0201) // keep unicode + NTLM
        // Ensure header is 64 bytes
        while msg.count < headerLen { msg.append(0) }
        msg.append(lmResponse)
        msg.append(ntResponse)
        msg.append(domainUTF16)
        msg.append(userUTF16)
        msg.append(workstationUTF16)
        return "NTLM \(msg.base64EncodedString())"
    }

    // MARK: - Crypto (NTLMv2)

    /// NTOWFv2 = HMAC_MD5(MD4(UTF16(password)), UTF16(Upper(user)+domain))
    public static func ntowfV2(password: String, user: String, domain: String) -> Data {
        let ntHash = MD4.hash(utf16LE(password))
        let identity = utf16LE(user.uppercased() + domain)
        return hmacMD5(key: ntHash, data: identity)
    }

    public static func ntlmV2Response(
        password: String,
        user: String,
        domain: String,
        serverChallenge: Data,
        clientChallenge: Data,
        timestamp: Data,
        targetInfo: Data
    ) -> Data {
        let responseKeyNT = ntowfV2(password: password, user: user, domain: domain)
        var blob = Data()
        blob.append(0x01) // RespType
        blob.append(0x01) // HiRespType
        blob.append(contentsOf: [UInt8](repeating: 0, count: 6))
        blob.append(timestamp)
        blob.append(clientChallenge)
        blob.append(contentsOf: [UInt8](repeating: 0, count: 4))
        blob.append(targetInfo)
        blob.append(contentsOf: [UInt8](repeating: 0, count: 4))

        var proofInput = serverChallenge
        proofInput.append(blob)
        let ntProof = hmacMD5(key: responseKeyNT, data: proofInput)
        var response = ntProof
        response.append(blob)
        return response
    }

    public static func hmacMD5(key: Data, data: Data) -> Data {
        let keySym = SymmetricKey(data: key)
        let mac = HMAC<Insecure.MD5>.authenticationCode(for: data, using: keySym)
        return Data(mac)
    }

    public static func utf16LE(_ s: String) -> Data {
        var data = Data()
        for u in s.utf16 {
            var le = u.littleEndian
            withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        }
        return data
    }

    public static func windowsFileTimeNow() -> Data {
        // 100-ns intervals since 1601-01-01 UTC
        let unix = Date().timeIntervalSince1970
        let windows = UInt64(unix * 10_000_000) + 116_444_736_000_000_000
        var le = windows.littleEndian
        var data = Data()
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
        return data
    }

    public static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    // MARK: - Binary helpers

    private static func appendUInt32(_ data: inout Data, _ value: UInt32) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private static func appendUInt16(_ data: inout Data, _ value: UInt16) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private static func appendSecBuf(_ data: inout Data, length: Int, offset: Int) {
        appendUInt16(&data, UInt16(length))
        appendUInt16(&data, UInt16(length))
        appendUInt32(&data, UInt32(offset))
    }

    private static func readUInt16(_ data: Data, _ offset: Int) -> UInt16 {
        guard offset + 2 <= data.count else { return 0 }
        return UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private static func readUInt32(_ data: Data, _ offset: Int) -> UInt32 {
        guard offset + 4 <= data.count else { return 0 }
        return UInt32(data[offset])
            | (UInt32(data[offset + 1]) << 8)
            | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }
}
