import XCTest
@testable import NDMEngine
@testable import NDMCore

final class FTPEngineIntegrationTests: XCTestCase {
    func testParsePASV() {
        let parsed = FTPEngine.parsePASV("227 Entering Passive Mode (127,0,0,1,20,45)")
        XCTAssertEqual(parsed?.host, "127.0.0.1")
        XCTAssertEqual(parsed?.port, 20 * 256 + 45)
    }

    func testFTPDownload() async throws {
        let payload = Data("hello-ftp-world-\(UUID().uuidString)".utf8)
        let server = LocalFTPServer(files: ["/file.bin": payload], username: "u", password: "p")
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ftp-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var url = server.url(path: "file.bin")
        // Embed credentials
        var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        comps.user = "u"
        comps.password = "p"
        url = comps.url!

        let task = try await manager.addURL(url.absoluteString)
        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        let fileURL = dest.appendingPathComponent(done.filename)
        XCTAssertEqual(try Data(contentsOf: fileURL), payload)
    }

    func testFTPResumeWithREST() async throws {
        var payload = Data(count: 32 * 1024)
        for i in 0..<payload.count { payload[i] = UInt8(i % 251) }

        let server = LocalFTPServer(files: ["/big.bin": payload], username: "u", password: "p")
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }

        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-ftp-resume-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let support = tmp.appendingPathComponent("support", isDirectory: true)
        let dest = tmp.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)

        let store = try DownloadStore(directory: support)
        let settings = AppSettings(downloadDirectory: dest, maxConnections: 1, useCategoryFolders: false)
        let manager = DownloadManager(store: store, settings: settings, supportRoot: support)

        var comps = URLComponents(url: server.url(path: "big.bin"), resolvingAgainstBaseURL: false)!
        comps.user = "u"
        comps.password = "p"
        let task = try await manager.addURL(comps.url!.absoluteString)

        // Pre-seed partial file (first 8 KiB)
        let work = support.appendingPathComponent("\(task.id)", isDirectory: true)
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try payload.subdata(in: 0..<8192).write(to: work.appendingPathComponent("ftp.partial"))

        try await manager.startAndWait(taskID: task.id)

        let tasks = try await manager.listTasks()
        let done = try XCTUnwrap(tasks.first(where: { $0.id == task.id }))
        XCTAssertEqual(done.status, .complete)
        XCTAssertEqual(try Data(contentsOf: dest.appendingPathComponent(done.filename)), payload)
    }

    func testFTPRejectsTruncatedTransferEvenWith226AndRetainsPartialForResume() async throws {
        let payload = Data((0..<512).map { UInt8($0 % 251) })
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(maximumTransferBytes: 127))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }

        do {
            _ = try await download.engine.start()
            XCTFail("Truncated FTP data must not complete even when the server sends 226")
        } catch EngineError.incompleteResponse(let expected, let received) {
            XCTAssertEqual(expected, Int64(payload.count))
            XCTAssertEqual(received, 127)
        }
        let progress = await download.engine.currentProgress()
        XCTAssertEqual(progress.status, .error)
        XCTAssertEqual(progress.totalBytes, Int64(payload.count), "SIZE must parse the 213 reply body")
        XCTAssertEqual(progress.completedBytes, 127)
        XCTAssertFalse(progress.segmentStates.contains(where: \.isFinished))
        XCTAssertEqual(try Data(contentsOf: download.partial), Data(payload.prefix(127)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))

        let retryServer = LocalFTPServer(files: ["file.bin": payload])
        try retryServer.start()
        defer { XCTAssertTrue(retryServer.stop(), "FTP fixture must release all sockets") }
        let retry = download.makeEngine(server: retryServer)
        let result = try await retry.start()
        XCTAssertEqual(try Data(contentsOf: result), payload)
        XCTAssertEqual(retryServer.receivedRESTOffsets, [127])
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.partial.path))
    }

    func testFTPRequiresPositiveTransferCompletionReply() async throws {
        let payload = Data("received bytes are not proof of FTP success".utf8)
        for reply in [426, 451, 200, 225] {
            let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(finalReply: .reply(reply)))
            try server.start()
            defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
            let download = try TestDownload(server: server)
            defer { download.remove() }

            do {
                _ = try await download.engine.start()
                XCTFail("Unexpected completion for reply \(reply)")
            } catch let error as FTPError {
                XCTAssertEqual(error, .retrFailed(reply))
            }
            let progress = await download.engine.currentProgress()
            XCTAssertEqual(progress.status, .error)
            XCTAssertEqual(try Data(contentsOf: download.partial), payload)
            XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
        }
    }

    func testFTPControlDisconnectDoesNotCompleteDownload() async throws {
        let payload = Data("control connection closes before 226".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(finalReply: .disconnect))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        do {
            _ = try await download.engine.start()
            XCTFail("Data EOF without a control completion must fail")
        } catch let error as FTPError {
            XCTAssertEqual(error, .disconnected)
        }
        let progress = await download.engine.currentProgress()
        XCTAssertEqual(progress.status, .error)
        XCTAssertEqual(try Data(contentsOf: download.partial), payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
    }

    func testFTPMissingFinalReplyTimesOutAndRetainsPartial() async throws {
        let payload = Data("server omits its final reply".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(finalReply: .omit))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        do {
            _ = try await download.engine.start()
            XCTFail("Data EOF without a control completion must time out")
        } catch let error as FTPError {
            XCTAssertEqual(error, .timeout)
        }
        let progress = await download.engine.currentProgress()
        XCTAssertEqual(progress.status, .error)
        XCTAssertEqual(try Data(contentsOf: download.partial), payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
    }

    func testFTPKnownZeroBytesAndUnavailableSIZECanComplete() async throws {
        for payload in [Data(), Data("FTP server does not support SIZE".utf8)] {
            for sizeReply: LocalFTPServer.Behavior.SizeReply in [.actual, .unavailable] {
                let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(sizeReply: sizeReply))
                try server.start()
                defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
                let download = try TestDownload(server: server)
                defer { download.remove() }
                let result = try await download.engine.start()
                XCTAssertEqual(try Data(contentsOf: result), payload)
                let progress = await download.engine.currentProgress()
                XCTAssertEqual(progress.status, .complete)
                XCTAssertEqual(progress.totalBytes, Int64(payload.count))
                XCTAssertEqual(progress.completedBytes, Int64(payload.count))
                XCTAssertEqual(progress.segmentStates.first?.isFinished, true)
            }
        }
    }

    func testFTPMalformedSIZEIsNotMistakenForTheReplyCodeAsLength() async throws {
        let payload = Data("SIZE unavailable despite a malformed positive reply".utf8)
        for sizeReply in ["213", "213 ", "213 -1", "213 invalid"] {
            let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(sizeReply: .raw(sizeReply)))
            try server.start()
            defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
            let download = try TestDownload(server: server)
            defer { download.remove() }
            let result = try await download.engine.start()
            XCTAssertEqual(try Data(contentsOf: result), payload)
            let progress = await download.engine.currentProgress()
            XCTAssertEqual(progress.status, .complete)
            XCTAssertEqual(progress.totalBytes, Int64(payload.count))
        }
    }

    func testFTPRejectsExtraBytesWhenSIZEIsZero() async throws {
        let payload = Data("unexpected body for a declared empty file".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(sizeReply: .advertised(0)))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        do {
            _ = try await download.engine.start()
            XCTFail("A known zero length must not be treated as unknown")
        } catch EngineError.incompleteResponse(let expected, let received) {
            XCTAssertEqual(expected, 0)
            XCTAssertEqual(received, Int64(payload.count))
        }
        XCTAssertEqual(try Data(contentsOf: download.partial), payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
    }

    func testFTPAllows250CompletionAndPreservesExistingDestinations() async throws {
        let payload = Data("new download".utf8)
        let original = Data("original must survive".utf8)
        let neighbor = Data("neighbor must survive".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(finalReply: .reply(250)))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        try original.write(to: download.target)
        let neighborURL = download.destination.appendingPathComponent("file (2).bin")
        try neighbor.write(to: neighborURL)
        let result = try await download.engine.start()
        XCTAssertEqual(result.lastPathComponent, "file (3).bin")
        XCTAssertEqual(try Data(contentsOf: download.target), original)
        XCTAssertEqual(try Data(contentsOf: neighborURL), neighbor)
        XCTAssertEqual(try Data(contentsOf: result), payload)
    }

    func testFTPRESTRejectionRestartsWithoutAppendingStalePartial() async throws {
        let payload = Data("complete remote file".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(acceptsREST: false))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        try Data("stale prefix".utf8).write(to: download.partial)
        let result = try await download.engine.start()
        XCTAssertEqual(try Data(contentsOf: result), payload)
        XCTAssertEqual(server.receivedRESTOffsets, [12])
    }

    func testFTPOversizedPartialIsPreservedAndNotPublished() async throws {
        let payload = Data("remote".utf8)
        let existing = Data("old partial longer than remote".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload])
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let download = try TestDownload(server: server)
        defer { download.remove() }
        try existing.write(to: download.partial)
        do {
            _ = try await download.engine.start()
            XCTFail("An oversized partial cannot be resumed into a valid file")
        } catch EngineError.incompleteResponse(let expected, let received) {
            XCTAssertEqual(expected, Int64(payload.count))
            XCTAssertEqual(received, Int64(existing.count))
        }
        XCTAssertEqual(try Data(contentsOf: download.partial), existing)
        XCTAssertEqual(server.receivedRESTOffsets, [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
    }

    func testFTPPauseAndCancelWhileWaitingForFinalReplyPreserveStopIntent() async throws {
        let payload = Data("finished bytes still need the server's final acknowledgement".utf8)
        for pause in [true, false] {
            let dataSent = expectation(description: "FTP data sent before final acknowledgement")
            let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(
                finalReplyDelay: 2,
                onDataTransferFinished: { dataSent.fulfill() }
            ))
            try server.start()
            defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
            let download = try TestDownload(server: server)
            defer { download.remove() }
            let running = Task { try await download.engine.start() }
            defer { running.cancel() }
            await fulfillment(of: [dataSent], timeout: 3)
            // Wait until the engine has written all bytes, while the server holds
            // the positive final reply. Stop must win before any file is published.
            let deadline = Date().addingTimeInterval(1)
            while await download.engine.currentProgress().completedBytes < Int64(payload.count), Date() < deadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            let waiting = await download.engine.currentProgress()
            XCTAssertEqual(waiting.completedBytes, Int64(payload.count))
            XCTAssertEqual(waiting.status, .downloading)
            if pause { await download.engine.pause() }
            else { await download.engine.cancel() }
            do {
                _ = try await running.value
                XCTFail("Stopped FTP transfer must not publish after a delayed 226")
            } catch EngineError.paused {
                XCTAssertTrue(pause)
            } catch EngineError.cancelled {
                XCTAssertFalse(pause)
            }
            let stopped = await download.engine.currentProgress()
            XCTAssertEqual(stopped.status, pause ? .paused : .incomplete)
            XCTAssertEqual(try Data(contentsOf: download.partial), payload)
            XCTAssertFalse(FileManager.default.fileExists(atPath: download.target.path))
        }
    }

    func testFTPExplicitRedownloadAtomicallyReplacesTheSamePath() async throws {
        try await verifyManagerRedownload(truncated: false)
    }

    func testFTPFailedExplicitRedownloadPreservesTheOriginal() async throws {
        try await verifyManagerRedownload(truncated: true)
    }

    private func verifyManagerRedownload(truncated: Bool) async throws {
        let payload = Data("verified replacement for the previous FTP download".utf8)
        let original = Data("previous complete download".utf8)
        let server = LocalFTPServer(files: ["file.bin": payload], behavior: .init(
            maximumTransferBytes: truncated ? 7 : nil, finalReplyDelay: 0.1
        ))
        try server.start()
        defer { XCTAssertTrue(server.stop(), "FTP fixture must release all sockets") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-ftp-redownload-\(UUID())")
        defer { try? FileManager.default.removeItem(at: root) }
        let destination = root.appendingPathComponent("downloads")
        let support = root.appendingPathComponent("support")
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
        let store = try DownloadStore(directory: support)
        let manager = DownloadManager(store: store,
                                      settings: AppSettings(downloadDirectory: destination, useCategoryFolders: false),
                                      supportRoot: support)
        var components = URLComponents(url: server.url(path: "file.bin"), resolvingAgainstBaseURL: false)!
        components.user = "user"
        components.password = "pass"
        var task = try await manager.addURL(components.url!.absoluteString, connections: 1)
        task.filename = "fixture.bin"
        task.folderPath = destination.path
        task.status = .complete
        try store.update(task)
        let target = destination.appendingPathComponent(task.filename)
        try original.write(to: target)

        try await manager.restart(taskID: task.id)
        XCTAssertEqual(try Data(contentsOf: target), original, "Restart must retain the original while FTP runs")
        var result = task
        for _ in 0..<100 {
            try await Task.sleep(nanoseconds: 50_000_000)
            result = try XCTUnwrap(store.allDownloads().first { $0.id == task.id })
            if result.status == .complete || result.status == .error { break }
        }
        await manager.pause(taskID: task.id)
        XCTAssertEqual(result.status, truncated ? .error : .complete, result.errorText ?? "")
        XCTAssertEqual(result.filename, "fixture.bin")
        XCTAssertEqual(try Data(contentsOf: target), truncated ? original : payload)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.appendingPathComponent("fixture (2).bin").path))
        if truncated {
            let partial = support.appendingPathComponent("\(task.id)/ftp.partial")
            XCTAssertEqual(try Data(contentsOf: partial), Data(payload.prefix(7)))
        }
    }

    private struct TestDownload {
        private let createdAt = Date()
        let root: URL
        let work: URL
        let destination: URL
        let engine: FTPEngine
        var partial: URL { work.appendingPathComponent("ftp.partial") }
        var target: URL { destination.appendingPathComponent("file.bin") }

        init(server: LocalFTPServer) throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-ftp-integrity-\(UUID().uuidString)")
            work = root.appendingPathComponent("work")
            destination = root.appendingPathComponent("destination")
            try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
            engine = FTPEngine(taskID: 1, request: DownloadRequest(
                url: server.url(path: "file.bin"), destinationDirectory: destination,
                suggestedFilename: "file.bin", username: "user", password: "pass"
            ), workDirectory: work)
        }

        func makeEngine(server: LocalFTPServer) -> FTPEngine {
            FTPEngine(taskID: 1, request: DownloadRequest(
                url: server.url(path: "file.bin"), destinationDirectory: destination,
                suggestedFilename: "file.bin", username: "user", password: "pass"
            ), workDirectory: work)
        }

        func remove() {
            // These loopback fixtures normally finish within a second (5s for
            // the deliberately missing final reply). Retain diagnostic output
            // for runner-only stalls before removing the isolated fixture.
            if Date().timeIntervalSince(createdAt) >= 10,
               let log = try? String(contentsOf: work.appendingPathComponent("LogFile.txt"), encoding: .utf8) {
                print("Slow FTP fixture command log:\n\(log)")
            }
            try? FileManager.default.removeItem(at: root)
        }
    }
}
