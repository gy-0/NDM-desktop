import Foundation
import NDMCore

/// Streams an HTTP Range (or full GET) into a file with append + progress callbacks.
/// Partial `seg.xN` files remain on cancel so the engine can resume.
enum RangeStreamDownloader {
    struct Result: Sendable {
        var bytesWritten: Int64
        var httpStatus: Int
        var contentLengthHint: Int64?
        var wwwAuthenticate: String?
        var responseHeaderLatencySeconds: Double
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
        append: Bool,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken] = [],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        sessionConfiguration: URLSessionConfiguration = .ephemeral,
        onBytes: @escaping @Sendable (Int64) -> Void
    ) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            let box = SessionBox(
                request: request,
                fileURL: fileURL,
                lease: lease,
                offsetStorage: offsetStorage,
                expectedValidator: expectedValidator,
                expectedTotal: expectedTotal,
                append: append,
                isCancelled: isCancelled,
                cancellationTokens: cancellationTokens,
                limiter: limiter,
                httpProxy: httpProxy,
                socksProxy: socksProxy,
                sessionConfiguration: sessionConfiguration,
                onBytes: onBytes,
                continuation: continuation
            )
            box.start()
        }
    }
}

/// Owns a one-shot URLSession + delegate for a single Range transfer.
private final class SessionBox: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private let lease: RangeTransferLease?
    private let offsetStorage: OffsetDownloadStorage?
    private let streamLock: NSRecursiveLock
    private var ownedRangeSatisfied = false
    private var initialCompleted: Int64 = 0
    private let expectedTotal: Int64?
    private let expectedValidator: HTTPRepresentationIdentity.Validator?
    private let fileURL: URL
    private let append: Bool
    private let isCancelled: @Sendable () -> Bool
    private let cancellationTokens: [CancelToken]
    private let limiter: BandwidthLimiter?
    private let httpProxy: ProxySettings?
    private let socksProxy: SocksProxySettings?
    private let onBytes: @Sendable (Int64) -> Void
    private var continuation: CheckedContinuation<RangeStreamDownloader.Result, Error>?
    private var session: URLSession!
    private var dataTask: URLSessionDataTask?
    private var handle: FileHandle?
    private var written: Int64 = 0
    private var lastReported: Int64 = 0
    private var status = 0
    private var contentLengthHint: Int64?
    private var expectedResponseBytes: Int64?
    private var wwwAuthenticate: String?
    private var startedAt = Date()
    private var responseHeaderLatencySeconds: Double = 0.75
    private var finished = false
    private let finishLock = NSLock()
    private var cancellationHandlerIDs: [(CancelToken, UUID)] = []

    init(
        request: URLRequest,
        fileURL: URL,
        lease: RangeTransferLease?,
        offsetStorage: OffsetDownloadStorage?,
        expectedValidator: HTTPRepresentationIdentity.Validator?,
        expectedTotal: Int64?,
        append: Bool,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings?,
        socksProxy: SocksProxySettings?,
        sessionConfiguration: URLSessionConfiguration,
        onBytes: @escaping @Sendable (Int64) -> Void,
        continuation: CheckedContinuation<RangeStreamDownloader.Result, Error>
    ) {
        self.request = request
        self.lease = lease
        self.offsetStorage = offsetStorage
        self.streamLock = lease?.lock ?? NSRecursiveLock()
        self.fileURL = fileURL
        self.expectedValidator = expectedValidator
        self.expectedTotal = expectedTotal
        self.append = append
        self.isCancelled = isCancelled
        self.cancellationTokens = cancellationTokens
        self.limiter = limiter
        self.httpProxy = httpProxy
        self.socksProxy = socksProxy
        self.onBytes = onBytes
        self.continuation = continuation
        super.init()
        let config = sessionConfiguration
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
        let task = session.dataTask(with: request)
        dataTask = task
        cancellationHandlerIDs = cancellationTokens.map { token in
            let id = token.registerCancellationHandler { [weak self] in
                self?.dataTask?.cancel()
            }
            return (token, id)
        }
        guard !isCancelled() else {
            finish(.failure(EngineError.cancelled))
            return
        }
        task.resume()
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        // Basic/Digest authentication is handled by DownloadEngine, which reconstructs
        // the owned Range after a challenge. A transparent URLSession retry
        // would reuse the original (possibly since shortened) Range header.
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest:
            if let failure = HTTPAuthenticationBoundary.failure(for: challenge, origin: request.url, proxy: httpProxy) {
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
        status = http.statusCode
        wwwAuthenticate = http.value(forHTTPHeaderField: "WWW-Authenticate")
            ?? http.value(forHTTPHeaderField: "Proxy-Authenticate")

        if status == 401 || status == 407 {
            completionHandler(.cancel)
            finish(.failure(EngineError.authRequired(status: status, challenge: wwwAuthenticate)))
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

        if let requestedRange = Self.requestedByteRange(from: request) {
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
            guard let responseRange = Self.contentRange(from: http),
                  responseRange.start == requestedRange.start,
                  requestedRange.end.map({ $0 == responseRange.end }) ?? true,
                  responseRange.end >= responseRange.start else {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
            let expectedBytes = responseRange.end - responseRange.start + 1
            expectedResponseBytes = expectedBytes
            if http.expectedContentLength > 0,
               http.expectedContentLength != expectedBytes {
                completionHandler(.cancel)
                finish(.failure(EngineError.invalidResponse))
                return
            }
        }
        if let cr = http.value(forHTTPHeaderField: "Content-Range"),
           let total = cr.split(separator: "/").last,
           let n = Int64(total), n > 0 {
            contentLengthHint = n
        } else if http.expectedContentLength > 0 {
            contentLengthHint = http.expectedContentLength
        }

        if let expectedTotal, expectedTotal > 0, contentLengthHint != expectedTotal {
            completionHandler(.cancel)
            finish(.failure(EngineError.invalidResponse))
            return
        }
        do {
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
                if !append || !FileManager.default.fileExists(atPath: fileURL.path) {
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
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
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
                    cursor += count
                }
                if written - lastReported >= 256 * 1024 {
                    lastReported = written
                    onBytes(written)
                }
                if let lease, initialCompleted + written == lease.segment.length,
                   let originalEnd = Self.requestedByteRange(from: request)?.end,
                   lease.segment.end < originalEnd {
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
            finish(.success(RangeStreamDownloader.Result(bytesWritten: written, httpStatus: status, contentLengthHint: contentLengthHint, wwwAuthenticate: wwwAuthenticate, responseHeaderLatencySeconds: responseHeaderLatencySeconds)))
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
            finish(.failure(EngineError.invalidResponse))
            return
        }
        finish(.success(RangeStreamDownloader.Result(
            bytesWritten: written,
            httpStatus: status,
            contentLengthHint: contentLengthHint,
            wwwAuthenticate: wwwAuthenticate,
            responseHeaderLatencySeconds: responseHeaderLatencySeconds
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
        let continuation = self.continuation
        self.continuation = nil
        let registrations = cancellationHandlerIDs
        cancellationHandlerIDs.removeAll()
        finishLock.unlock()

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

    private static func contentRange(from response: HTTPURLResponse) -> (start: Int64, end: Int64)? {
        guard let value = response.value(forHTTPHeaderField: "Content-Range")?
            .trimmingCharacters(in: .whitespacesAndNewlines),
              value.lowercased().hasPrefix("bytes ") else {
            return nil
        }
        let rangeAndTotal = value.dropFirst("bytes ".count)
            .split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard let boundsText = rangeAndTotal.first else { return nil }
        let bounds = boundsText.split(
            separator: "-",
            maxSplits: 1,
            omittingEmptySubsequences: false
        )
        guard bounds.count == 2,
              let start = Int64(bounds[0]),
              let end = Int64(bounds[1]),
              start >= 0, end >= start else {
            return nil
        }
        return (start, end)
    }
}
