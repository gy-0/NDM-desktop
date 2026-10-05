import XCTest
import Foundation
@testable import NDMCore
@testable import NDMEngine

final class ConnectionLimitReasonTests: XCTestCase {
    func testRealResponsesDistinguishRangeRefusalFromUnverifiedIdentity() async throws {
        let payload = Data(repeating: 0x5A, count: 512 * 1024)
        for (validator, ignoresRange, unknownLength, expected) in [
            (true, false, false, Optional<ConnectionLimitReason>.none),
            (false, false, false, .unverifiedResource),
            (true, true, false, .rangeUnsupported),
            (true, true, true, .unknownLength)
        ] {
            let server = LocalRangeServer(payload: payload, omitFullContentLength: unknownLength, ignoresRangeRequests: ignoresRange, sendsValidator: validator)
            try server.start(); defer { server.stop() }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("connection-reason-\(UUID())")
            let output = root.appendingPathComponent("output")
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let engine = DownloadEngine(taskID: 1,
                request: .init(url: server.baseURL, connections: 4, destinationDirectory: output),
                workDirectory: root.appendingPathComponent("work"))
            let final = try await engine.start()
            XCTAssertEqual(try Data(contentsOf: final), payload)
            let progress = await engine.currentProgress()
            XCTAssertEqual(progress.connectionLimitReason, expected)
            if expected == .rangeUnsupported { XCTAssertEqual(server.recordedMethods, ["GET"]) }
            if expected == .unverifiedResource { XCTAssertEqual(server.recordedMethods, ["GET", "GET"]) }
        }
    }
}
