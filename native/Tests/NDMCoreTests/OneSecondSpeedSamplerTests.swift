import XCTest
@testable import NDMCore

final class OneSecondSpeedSamplerTests: XCTestCase {
    func testSamplerUsesBytesTransferredAcrossThePreviousSecond() throws {
        var sampler = OneSecondSpeedSampler()
        XCTAssertNil(sampler.consume(completedBytes: 1_000, reset: true, now: 100))
        XCTAssertNil(sampler.consume(completedBytes: 1_900, now: 100.9))
        let speed = try XCTUnwrap(sampler.consume(completedBytes: 3_000, now: 101))
        XCTAssertEqual(
            speed,
            2_000,
            accuracy: 0.001
        )
    }

    func testSamplerUsesActualElapsedTimeAndNeverReportsNegativeBytes() throws {
        var sampler = OneSecondSpeedSampler()
        _ = sampler.consume(completedBytes: 4_000, reset: true, now: 200)
        let speed = try XCTUnwrap(sampler.consume(completedBytes: 7_000, now: 201.5))
        XCTAssertEqual(
            speed,
            2_000,
            accuracy: 0.001
        )
        let resetSpeed = try XCTUnwrap(sampler.consume(completedBytes: 100, now: 202.5))
        XCTAssertEqual(
            resetSpeed,
            0,
            accuracy: 0.001
        )
    }

    func testSpeedFormattingKeepsAStablePrecision() {
        XCTAssertEqual(SpeedNumeralFormatting.parts(5.75 * 1024 * 1024).value, "5.8")
        XCTAssertEqual(SpeedNumeralFormatting.parts(5.75 * 1024 * 1024).unit, "MB/s")
    }
}
