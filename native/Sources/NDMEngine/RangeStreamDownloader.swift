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

    static func download(
        request: URLRequest,
        to fileURL: URL,
        append: Bool,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken] = [],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        onBytes: @escaping @Sendable (Int64) -> Void
    ) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            let box = SessionBox(
                request: request,
                fileURL: fileURL,
                append: append,
                isCancelled: isCancelled,
                cancellationTokens: cancellationTokens,
                limiter: limiter,
                httpProxy: httpProxy,
                socksProxy: socksProxy,
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
        append: Bool,
        isCancelled: @escaping @Sendable () -> Bool,
        cancellationTokens: [CancelToken],
        limiter: BandwidthLimiter?,
        httpProxy: ProxySettings?,
        socksProxy: SocksProxySettings?,
        onBytes: @escaping @Sendable (Int64) -> Void,
        continuation: CheckedContinuation<RangeStreamDownloader.Result, Error>
    ) {
        self.request = request
        self.fileURL = fileURL
        self.append = append
        self.isCancelled = isCancelled
        self.cancellationTokens = cancellationTokens
        self.limiter = limiter
        self.httpProxy = httpProxy
        self.socksProxy = socksProxy
        self.onBytes = onBytes
        self.continuation = continuation
        super.init()
        let config = URLSessionConfiguration.ephemeral
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
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
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

        do {
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
            completionHandler(.allow)
        } catch {
            completionHandler(.cancel)
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if isCancelled() {
            dataTask.cancel()
            finish(.failure(EngineError.cancelled))
            return
        }
        limiter?.consume(data.count)
        do {
            try handle?.write(contentsOf: data)
            written += Int64(data.count)
            if written - lastReported >= 256 * 1024 {
                lastReported = written
                onBytes(written)
            }
        } catch {
            dataTask.cancel()
            finish(.failure(error))
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        try? handle?.close()
        handle = nil
        if finished { return }
        if written != lastReported {
            lastReported = written
            onBytes(written)
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
