import Network
import XCTest
@testable import NDMCore
@testable import NDMEngine

/// A live HLS origin: the playlist window advances on every request, and the stream
/// ends (gains #EXT-X-ENDLIST) after a set number of windows.
private final class RollingHLSServer: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ndm.test.live")
    private let lock = NSLock()
    private var listener: NWListener?
    private var _playlistRequests = 0
    private let windowSize: Int
    private let endsAfterRequests: Int
    private let targetDuration: Int
    private(set) var port: UInt16 = 0

    init(windowSize: Int = 3, endsAfterRequests: Int = 4, targetDuration: Int = 1) {
        self.windowSize = windowSize
        self.endsAfterRequests = endsAfterRequests
        self.targetDuration = targetDuration
    }

    var playlistRequests: Int {
        lock.lock(); defer { lock.unlock() }
        return _playlistRequests
    }

    var url: URL { URL(string: "http://127.0.0.1:\(port)/live.m3u8")! }

    func start() throws {
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                if let p = listener.port?.rawValue { self?.port = p }
                ready.signal()
            }
        }
        listener.newConnectionHandler = { [weak self] in self?.handle($0) }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 3)
        guard port != 0 else { throw NSError(domain: "RollingHLSServer", code: 1) }
    }

    func stop() { listener?.cancel(); listener = nil }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            let path = (request.components(separatedBy: " ").dropFirst().first) ?? ""
            let body: Data
            if path.hasSuffix(".m3u8") {
                body = Data(self.playlist().utf8)
            } else {
                // Each segment's bytes name it, so the merged result can be checked.
                let name = path.split(separator: "/").last.map(String.init) ?? "?"
                body = Data("[\(name)]".utf8)
            }
            var header = "HTTP/1.1 200 OK\r\n"
            header += "Content-Length: \(body.count)\r\n"
            header += "Connection: close\r\n\r\n"
            connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }

    /// Window `n` starts at media sequence `n`, so the window genuinely slides.
    private func playlist() -> String {
        lock.lock()
        let index = _playlistRequests
        _playlistRequests += 1
        lock.unlock()

        var lines = [
            "#EXTM3U",
            "#EXT-X-VERSION:3",
            "#EXT-X-TARGETDURATION:\(targetDuration)",
            "#EXT-X-MEDIA-SEQUENCE:\(index)",
        ]
        for offset in 0..<windowSize {
            lines.append("#EXTINF:\(targetDuration).0,")
            lines.append("s\(index + offset).ts")
        }
        if index + 1 >= endsAfterRequests {
            lines.append("#EXT-X-ENDLIST")
        }
        return lines.joined(separator: "\n") + "\n"
    }
}

