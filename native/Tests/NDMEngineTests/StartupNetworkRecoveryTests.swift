import XCTest
import Foundation
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

/// Loopback-only metadata failures, before any range worker or output exists.
final class StartupNetworkRecoveryTests: XCTestCase {
    func testPauseBeforeStartPreventsNetworkAndOutputCreation() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 42, count: 65536))
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories()
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = DownloadEngine(taskID: 1, request: .init(url: server.baseURL, destinationDirectory: output), workDirectory: work)
        engine.requestPause()
        do { _ = try await engine.start(); XCTFail("A pending pause must survive startup") }
        catch EngineError.paused {}
        XCTAssertTrue(server.recordedMethods.isEmpty)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path))
    }

    func testTransientRangeZeroProbeFailureCanRecoverBeforeWorkersStart() async throws {
        let payload = Data((0..<524288).map { UInt8(truncatingIfNeeded: $0 &* 13 &+ ($0 >> 8)) })
        // HEAD is unsupported. The first two one-byte probes receive valid
        // headers followed by a premature TCP close instead of the body byte.
        let server = LocalRangeServer(payload: payload,
            truncateRangeBody: { start, ordinal in start == 0 && ordinal <= 2 ? 0 : nil },
            headStatus: 405)
        try server.start(); defer {
            print("STARTUP_TRANSPORT_EVIDENCE methods=\(server.recordedMethods) ranges=\(server.recordedRanges) truncated=\(server.truncatedResponses)")
            server.stop()
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("startup-network-\(UUID().uuidString)")
        let output = root.appendingPathComponent("output"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL,
            headers: ["X-Fixture": "startup-recovery"], connections: 2,
            destinationDirectory: output, suggestedFilename: "fixture.bin")
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(SHA256.hash(data: try Data(contentsOf: final)), SHA256.hash(data: payload))
        XCTAssertEqual(server.truncatedResponses, 2)
        XCTAssertGreaterThanOrEqual(server.recordedRanges.filter { $0.lowercased() == "range: bytes=0-0" }.count, 3)
        XCTAssertTrue(server.recordedMethods.allSatisfy { $0 == "HEAD" || $0 == "GET" })
        XCTAssertTrue(server.recordedHeaders.allSatisfy { $0["x-fixture"] == "startup-recovery" })
        XCTAssertTrue(server.recordedBodies.allSatisfy(\.isEmpty))
    }
    private func directories() throws -> (URL, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("startup-boundary-\(UUID().uuidString)")
        let output = root.appendingPathComponent("output"), work = root.appendingPathComponent("work")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        return (root, output, work)
    }
    func testPersistentProbeDisconnectStopsAfterInitialPlusThreeRetries() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 42, count: 65536), truncateRangeBody: { _, _ in 0 }, headStatus: 405)
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, destinationDirectory: output, suggestedFilename: "fixture.bin")
        do { _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start(); XCTFail("Probe must exhaust its startup budget") }
        catch { XCTAssertEqual((error as NSError).code, NSURLErrorNetworkConnectionLost) }
        XCTAssertEqual(server.truncatedResponses, 4)
        XCTAssertEqual(server.recordedRanges.count, 4)
        XCTAssertTrue(server.recordedRanges.allSatisfy { $0.lowercased() == "range: bytes=0-0" })
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.appendingPathComponent("segments.bin").path))
    }
    func testBodyBearingProbeDisconnectDoesNotReplayPOST() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 42, count: 65536), truncateBody: { method in method == "POST" ? 0 : nil })
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, method: "POST", headers: ["Content-Type":"application/x-www-form-urlencoded"], body: Data("fixture=form".utf8), destinationDirectory: output)
        do { _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start(); XCTFail("POST must not replay after uncertain receipt") }
        catch { XCTAssertEqual((error as NSError).code, NSURLErrorNetworkConnectionLost) }
        XCTAssertEqual(server.recordedMethods, ["POST"])
        XCTAssertEqual(server.recordedBodies, ["fixture=form"])
        XCTAssertEqual(server.truncatedResponses, 1)
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty)
    }
    func testHTTPFailuresDoNotConsumeTransportRetryBudget() async throws {
        for status in [403, 500] {
            let server = LocalRangeServer(payload: Data(repeating: 42, count: 65536), injectedRangeFailureStatus: status, injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: 20, headStatus: 405)
            try server.start(); defer { server.stop() }
            let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
            let request = DownloadRequest(url: server.baseURL, destinationDirectory: output)
            do { _ = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start(); XCTFail("HTTP error must remain terminal") }
            catch { XCTAssertEqual((error as? EngineError)?.errorDescription, EngineError.httpStatus(status).errorDescription) }
            XCTAssertEqual(server.recordedMethods, ["HEAD", "GET"])
            XCTAssertEqual(server.recordedRanges.count, 1)
        }
    }
    func testPauseCancelsInFlightStartupProbeWithoutRetry() async throws {
        for useRange in [false, true] {
            let server = LocalRangeServer(payload: Data(repeating: 42, count: 65536), responseDelay: useRange ? 0 : 1.5, rangeResponseDelay: { _ in 1.5 }, headStatus: useRange ? 405 : 200)
            try server.start(); defer { server.stop() }
            let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
            let engine = DownloadEngine(taskID: 1, request: .init(url: server.baseURL, destinationDirectory: output), workDirectory: work)
            let running = Task { try await engine.start() }
            let deadline = Date().addingTimeInterval(3)
            while (useRange ? server.recordedRanges.isEmpty : server.recordedMethods.isEmpty) && Date() < deadline { try await Task.sleep(nanoseconds: 5_000_000) }
            let count = server.recordedMethods.count, before = Date()
            await engine.pause()
            do { _ = try await running.value; XCTFail("Pause must stop probe") }
            catch EngineError.paused {} catch EngineError.cancelled {} catch is CancellationError {}
            catch { XCTAssertEqual((error as NSError).code, NSURLErrorCancelled) }
            XCTAssertLessThan(Date().timeIntervalSince(before), 0.6)
            XCTAssertEqual(server.recordedMethods.count, count)
            XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: output.path).isEmpty)
        }
    }

    func testDigestNonceIsRebuiltAcrossMetadataTransportRetry() async throws {
        let payload = Data(repeating: 42, count: 65536)
        let server = LocalRangeServer(payload: payload,
            authenticationChallenge: "Digest realm=\"fixture\", nonce=\"startup-fixture-nonce\", qop=\"auth\", algorithm=MD5",
            truncateRangeBody: { _, ordinal in ordinal == 2 ? 0 : nil },
            injectedRangeFailureStatus: 401, injectRangeFailureAfterCount: 0, injectedRangeFailureLimit: 1, headStatus: 405)
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, connections: 1, destinationDirectory: output, username: "fixture", password: "fixture")
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(try Data(contentsOf: final), payload)
        let regex = try NSRegularExpression(pattern: "nc=([0-9a-fA-F]{8})")
        let signed = server.recordedHeaders.compactMap { $0["authorization"] }.filter { $0.hasPrefix("Digest ") }
        let counts = signed.compactMap { header -> Int? in
            guard let match = regex.firstMatch(in: header, range: NSRange(header.startIndex..., in: header)),
                  let range = Range(match.range(at: 1), in: header) else { return nil }
            return Int(header[range], radix: 16)
        }
        XCTAssertGreaterThanOrEqual(counts.count, 4)
        XCTAssertEqual(Set(counts).count, counts.count, "Rebuilt requests must not replay an old Digest nonce count")
        XCTAssertEqual(counts, counts.sorted())
        XCTAssertEqual(server.truncatedResponses, 1)
    }

    func testUnsupportedHEADAndUnsatisfiableEmptyRangeStillDownloadEmptyFile() async throws {
        let server = LocalRangeServer(payload: Data(), headStatus: 405)
        try server.start(); defer { server.stop() }
        let (root, output, work) = try directories(); defer { try? FileManager.default.removeItem(at: root) }
        let request = DownloadRequest(url: server.baseURL, destinationDirectory: output, suggestedFilename: "empty.bin")
        let final = try await DownloadEngine(taskID: 1, request: request, workDirectory: work).start()
        XCTAssertEqual(try Data(contentsOf: final), Data())
        XCTAssertEqual(server.recordedMethods, ["HEAD", "GET", "GET"])
        XCTAssertEqual(server.recordedRanges, ["Range: bytes=0-0"])
    }

}
