import XCTest
@testable import NDMEngine

/// Vector tests generated with the reference Apache-2.0 implementations
/// (`utils/xbogus.py`, `utils/abogus.py` of jiji262/douyin-downloader) under a
/// fixed clock and random stream. Any drift in the port breaks these.
final class DouyinSignTests: XCTestCase {
    private let userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
    private let fingerprint = "1136|850|1166|925|0|30|0|0|1512|907|1600|1005|1136|850|24|24|Win32"
    private let fixedTimeMilliseconds = 1_757_000_000_000

    func testSM3StandardVectors() {
        let abc = DouyinSM3.hash(Array("abc".utf8))
        XCTAssertEqual(hex(abc), "66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0")
        let repeated = DouyinSM3.hash(Array(String(repeating: "abcd", count: 16).utf8))
        XCTAssertEqual(hex(repeated), "debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732")
    }

    func testXBogusMatchesReferenceVector() {
        let url = "https://www.douyin.com/aweme/v1/web/aweme/detail/"
            + "?device_platform=webapp&aid=6383&aweme_id=7662339530070410737"
        let signature = DouyinXBogus.sign(url: url, userAgent: userAgent, timestamp: 1_757_000_000)
        XCTAssertEqual(signature, "DFSzswVYOGvAN9dxCjxxBe9WX7Jw")
    }

    func testABogusGetMatchesReferenceVector() {
        let params = "device_platform=webapp&aid=6383&channel=channel_pc_web"
            + "&aweme_id=7662339530070410737&msToken=abcdefghij&cookie_enabled=true&platform=PC"
        let result = DouyinABogus.sign(
            params: params,
            userAgent: userAgent,
            fingerprint: fingerprint,
            random: { 0.42 },
            now: { self.fixedTimeMilliseconds }
        )
        XCTAssertEqual(
            result.signature,
            "Q6mh/dwdk3ETfE6b542LfY3q6fl3YggF0SVkMD2fxx34wg39HMYD9exoEEUv1m8ji4/sIeLjy4hbY3ohrQc701wfHW4L/2AhsfSkKl12so0j53inCLRQE0wN57sAtlaQsv1lEOgkqw5bK8RsloFe-wHvPjojx2f39gbG"
        )
        XCTAssertEqual(result.signedParams, params + "&a_bogus=" + result.signature)
    }

    func testABogusPostMatchesReferenceVector() {
        let params = "device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1"
        let body = "aweme_type=0&item_id=7467485482314763572&play_delta=1&source=0"
        let result = DouyinABogus.sign(
            params: params,
            body: body,
            userAgent: userAgent,
            fingerprint: fingerprint,
            random: { 0.42 },
            now: { self.fixedTimeMilliseconds }
        )
        XCTAssertEqual(
            result.signature,
            "Q6mh/dwdk3ETfE6b542LfY3q6UXwYggF0SVkMD2fV5Z4wg39HMYD9exoEEUv1m8ji4/sIeLjy4hbY3ohrQc701wfHW4L/2AhsfSkKl12so0j53inCLRQE0wN57sAtlaQsv1lEOgkqw5bK8RsloFe-wHvPjojx2f39gb-"
        )
        XCTAssertEqual(result.signature.count > 0, true)
    }

    func testFingerprintShape() {
        let value = DouyinABogus.fingerprint(random: { 0.42 })
        let parts = value.split(separator: "|", omittingEmptySubsequences: false)
        XCTAssertEqual(parts.count, 17)
        XCTAssertEqual(parts.last, "Win32")
        XCTAssertEqual(parts[0], "1400")
    }

    func testRC4RoundTripMatchesReferenceAlgorithm() {
        let key: [UInt8] = [0x00, 0x01, 0x0e]
        let encrypted = DouyinRC4.encrypt(key: key, data: Array(userAgent.utf8))
        let decrypted = DouyinRC4.encrypt(key: key, data: encrypted)
        XCTAssertEqual(decrypted, Array(userAgent.utf8))
    }

    private func hex(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
}
