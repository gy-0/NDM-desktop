import XCTest
@testable import NDMCore

final class SettingsInputValidationTests: XCTestCase {
    func testConnectionCountAcceptsOnlyProductRange() {
        XCTAssertEqual(SettingsInputValidation.connectionCount(" 8 "), 8)
        XCTAssertEqual(SettingsInputValidation.connectionCount("32"), 32)
        XCTAssertNil(SettingsInputValidation.connectionCount("0"))
        XCTAssertNil(SettingsInputValidation.connectionCount("33"))
        XCTAssertNil(SettingsInputValidation.connectionCount("eight"))
    }

    func testBandwidthDoesNotSilentlyTurnInvalidTextIntoUnlimited() {
        XCTAssertEqual(SettingsInputValidation.bandwidthBytesPerSecond("0"), 0)
        XCTAssertEqual(SettingsInputValidation.bandwidthBytesPerSecond(" 1048576 "), 1_048_576)
        XCTAssertNil(SettingsInputValidation.bandwidthBytesPerSecond("-1"))
        XCTAssertNil(SettingsInputValidation.bandwidthBytesPerSecond("fast"))
        XCTAssertNil(SettingsInputValidation.bandwidthBytesPerSecond("999999999999999999999"))
    }

    func testCustomBandwidthAcceptsHumanReadableMegabytesPerSecond() {
        XCTAssertEqual(SettingsInputValidation.bandwidthMegabytesPerSecond("1"), 1_000_000)
        XCTAssertEqual(SettingsInputValidation.bandwidthMegabytesPerSecond(" 2.5 "), 2_500_000)
        XCTAssertEqual(SettingsInputValidation.bandwidthMegabytesPerSecond("0,75"), 750_000)
        XCTAssertNil(SettingsInputValidation.bandwidthMegabytesPerSecond("0"))
        XCTAssertNil(SettingsInputValidation.bandwidthMegabytesPerSecond("-1"))
        XCTAssertNil(SettingsInputValidation.bandwidthMegabytesPerSecond("fast"))
        XCTAssertNil(SettingsInputValidation.bandwidthMegabytesPerSecond("nan"))
    }

    func testPortRejectsZeroOverflowAndNonNumbers() {
        XCTAssertEqual(SettingsInputValidation.port(" 8080 "), 8_080)
        XCTAssertEqual(SettingsInputValidation.port("65535"), 65_535)
        XCTAssertNil(SettingsInputValidation.port("0"))
        XCTAssertNil(SettingsInputValidation.port("65536"))
        XCTAssertNil(SettingsInputValidation.port("auto"))
    }

    func testIntegerPortRejectsValuesThatWouldTrapUInt16Conversion() {
        XCTAssertEqual(SettingsInputValidation.port(8_080), 8_080)
        XCTAssertEqual(SettingsInputValidation.port(65_535), 65_535)
        XCTAssertNil(SettingsInputValidation.port(0))
        XCTAssertNil(SettingsInputValidation.port(-1))
        XCTAssertNil(SettingsInputValidation.port(65_536))
    }

    func testNonEmptyTextTrimsBeforeValidation() {
        XCTAssertEqual(SettingsInputValidation.nonEmptyText("  proxy.example  "), "proxy.example")
        XCTAssertNil(SettingsInputValidation.nonEmptyText(" \n\t "))
    }
}
