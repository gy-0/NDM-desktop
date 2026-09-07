import XCTest
@testable import NDMCore

final class DownloadDiagnosticTests: XCTestCase {
    private var savedLanguage: AppLanguageMode!

    override func setUp() {
        super.setUp()
        savedLanguage = L10n.currentMode
    }

    override func tearDown() {
        L10n.apply(savedLanguage)
        super.tearDown()
    }

    // MARK: - HTTP classification

    func testHTTPStatusClassification() {
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(403), .linkExpired(status: 403))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(404), .linkExpired(status: 404))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(410), .linkExpired(status: 410))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(401), .signInRequired(status: 401))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(407), .signInRequired(status: 407))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(416), .rangeNotSupported)
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(429), .serverThrottled)
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(503), .serverError(status: 503))
        XCTAssertEqual(DownloadDiagnostic.fromHTTPStatus(418), .httpError(status: 418))
    }

    func testURLErrorClassification() {
        XCTAssertEqual(DownloadDiagnostic.fromURLError(URLError(.notConnectedToInternet)), .offline)
        XCTAssertEqual(DownloadDiagnostic.fromURLError(URLError(.timedOut)), .timeout)
        XCTAssertEqual(DownloadDiagnostic.fromURLError(URLError(.networkConnectionLost)), .connectionLost)
        XCTAssertEqual(DownloadDiagnostic.fromURLError(URLError(.secureConnectionFailed)), .sslFailure)
    }

    func testDiskFullClassification() {
        let cocoa = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)
        XCTAssertEqual(DownloadDiagnostic.fromCocoaError(cocoa), .diskFull)
        let posix = NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC))
        XCTAssertEqual(DownloadDiagnostic.fromCocoaError(posix), .diskFull)
        let other = NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError)
        XCTAssertNil(DownloadDiagnostic.fromCocoaError(other))
    }

    // MARK: - Storage round-trip

    func testStorageRoundTripAllCases() {
        let cases: [DownloadDiagnostic] = [
            .linkExpired(status: 403),
            .signInRequired(status: 407),
            .rangeNotSupported,
            .serverThrottled,
            .serverError(status: 502),
            .httpError(status: 418),
            .offline,
            .timeout,
            .connectionLost,
            .sslFailure,
            .diskFull,
            .mergeFailed(detail: "ffmpeg exited 1"),
            .mediaFetchFailed(status: 403),
            .generic(detail: "weird: thing | with separators"),
        ]
        for diag in cases {
            let stored = diag.storageString
            XCTAssertEqual(DownloadDiagnostic(storageString: stored), diag, "round-trip failed for \(stored)")
        }
    }

    func testLegacyPlainTextIsNotParsed() {
        XCTAssertNil(DownloadDiagnostic.fromStoredErrorText("410 Gone"))
        XCTAssertNil(DownloadDiagnostic.fromStoredErrorText(nil))
        XCTAssertNil(DownloadDiagnostic.fromStoredErrorText("#diag:someFutureCase:9"))
    }

    // MARK: - Copy renders in the current UI language

    func testCopyFollowsLanguage() {
        let diag = DownloadDiagnostic.linkExpired(status: 403)

        L10n.apply(.english)
        XCTAssertEqual(diag.title, "The download address is no longer valid")
        XCTAssertTrue(diag.rowSummary.hasPrefix("Address expired"))

        L10n.apply(.simplifiedChinese)
        XCTAssertEqual(diag.title, "下载地址已失效")
        XCTAssertTrue(diag.rowSummary.hasPrefix("地址已失效"))

        // Raw label never localizes.
        XCTAssertEqual(diag.rawLabel, "HTTP 403")
    }

    func testEveryCaseHasNonEmptyCopy() {
        let cases: [DownloadDiagnostic] = [
            .linkExpired(status: 403), .signInRequired(status: 401), .rangeNotSupported,
            .serverThrottled, .serverError(status: 500), .httpError(status: 418),
            .offline, .timeout, .connectionLost, .sslFailure, .diskFull,
            .mergeFailed(detail: "d"), .mediaFetchFailed(status: 403), .generic(detail: "d"),
        ]
        for mode in [AppLanguageMode.english, .simplifiedChinese] {
            L10n.apply(mode)
            for diag in cases {
                XCTAssertFalse(diag.title.isEmpty)
                XCTAssertFalse(diag.message.isEmpty)
                XCTAssertFalse(diag.rowSummary.isEmpty)
                XCTAssertFalse(diag.rawLabel.isEmpty)
                XCTAssertTrue(diag.rowSummary.contains(" · "), "row summary should be headline · hint")
            }
        }
    }

    // MARK: - Presentation integration

    func testPresentationRendersStoredDiagnostic() {
        L10n.apply(.simplifiedChinese)
        let task = DownloadTask(
            url: "https://cdn.example.com/file.zip",
            status: .error,
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
        )
        let row = TaskRowPresentation.make(task: task, progress: nil)
        XCTAssertEqual(row.diagnostic, .linkExpired(status: 403))
        XCTAssertEqual(
            row.errorText,
            DownloadDiagnostic.linkExpired(status: 403).rowSummary(hasSavedData: false)
        )
        XCTAssertEqual(row.statusDetail, row.errorText)
        XCTAssertEqual(row.diagnostic?.primaryAction, .renew)
        XCTAssertEqual(row.primaryAction, .recover)
        XCTAssertEqual(row.recoveryAction, .renewURL)
        XCTAssertTrue(row.canRenew)
        XCTAssertTrue(row.needsLinkRenew)
    }

    func testNeedsLinkRenewOnlyForLinkExpiry() {
        let expired = DownloadTask(
            url: "https://cdn.example.com/file.zip",
            status: .error,
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
        )
        let diskFull = DownloadTask(
            url: "https://cdn.example.com/file.zip",
            status: .error,
            errorText: DownloadDiagnostic.diskFull.storageString
        )
        let plain = DownloadTask(
            url: "https://cdn.example.com/file.zip",
            status: .error,
            errorText: "410 Gone"
        )
        XCTAssertTrue(TaskRowPresentation.make(task: expired, progress: nil).needsLinkRenew)
        XCTAssertFalse(TaskRowPresentation.make(task: diskFull, progress: nil).needsLinkRenew)
        XCTAssertFalse(TaskRowPresentation.make(task: plain, progress: nil).needsLinkRenew)
        // canRenew remains available for manual repair from menus.
        XCTAssertTrue(TaskRowPresentation.make(task: diskFull, progress: nil).canRenew)
    }

    func testBrowserRescueURLOnlyAppearsForRecoverableDirectFailures() {
        var task = DownloadTask(
            url: "https://cdn.example.com/file.zip?expired",
            linkType: "normal",
            status: .error,
            pageURL: "https://example.com/download/42",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
        )
        XCTAssertEqual(task.browserRescueURL?.absoluteString, "https://example.com/download/42")

        task.errorText = DownloadDiagnostic.signInRequired(status: 401).storageString
        XCTAssertNotNil(task.browserRescueURL)

        task.errorText = DownloadDiagnostic.diskFull.storageString
        XCTAssertNil(task.browserRescueURL)

        task.errorText = DownloadDiagnostic.httpError(status: 418).storageString
        XCTAssertNotNil(task.browserRescueURL)

        task.errorText = DownloadDiagnostic.linkExpired(status: 403).storageString
        task.linkType = "ytdlp"
        XCTAssertNil(task.browserRescueURL)

        task.linkType = "normal"
        task.status = .complete
        XCTAssertNil(task.browserRescueURL)
    }

    func testRecoveryActionNamesTheGestureTheUserWillActuallyPerform() {
        var task = DownloadTask(
            url: "https://cdn.example.com/file.zip?expired",
            status: .error,
            pageURL: "https://example.com/download/42",
            errorText: DownloadDiagnostic.linkExpired(status: 403).storageString
        )
        XCTAssertEqual(TaskRecoveryAction.make(from: task), .openSourcePage)
        XCTAssertFalse(
            DownloadDiagnostic.linkExpired(status: 403)
                .message(hasSavedData: false)
                .contains("分段")
        )

        task.pageURL = nil
        XCTAssertEqual(TaskRecoveryAction.make(from: task), .renewURL)

        task.errorText = DownloadDiagnostic.timeout.storageString
        XCTAssertEqual(TaskRecoveryAction.make(from: task), .retry)
    }

    func testPresentationPassesThroughLegacyError() {
        let task = DownloadTask(url: "https://a/x", status: .error, errorText: "410 Gone")
        let row = TaskRowPresentation.make(task: task, progress: nil)
        XCTAssertNil(row.diagnostic)
        XCTAssertEqual(row.errorText, "410 Gone")
    }

    func testStoredYtDlp403IsNotPresentedAsPackagingFailure() {
        L10n.apply(.simplifiedChinese)
        let stored = "#diag:mergeFailed|ERROR: unable to download video data: HTTP Error 403: Forbidden"
        XCTAssertEqual(
            DownloadDiagnostic.fromStoredErrorText(stored),
            .mediaFetchFailed(status: 403)
        )
        XCTAssertEqual(
            DownloadDiagnostic.classifyEngineMessage(
                "ERROR: unable to download video data: HTTP Error 403: Forbidden"
            ),
            .mediaFetchFailed(status: 403)
        )

        let task = DownloadTask(
            url: "https://www.youtube.com/watch?v=5KtlQYqVCAI",
            linkType: "ytdlp",
            status: .error,
            errorText: stored
        )
        let row = TaskRowPresentation.make(task: task, progress: nil)
        XCTAssertEqual(row.diagnostic, .mediaFetchFailed(status: 403))
        XCTAssertEqual(row.diagnostic?.primaryAction, .retry)
        XCTAssertEqual(TaskRecoveryAction.make(from: task), .retry)
        XCTAssertEqual(row.diagnostic?.title, "未能获取视频数据")
        XCTAssertTrue(row.errorText?.contains("未能获取视频") == true)
        XCTAssertFalse(row.errorText?.contains("只能") == true)
        XCTAssertFalse(row.diagnostic?.message.contains("只能") == true)
    }

    func testPackagingCopyDoesNotSoundLikeChat() {
        L10n.apply(.simplifiedChinese)
        let diag = DownloadDiagnostic.mergeFailed(detail: "ffmpeg exited 1")
        XCTAssertEqual(diag.title, "视频封装未完成")
        XCTAssertEqual(diag.rowSummary, "封装未完成 · 分轨已保留，可重试封装")
        XCTAssertFalse(diag.message.contains("只能"))
        XCTAssertTrue(diag.message.contains("重试将仅重新封装"))
    }
}
