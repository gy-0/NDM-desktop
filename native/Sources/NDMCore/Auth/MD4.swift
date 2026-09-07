import Foundation

/// Minimal MD4 (RFC 1320) for NTLM NT hash — not available in CryptoKit.
enum MD4 {
    static func hash(_ message: Data) -> Data {
        var message = message
        let originalLengthBits = UInt64(message.count) &* 8
        message.append(0x80)
        while (message.count % 64) != 56 {
            message.append(0)
        }
        var len = originalLengthBits
        for _ in 0..<8 {
            message.append(UInt8(len & 0xff))
            len >>= 8
        }

        var a: UInt32 = 0x6745_2301
        var b: UInt32 = 0xEFCD_AB89
        var c: UInt32 = 0x98BA_DCFE
        var d: UInt32 = 0x1032_5476

        let blockCount = message.count / 64
        for bi in 0..<blockCount {
            let base = bi * 64
            var x = [UInt32](repeating: 0, count: 16)
            for j in 0..<16 {
                let o = base + j * 4
                x[j] = UInt32(message[o])
                    | (UInt32(message[o + 1]) << 8)
                    | (UInt32(message[o + 2]) << 16)
                    | (UInt32(message[o + 3]) << 24)
            }
            let aa = a, bb = b, cc = c, dd = d

            // Round 1
            a = f(a, b, c, d, x[0], 3); d = f(d, a, b, c, x[1], 7)
            c = f(c, d, a, b, x[2], 11); b = f(b, c, d, a, x[3], 19)
            a = f(a, b, c, d, x[4], 3); d = f(d, a, b, c, x[5], 7)
            c = f(c, d, a, b, x[6], 11); b = f(b, c, d, a, x[7], 19)
            a = f(a, b, c, d, x[8], 3); d = f(d, a, b, c, x[9], 7)
            c = f(c, d, a, b, x[10], 11); b = f(b, c, d, a, x[11], 19)
            a = f(a, b, c, d, x[12], 3); d = f(d, a, b, c, x[13], 7)
            c = f(c, d, a, b, x[14], 11); b = f(b, c, d, a, x[15], 19)

            // Round 2
            a = g(a, b, c, d, x[0], 3); d = g(d, a, b, c, x[4], 5)
            c = g(c, d, a, b, x[8], 9); b = g(b, c, d, a, x[12], 13)
            a = g(a, b, c, d, x[1], 3); d = g(d, a, b, c, x[5], 5)
            c = g(c, d, a, b, x[9], 9); b = g(b, c, d, a, x[13], 13)
            a = g(a, b, c, d, x[2], 3); d = g(d, a, b, c, x[6], 5)
            c = g(c, d, a, b, x[10], 9); b = g(b, c, d, a, x[14], 13)
            a = g(a, b, c, d, x[3], 3); d = g(d, a, b, c, x[7], 5)
            c = g(c, d, a, b, x[11], 9); b = g(b, c, d, a, x[15], 13)

            // Round 3
            a = h(a, b, c, d, x[0], 3); d = h(d, a, b, c, x[8], 9)
            c = h(c, d, a, b, x[4], 11); b = h(b, c, d, a, x[12], 15)
            a = h(a, b, c, d, x[2], 3); d = h(d, a, b, c, x[10], 9)
            c = h(c, d, a, b, x[6], 11); b = h(b, c, d, a, x[14], 15)
            a = h(a, b, c, d, x[1], 3); d = h(d, a, b, c, x[9], 9)
            c = h(c, d, a, b, x[5], 11); b = h(b, c, d, a, x[13], 15)
            a = h(a, b, c, d, x[3], 3); d = h(d, a, b, c, x[11], 9)
            c = h(c, d, a, b, x[7], 11); b = h(b, c, d, a, x[15], 15)

            a &+= aa; b &+= bb; c &+= cc; d &+= dd
        }

        var out = Data(capacity: 16)
        for v in [a, b, c, d] {
            var le = v.littleEndian
            withUnsafeBytes(of: &le) { out.append(contentsOf: $0) }
        }
        return out
    }

    private static func f(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32, _ x: UInt32, _ s: UInt32) -> UInt32 {
        rotateLeft(a &+ ((b & c) | (~b & d)) &+ x, s)
    }

    private static func g(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32, _ x: UInt32, _ s: UInt32) -> UInt32 {
        rotateLeft(a &+ ((b & c) | (b & d) | (c & d)) &+ x &+ 0x5A82_7999, s)
    }

    private static func h(_ a: UInt32, _ b: UInt32, _ c: UInt32, _ d: UInt32, _ x: UInt32, _ s: UInt32) -> UInt32 {
        rotateLeft(a &+ (b ^ c ^ d) &+ x &+ 0x6ED9_EBA1, s)
    }

    private static func rotateLeft(_ x: UInt32, _ n: UInt32) -> UInt32 {
        (x << n) | (x >> (32 - n))
    }
}
