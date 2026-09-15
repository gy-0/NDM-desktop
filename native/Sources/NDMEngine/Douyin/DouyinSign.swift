// Modified Swift ports of Apache-2.0 Douyin signature implementations.
// Copyright Johnserf-Seed and Evil0ctal contributors. See licenses/douyin/NOTICE.md.
import Foundation

/// Pseudo-random source in `[0, 1)`. The reference implementation is
/// non-deterministic; injecting the stream keeps the signature testable.
public typealias DouyinRandomSource = () -> Double

/// Default access values shared by every signed request. Signing is
/// User-Agent-bound: the UA hashed into the signature must be the UA the
/// request actually sends, so both live here.
public enum DouyinAccess {
    public static let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"

    public static func defaultRandom() -> DouyinRandomSource {
        { Double.random(in: 0..<1) }
    }
}

/// X-Bogus query signature (ported from the Apache-2.0 `xbogus.py` of
/// Douyin_TikTok_Download_API). Kept as the fallback for endpoints that reject
/// a_bogus-shaped requests.
enum DouyinXBogus {
    static let userAgentKey: [UInt8] = [0x00, 0x01, 0x0c]
    static let alphabet = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe="

    static func sign(url: String, userAgent: String, timestamp: Int) -> String {
        let rc4Ua = DouyinRC4.encrypt(key: userAgentKey, data: DouyinBytes.latin1(userAgent))
        let base64Ua = Data(rc4Ua).base64EncodedString()
        let uaHex = DouyinMD5.hex(Array(base64Ua.utf8))
        let uaArray = hexPairs(uaHex)

        let emptyHex = "d41d8cd98f00b204e9800998ecf8427e"
        let emptyArray = hexPairs(DouyinMD5.hex(hexPairs(emptyHex).map { UInt8($0 & 0xff) }))

        let urlArray = urlDigest(url)

        var values: [Int] = [
            64, 0, 1, 12,
            urlArray[14], urlArray[15],
            emptyArray[14], emptyArray[15],
            uaArray[14], uaArray[15],
            (timestamp >> 24) & 255, (timestamp >> 16) & 255,
            (timestamp >> 8) & 255, timestamp & 255,
            (536_919_696 >> 24) & 255, (536_919_696 >> 16) & 255,
            (536_919_696 >> 8) & 255, 536_919_696 & 255,
        ]
        var checksum = values[0]
        for value in values.dropFirst() { checksum ^= value }
        values.append(checksum)

        var garbled: [UInt8] = [2, 255]
        garbled += DouyinRC4.encrypt(key: [0xff], data: values.map { UInt8($0 & 0xff) })

        var signature = ""
        var index = 0
        while index + 2 < garbled.count {
            signature += calculation(garbled[index], garbled[index + 1], garbled[index + 2])
            index += 3
        }
        return signature
    }

    private static func hexPairs(_ hex: String) -> [Int] {
        var pairs = [Int]()
        var index = hex.startIndex
        while index < hex.endIndex {
            let next = hex.index(index, offsetBy: 2, limitedBy: hex.endIndex) ?? hex.endIndex
            let pair = String(hex[index..<next])
            if let value = Int(pair, radix: 16) { pairs.append(value) }
            index = next
        }
        return pairs
    }

    private static func urlDigest(_ url: String) -> [Int] {
        let first = Array(url.utf8).map(Int.init)
        let second = hexPairs(DouyinMD5.hex(first.map { UInt8($0 & 0xff) }))
        let third = hexPairs(DouyinMD5.hex(second.map { UInt8($0 & 0xff) }))
        return third
    }

    private static func calculation(_ a: UInt8, _ b: UInt8, _ c: UInt8) -> String {
        let value = (Int(a) & 255) << 16 | (Int(b) & 255) << 8 | (Int(c) & 255)
        let alphabet = Array(alphabet)
        return String([
            alphabet[(value & 0xFC0000) >> 18],
            alphabet[(value & 0x03F000) >> 12],
            alphabet[(value & 0x0FC0) >> 6],
            alphabet[value & 0x3F],
        ])
    }
}

/// a_bogus query signature, a direct port of the Apache-2.0 `abogus.py` from
/// johnserf-seed/f2. The algorithm mixes salted SM3 digests of the query and
/// body with an obfuscated byte table and a browser fingerprint.
enum DouyinABogus {
    static let salt = "cus"
    static let aid = 6383
    static let pageID = 0
    static let options = [0, 1, 14]
    static let userAgentKey: [UInt8] = [0x00, 0x01, 0x0e]
    static let character = "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe"
    static let character2 = "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe"

    static let sortIndex = [
        18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28,
        32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
    ]
    static let sortIndex2 = [
        18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37,
        44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
    ]

