import XCTest
@testable import NDMEngine
@testable import NDMCore

final class DiagnosticClassifierTests: XCTestCase {
    func testEngineErrorClassification() {
        XCTAssertEqual(DownloadDiagnostic.classify(EngineError.httpStatus(403)), .linkExpired(status: 403))
        XCTAssertEqual(DownloadDiagnostic.classify(EngineError.httpStatus(503)), .serverError(status: 503))
        XCTAssertEqual(
            DownloadDiagnostic.classify(EngineError.authRequired(status: 401, challenge: nil)),
            .signInRequired(status: 401)
        )
        XCTAssertEqual(DownloadDiagnostic.classify(EngineError.notResumable), .rangeNotSupported)
        // `EngineError.mergeFailed` carries every yt-dlp failure; only
        // genuinely merge-flavored messages keep the merge label.
        XCTAssertEqual(
            DownloadDiagnostic.classify(EngineError.mergeFailed("ffmpeg exited 1")),
            .mergeFailed(detail: "ffmpeg exited 1")
        )
        XCTAssertEqual(
            DownloadDiagnostic.classify(EngineError.mergeFailed("Failed on Merging segments.")),
            .mergeFailed(detail: "Failed on Merging segments.")
        )
        XCTAssertEqual(
            DownloadDiagnostic.classify(
                EngineError.mergeFailed("ERROR: aria2c exited with code 28")
            ),
            .generic(detail: "ERROR: aria2c exited with code 28")
        )
        XCTAssertEqual(
            DownloadDiagnostic.classify(
                EngineError.mergeFailed("ERROR: unable to download video data: HTTP Error 403: Forbidden")
            ),
            .mediaFetchFailed(status: 403)
        )
        XCTAssertEqual(
            DownloadDiagnostic.classify(
                EngineError.mergeFailed("yt-dlp finished but no file appeared")
            ),
            .generic(detail: "yt-dlp finished but no file appeared")
        )
        XCTAssertEqual(
            DownloadDiagnostic.classify(
                EngineError.insufficientStorage(requiredBytes: 2_000, availableBytes: 1_000)
            ),
            .diskFull
        )
    }

    func testFTPErrorClassification() {
        XCTAssertEqual(DownloadDiagnostic.classify(FTPError.timeout), .timeout)
        XCTAssertEqual(DownloadDiagnostic.classify(FTPError.disconnected), .connectionLost)
        XCTAssertEqual(DownloadDiagnostic.classify(FTPError.loginFailed(530)), .signInRequired(status: 401))
    }

    func testFoundationErrorClassification() {
        XCTAssertEqual(DownloadDiagnostic.classify(URLError(.timedOut)), .timeout)
        XCTAssertEqual(DownloadDiagnostic.classify(URLError(.notConnectedToInternet)), .offline)
        let diskFull = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
        XCTAssertEqual(DownloadDiagnostic.classify(diskFull), .diskFull)
        // NSError bridged URL errors still classify.
        let bridged = NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost)
        XCTAssertEqual(DownloadDiagnostic.classify(bridged), .connectionLost)
    }
}
