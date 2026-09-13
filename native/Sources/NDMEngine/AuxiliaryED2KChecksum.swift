import Foundation
import CommonCrypto

/// ED2K's protocol checksum, streamed alongside publication. This is not used
/// as a new security hash: it verifies the content identity supplied by the link.
struct AuxiliaryED2KChecksum {
    static let partSize = 9_728_000
    private var part = CC_MD4_CTX()
    private var root = CC_MD4_CTX()
    private var partBytes = 0
    private var fullParts = 0
    init() { CC_MD4_Init(&part); CC_MD4_Init(&root) }
    mutating func update(_ bytes: Data) {
        bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            var offset = 0
            while offset < raw.count {
                let count = min(Self.partSize - partBytes, raw.count - offset)
                CC_MD4_Update(&part, base.advanced(by: offset), CC_LONG(count))
                offset += count; partBytes += count
                if partBytes == Self.partSize {
                    var digest = [UInt8](repeating: 0, count: Int(CC_MD4_DIGEST_LENGTH))
                    CC_MD4_Final(&digest, &part); CC_MD4_Update(&root, digest, CC_LONG(digest.count))
                    fullParts += 1; partBytes = 0; CC_MD4_Init(&part)
                }
            }
        }
    }
    mutating func finish() -> String {
        var digest = [UInt8](repeating: 0, count: Int(CC_MD4_DIGEST_LENGTH))
        CC_MD4_Final(&digest, &part)
        if fullParts > 0 {
            // The protocol includes the MD4 of an empty final part when the
            // file length is exactly a multiple of its part size.
            CC_MD4_Update(&root, digest, CC_LONG(digest.count)); CC_MD4_Final(&digest, &root)
        }
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}
