import XCTest
@testable import NDMEngine

final class RangeRetryDelayTests: XCTestCase {
    func testRetryAfterSecondsAndHTTPDate() {
        XCTAssertEqual(RangeStreamDownloader.retryDelay("120"), 120)
        XCTAssertNil(RangeStreamDownloader.retryDelay("NaN"))
        XCTAssertNil(RangeStreamDownloader.retryDelay("-1"))
        XCTAssertNil(RangeStreamDownloader.retryDelay("not a date"))
        XCTAssertNil(RangeStreamDownloader.retryDelay(nil))
        let now = Date(timeIntervalSince1970: 1_445_412_480)
        XCTAssertEqual(RangeStreamDownloader.retryDelay("Wed, 21 Oct 2015 07:28:00 GMT", now: now), 0)
        XCTAssertEqual(RangeStreamDownloader.retryDelay("Wed, 21 Oct 2015 07:30:00 GMT", now: now), 120)
    }
}
