import XCTest
@testable import NDMEngine

final class RemoteFilePreviewProbeTests: XCTestCase {
    func testHeadBuildsUsefulPreviewFromDispositionAndHeaders() async throws {
        let requested = URL(string: "https://cdn.example.com/download?id=1")!
        let resolved = URL(string: "https://cdn.example.com/assets/final")!
        let preview = try await RemoteFilePreviewProbe.probe(url: requested) { request in
            XCTAssertEqual(request.httpMethod, "HEAD")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Encoding"), "identity")
            return Self.response(
                url: resolved,
                status: 200,
                headers: [
                    "Content-Disposition": "attachment; filename=Report.pdf",
                    "Content-Type": "application/pdf; charset=binary",
                    "Content-Length": "4096",
                    "Accept-Ranges": "bytes",
                ]
            )
        }

        XCTAssertEqual(preview.filename, "Report.pdf")
        XCTAssertEqual(preview.mimeType, "application/pdf")
        XCTAssertEqual(preview.contentLength, 4096)
        XCTAssertTrue(preview.acceptsByteRanges)
        XCTAssertEqual(preview.resolvedURL, resolved)
    }

    func testRejectedHeadFallsBackToHeaderOnlyRangeProbe() async throws {
        let url = URL(string: "https://example.com/file")!
        let methods = RequestLog()
        let preview = try await RemoteFilePreviewProbe.probe(url: url) { request in
            methods.append(request.httpMethod ?? "")
            if request.httpMethod == "HEAD" {
                return Self.response(url: url, status: 405)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Range"), "bytes=0-0")
            return Self.response(
                url: url,
                status: 206,
                headers: [
                    "Content-Range": "bytes 0-0/8192",
                    "Content-Length": "1",
                    "Content-Type": "application/x-apple-diskimage",
                    "Content-Disposition": "attachment; filename=NDM.dmg",
                ]
            )
        }

        XCTAssertEqual(methods.values, ["HEAD", "GET"])
        XCTAssertEqual(preview.filename, "NDM.dmg")
        XCTAssertEqual(preview.contentLength, 8192)
        XCTAssertTrue(preview.acceptsByteRanges)
    }

    func testRangeIgnoringServerIsNotClaimedAsResumable() async throws {
        let url = URL(string: "https://example.com/archive.zip")!
        let preview = try await RemoteFilePreviewProbe.probe(url: url) { request in
            if request.httpMethod == "HEAD" {
                return Self.response(url: url, status: 501)
            }
            return Self.response(
                url: url,
                status: 200,
                headers: [
                    "Content-Length": "12345",
                    "Content-Type": "application/zip",
                ]
            )
        }

        XCTAssertEqual(preview.contentLength, 12345)
        XCTAssertFalse(preview.acceptsByteRanges)
        XCTAssertEqual(preview.filename, "archive.zip")
    }

    func testRangeFailureIsSurfaced() async {
        let url = URL(string: "https://example.com/private.bin")!
        do {
            _ = try await RemoteFilePreviewProbe.probe(url: url) { request in
                Self.response(url: url, status: request.httpMethod == "HEAD" ? 403 : 416)
            }
            XCTFail("Expected the range response to fail")
        } catch let error as RemoteFilePreviewProbeError {
            XCTAssertEqual(error, .httpStatus(416))
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    private static func response(
        url: URL,
        status: Int,
        headers: [String: String] = [:]
    ) -> HTTPURLResponse {
        HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String] = []

    func append(_ value: String) {
        lock.lock()
        storage.append(value)
        lock.unlock()
    }

    var values: [String] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}
