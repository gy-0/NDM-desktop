import Foundation
import XCTest
@testable import NDMCore
@testable import NDMEngine

final class EnginePrestartPauseTests: XCTestCase {
    private func checkPause(kind: String) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-prestart-pause-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let work = root.appendingPathComponent("work")
        let http = LocalRangeServer(payload: Data("fixture".utf8))
        let ftp = LocalFTPServer(files: [:])
        if kind == "ftp" { try ftp.start() } else { try http.start() }
        defer { ftp.stop(); http.stop() }
        let request = DownloadRequest(url: kind == "ftp" ? ftp.url(path: "file.bin") : http.baseURL,
            destinationDirectory: root.appendingPathComponent("downloads"), suggestedFilename: "file.bin")
        let pause: () async -> Void
        let start: () async throws -> URL
        switch kind {
        case "hls":
            let engine = HLSEngine(taskID: 1, request: request, workDirectory: work)
            pause = { await engine.pause() }; start = { try await engine.start() }
        case "ftp":
            let engine = FTPEngine(taskID: 1, request: request, workDirectory: work)
            pause = { await engine.pause() }; start = { try await engine.start() }
        default:
            let engine = MKVMergeEngine(taskID: 1, videoRequest: request, audioRequest: request, workDirectory: work)
            pause = { await engine.pause() }; start = { try await engine.start() }
        }
        await pause()
        do { _ = try await start(); XCTFail("A pause already acknowledged before startup must prevent the run") }
        catch EngineError.paused { /* The preserved stop intent owns this generation. */ }
        catch { XCTFail("Expected paused before any network work; got \(error)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path), "Pre-start pause must not create staging files")
        if kind != "ftp" { XCTAssertTrue(http.recordedMethods.isEmpty, "Pre-start pause must not reach the origin") }
    }

    func testHLSPauseBeforeStartIsNotReset() async throws { try await checkPause(kind: "hls") }
    func testFTPPauseBeforeStartIsNotReset() async throws { try await checkPause(kind: "ftp") }
    func testMKVPauseBeforeStartIsNotReset() async throws { try await checkPause(kind: "mkv") }
}