final class LiveHLSCaptureTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("ndm-live-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func makeEngine(_ url: URL) -> HLSEngine {
        HLSEngine(
            taskID: 1,
            request: DownloadRequest(
                url: url,
                destinationDirectory: root.appendingPathComponent("out", isDirectory: true),
                suggestedFilename: "live.ts"
            ),
            workDirectory: root.appendingPathComponent("work", isDirectory: true)
        )
    }

    private func merged(_ url: URL) throws -> String {
        try String(contentsOf: url, encoding: .utf8)
    }

    /// The behaviour that did not exist: following the window instead of taking one
    /// snapshot of it. Before this, a live stream produced whatever happened to be in
    /// the first window and reported success.
    func testALiveStreamIsFollowedUntilItEnds() async throws {
        let server = RollingHLSServer(windowSize: 3, endsAfterRequests: 4)
        try server.start()
        defer { server.stop() }

        let output = try await makeEngine(server.url).start()
        let text = try merged(output)

        // Windows start at 0,1,2,3 with three segments each, so s0…s5 all appear.
        for name in ["s0.ts", "s1.ts", "s2.ts", "s3.ts", "s4.ts", "s5.ts"] {
            XCTAssertTrue(text.contains("[\(name)]"), "missing \(name) from \(text)")
        }
        XCTAssertGreaterThan(
            server.playlistRequests,
            1,
            "a live playlist must be refetched, not read once"
        )
    }

    /// The sliding window means the same array index is a different segment each time;
    /// deduplicating by index would repeat content.
    func testNoSegmentIsCapturedTwice() async throws {
        let server = RollingHLSServer(windowSize: 4, endsAfterRequests: 5)
        try server.start()
        defer { server.stop() }

        let text = try merged(try await makeEngine(server.url).start())
        for name in ["s0.ts", "s1.ts", "s2.ts", "s3.ts"] {
            XCTAssertEqual(
                text.components(separatedBy: "[\(name)]").count - 1,
                1,
                "\(name) appears more than once in \(text)"
            )
        }
    }

    func testCapturedSegmentsAreInOrder() async throws {
        let server = RollingHLSServer(windowSize: 2, endsAfterRequests: 5)
        try server.start()
        defer { server.stop() }

        let text = try merged(try await makeEngine(server.url).start())
        let order = (0..<6).compactMap { text.range(of: "[s\($0).ts]")?.lowerBound }
        XCTAssertEqual(order, order.sorted(), "the recording must be chronological")
    }

    /// Stopping is how a live capture normally ends, so it must keep what it recorded
    /// rather than throwing everything away.
    func testStoppingKeepsWhatWasAlreadyCaptured() async throws {
        // Never ends on its own, so only the cancel can stop it.
        let server = RollingHLSServer(windowSize: 2, endsAfterRequests: .max)
        try server.start()
        defer { server.stop() }

        let engine = makeEngine(server.url)
        let task = Task { try await engine.start() }
        // Let it get through a couple of refreshes before stopping.
        try await Task.sleep(nanoseconds: 1_800_000_000)
        await engine.cancel()

        let output = try await task.value
        let text = try merged(output)
        XCTAssertTrue(text.contains("[s0.ts]"), "the start of the recording must survive")
        XCTAssertFalse(text.isEmpty)
    }

    /// A recording is unbounded by nature, so something has to stop it. Without a cap a
    /// forgotten capture fills the disk.
    func testASizeLimitStopsTheRecording() async throws {
        let server = RollingHLSServer(windowSize: 2, endsAfterRequests: .max)
        try server.start()
        defer { server.stop() }

        let engine = makeEngine(server.url)
        await engine.setLiveLimits(.init(maximumDuration: 3600, maximumBytes: 1))
        let text = try merged(try await engine.start())
        XCTAssertTrue(text.contains("[s0.ts]"))
        XCTAssertFalse(text.contains("[s4.ts]"), "the limit should have stopped it early")
    }

    func testATimeLimitStopsTheRecording() async throws {
        let server = RollingHLSServer(windowSize: 2, endsAfterRequests: .max)
        try server.start()
        defer { server.stop() }

        let engine = makeEngine(server.url)
        await engine.setLiveLimits(.init(maximumDuration: 0.1, maximumBytes: .max))
        let started = Date()
        _ = try await engine.start()
        XCTAssertLessThan(
            Date().timeIntervalSince(started),
            20,
            "a time-limited capture must actually stop"
        )
    }

    /// A finished playlist still behaves exactly as before — the live path must not
    /// change how ordinary HLS downloads work.
    func testAFinishedPlaylistIsStillASingleShotDownload() async throws {
        let playlist = """
        #EXTM3U
        #EXT-X-TARGETDURATION:1
        #EXTINF:1.0,
        a.ts
        #EXTINF:1.0,
        b.ts
        #EXT-X-ENDLIST
        """
        let server = LocalHLSServer(files: [
            "vod.m3u8": Data(playlist.utf8),
            "a.ts": Data("AAA".utf8),
            "b.ts": Data("BBB".utf8),
        ])
        try server.start()
        defer { server.stop() }

        let output = try await makeEngine(server.url(path: "vod.m3u8")).start()
        XCTAssertEqual(try merged(output), "AAABBB")
    }
}
