import XCTest
@testable import NDMCore

final class NTLMAuthTests: XCTestCase {
    func testMD4RFC1320() {
        XCTAssertEqual(MD4.hash(Data()).hex, "31d6cfe0d16ae931b73c59d7e0c089c0")
        XCTAssertEqual(MD4.hash(Data("a".utf8)).hex, "bde52cb31de33e46245e05fbdbd6fb24")
        XCTAssertEqual(MD4.hash(Data("abc".utf8)).hex, "a448017aaf21d8525fc10ae87aa6729d")
    }

    func testType1MatchesOriginalFlagsAndSize() {
        let msg = NTLMAuth.type1Message()
        XCTAssertEqual(msg.count, 32)
        XCTAssertEqual(String(data: msg.prefix(7), encoding: .ascii), "NTLMSSP")
        XCTAssertEqual(msg[7], 0)
        // type = 1
        XCTAssertEqual(msg[8], 1)
        // flags = 0x88207 LE
        XCTAssertEqual(msg[12], 0x07)
        XCTAssertEqual(msg[13], 0x82)
        XCTAssertEqual(msg[14], 0x08)
        XCTAssertEqual(msg[15], 0x00)
        XCTAssertEqual(NTLMAuth.type1Flags, 0x0008_8207)
    }

    /// MS-NLMP 4.2.4.1.1 NTOWFv2 example.
    func testNTOWFv2MicrosoftVector() {
        let key = NTLMAuth.ntowfV2(password: "Password", user: "User", domain: "Domain")
        XCTAssertEqual(key.hex, "0c868a403bfd7a93a3001ef22ef02e3f")
    }

    func testParseType2Challenge() throws {
        // Minimal Type2: signature + type2 + empty target + flags + challenge + zeros
        var blob = Data()
        blob.append(contentsOf: Array("NTLMSSP\0".utf8))
        // type 2
        blob.append(contentsOf: [2, 0, 0, 0])
        // target name secbuf empty @ 48
        blob.append(contentsOf: [0, 0, 0, 0, 48, 0, 0, 0])
        // flags unicode|ntlm
        blob.append(contentsOf: [0x05, 0x82, 0x88, 0xA0])
        // server challenge
        blob.append(contentsOf: [0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF])
        // reserved 8
        blob.append(contentsOf: [UInt8](repeating: 0, count: 8))
        // target info empty @ 48
        blob.append(contentsOf: [0, 0, 0, 0, 48, 0, 0, 0])

        let header = "NTLM \(blob.base64EncodedString())"
        let type2 = try XCTUnwrap(NTLMAuth.parseType2(from: header))
        XCTAssertEqual(type2.serverChallenge.hex, "0123456789abcdef")
    }

    func testType3RoundTripProof() throws {
        let challenge = Data([0x01, 0x23, 0x45, 0x67, 0x89, 0xAB, 0xCD, 0xEF])
        let clientChallenge = Data(repeating: 0xAA, count: 8)
        let timestamp = Data(repeating: 0x00, count: 8)
        let targetInfo = Data()
        let type2 = NTLMAuth.Type2(
            serverChallenge: challenge,
            flags: 0xA288_8205,
            targetName: "Domain",
            targetInfo: targetInfo
        )
        let header = NTLMAuth.type3AuthorizationHeader(
            type2: type2,
            username: "User",
            password: "Password",
            workstation: "WORKSTATION",
            clientChallenge: clientChallenge,
            timestamp: timestamp
        )
        XCTAssertTrue(header.hasPrefix("NTLM "))
        let token = try XCTUnwrap(Data(base64Encoded: String(header.dropFirst(5))))
        XCTAssertTrue(token.starts(with: Array("NTLMSSP\0".utf8)))
        XCTAssertEqual(token[8], 3)

        let expected = NTLMAuth.ntlmV2Response(
            password: "Password",
            user: "User",
            domain: "Domain",
            serverChallenge: challenge,
            clientChallenge: clientChallenge,
            timestamp: timestamp,
            targetInfo: targetInfo
        )
        // NT response security buffer at offset 20: len, len, offset
        let ntLen = Int(token[20]) | (Int(token[21]) << 8)
        let ntOff = Int(token[24]) | (Int(token[25]) << 8) | (Int(token[26]) << 16) | (Int(token[27]) << 24)
        let ntResp = token.subdata(in: ntOff..<(ntOff + ntLen))
        XCTAssertEqual(ntResp, expected)
    }

    func testSplitUserDomain() {
        XCTAssertEqual(NTLMAuth.splitUserDomain("CORP\\alice").user, "alice")
        XCTAssertEqual(NTLMAuth.splitUserDomain("CORP\\alice").domain, "CORP")
        XCTAssertEqual(NTLMAuth.splitUserDomain("alice@corp.local").user, "alice")
        XCTAssertEqual(NTLMAuth.splitUserDomain("alice@corp.local").domain, "corp.local")
    }

    func testBareNTLMChallengeHasNoToken() {
        XCTAssertNil(NTLMAuth.ntlmToken(from: "NTLM"))
        XCTAssertTrue(NTLMAuth.isNTLMChallenge("NTLM"))
    }
}

private extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
