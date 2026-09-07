import XCTest
@testable import NDMCore

final class AuthStoreTests: XCTestCase {
    func testInsertAndLookup() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-auth-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = try DownloadStore(directory: dir)
        _ = try store.insertAuth(AuthCredential(
            target: "example.com",
            protocolName: "digest",
            username: "u",
            password: "p"
        ))
        let found = try store.auth(forHost: "cdn.example.com")
        XCTAssertEqual(found?.username, "u")
        XCTAssertEqual(found?.password, "p")
    }
}