    // 256-entry permutation shared by the byte transform.
    static let bigArray: [Int] = [
        121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101,
        250, 207, 198, 50, 139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100,
        159, 160, 43, 8, 169, 217, 180, 120, 247, 45, 90, 11, 27, 197, 46, 3,
        84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161, 178, 81, 64, 187,
        134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150,
        110, 219, 199, 255, 181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201,
        17, 124, 125, 104, 96, 83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135,
        112, 158, 13, 1, 188, 164, 210, 237, 222, 98, 212, 77, 253, 42, 170, 202,
        26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141, 185, 33, 157, 31,
        252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109,
        57, 24, 38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232, 63,
        52, 205, 86, 140, 66, 175, 111, 171, 246, 133, 238, 193, 99, 60, 74, 91,
        225, 51, 76, 37, 145, 211, 166, 151, 213, 206, 0, 200, 244, 176, 218, 44,
        184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85, 224, 155, 226, 242,
        87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59,
        9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14, 156,
    ]

    struct Result: Equatable, Sendable {
        let signature: String
        let signedParams: String
    }

    static func sign(
        params: String,
        body: String = "",
        userAgent: String,
        fingerprint: String,
        random: @escaping DouyinRandomSource = DouyinAccess.defaultRandom(),
        now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }
    ) -> Result {
        var directory = [Int: Int]()
        directory[8] = 3
        directory[18] = 44
        directory[66] = 0
        directory[69] = 0
        directory[70] = 0
        directory[71] = 0

        let startEncryption = now()
        let array1 = paramsToArray(paramsToArray(params))
        let array2 = paramsToArray(paramsToArray(body))
        let encodedUa = base64Encode(
            DouyinRC4.encrypt(key: userAgentKey, data: Array(userAgent.utf8)),
            alphabet: character2
        )
        let array3 = sm3ToArray(Array(encodedUa.utf8))
        let endEncryption = now()

        directory[20] = (startEncryption >> 24) & 255
        directory[21] = (startEncryption >> 16) & 255
        directory[22] = (startEncryption >> 8) & 255
        directory[23] = startEncryption & 255
        directory[24] = startEncryption / 4_294_967_296
        directory[25] = startEncryption / 1_099_511_627_776

        directory[26] = (options[0] >> 24) & 255
        directory[27] = (options[0] >> 16) & 255
        directory[28] = (options[0] >> 8) & 255
        directory[29] = options[0] & 255

        directory[30] = (options[1] / 256) & 255
        directory[31] = (options[1] % 256) & 255
        directory[32] = (options[1] >> 24) & 255
        directory[33] = (options[1] >> 16) & 255

        directory[34] = (options[2] >> 24) & 255
        directory[35] = (options[2] >> 16) & 255
        directory[36] = (options[2] >> 8) & 255
        directory[37] = options[2] & 255

        directory[38] = array1[21]
        directory[39] = array1[22]
        directory[40] = array2[21]
        directory[41] = array2[22]
        directory[42] = array3[23]
        directory[43] = array3[24]

        directory[44] = (endEncryption >> 24) & 255
        directory[45] = (endEncryption >> 16) & 255
        directory[46] = (endEncryption >> 8) & 255
        directory[47] = endEncryption & 255
        directory[48] = directory[8]
        directory[49] = endEncryption / 4_294_967_296
        directory[50] = endEncryption / 1_099_511_627_776

        directory[51] = (pageID >> 24) & 255
        directory[52] = (pageID >> 16) & 255
        directory[53] = (pageID >> 8) & 255
        directory[54] = pageID & 255
        directory[55] = pageID
        directory[56] = aid
        directory[57] = aid & 255
        directory[58] = (aid >> 8) & 255
        directory[59] = (aid >> 16) & 255
        directory[60] = (aid >> 24) & 255

        directory[64] = fingerprint.utf8.count
        directory[65] = fingerprint.utf8.count

        var payload = sortIndex.map { directory[$0] ?? 0 }
        var checksum = 0
        for index in 0..<(sortIndex2.count - 1) {
            if index == 0 { checksum = directory[sortIndex2[0]] ?? 0 }
            checksum ^= directory[sortIndex2[index + 1]] ?? 0
        }
        payload += Array(fingerprint.utf8).map(Int.init)
        payload.append(checksum)

        let transformed = transformBytes(payload)
        let raw = generateRandomBytes(length: 3, random: random) + transformed
        let signature = abogusEncode(raw, alphabet: character)
        return Result(signature: signature, signedParams: params + "&a_bogus=" + signature)
    }

    static func fingerprint(random: @escaping DouyinRandomSource = DouyinAccess.defaultRandom()) -> String {
        func randint(_ lower: Int, _ upper: Int) -> Int {
            lower + Int(random() * Double(upper - lower + 1))
        }
        let innerWidth = randint(1024, 1920)
        let innerHeight = randint(768, 1080)
        let outerWidth = innerWidth + randint(24, 32)
        let outerHeight = innerHeight + randint(75, 90)
        let screenX = 0
        let screenY = random() < 0.5 ? 0 : 30
        let sizeWidth = randint(1024, 1920)
        let sizeHeight = randint(768, 1080)
        let availableWidth = randint(1280, 1920)
        let availableHeight = randint(800, 1080)
        return "\(innerWidth)|\(innerHeight)|\(outerWidth)|\(outerHeight)|"
            + "\(screenX)|\(screenY)|0|0|\(sizeWidth)|\(sizeHeight)|"
            + "\(availableWidth)|\(availableHeight)|\(innerWidth)|\(innerHeight)|24|24|Win32"
    }

    static func generateRandomBytes(length: Int, random: DouyinRandomSource) -> [UInt8] {
        func shiftRight(_ value: Int, _ count: Int) -> Int {
            (value % 0x1_0000_0000) >> count
        }
        var output = [UInt8]()
        for _ in 0..<length {
            let value = Int(random() * 10000)
            let low = value & 255
            let high = shiftRight(value, 8) & 255
            output.append(UInt8((low & 170) | 1))
            output.append(UInt8((low & 85) | 2))
            output.append(UInt8((high & 170) | 5))
            output.append(UInt8((high & 85) | 40))
        }
        return output
    }

    static func transformBytes(_ input: [Int]) -> [UInt8] {
        var table = bigArray
        var output = [UInt8]()
        output.reserveCapacity(input.count)
        var indexB = table[1]
        var initialValue = 0
        var valueE = 0
        for (index, value) in input.enumerated() {
            let sumInitialSeed: Int
            if index == 0 {
                initialValue = table[indexB]
                sumInitialSeed = indexB + initialValue
                table[1] = initialValue
                table[indexB] = indexB
            } else {
                sumInitialSeed = initialValue + valueE
            }
            let sumInitial = sumInitialSeed % 256
            output.append(UInt8((value ^ table[sumInitial]) & 0xff))
            valueE = table[(index + 2) % 256]
            let swapIndex = (indexB + valueE) % 256
            initialValue = table[swapIndex]
            table[swapIndex] = table[(index + 2) % 256]
            table[(index + 2) % 256] = initialValue
            indexB = swapIndex
        }
        return output
    }

    static func base64Encode(_ bytes: [UInt8], alphabet: String) -> String {
        var binary = ""
        binary.reserveCapacity(bytes.count * 8)
        for byte in bytes {
            binary += String(byte, radix: 2).leftPadded(to: 8)
        }
        let padding = (6 - binary.count % 6) % 6
        binary += String(repeating: "0", count: padding)
        let alphabetChars = Array(alphabet)
        var output = ""
        var index = binary.startIndex
        while index < binary.endIndex {
            let next = binary.index(index, offsetBy: 6)
            if let value = Int(binary[index..<next], radix: 2) {
                output.append(alphabetChars[value])
            }
            index = next
        }
        output += String(repeating: "=", count: padding / 2)
        return output
    }

    static func abogusEncode(_ bytes: [UInt8], alphabet: String) -> String {
        let alphabetChars = Array(alphabet)
        var output = ""
        var index = 0
        while index < bytes.count {
            let n: UInt32
            if index + 2 < bytes.count {
                n = UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2])
            } else if index + 1 < bytes.count {
                n = UInt32(bytes[index]) << 16 | UInt32(bytes[index + 1]) << 8
            } else {
                n = UInt32(bytes[index]) << 16
            }
            for (shift, mask) in zip([18, 12, 6, 0], [0xFC_0000, 0x03_F000, 0x0FC0, 0x3F]) {
                if shift == 6 && index + 1 >= bytes.count { break }
                if shift == 0 && index + 2 >= bytes.count { break }
                output.append(alphabetChars[Int((n & UInt32(mask)) >> UInt32(shift))])
            }
            index += 3
        }
        output += String(repeating: "=", count: (4 - output.count % 4) % 4)
        return output
    }

    static func sm3ToArray(_ bytes: [UInt8]) -> [Int] {
        DouyinSM3.hash(bytes).map(Int.init)
    }

    static func paramsToArray(_ param: String, addSalt: Bool = true) -> [Int] {
        sm3ToArray(Array((addSalt ? param + salt : param).utf8))
    }

    static func paramsToArray(_ array: [Int]) -> [Int] {
        sm3ToArray(array.map { UInt8($0 & 0xff) })
    }
}

extension String {
    fileprivate func leftPadded(to width: Int) -> String {
        count >= width ? self : String(repeating: "0", count: width - count) + self
    }
}
