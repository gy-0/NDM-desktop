import Foundation
import NDMCore

/// Streams an HTTP Range (or full GET) into a file with append + progress callbacks.
/// Partial `seg.xN` files remain on cancel so the engine can resume.
enum RangeStreamDownloader {
    /// In-memory route learned from validated headers. Never replaces the saved
    /// user request identity, and never survives a new probe/resume.
    struct RedirectContext: Sendable {
        let request: URLRequest
        let origin: URL
        let crossedOrigin: Bool
    }
    final class RedirectCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var value: RedirectContext?
        func store(_ context: RedirectContext) { lock.lock(); defer { lock.unlock() }; value = context }
        func snapshot() -> RedirectContext? { lock.lock(); defer { lock.unlock() }; return value }
    }

    struct Result: Sendable {
        var bytesWritten: Int64
        var httpStatus: Int
        var contentLengthHint: Int64?
        var wwwAuthenticate: String?
        var responseHeaderLatencySeconds: Double
        var response: HTTPURLResponse? = nil
    }

    /// Selected after validated response headers, before URLSession may deliver
    /// body bytes. The caller keeps the original lease and sets its owned range
    /// under that lease's lock before returning the destination.
    struct ResponseSink: Sendable {
        let fileURL: URL
        let offsetStorage: OffsetDownloadStorage?
    }

    static func retryDelay(_ value: String?, now: Date = Date()) -> TimeInterval? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let seconds = Double(trimmed), seconds.isFinite, seconds >= 0 { return seconds }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        guard let date = formatter.date(from: trimmed) else { return nil }
        return max(0, date.timeIntervalSince(now))
    }

    static func download(
        request: URLRequest,
        to fileURL: URL,
        lease: RangeTransferLease? = nil,
        offsetStorage: OffsetDownloadStorage? = nil,
        expectedValidator: HTTPRepresentationIdentity.Validator? = nil,
        expectedTotal: Int64? = nil,
        expectedResourceURL: URL? = nil,
        rejectHTMLResponse: Bool = false,
        append: Bool,
        redirectContext: RedirectContext? = nil,
        captureRedirect: RedirectCapture? = nil,
        bootstrap: Bool = false,
        onResponse: (@Sendable (HTTPURLResponse) throws -> Void)? = nil,
        prepareRangeBody: (@Sendable (HTTPURLResponse) async throws -> ResponseSink)? = nil,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken] = [],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        internalProxy: ProxySettings? = nil,
        sessionConfiguration: URLSessionConfiguration = .ephemeral,
        requestURLValidator: (@Sendable (URL) throws -> Void)? = nil,
        onBytes: @escaping @Sendable (Int64) -> Void
    ) async throws -> Result {
        try Task.checkCancellation()
        let taskCancellation = CancelToken()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let box = SessionBox(
                    request: request,
                    fileURL: fileURL,
                    lease: lease,
                    offsetStorage: offsetStorage,
                    expectedValidator: expectedValidator,
                    expectedTotal: expectedTotal,
                    expectedResourceURL: expectedResourceURL,
                    rejectHTMLResponse: rejectHTMLResponse,
                    append: append,
                    redirectContext: redirectContext,
                    captureRedirect: captureRedirect,
                    bootstrap: bootstrap,
                    onResponse: onResponse,
                    prepareRangeBody: prepareRangeBody,
                    isCancelled: { taskCancellation.isCancelled || isCancelled() },
                    cancellationTokens: cancellationTokens + [taskCancellation],
                    limiter: limiter,
                    httpProxy: httpProxy,
                    socksProxy: socksProxy,
                    internalProxy: internalProxy,
                    sessionConfiguration: sessionConfiguration,
                    requestURLValidator: requestURLValidator,
                    onBytes: onBytes,
                    continuation: continuation
                )
                box.start()
            }
        } onCancel: {
            taskCancellation.cancel()
        }
    }
}

