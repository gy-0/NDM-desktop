import XCTest
@testable import NDMEngine
import NDMCore

final class HTTPFileResponsePolicyTests: XCTestCase {
    func testKnownFilesRejectWebpageMIMETypesButTextAndEndpointsRemainValid() {
        for name in ["document.zip", "guide.PDF", "video.mp4", "image.jpg", "installer.dmg"] {
            XCTAssertTrue(HTTPFileResponsePolicy.requiresFileResponse(filename: name))
        }
        for name in ["saved.html", "saved.xhtml", "source.txt", "download.php", "download", ""] {
            XCTAssertFalse(HTTPFileResponsePolicy.requiresFileResponse(filename: name))
        }
        XCTAssertTrue(HTTPFileResponsePolicy.isHTML(" Text/HTML ; charset=utf-8"))
        XCTAssertTrue(HTTPFileResponsePolicy.isHTML("application/xhtml+xml"))
        XCTAssertFalse(HTTPFileResponsePolicy.isHTML("application/zip"))
        XCTAssertFalse(HTTPFileResponsePolicy.isHTML(nil))
    }

    func testUnexpectedWebpageDiagnosticPersistsWithoutPretendingHTTPFailureOrSignIn() {
        let diagnostic = DownloadDiagnostic.classify(EngineError.unexpectedWebPage)
        XCTAssertEqual(diagnostic, .unexpectedWebPage)
        XCTAssertEqual(diagnostic.primaryAction, .openPage)
        XCTAssertEqual(DownloadDiagnostic.fromStoredErrorText(diagnostic.storageString), diagnostic)
        XCTAssertEqual(diagnostic.rawLabel, "unexpected webpage")
    }
}
