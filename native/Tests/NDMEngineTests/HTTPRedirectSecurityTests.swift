import XCTest
import CryptoKit
@testable import NDMCore
@testable import NDMEngine

final class HTTPRedirectSecurityTests: XCTestCase {
    private let payload = Data((0..<262_144).map { UInt8($0 % 251) })
    private let privateHeaders = [
        "Cookie": "session=synthetic-fixture",
        "Authorization": "Bearer synthetic-fixture",
        "Proxy-Authorization": "Basic c3ludGhldGljOnByb3h5",
        "Referer": "https://source.invalid/private-page",
        "Origin": "https://source.invalid",
        "X-Api-Key": "synthetic-key",
        "X-Custom-Secret": "synthetic-custom-value",
    ]

    func testSameOriginRedirectPreservesCallerHeadersAndRangeIdentity() async throws {
        let server = LocalRedirectServer(payload: payload, hosts: ["127.0.0.1", "127.0.0.1"])
        try server.start(); defer { server.stop() }
        let f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
        XCTAssertEqual(digest(try Data(contentsOf: final)), digest(payload))
        let destination = server.requests.filter { $0.stage == server.finalStage }
        XCTAssertEqual(destination.map(\.method), ["HEAD", "GET"])
        for request in server.requests { assertPrivateHeadersPresent(request) }
        assertRangeIdentity(destination, validator: server.entityTag, expectedRange: "bytes=0-262143")
    }

    func testCrossOriginProbeAndFreshRangeRequestStripCallerHeadersAtEveryCrossing() async throws {
        for status in [302, 307] {
            let server = LocalRedirectServer(payload: payload, redirectStatus: status)
            try server.start(); defer { server.stop() }
            let f = try fixture(server: server)
            defer { try? FileManager.default.removeItem(at: f.root) }
            let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
            XCTAssertEqual(digest(try Data(contentsOf: final)), digest(payload))
            let source = server.requests.filter { $0.stage == 0 }
            let destination = server.requests.filter { $0.stage == server.finalStage }
            XCTAssertEqual(source.map(\.method), ["HEAD", "GET"], "Each regenerated request starts at the saved original URL")
            XCTAssertEqual(destination.map(\.method), ["HEAD", "GET"])
            for request in source { assertPrivateHeadersPresent(request) }
            for request in destination { assertOnlySafeCallerHeaders(request) }
            assertRangeIdentity(destination, validator: server.entityTag, expectedRange: "bytes=0-262143")
        }
    }

    func testReturningToOriginalOriginDoesNotRestorePrivateHeadersWithinRedirectChain() async throws {
        // IPv6 loopback supplies C without requiring a macOS IPv4 alias.
        let server = LocalRedirectServer(payload: payload,
            hosts: ["127.0.0.1", "localhost", "127.0.0.1", "[::1]"])
        try server.start(); defer { server.stop() }
        let f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
        XCTAssertEqual(digest(try Data(contentsOf: final)), digest(payload))
        for stage in server.hosts.indices {
            let hop = server.requests.filter { $0.stage == stage }
            XCTAssertEqual(hop.map(\.method), ["HEAD", "GET"], "Missing hop \(stage)")
            for request in hop {
                if stage == 0 { assertPrivateHeadersPresent(request) }
                else { assertOnlySafeCallerHeaders(request) }
            }
            assertRangeIdentity(hop, validator: server.entityTag, expectedRange: "bytes=0-262143")
        }
    }

    func testHead405BootstrapAndNoValidatorFullGetKeepRedirectBoundary() async throws {
        let server = LocalRedirectServer(payload: payload, headStatus: 405, sendsValidator: false)
        try server.start(); defer { server.stop() }
        let f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
        XCTAssertEqual(digest(try Data(contentsOf: final)), digest(payload))
        let source = server.requests.filter { $0.stage == 0 }
        let destination = server.requests.filter { $0.stage == server.finalStage }
        XCTAssertEqual(source.map(\.method), ["HEAD", "GET", "GET"])
        XCTAssertEqual(destination.map(\.method), ["HEAD", "GET", "GET"])
        XCTAssertEqual(destination.map { $0.headers["range"] }, [nil, "bytes=0-0", nil])
        for request in source { assertPrivateHeadersPresent(request) }
        for request in destination {
            assertOnlySafeCallerHeaders(request)
            XCTAssertNil(request.headers["if-range"])
        }
    }