/// Owns a one-shot URLSession + delegate for a single Range transfer.
private final class SessionBox: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private let redirectOrigin: URL?
    private let captureRedirect: RangeStreamDownloader.RedirectCapture?
    private let lease: RangeTransferLease?
    private var offsetStorage: OffsetDownloadStorage?
    private let streamLock: NSRecursiveLock
    private var ownedRangeSatisfied = false
    private var initialCompleted: Int64 = 0
    private let expectedTotal: Int64?
    private let expectedResourceURL: URL?
    private let expectedValidator: HTTPRepresentationIdentity.Validator?
    private var fileURL: URL
    private let rejectHTMLResponse: Bool
    private let append: Bool
    private let bootstrap: Bool
    private let onResponse: (@Sendable (HTTPURLResponse) throws -> Void)?
    private let prepareRangeBody: (@Sendable (HTTPURLResponse) async throws -> RangeStreamDownloader.ResponseSink)?
    private var responsePreparationTask: Task<Void, Never>?
    private var pendingResponseDisposition: ((URLSession.ResponseDisposition) -> Void)?
    private var response: HTTPURLResponse?
    private let isCancelled: @Sendable () -> Bool
    private let cancellationTokens: [CancelToken]
    private let limiter: BandwidthLimiter?
    private let httpProxy: ProxySettings?
    private let socksProxy: SocksProxySettings?
    private let internalProxy: ProxySettings?
    private let requestURLValidator: (@Sendable (URL) throws -> Void)?
    private let onBytes: @Sendable (Int64) -> Void
    private var continuation: CheckedContinuation<RangeStreamDownloader.Result, Error>?
    private var session: URLSession!
    private var dataTask: URLSessionDataTask?
    private var handle: FileHandle?
    private var written: Int64 = 0
    private var lastReported: Int64 = 0
    private var lastProgressReportTime: TimeInterval = 0
    private var status = 0
    private var contentLengthHint: Int64?
    private var expectedResponseBytes: Int64?
    private var wwwAuthenticate: String?
    private var startedAt = Date()
    private var responseHeaderLatencySeconds: Double = 0.75
    private var finished = false
    private var crossedOrigin = false
    private let finishLock = NSLock()
    private var cancellationHandlerIDs: [(CancelToken, UUID)] = []

    init(
        request: URLRequest,
        fileURL: URL,
        lease: RangeTransferLease?,
        offsetStorage: OffsetDownloadStorage?,
        expectedValidator: HTTPRepresentationIdentity.Validator?,
        expectedTotal: Int64?,
        expectedResourceURL: URL?,
        rejectHTMLResponse: Bool,
        append: Bool,
        redirectContext: RangeStreamDownloader.RedirectContext?,
        captureRedirect: RangeStreamDownloader.RedirectCapture?,
        bootstrap: Bool,
        onResponse: (@Sendable (HTTPURLResponse) throws -> Void)?,
        prepareRangeBody: (@Sendable (HTTPURLResponse) async throws -> RangeStreamDownloader.ResponseSink)?,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings?,
        socksProxy: SocksProxySettings?,
        internalProxy: ProxySettings?,
        sessionConfiguration: URLSessionConfiguration,
        requestURLValidator: (@Sendable (URL) throws -> Void)?,
        onBytes: @escaping @Sendable (Int64) -> Void,
        continuation: CheckedContinuation<RangeStreamDownloader.Result, Error>
    ) {
        self.request = request
        self.redirectOrigin = redirectContext?.origin ?? request.url
        self.crossedOrigin = redirectContext?.crossedOrigin ?? false
        self.captureRedirect = captureRedirect
        self.lease = lease
        self.offsetStorage = offsetStorage
        self.streamLock = lease?.lock ?? NSRecursiveLock()
        self.fileURL = fileURL
        self.expectedValidator = expectedValidator
        self.expectedTotal = expectedTotal
        self.expectedResourceURL = expectedResourceURL
        self.rejectHTMLResponse = rejectHTMLResponse
        self.append = append
        self.bootstrap = bootstrap
        self.onResponse = onResponse
        self.prepareRangeBody = prepareRangeBody
        self.isCancelled = isCancelled
        self.cancellationTokens = cancellationTokens
        self.limiter = limiter
        self.httpProxy = httpProxy
        self.socksProxy = socksProxy
        self.internalProxy = internalProxy
        self.requestURLValidator = requestURLValidator
        self.onBytes = onBytes
        self.continuation = continuation
        super.init()
        let config = sessionConfiguration
        HTTPRedirectPolicy.configure(config)
        config.timeoutIntervalForRequest = 60
        config.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        config.connectionProxyDictionary = Self.proxyDictionary(
            http: httpProxy,
            socks: socksProxy
        )
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    private static func proxyDictionary(
        http: ProxySettings?,
        socks: SocksProxySettings?
    ) -> [AnyHashable: Any]? {
        if let socks, socks.enabled, !socks.host.isEmpty {
            var dict: [AnyHashable: Any] = [
                kCFStreamPropertySOCKSProxyHost as String: socks.host,
                kCFStreamPropertySOCKSProxyPort as String: NSNumber(value: socks.port),
                kCFStreamPropertySOCKSVersion as String: socks.version == .v5
                    ? kCFStreamSocketSOCKSVersion5
                    : kCFStreamSocketSOCKSVersion4,
            ]
            if let username = socks.username { dict[kCFStreamPropertySOCKSUser as String] = username }
            if let password = socks.password { dict[kCFStreamPropertySOCKSPassword as String] = password }
            return dict
        }
        if let http, http.enabled, !http.host.isEmpty {
            return [
                kCFNetworkProxiesHTTPEnable as String: true,
                kCFNetworkProxiesHTTPProxy as String: http.host,
                kCFNetworkProxiesHTTPPort as String: NSNumber(value: http.port),
                kCFNetworkProxiesHTTPSEnable as String: true,
                kCFNetworkProxiesHTTPSProxy as String: http.host,
                kCFNetworkProxiesHTTPSPort as String: NSNumber(value: http.port),
            ]
        }
        return nil
    }

    func start() {
        streamLock.lock(); defer { streamLock.unlock() }
        startedAt = Date()
        do { if let url = request.url { try ProxyURLPolicy.validate(url, requiresProxy: socksProxy?.enabled == true || (internalProxy != nil && url.scheme?.lowercased() == "https")); try requestURLValidator?(url) } }
        catch { finish(.failure(error)); return }
        let task = session.dataTask(with: request)
        dataTask = task
        cancellationHandlerIDs = cancellationTokens.map { token in
            let id = token.registerCancellationHandler { [weak self] in
                self?.cancelTransfer()
            }
            return (token, id)
        }
        guard !isCancelled() else {
            finish(.failure(EngineError.cancelled))
            return
        }
        task.resume()
    }

    private func cancelTransfer() {
        dataTask?.cancel()
        guard prepareRangeBody != nil else { return }
        // Swift can invoke this hook while holding its task-status lock. Never
        // wait for the writer lock here: its owner may be resuming that task's
        // continuation and waiting for the task-status lock in turn.
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            cancelPendingPreparation()
        }
    }

    private func cancelPendingPreparation() {
        streamLock.lock(); defer { streamLock.unlock() }
        // A pending response disposition must not wait on the planner after the
        // user cancels. No body writer has been opened in this state.
        if pendingResponseDisposition != nil { finish(.failure(EngineError.cancelled)) }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest proposed: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
    ) {
        streamLock.lock(); defer { streamLock.unlock() }
        guard !finished, let origin = redirectOrigin else { completionHandler(nil); return }
        do {
            if let url = proposed.url { try ProxyURLPolicy.validate(url, requiresProxy: socksProxy?.enabled == true || (internalProxy != nil && url.scheme?.lowercased() == "https")); try requestURLValidator?(url) }
            var redirected = try HTTPRedirectPolicy.redirect(proposed, from: response.url, origin: origin,
                crossedOrigin: &crossedOrigin,
                authenticatedHTTPProxy: internalProxy == nil && httpProxy?.enabled == true && socksProxy?.enabled != true && !(httpProxy?.username ?? "").isEmpty,
                originalRequest: request)
            if let internalProxy { SOCKSHTTPBridge.authorize(&redirected, endpoint: internalProxy) }
            completionHandler(redirected)
        } catch {
            completionHandler(nil)
            finish(.failure(error))
        }
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        if let internalProxy, SOCKSHTTPBridge.matches(challenge, endpoint: internalProxy) {
            completionHandler(.useCredential, URLCredential(user: internalProxy.username!, password: internalProxy.password!, persistence: .none))
            return
        }
        // Basic/Digest authentication is handled by DownloadEngine, which reconstructs
        // the owned Range after a challenge. A transparent URLSession retry
        // would reuse the original (possibly since shortened) Range header.
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest:
            if let failure = (crossedOrigin && !challenge.protectionSpace.isProxy() ? HTTPAuthenticationBoundary.Failure.crossOrigin : nil) ?? HTTPAuthenticationBoundary.failure(for: challenge, origin: redirectOrigin, proxy: httpProxy) {
                completionHandler(.cancelAuthenticationChallenge, nil)
                finish(.failure(failure))
                return
            }
            let response = challenge.failureResponse as? HTTPURLResponse
            let status = response?.statusCode ?? (challenge.protectionSpace.isProxy() ? 407 : 401)
            let header = response?.value(forHTTPHeaderField: status == 407 ? "Proxy-Authenticate" : "WWW-Authenticate")
            completionHandler(.cancelAuthenticationChallenge, nil)
            finish(.failure(EngineError.authRequired(status: status, challenge: header)))
        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        streamLock.lock(); defer { streamLock.unlock() }
        guard !finished else { completionHandler(.cancel); return }
        responseHeaderLatencySeconds = max(
            0.001,
            Date().timeIntervalSince(startedAt)
        )
        if isCancelled() {
            completionHandler(.cancel)
            finish(.failure(EngineError.cancelled))
            return
        }
        guard let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            finish(.failure(EngineError.invalidResponse))
            return
        }
        if (200..<300).contains(http.statusCode), rejectHTMLResponse,
           HTTPFileResponsePolicy.isHTML(http.value(forHTTPHeaderField: "Content-Type")) {
            completionHandler(.cancel)
            finish(.failure(EngineError.unexpectedWebPage))
            return
        }
        status = http.statusCode
        wwwAuthenticate = http.value(forHTTPHeaderField: "WWW-Authenticate")
            ?? http.value(forHTTPHeaderField: "Proxy-Authenticate")

        if status == 401 || status == 407 {
            completionHandler(.cancel)
            if status == 401, crossedOrigin || !HTTPRedirectPolicy.sameOrigin(redirectOrigin, http.url) {
                finish(.failure(HTTPAuthenticationBoundary.Failure.crossOrigin))
                return
            }
            finish(.failure(EngineError.authRequired(status: status, challenge: wwwAuthenticate)))
            return
        }

        self.response = http
        // Metadata bootstrap must inspect 416/auth/status without saving error
        // pages. Its caller owns fallback policy; normal range workers keep theirs.
        if bootstrap, !(200..<300).contains(status) {
            completionHandler(.cancel)
            finish(.success(.init(bytesWritten: 0, httpStatus: status,
                contentLengthHint: nil, wwwAuthenticate: wwwAuthenticate,
                responseHeaderLatencySeconds: responseHeaderLatencySeconds, response: http)))
            return
        }

        if status == 429 || status == 503 {
            completionHandler(.cancel)
            finish(.failure(EngineError.temporarilyUnavailable(
                status: status,
                retryAfter: RangeStreamDownloader.retryDelay(http.value(forHTTPHeaderField: "Retry-After"))
            )))
            return
        }

        guard (200..<300).contains(status) || status == 206 else {
            completionHandler(.cancel)
            finish(.failure(EngineError.httpStatus(status)))
            return
        }

        let originalRange = Self.requestedByteRange(from: request)
        // A fresh bootstrap may adopt a server's full 200 response to bytes=0-0.
        // Resuming workers never opt into this exception.
        let requestedRange = bootstrap && status == 200 ? nil : originalRange
        if request.value(forHTTPHeaderField: "Range") != nil, originalRange == nil {
            completionHandler(.cancel)
            finish(.failure(EngineError.invalidResponse))
            return
        }
        if let requestedRange {
            // Validators are scoped to a resource URI. Equal ETags and lengths
            // on another redirect destination cannot authorize joining bytes.
            if let expectedResourceURL, http.url != expectedResourceURL {
                completionHandler(.cancel)
                finish(.failure(HTTPRepresentationIdentity.Failure.changed))
                return
            }
            // A 200 response to a Range request means the server ignored Range.
            // Appending that full body to a partial segment would silently corrupt
            // the finished file, so let the engine restart once as a clean GET.
            guard status == 206 else {
                completionHandler(.cancel)
                finish(.failure(EngineError.notResumable))
                return
            }
            if let expectedValidator, !expectedValidator.matches(http) {
                completionHandler(.cancel)
                finish(.failure(HTTPRepresentationIdentity.Failure.changed))
                return
            }
            guard HTTPFileResponsePolicy.hasIdentityEncoding(http),
                  let responseRange = HTTPFileResponsePolicy.contentRange(http.value(forHTTPHeaderField: "Content-Range")),
                  responseRange.start == requestedRange.start,
                  requestedRange.end.map({ $0 == responseRange.end }) ?? true,
                  responseRange.end >= responseRange.start else {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
            if let expectedTotal, responseRange.total != expectedTotal {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
            contentLengthHint = responseRange.total
            let expectedBytes = responseRange.length
            expectedResponseBytes = expectedBytes
            if http.expectedContentLength >= 0,
               http.expectedContentLength != expectedBytes {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
        } else {
            // A clean response must describe the whole representation. An
            // unsolicited 206 is not safe even when its body length looks right.
            guard status != 206 else {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
            if http.expectedContentLength >= 0 {
                contentLengthHint = http.expectedContentLength
                // For identity bodies this is the delivered byte count too.
                if HTTPFileResponsePolicy.hasIdentityEncoding(http) {
                    expectedResponseBytes = http.expectedContentLength
                }
            }
        }

        if let expectedTotal, expectedTotal > 0, contentLengthHint != expectedTotal {
            completionHandler(.cancel)
            finish(.failure(EngineError.invalidResponse))
            return
        }
        if status == 206, let origin = redirectOrigin, let effective = dataTask.currentRequest,
           effective.url == http.url {
            captureRedirect?.store(.init(request: effective, origin: origin, crossedOrigin: crossedOrigin))
        }
        if status == 206, let prepareRangeBody {
            // Hold the response disposition, not the delegate thread or lease
            // lock, while the engine reserves a destination and persists a plan.
            pendingResponseDisposition = completionHandler
            responsePreparationTask = Task {
                do {
                    let sink = try await prepareRangeBody(http)
                    self.finishResponsePreparation(.success(sink), response: http)
                } catch {
                    self.finishResponsePreparation(.failure(error), response: http)
                }
            }
            return
        }
        openResponseSink(http, completionHandler: completionHandler)
    }

    private func finishResponsePreparation(
        _ result: Result<RangeStreamDownloader.ResponseSink, Error>, response: HTTPURLResponse
    ) {
        streamLock.lock(); defer { streamLock.unlock() }
        guard !finished, let disposition = pendingResponseDisposition else { return }
        pendingResponseDisposition = nil
        responsePreparationTask = nil
        if isCancelled() {
            disposition(.cancel)
            finish(.failure(EngineError.cancelled))
            return
        }
        do {
            let sink = try result.get()
            // A prepared open response may own only a prefix, never bytes before
            // its request start or beyond the validated response extent.
            guard let lease, let range = Self.requestedByteRange(from: request),
                  let expectedResponseBytes,
                  lease.completed >= 0, lease.segment.start + lease.completed == range.start,
                  lease.segment.length > lease.completed,
                  lease.segment.length - lease.completed <= expectedResponseBytes else {
                throw EngineError.invalidResponse
            }
            fileURL = sink.fileURL
            offsetStorage = sink.offsetStorage
            openResponseSink(response, completionHandler: disposition)
        } catch {
            disposition(.cancel)
            finish(.failure(error))
        }
    }

    /// Called only under the writer/lease lock, after all response checks and any
    /// asynchronous ownership preparation have completed.
    private func openResponseSink(
        _ http: HTTPURLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        do {
            try onResponse?(http)
            if let offsetStorage {
                // Lock order is lease -> backend. Validation precedes selecting any
                // writable sink, so ignored/mismatched Range responses cannot mutate it.
                guard let lease,
                      let range = offsetStorage.snapshot().first(where: { $0.id == lease.segment.segmentId }),
                      range.start == lease.segment.start, range.end == lease.segment.end,
                      let prefix = offsetStorage.writtenPrefix(segmentID: range.id),
                      prefix >= 0, prefix < range.length,
                      let requested = Self.requestedByteRange(from: request),
                      requested.start == range.start + prefix,
                      requested.end.map({ $0 >= range.end }) ?? true else {
                    throw EngineError.invalidResponse
                }
                initialCompleted = prefix
            } else {
                // Bootstrap already registered this inode in its ownership receipt.
                if (!append && !bootstrap) || !FileManager.default.fileExists(atPath: fileURL.path) {
                    FileManager.default.createFile(atPath: fileURL.path, contents: nil)
                }
                handle = try FileHandle(forWritingTo: fileURL)
                if append {
                    try handle?.seekToEnd()
                } else {
                    try handle?.truncate(atOffset: 0)
                    try handle?.seek(toOffset: 0)
                }
                initialCompleted = Int64(try handle?.offset() ?? 0)
            }
            lease?.completed = initialCompleted
            lease?.resetTransferSample()
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        streamLock.lock()
        if !finished, !ownedRangeSatisfied, let expectedResponseBytes,
           Int64(data.count) > expectedResponseBytes - written {
            dataTask.cancel()
            finish(.failure(EngineError.invalidResponse))
            streamLock.unlock()
            return
        }
        streamLock.unlock()
        var cursor = data.startIndex
        while cursor < data.endIndex {
            // URLSession may deliver megabytes at once. Admit bounded prefixes so
            // throttled transfers keep writing/reporting instead of waiting for an
            // entire callback's quota and discarding it when the user pauses.
            streamLock.lock()
            guard !finished && !ownedRangeSatisfied else { streamLock.unlock(); return }
            let remaining = lease.map { max(0, $0.segment.length - initialCompleted - written) }
            let proposed = min(data.endIndex - cursor, 64 * 1024)
            let quotaCount = remaining.map { min(proposed, Int($0)) } ?? proposed
            streamLock.unlock()

            // Never hold the ownership lock while waiting: the planner can shorten
            // a donor's range, and the next write must recheck that latest boundary.
            if isCancelled() || limiter?.consume(quotaCount, isCancelled: isCancelled) == false {
                dataTask.cancel()
                finish(.failure(EngineError.cancelled))
                return
            }
            streamLock.lock(); defer { streamLock.unlock() }
            guard !finished && !ownedRangeSatisfied else { return }
            if isCancelled() {
                dataTask.cancel()
                finish(.failure(EngineError.cancelled))
                return
            }
            do {
                let remaining = lease.map { max(0, $0.segment.length - initialCompleted - written) }
                let count = remaining.map { min(quotaCount, Int($0)) } ?? quotaCount
                if count > 0 {
                    let prefix = data[cursor..<(cursor + count)]
                    if let offsetStorage, let lease {
                        // pwrite can save only a prefix before throwing (e.g. ENOSPC).
                        // Reconcile progress under the lease even on that failure.
                        defer {
                            if let prefix = offsetStorage.writtenPrefix(segmentID: lease.segment.segmentId) {
                                written = prefix - initialCompleted
                                lease.completed = prefix
                            }
                        }
                        try offsetStorage.write(segmentID: lease.segment.segmentId, data: Data(prefix))
                    } else {
                        guard let handle else { throw EngineError.invalidResponse }
                        try handle.write(contentsOf: prefix)
                        written += Int64(count)
                    }
                    lease?.completed = initialCompleted + written
                    lease?.recordTransferSample()
                    cursor += count
                }
                let now = ProcessInfo.processInfo.systemUptime
                if written > lastReported && (lastReported == 0 || written / (256 * 1024) > lastReported / (256 * 1024)
                    || now - lastProgressReportTime >= 0.1) {
                    lastProgressReportTime = now
                    lastReported = written
                    onBytes(written)
                }
                if let lease, initialCompleted + written == lease.segment.length,
                   let expectedResponseBytes, written < expectedResponseBytes {
                    ownedRangeSatisfied = true
                    try handle?.close()
                    handle = nil
                    dataTask.cancel()
                }
                if count == 0 || ownedRangeSatisfied { return }
            } catch {
                dataTask.cancel()
                finish(.failure(error))
                return
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        streamLock.lock(); defer { streamLock.unlock() }
        try? handle?.close()
        handle = nil
        if finished { return }
        if written != lastReported {
            lastReported = written
            onBytes(written)
        }
        if ownedRangeSatisfied && !isCancelled()
            && (error == nil || (error as NSError?)?.code == NSURLErrorCancelled) {
            finish(.success(RangeStreamDownloader.Result(bytesWritten: written, httpStatus: status, contentLengthHint: contentLengthHint, wwwAuthenticate: wwwAuthenticate, responseHeaderLatencySeconds: responseHeaderLatencySeconds, response: response)))
            return
        }
        if let error {
            if isCancelled() || (error as NSError).code == NSURLErrorCancelled {
                // 401 path already finished via authRequired in didReceive response
                finish(.failure(EngineError.cancelled))
            } else {
                finish(.failure(error))
            }
            return
        }
        if let expectedResponseBytes, written != expectedResponseBytes {
            finish(.failure(EngineError.incompleteResponse(expected: expectedResponseBytes, received: written)))
            return
        }
        finish(.success(RangeStreamDownloader.Result(
            bytesWritten: written,
            httpStatus: status,
            contentLengthHint: contentLengthHint,
            wwwAuthenticate: wwwAuthenticate,
            responseHeaderLatencySeconds: responseHeaderLatencySeconds, response: response
        )))
    }

    private func finish(_ result: Result<RangeStreamDownloader.Result, Error>) {
        streamLock.lock(); defer { streamLock.unlock() }
        finishLock.lock()
        guard !finished else {
            finishLock.unlock()
            return
        }
        finished = true
        let disposition = pendingResponseDisposition
        pendingResponseDisposition = nil
        responsePreparationTask?.cancel()
        responsePreparationTask = nil
        let continuation = self.continuation
        self.continuation = nil
        let registrations = cancellationHandlerIDs
        cancellationHandlerIDs.removeAll()
        finishLock.unlock()

        disposition?(.cancel)

        for (token, id) in registrations {
            token.removeCancellationHandler(id)
        }
        // Replanning must not inspect/truncate a segment until its writer is closed.
        // `finish` can be reached from didReceive(data:) before didCompleteWithError.
        try? handle?.close()
        handle = nil
        if written != lastReported {
            lastReported = written
            onBytes(written)
        }
        session.invalidateAndCancel()
        continuation?.resume(with: result)
    }

    private static func requestedByteRange(from request: URLRequest) -> (start: Int64, end: Int64?)? {
        guard let value = request.value(forHTTPHeaderField: "Range")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              value.lowercased().hasPrefix("bytes=") else {
            return nil
        }
        let bounds = String(value.dropFirst("bytes=".count))
            .split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard bounds.count == 2,
              let start = Int64(bounds[0]), start >= 0 else {
            return nil
        }
        if bounds[1].isEmpty { return (start, nil) }
        guard let end = Int64(bounds[1]), end >= start else { return nil }
        return (start, end)
    }
}
