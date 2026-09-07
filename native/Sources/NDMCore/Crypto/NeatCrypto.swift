import Foundation
import CommonCrypto

/// AES-256 helper for bridge credential framing.
///
/// CCCrypt(AES, PKCS7, key="SG2921" zero-padded to 32, IV=NULL→zeros, Base64).
public enum NeatCrypto {
    /// Shared passphrase used by the browser-bridge crypto framing.
    public static let passwordKey = "SG2921"

    private static var aesKey: Data {
        var key = Data(passwordKey.utf8)
        if key.count < kCCKeySizeAES256 {
            key.append(Data(count: kCCKeySizeAES256 - key.count))
        } else if key.count > kCCKeySizeAES256 {
            key = key.prefix(kCCKeySizeAES256)
        }
        return key
    }

    /// `+[NeatNsUtils encryptString:]`
    public static func encryptString(_ plaintext: String) -> String {
        let data = Data(plaintext.utf8)
        guard let encrypted = aes256(data, operation: CCOperation(kCCEncrypt)) else {
            return ""
        }
        return encrypted.base64EncodedString(options: [])
    }

    /// `+[NeatNsUtils decryptString:]`
    public static func decryptString(_ base64: String) -> String? {
        guard let data = Data(base64Encoded: base64),
              let plain = aes256(data, operation: CCOperation(kCCDecrypt)) else {
            return nil
        }
        return String(data: plain, encoding: .utf8)
    }

    private static func aes256(_ data: Data, operation: CCOperation) -> Data? {
        let key = aesKey
        let iv = Data(count: kCCBlockSizeAES128) // NULL IV → zeros (CBC)
        let bufferSize = data.count + kCCBlockSizeAES128
        var outLength = 0
        var out = Data(count: bufferSize)
        let status: CCCryptorStatus = out.withUnsafeMutableBytes { outBytes in
            data.withUnsafeBytes { inBytes in
                key.withUnsafeBytes { keyBytes in
                    iv.withUnsafeBytes { ivBytes in
                        CCCrypt(
                            operation,
                            CCAlgorithm(kCCAlgorithmAES),
                            CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, kCCKeySizeAES256,
                            ivBytes.baseAddress,
                            inBytes.baseAddress, data.count,
                            outBytes.baseAddress, bufferSize,
                            &outLength
                        )
                    }
                }
            }
        }
        guard status == kCCSuccess else { return nil }
        out.count = outLength
        return out
    }
}
