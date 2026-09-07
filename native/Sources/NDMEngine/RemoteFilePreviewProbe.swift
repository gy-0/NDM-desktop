import Foundation
import NDMCore

/// Lightweight metadata used by the New Download preview for ordinary files.
/// The probe only reads response headers; it never consumes the file payload.
public struct RemoteFilePreview: Sendable, Equatable {
    public let resolvedURL: URL
    public let filename: String
    public let mimeType: String?
    public let contentLength: Int64?
    public let acceptsByteRanges: Bool

    public init(
        resolvedURL: URL,
        filename: String,
        mimeType: String?,
        contentLength: Int64?,
        acceptsByteRanges: Bool
    ) {
        self.resolvedURL = resolvedURL
        self.filename = filename
        self.mimeType = mimeType
        self.contentLength = contentLength
        self.acceptsByteRanges = acceptsByteRanges
    }
}

public enum RemoteFilePreviewProbeError: LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server did not return an HTTP response."
        case .httpStatus(let status):
            return "The server returned HTTP \(status)."
        }
    }
}

/// Best-effort HEAD with a header-only Range fallback for servers that reject
/// HEAD. The fallback cancels as soon as headers arrive, so a server ignoring
/// `Range: bytes=0-0` cannot accidentally turn preview into a full download.
public enum RemoteFilePreviewProbe {
    typealias HeaderLoader = @Sendable (URLRequest) async throws -> HTTPURLResponse

    public static func probe(
        url: URL,
        timeout: TimeInterval = 12
    ) async throws -> RemoteFilePreview {
        try await probe(url: url) { request in
            try await HeaderOnlyRequest.response(for: request, timeout: timeout)
        }
    }

    static func probe(
        url: URL,
        loadingHeadersWith loader: @escaping HeaderLoader
    ) async throws -> RemoteFilePreview {
        var head = URLRequest(url: url)
        head.httpMethod = "HEAD"
        prepare(&head)

        if let response = try? await loader(head),
           (200..<400).contains(response.statusCode) {
            return preview(from: response, requestedURL: url, rangeFallback: false)
        }

        var range = URLRequest(url: url)
        range.httpMethod = "GET"
        range.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        prepare(&range)
        let response = try await loader(range)
        guard (200..<400).contains(response.statusCode) else {
            throw RemoteFilePreviewProbeError.httpStatus(response.statusCode)
        }
        return preview(from: response, requestedURL: url, rangeFallback: true)
    }

    private static func prepare(_ request: inout URLRequest) {
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    }

    private static func preview(
        from response: HTTPURLResponse,
        requestedURL: URL,
        rangeFallback: Bool
    ) -> RemoteFilePreview {
        let resolvedURL = response.url ?? requestedURL
        let rawMIME = response.value(forHTTPHeaderField: "Content-Type")
        let mimeType = rawMIME?
            .split(separator: ";", maxSplits: 1)
            .first
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }

        let contentRange = response.value(forHTTPHeaderField: "Content-Range")
        let rangeTotal = contentRange?
            .split(separator: "/", maxSplits: 1)
            .last
            .flatMap { Int64($0) }
        let headerLength = response.value(forHTTPHeaderField: "Content-Length")
            .flatMap(Int64.init)
        let contentLength: Int64?
        if let rangeTotal, rangeTotal > 0 {
            contentLength = rangeTotal
        } else if let headerLength, headerLength > 0,
                  !rangeFallback || response.statusCode == 200 {
            contentLength = headerLength
        } else {
            contentLength = nil
        }

        let advertisedRanges = response
            .value(forHTTPHeaderField: "Accept-Ranges")?
            .lowercased()
            .contains("bytes") == true
        let acceptsByteRanges = response.statusCode == 206 || advertisedRanges
        let filename = DownloadFilename.resolve(
            contentDispositionName: response.suggestedFilename,
            url: resolvedURL,
            mimeType: mimeType
        )

        return RemoteFilePreview(
            resolvedURL: resolvedURL,
            filename: filename,
            mimeType: mimeType,
            contentLength: contentLength,
            acceptsByteRanges: acceptsByteRanges
        )
    }
}

private final class HeaderOnlyRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<HTTPURLResponse, Error>?
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var didFinish = false

    static func response(
        for request: URLRequest,
        timeout: TimeInterval
    ) async throws -> HTTPURLResponse {
        let loader = HeaderOnlyRequest()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                loader.start(request: request, timeout: timeout, continuation: continuation)
            }
        }, onCancel: {
            loader.cancel()
        })
    }

    private func start(
        request: URLRequest,
        timeout: TimeInterval,
        continuation: CheckedContinuation<HTTPURLResponse, Error>
    ) {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        configuration.urlCache = nil
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request)
        self.session = session
        self.task = task
        lock.unlock()
        task.resume()
    }

    private func finish(_ result: Result<HTTPURLResponse, Error>) {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        let continuation = self.continuation
        self.continuation = nil
        let session = self.session
        self.session = nil
        self.task = nil
        lock.unlock()
        continuation?.resume(with: result)
        session?.invalidateAndCancel()
    }

    private func cancel() {
        lock.lock()
        if didFinish {
            lock.unlock()
            return
        }
        let task = self.task
        lock.unlock()
        task?.cancel()
        finish(.failure(CancellationError()))
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        completionHandler(.cancel)
        guard let http = response as? HTTPURLResponse else {
            finish(.failure(RemoteFilePreviewProbeError.invalidResponse))
            return
        }
        finish(.success(http))
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            finish(.failure(error))
        } else {
            finish(.failure(RemoteFilePreviewProbeError.invalidResponse))
        }
    }
}
