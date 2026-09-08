import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

final class ProbeBootstrapTests: XCTestCase {
    func testIgnoredRangeAdoptsFullBodyWithoutSecondGET() async throws {
        try await run(method: "GET")
    }
    func testPOSTDownloadsFullResponseWithSingleBodySubmission() async throws {
        try await run(method: "POST")
    }
    func testCompleteBootstrapNeverOverwritesExistingDestination() async throws {
        try await run(method: "POST", collision: true)
    }
    func testRestartRecoversOwnedBootstrapFromPreviousProcess() async throws {
        try await run(method: "POST", seedBootstrap: true)
    }
    func testAdoptedBodyPublishesByRenameWithoutAnotherFileSpaceBudget() async throws {
        try await run(method: "POST", lowSpaceAfterAdoption: true)
    }
    private func run(method: String, collision: Bool = false, seedBootstrap: Bool = false, lowSpaceAfterAdoption: Bool = false) async throws {
        let payload = Data((0..<524288).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ ($0 >> 8)) })
        let server = LocalRangeServer(payload: payload, ignoresRangeRequests: true, headStatus: 405)
        try server.start(); defer { server.stop() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("probe-bootstrap-\(UUID().uuidString)")
        let output = root.appendingPathComponent("output"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        if seedBootstrap {
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            let staging = work.appendingPathComponent(".ndm-merge-1-\(UUID()).partial")
            let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            XCTAssertGreaterThanOrEqual(descriptor, 0)
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            _ = try MergeStagingReceipt.register(taskID: 1, staging: staging, descriptor: descriptor, in: work)
            try handle.write(contentsOf: Data(repeating: 17, count: 65536))
            try handle.synchronize()
            try handle.close()
        }
        let final = output.appendingPathComponent("fixture.bin")
        if collision { try Data("keep-user-file".utf8).write(to: final) }
        let request = DownloadRequest(url: server.baseURL, method: method,
            headers: ["X-Fixture": "bootstrap", "Content-Type": "application/x-www-form-urlencoded"],
            body: method == "POST" ? Data("fixture=form".utf8) : nil,
            connections: 2, destinationDirectory: output, suggestedFilename: "fixture.bin")
        do {
            let file = try await DownloadEngine(taskID: 1, request: request, workDirectory: work,
                capacityProvider: { _ in
                    if lowSpaceAfterAdoption && FileManager.default.fileExists(atPath: work.appendingPathComponent("seg.x0").path) { return 0 }
                    return Int64(payload.count * 4)
                }).start()
            XCTAssertFalse(collision, "Existing user file must reject publication")
            XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: file)), SHA256.hash(data: payload))
        } catch {
            guard collision else { throw error }
            XCTAssertEqual((error as NSError).code, Int(EEXIST))
            XCTAssertEqual(try Data(contentsOf: final), Data("keep-user-file".utf8))
        }
        XCTAssertEqual(server.recordedMethods, method == "GET" ? ["HEAD", "GET"] : ["POST"])
        XCTAssertEqual(server.recordedRanges, method == "GET" ? ["Range: bytes=0-0"] : [])
        XCTAssertEqual(server.recordedBodies, method == "GET" ? ["", ""] : ["fixture=form"])
        XCTAssertTrue(server.recordedHeaders.allSatisfy { $0["x-fixture"] == "bootstrap" })
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: work.path).contains { $0.hasPrefix("bootstrap-") || $0.hasPrefix(".ndm-merge-") })
        XCTAssertFalse(FileManager.default.fileExists(atPath: MergeStagingReceipt.location(in: work).path))
    }
}