    func testCrossOriginBodyPreservingRedirectNeverSendsPOSTToDestination() async throws {
        let server = LocalRedirectServer(payload: payload)
        try server.start(); defer { server.stop() }
        var f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        f.request.method = "POST"
        f.request.body = Data("fixture=private-body".utf8)
        f.request.headers["Content-Type"] = "application/x-www-form-urlencoded"
        do {
            _ = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
            XCTFail("A redirect cannot authorize sending a request body to another origin")
        } catch HTTPRedirectPolicy.Failure.crossOriginBody {
            XCTAssertFalse(FileManager.default.fileExists(atPath: f.output.appendingPathComponent("result.bin").path))
        } catch { XCTFail("Unexpected redirect failure: \(error)") }
        XCTAssertEqual(server.requests.map(\.stage), [0])
        let source = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(source.method, "POST")
        XCTAssertEqual(source.body, f.request.body)
        assertPrivateHeadersPresent(source)
    }

    func testSameOriginBodyPreservingRedirectRetainsMethodAndBody() async throws {
        let server = LocalRedirectServer(payload: payload, hosts: ["127.0.0.1", "127.0.0.1"])
        try server.start(); defer { server.stop() }
        var f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        f.request.method = "POST"
        f.request.body = Data("fixture=private-body".utf8)
        f.request.headers["Content-Type"] = "application/x-www-form-urlencoded"
        let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
        XCTAssertEqual(digest(try Data(contentsOf: final)), digest(payload))
        XCTAssertEqual(server.requests.map(\.stage), [0, 1])
        for request in server.requests {
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.body, f.request.body)
            assertPrivateHeadersPresent(request)
        }
    }

    func testCrossOrigin401CannotTriggerRetryWithOriginalCredentials() async throws {
        for method in ["HEAD", "GET"] {
            for challengeHeader in [true, false] {
                let server = LocalRedirectServer(payload: payload, challengeMethod: method, sendsChallengeHeader: challengeHeader)
                try server.start(); defer { server.stop() }
                var f = try fixture(server: server)
                defer { try? FileManager.default.removeItem(at: f.root) }
                f.request.username = "synthetic-user"
                f.request.password = "synthetic-password"
                do {
                    _ = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
                    XCTFail("A challenge from the redirected server cannot authorize reusing source credentials")
                } catch HTTPAuthenticationBoundary.Failure.crossOrigin {
                } catch { XCTFail("Unexpected authentication failure: \(error)") }
                let source = server.requests.filter { $0.stage == 0 }
                let destination = server.requests.filter { $0.stage == server.finalStage }
                let expectedMethods = method == "HEAD" ? ["HEAD"] : ["HEAD", "GET"]
                XCTAssertEqual(source.map(\.method), expectedMethods, "No source auth retry for a target challenge")
                XCTAssertEqual(destination.map(\.method), expectedMethods, "No retry at target with source credentials")
                for request in source { assertPrivateHeadersPresent(request) }
                for request in destination { assertOnlySafeCallerHeaders(request) }
            }
        }
    }

    func testRedirectURLWithUserInfoIsRejectedBeforeFollowingEvenOnSameOrigin() async throws {
        let server = LocalRedirectServer(payload: payload, hosts: ["127.0.0.1", "127.0.0.1"], redirectedUserInfo: true)
        try server.start(); defer { server.stop() }
        let f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        do {
            _ = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
            XCTFail("Redirect URL userinfo must not become new credentials")
        } catch HTTPRedirectPolicy.Failure.unsafeTarget {
            XCTAssertFalse(FileManager.default.fileExists(atPath: f.output.appendingPathComponent("result.bin").path))
        } catch { XCTFail("Unexpected redirect failure: \(error)") }
        XCTAssertEqual(server.requests.map(\.stage), [0], "Reject before making the redirected request or fallback probe")
        XCTAssertEqual(server.requests.first?.method, "HEAD")
    }

    func testPausedRedirectedDownloadReusesPrefixWithOriginalRequestAndRejectsDirectTargetAdoption() async throws {
        let bytes = Data((0..<1_048_576).map { UInt8($0 % 251) })
        let server = LocalRedirectServer(payload: bytes, chunkSize: 32_768, chunkDelay: 0.02)
        try server.start(); defer { server.stop() }
        let f = try fixture(server: server)
        defer { try? FileManager.default.removeItem(at: f.root) }
        let engine = DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work)
        let run = Task { try await engine.start() }
        for _ in 0..<150 {
            if await engine.currentProgress().completedBytes >= 65_536 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        await engine.pause()
        do { _ = try await run.value; XCTFail("Fixture completed before it could be paused") }
        catch EngineError.paused {} catch { XCTFail("Unexpected pause error: \(error)") }
        guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: f.work) else {
            return XCTFail("Paused redirected download did not preserve an owned partial")
        }
        let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: f.work))
        XCTAssertEqual(identity.requestFingerprint, HTTPRepresentationIdentity.fingerprint(for: f.request))
        let savedPrefix: Int64
        do {
            let saved = try OffsetDownloadStorage.recover(taskID: 1, workDirectory: f.work,
                resourceContextHash: identity.storageContextHash)
            savedPrefix = try XCTUnwrap(saved.snapshot().first?.durablePrefix)
        }
        XCTAssertGreaterThanOrEqual(savedPrefix, 65_536)
        XCTAssertLessThan(savedPrefix, Int64(bytes.count))
        let before = try Data(contentsOf: partial)
        let receipt = try Data(contentsOf: f.work.appendingPathComponent("offset-storage-v2.json"))
        let countBefore = server.requests.count
        var directTarget = f.request
        directTarget.url = server.url(at: server.finalStage)
        do {
            _ = try await DownloadEngine(taskID: 1, request: directTarget, workDirectory: f.work).start()
            XCTFail("A learned redirect destination is not the original saved request identity")
        } catch HTTPRepresentationIdentity.Failure.changed {} catch { XCTFail("Unexpected identity failure: \(error)") }
        XCTAssertEqual(server.requests.count, countBefore, "Reject changed saved URI before any network request")
        XCTAssertEqual(try Data(contentsOf: partial), before)
        XCTAssertEqual(try Data(contentsOf: f.work.appendingPathComponent("offset-storage-v2.json")), receipt)
        let final = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
        XCTAssertEqual(digest(try Data(contentsOf: final)), digest(bytes))
        let resumed = Array(server.requests.dropFirst(countBefore))
        let expectedRange = "bytes=\(savedPrefix)-\(bytes.count - 1)"
        XCTAssertEqual(resumed.filter { $0.stage == 0 }.map(\.method), ["HEAD", "GET"])
        assertRangeIdentity(resumed.filter { $0.stage == server.finalStage }, validator: server.entityTag, expectedRange: expectedRange)
        for request in resumed {
            if request.stage == 0 { assertPrivateHeadersPresent(request) }
            else { assertOnlySafeCallerHeaders(request) }
        }
    }

    func testChangedRedirectTargetRetainsPausedProgressEvenWithSameETagAndSize() async throws {
        for getOnly in [false, true] {
            let bytes = Data((0..<1_048_576).map { UInt8($0 % 251) })
            let server = LocalRedirectServer(payload: bytes, chunkSize: 32_768, chunkDelay: 0.02)
            try server.start(); defer { server.stop() }
            let f = try fixture(server: server)
            defer { try? FileManager.default.removeItem(at: f.root) }
            let partial = try await pauseWithOwnedProgress(f)
            let identity = try XCTUnwrap(HTTPRepresentationIdentity.load(in: f.work))
            XCTAssertEqual(identity.version, 2)
            XCTAssertNotNil(identity.redirectedResourceFingerprint)
            let before = try Data(contentsOf: partial)
            let receiptBefore = try canonicalJSON(f.work.appendingPathComponent("offset-storage-v2.json"))
            let identityBefore = try canonicalJSON(HTTPRepresentationIdentity.file(in: f.work))
            let countBefore = server.requests.count
            server.replaceFinalPath(with: "another-object.bin", getOnly: getOnly)
            do {
                _ = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
                XCTFail("Same size and ETag at a different redirect target cannot join saved bytes")
            } catch HTTPRepresentationIdentity.Failure.changed {
            } catch OffsetDownloadStorage.Failure.identityMismatch {
            } catch { XCTFail("Unexpected resume failure: \(error)") }
            XCTAssertEqual(try Data(contentsOf: partial), before, "Reject before any redirected response byte reaches the old sink")
            XCTAssertEqual(try canonicalJSON(f.work.appendingPathComponent("offset-storage-v2.json")), receiptBefore)
            XCTAssertEqual(try canonicalJSON(HTTPRepresentationIdentity.file(in: f.work)), identityBefore)
            XCTAssertFalse(FileManager.default.fileExists(atPath: f.output.appendingPathComponent("result.bin").path))
            let attempt = Array(server.requests.dropFirst(countBefore))
            let expected = getOnly ? ["HEAD", "GET"] : ["HEAD"]
            XCTAssertEqual(attempt.filter { $0.stage == 0 }.map(\.method), expected)
            XCTAssertEqual(attempt.filter { $0.stage == server.finalStage }.map(\.method), expected)
            for request in attempt where request.stage == server.finalStage { assertOnlySafeCallerHeaders(request) }
        }
    }

    func testVersionOneCheckpointCannotRetroactivelyBindRedirectTarget() async throws {
        for offset in [false, true] {
            let server = LocalRedirectServer(payload: payload)
            try server.start(); defer { server.stop() }
            let f = try fixture(server: server)
            defer { try? FileManager.default.removeItem(at: f.root) }
            let identity = HTTPRepresentationIdentity(request: f.request, totalBytes: Int64(payload.count),
                validator: .etag(server.entityTag))
            XCTAssertEqual(identity.version, 1)
            XCTAssertNil(identity.redirectedResourceFingerprint)
            let partial: URL
            let receipt: URL
            if offset {
                let storage = try OffsetDownloadStorage.create(taskID: 1, workDirectory: f.work,
                    destinationURL: f.output.appendingPathComponent("result.bin"), totalBytes: Int64(payload.count),
                    resourceContextHash: identity.storageContextHash,
                    ranges: [.init(id: 0, start: 0, end: Int64(payload.count - 1), durablePrefix: 0)])
                try storage.write(segmentID: 0, data: payload.prefix(131_072))
                try storage.checkpoint()
                partial = storage.partialURL
                receipt = f.work.appendingPathComponent("offset-storage-v2.json")
            } else {
                let plan = SegmentFileFormat.planEqualSegments(totalBytes: Int64(payload.count), connections: 1)
                receipt = f.work.appendingPathComponent("segments.bin")
                try SegmentFileFormat.serialize(plan).write(to: receipt)
                partial = SegmentFileFormat.segmentFileURL(id: 0, in: f.work)
                try payload.prefix(131_072).write(to: partial)
            }
            try identity.save(in: f.work)
            let before = try Data(contentsOf: partial)
            let receiptBefore = try Data(contentsOf: receipt)
            let identityBefore = try Data(contentsOf: HTTPRepresentationIdentity.file(in: f.work))
            do {
                _ = try await DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work).start()
                XCTFail("A checkpoint without a recorded final URI cannot adopt a redirect after the fact")
            } catch HTTPRepresentationIdentity.Failure.changed {
            } catch OffsetDownloadStorage.Failure.identityMismatch {
            } catch { XCTFail("Unexpected legacy redirect failure: \(error)") }
            XCTAssertEqual(try Data(contentsOf: partial), before)
            XCTAssertEqual(try Data(contentsOf: receipt), receiptBefore)
            XCTAssertEqual(try Data(contentsOf: HTTPRepresentationIdentity.file(in: f.work)), identityBefore)
            XCTAssertEqual(server.requests.map(\.method), ["HEAD", "HEAD"], "Refuse before any byte GET")
            XCTAssertFalse(FileManager.default.fileExists(atPath: f.output.appendingPathComponent("result.bin").path))
        }
    }

    func testRegeneratedDirectTargetRequestScopesAllCallerHeadersToOriginalOrigin() throws {
        let origin = URL(string: "https://origin.invalid/start")!
        var request = URLRequest(url: URL(string: "https://target.invalid/result")!)
        for (name, value) in privateHeaders { request.setValue(value, forHTTPHeaderField: name) }
        request.setValue("origin.invalid", forHTTPHeaderField: "Host")
        request.setValue("synthetic-proxy-credential", forHTTPHeaderField: "Proxy-Authorization")
        let portable = ["Accept": "application/octet-stream", "Accept-Encoding": "identity",
                        "Accept-Language": "zh-CN", "User-Agent": "Fixture Browser",
                        "Range": "bytes=100-199", "If-Range": "\"original-version\""]
        for (name, value) in portable { request.setValue(value, forHTTPHeaderField: name) }
        let scoped = try HTTPRedirectPolicy.scope(request, to: origin)
        XCTAssertEqual(scoped.url, request.url)
        XCTAssertEqual(Set((scoped.allHTTPHeaderFields ?? [:]).keys.map { $0.lowercased() }),
                       Set(portable.keys.map { $0.lowercased() }))
        for (name, value) in portable { XCTAssertEqual(scoped.value(forHTTPHeaderField: name), value) }
        XCTAssertFalse(scoped.httpShouldHandleCookies)
        // A caller rebuilding a later return to A must retain the crossing fact.
        request.url = origin
        let returned = try HTTPRedirectPolicy.scope(request, to: origin, crossedOrigin: true)
        for name in privateHeaders.keys { XCTAssertNil(returned.value(forHTTPHeaderField: name)) }
        XCTAssertEqual(returned.value(forHTTPHeaderField: "Range"), "bytes=100-199")
    }

    func testPolicyRejectsHTTPSDowngradeIncludingAfterAnHTTPToHTTPSUpgrade() throws {
        let secure = URL(string: "https://origin.invalid/start")!
        let insecure = URL(string: "http://origin.invalid/result")!
        XCTAssertThrowsError(try HTTPRedirectPolicy.scope(URLRequest(url: insecure), to: secure)) { error in
            guard case HTTPRedirectPolicy.Failure.insecureDowngrade = error else {
                return XCTFail("Unexpected policy failure: \(error)")
            }
        }
        var crossed = false
        XCTAssertThrowsError(try HTTPRedirectPolicy.redirect(URLRequest(url: insecure), from: secure,
            origin: URL(string: "http://origin.invalid/start")!, crossedOrigin: &crossed)) { error in
            guard case HTTPRedirectPolicy.Failure.insecureDowngrade = error else {
                return XCTFail("Unexpected policy failure: \(error)")
            }
        }
    }

    func testOriginScopeDistinguishesPortsWhileRecognizingDefaultPorts() throws {
        let origin = URL(string: "http://127.0.0.1:51000/start")!
        var request = URLRequest(url: URL(string: "http://127.0.0.1:51001/result")!)
        for (name, value) in privateHeaders { request.setValue(value, forHTTPHeaderField: name) }
        XCTAssertFalse(HTTPRedirectPolicy.sameOrigin(origin, request.url))
        let scoped = try HTTPRedirectPolicy.scope(request, to: origin)
        for name in privateHeaders.keys { XCTAssertNil(scoped.value(forHTTPHeaderField: name)) }
        XCTAssertTrue(HTTPRedirectPolicy.sameOrigin(URL(string: "https://origin.invalid/start"),
                                                  URL(string: "https://origin.invalid:443/result")))
        XCTAssertFalse(HTTPRedirectPolicy.sameOrigin(URL(string: "http://origin.invalid/start"),
                                                   URL(string: "https://origin.invalid/result")))
    }

    func testAuthenticatedHTTPProxyRedirectIsConfinedToSameOrigin() throws {
        let origin = URL(string: "http://origin.invalid/start")!
        var proposed = URLRequest(url: URL(string: "http://origin.invalid/next")!)
        for (name, value) in privateHeaders { proposed.setValue(value, forHTTPHeaderField: name) }
        var crossed = false
        let sameOrigin = try HTTPRedirectPolicy.redirect(proposed, from: origin, origin: origin,
            crossedOrigin: &crossed, authenticatedHTTPProxy: true)
        XCTAssertFalse(crossed)
        for (name, value) in privateHeaders { XCTAssertEqual(sameOrigin.value(forHTTPHeaderField: name), value) }
        proposed.url = URL(string: "http://target.invalid/result")!
        XCTAssertThrowsError(try HTTPRedirectPolicy.redirect(proposed, from: origin, origin: origin,
            crossedOrigin: &crossed, authenticatedHTTPProxy: true)) { error in
            guard case HTTPRedirectPolicy.Failure.authenticatedProxyRedirect = error else {
                return XCTFail("Unexpected proxy boundary failure: \(error)")
            }
        }
        crossed = false
        let withoutProxy = try HTTPRedirectPolicy.redirect(proposed, from: origin, origin: origin,
            crossedOrigin: &crossed, authenticatedHTTPProxy: false)
        XCTAssertTrue(crossed)
        XCTAssertNil(withoutProxy.value(forHTTPHeaderField: "Proxy-Authorization"))
        for name in privateHeaders.keys { XCTAssertNil(withoutProxy.value(forHTTPHeaderField: name)) }
    }

    private func pauseWithOwnedProgress(_ f: Fixture) async throws -> URL {
        let engine = DownloadEngine(taskID: 1, request: f.request, workDirectory: f.work)
        let run = Task { try await engine.start() }
        for _ in 0..<150 {
            if await engine.currentProgress().completedBytes >= 65_536 { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        await engine.pause()
        do { _ = try await run.value; XCTFail("Fixture completed before pause") }
        catch EngineError.paused {} catch { XCTFail("Unexpected pause failure: \(error)") }
        guard case let .incomplete(partial) = try OffsetDownloadStorage.inspect(taskID: 1, workDirectory: f.work) else {
            throw NSError(domain: "HTTPRedirectSecurityTests", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Paused download has no owned partial"])
        }
        return partial
    }

    private func canonicalJSON(_ path: URL) throws -> Data {
        try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: Data(contentsOf: path)), options: .sortedKeys)
    }

    private func assertPrivateHeadersPresent(_ request: LocalRedirectServer.Request,
                                            file: StaticString = #filePath, line: UInt = #line) {
        for (name, value) in privateHeaders {
            XCTAssertEqual(request.headers[name.lowercased()], value, "\(request.method) hop \(request.stage): \(name)", file: file, line: line)
        }
    }

    private func assertOnlySafeCallerHeaders(_ request: LocalRedirectServer.Request,
                                            file: StaticString = #filePath, line: UInt = #line) {
        for name in privateHeaders.keys {
            XCTAssertNil(request.headers[name.lowercased()], "\(request.method) hop \(request.stage) leaked \(name)", file: file, line: line)
        }
        XCTAssertEqual(request.headers["accept"], "application/octet-stream", file: file, line: line)
        XCTAssertEqual(request.headers["accept-language"], "zh-CN", file: file, line: line)
        XCTAssertEqual(request.headers["user-agent"], "NDM redirect fixture", file: file, line: line)
    }

    private func assertRangeIdentity(_ requests: [LocalRedirectServer.Request], validator: String, expectedRange: String,
                                     file: StaticString = #filePath, line: UInt = #line) {
        let ranges = requests.filter { $0.headers["range"] != nil }
        XCTAssertEqual(ranges.count, 1, file: file, line: line)
        XCTAssertEqual(ranges.first?.headers["range"], expectedRange, file: file, line: line)
        XCTAssertEqual(ranges.first?.headers["if-range"], validator, file: file, line: line)
    }

    private struct Fixture {
        let root: URL, work: URL, output: URL
        var request: DownloadRequest
    }

    private func fixture(server: LocalRedirectServer) throws -> Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-redirect-\(UUID())")
        let work = root.appendingPathComponent("work"), output = root.appendingPathComponent("output")
        try FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        var headers = privateHeaders
        headers["Accept"] = "application/octet-stream"
        headers["Accept-Language"] = "zh-CN"
        let request = DownloadRequest(url: server.url, headers: headers, userAgent: "NDM redirect fixture", connections: 1,
            destinationDirectory: output, suggestedFilename: "result.bin")
        return Fixture(root: root, work: work, output: output, request: request)
    }

    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
