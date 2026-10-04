import XCTest
@testable import NDMCore

final class OneSecondSpeedSamplerTests: XCTestCase {
    func testSamplerUsesBytesTransferredAcrossThePreviousSecond() throws {
        var sampler = OneSecondSpeedSampler()
        XCTAssertNil(sampler.consume(completedBytes: 1_000, reset: true, now: 100))
        XCTAssertNil(sampler.consume(completedBytes: 1_100, now: 100.1))
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 1_500, now: 100.25)), 2_000, accuracy: 0.001)
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

    func testStartupRequiresNewBytesAndResetExcludesRestoredProgress() throws {
        var sampler = OneSecondSpeedSampler()
        XCTAssertNil(sampler.consume(completedBytes: 1_000_000, now: 10))
        XCTAssertNil(sampler.consume(completedBytes: 1_000_000, now: 10.25))
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 1_001_000, now: 10.5)), 2_000, accuracy: 0.001)
        XCTAssertNil(sampler.consume(completedBytes: 1_005_000, now: 10.75))
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 1_005_000, now: 11)), 5_000, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 1_005_000, now: 12)), 0)

        XCTAssertNil(sampler.consume(completedBytes: 1_005_000, reset: true, now: 20))
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 1_005_500, now: 20.25)), 2_000, accuracy: 0.001)
        sampler.clear()
        XCTAssertNil(sampler.consume(completedBytes: 2_000_000, now: 30))
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 2_001_000, now: 30.25)), 4_000, accuracy: 0.001)
    }

    func testWaitingForHeadersDoesNotConsumeTheEarlyByteSample() throws {
        var sampler = OneSecondSpeedSampler()
        XCTAssertNil(sampler.consume(completedBytes: 0, now: 10))
        XCTAssertEqual(sampler.consume(completedBytes: 0, now: 11), 0)
        XCTAssertEqual(sampler.consume(completedBytes: 0, now: 12), 0)
        XCTAssertEqual(try XCTUnwrap(sampler.consume(completedBytes: 500, now: 12.25)), 2_000, accuracy: 0.001)
    }

    func testSpeedFormattingKeepsAStablePrecision() {
        XCTAssertEqual(SpeedNumeralFormatting.parts(5.75 * 1024 * 1024).value, "5.8")
        XCTAssertEqual(SpeedNumeralFormatting.parts(5.75 * 1024 * 1024).unit, "MB/s")
    }
}
