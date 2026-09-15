// Modified Swift ports of Apache-2.0 Douyin signature implementations.
// Copyright Johnserf-Seed and Evil0ctal contributors. See licenses/douyin/NOTICE.md.
import CryptoKit
import Foundation

/// Byte helpers for the signature algorithms. Both were written against
/// Latin-1 `chr`/`ord` semantics, so every intermediate value is a single
/// byte even when the surrounding language deals in text.
enum DouyinBytes {
    static func latin1(_ bytes: [UInt8]) -> String {
        String(bytes.map { Character(UnicodeScalar($0)) })
    }

    static func latin1(_ value: String) -> [UInt8] {
        value.unicodeScalars.map { UInt8($0.value & 0xff) }
    }
}

enum DouyinMD5 {
    static func digest(_ bytes: [UInt8]) -> [UInt8] {
        Array(Insecure.MD5.hash(data: Data(bytes)))
    }

    static func hex(_ bytes: [UInt8]) -> String {
        digest(bytes).map { String(format: "%02x", $0) }.joined()
    }

    /// Hex digest of a string's UTF-8 bytes.
    static func hex(_ value: String) -> String {
        hex(Array(value.utf8))
    }
}

enum DouyinRC4 {
    static func encrypt(key: [UInt8], data: [UInt8]) -> [UInt8] {
        var s = (0...255).map { UInt8($0) }
        var j = 0
        for i in 0...255 {
            j = (j + Int(s[i]) + Int(key[i % key.count])) % 256
            s.swapAt(i, j)
        }
        var i = 0
        j = 0
        var output = [UInt8]()
        output.reserveCapacity(data.count)
        for byte in data {
            i = (i + 1) % 256
            j = (j + Int(s[i])) % 256
            s.swapAt(i, j)
            output.append(byte ^ s[(Int(s[i]) + Int(s[j])) % 256])
        }
        return output
    }
}

/// SM3 as specified by GM/T 0004-2012. The signatures require the salted SM3
/// of request parameters, and CryptoKit does not ship SM3, so this is a direct
/// port of the reference compression function.
enum DouyinSM3 {
    private static let iv: [UInt32] = [
        0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
        0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
    ]

    static func hash(_ message: [UInt8]) -> [UInt8] {
        var data = message
        let bitLength = UInt64(message.count) * 8
        data.append(0x80)
        while data.count % 64 != 56 { data.append(0) }
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((bitLength >> UInt64(shift)) & 0xff))
        }
        var state = iv
        var offset = 0
        while offset < data.count {
            compress(&state, Array(data[offset..<(offset + 64)]))
            offset += 64
        }
        var output = [UInt8]()
        output.reserveCapacity(32)
        for word in state {
            output.append(UInt8((word >> 24) & 0xff))
            output.append(UInt8((word >> 16) & 0xff))
            output.append(UInt8((word >> 8) & 0xff))
            output.append(UInt8(word & 0xff))
        }
        return output
    }

    private static func rotl(_ value: UInt32, _ count: UInt32) -> UInt32 {
        count == 0 ? value : (value << count) | (value >> (32 - count))
    }

    private static func p0(_ value: UInt32) -> UInt32 {
        value ^ rotl(value, 9) ^ rotl(value, 17)
    }

    private static func p1(_ value: UInt32) -> UInt32 {
        value ^ rotl(value, 15) ^ rotl(value, 23)
    }

    private static func ff(_ x: UInt32, _ y: UInt32, _ z: UInt32, _ round: Int) -> UInt32 {
        round < 16 ? x ^ y ^ z : (x & y) | (x & z) | (y & z)
    }

    private static func gg(_ x: UInt32, _ y: UInt32, _ z: UInt32, _ round: Int) -> UInt32 {
        round < 16 ? x ^ y ^ z : (x & y) | (~x & z)
    }

    private static func compress(_ state: inout [UInt32], _ block: [UInt8]) {
        var w = [UInt32](repeating: 0, count: 68)
        for index in 0..<16 {
            w[index] = UInt32(block[index * 4]) << 24
                | UInt32(block[index * 4 + 1]) << 16
                | UInt32(block[index * 4 + 2]) << 8
                | UInt32(block[index * 4 + 3])
        }
        for index in 16..<68 {
            let mixed = w[index - 16] ^ w[index - 9] ^ rotl(w[index - 3], 15)
            w[index] = p1(mixed) ^ rotl(w[index - 13], 7) ^ w[index - 6]
        }
        var wPrime = [UInt32](repeating: 0, count: 64)
        for index in 0..<64 { wPrime[index] = w[index] ^ w[index + 4] }

        var a = state[0], b = state[1], c = state[2], d = state[3]
        var e = state[4], f = state[5], g = state[6], h = state[7]
        for round in 0..<64 {
            let t: UInt32 = round < 16 ? 0x79cc4519 : 0x7a879d8a
            let ss1 = rotl(rotl(a, 12) &+ e &+ rotl(t, UInt32(round % 32)), 7)
            let ss2 = ss1 ^ rotl(a, 12)
            let tt1 = ff(a, b, c, round) &+ d &+ ss2 &+ wPrime[round]
            let tt2 = gg(e, f, g, round) &+ h &+ ss1 &+ w[round]
            d = c
            c = rotl(b, 9)
            b = a
            a = tt1
            h = g
            g = rotl(f, 19)
            f = e
            e = p0(tt2)
        }
        state[0] ^= a
        state[1] ^= b
        state[2] ^= c
        state[3] ^= d
        state[4] ^= e
        state[5] ^= f
        state[6] ^= g
        state[7] ^= h
    }
}
