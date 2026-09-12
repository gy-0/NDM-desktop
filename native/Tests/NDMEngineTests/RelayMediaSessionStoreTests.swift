import XCTest
@testable import NDMEngine

final class RelayMediaSessionStoreTests: XCTestCase {
    private let url = "https://www.youtube.com/watch?v=fixture"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private func encoded(_ rows: [String]) -> String {
        Data((["# Netscape HTTP Cookie File"] + rows).joined(separator: "\n").utf8).base64EncodedString()
    }
    private let row = "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-secret"

    func testScopedHttpOnlySessionUsesPrivateTemporaryFileAndOnlyIdentifierPersists() throws {
        let store = RelayMediaSessionStore()
        let source = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([
            row,
            ".unrelated.example\tTRUE\t/\tTRUE\t0\tother\tforeign",
            ".com\tTRUE\t/\tTRUE\t0\tpublicsuffix\tforeign",
            ".youtube.com\tFALSE\t/\tTRUE\t0\thostonly\tforeign",
            ".youtube.com\tTRUE\t/\tTRUE\t1\texpired\tforeign"
        ]), now: now))
        let lease = try store.lease(source, now: now)
        guard case .file(let path) = lease.source else { return XCTFail("Relay source did not create a file lease") }
        let contents = try String(contentsOfFile: path, encoding: .utf8)
        XCTAssertTrue(contents.contains(row))
        XCTAssertFalse(contents.contains("foreign"))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)?.intValue, 0o700)
        let saved = try JSONEncoder().encode(YtDlpDownloadOptions(cookieSource: source))
        XCTAssertFalse(String(decoding: saved, as: UTF8.self).contains("fixture-secret"))
        XCTAssertEqual(try JSONDecoder().decode(YtDlpDownloadOptions.self, from: saved).cookieSource, source)
        lease.close()
        XCTAssertFalse(FileManager.default.fileExists(atPath: path))
    }

    func testExplicitSessionIDKeepsProfilesAndPagesSeparate() throws {
        let store = RelayMediaSessionStore()
        let firstID = UUID().uuidString, secondID = UUID().uuidString
        let first = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([row]), sessionID: firstID, now: now))
        let second = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([]), sessionID: secondID, now: now))
        XCTAssertEqual(try store.source(for: url + "#player", sessionID: firstID), first)
        XCTAssertEqual(try store.source(for: url, sessionID: secondID), second)
        XCTAssertThrowsError(try store.source(for: url + "2", sessionID: firstID))
        XCTAssertThrowsError(try store.source(for: url, sessionID: firstID, browser: "firefox"))
        let anonymous = try store.lease(second, now: now)
        defer { anonymous.close() }
        guard case .file(let file) = anonymous.source else { return XCTFail("Missing anonymous jar") }
        XCTAssertFalse(try String(contentsOfFile: file).contains("fixture-secret"))
    }

    func testExpiredOrRestartedSessionsNeverChooseDefaultBrowserAndCapacityIsBounded() throws {
        let store = RelayMediaSessionStore(lifetime: 30, capacity: 1)
        let first = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([row]), now: now))
        XCTAssertThrowsError(try store.lease(first, now: now.addingTimeInterval(31)))
        XCTAssertThrowsError(try RelayMediaSessionStore().lease(first, now: now))
        _ = store.remember(url: url + "2", browser: "chrome", encodedCookies: encoded([row]), now: now.addingTimeInterval(1))
        XCTAssertThrowsError(try store.lease(first, now: now.addingTimeInterval(2)))
    }

    func testRestartRefreshUsesExactExtensionTokenAndFailureStaysExplicit() async throws {
        let store = RelayMediaSessionStore()
        let id = UUID().uuidString
        let source = YtDlpCookieSource.relay(browser: "chrome", sessionID: id, pageURL: url)
        let expectedURL = url, encoded = encoded([row])
        store.setRefreshHandler { sessionID, pageURL in
            guard sessionID == id && pageURL == expectedURL else { return nil }
            return encoded
        }
        let lease = try await store.refreshedLease(source)
        defer { lease.close() }
        guard case .file = lease.source else { return XCTFail("Refresh did not create a scoped jar") }
        do {
            _ = try await RelayMediaSessionStore().refreshedLease(source)
            XCTFail("Missing extension must not switch profiles")
        } catch RelayMediaSessionStore.Failure.unavailable { }
    }

    func testExplicitRefreshReplacesAnUnexpiredCookieSnapshotIncludingLogout() async throws {
        let store = RelayMediaSessionStore()
        let source = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([row])))
        let loggedOut = encoded([])
        store.setRefreshHandler { _, _ in loggedOut }
        try await store.refresh(source)
        let lease = try store.lease(source)
        defer { lease.close() }
        guard case .file(let file) = lease.source else { return XCTFail("Missing refreshed cookie jar") }
        XCTAssertFalse(try String(contentsOfFile: file).contains("fixture-secret"))
    }

    func testCookieAPIFailureOnlyAllowsAnExplicitlyAnonymousHandoff() async throws {
        let store = RelayMediaSessionStore()
        let anonymous = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([])))
        let signedIn = try XCTUnwrap(store.remember(url: url, browser: "chrome", encodedCookies: encoded([row])))
        try await store.refresh(anonymous, allowCachedAnonymous: true)
        do {
            try await store.refresh(signedIn, allowCachedAnonymous: true)
            XCTFail("Old signed-in cookies must not be reused when refresh is unavailable")
        } catch RelayMediaSessionStore.Failure.unavailable { }
    }

    func testMalformedOversizeAndWrongScopeNeverCreateSession() {
        let store = RelayMediaSessionStore()
        for payload in ["bad base64", String(repeating: "A", count: 90_001)] {
            XCTAssertNil(store.remember(url: url, browser: "chrome", encodedCookies: payload, now: now))
        }
        XCTAssertNil(store.remember(url: url, browser: "unsupported", encodedCookies: encoded([row]), now: now))
        XCTAssertNil(store.remember(url: "file:///private/test", browser: "chrome", encodedCookies: encoded([row]), now: now))
        XCTAssertNotNil(store.remember(url: "http://www.youtube.com/watch", browser: "chrome", encodedCookies: encoded([row]), now: now))
    }
}
