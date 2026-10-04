import Foundation

/// One response, two rendezvous: headers release startup; the persisted segment
/// plan releases the body. Completion/error also releases either suspended side.
actor BootstrapRangeHandoff {
    enum Discovery: @unchecked Sendable {
        case response(HTTPURLResponse)
        case finished(URL, URLResponse)
    }
    private var discovery: Result<Discovery, Error>?
    private var discoveryWaiter: CheckedContinuation<Discovery, Error>?
    private var sink: Result<RangeStreamDownloader.ResponseSink, Error>?
    private var sinkWaiter: CheckedContinuation<RangeStreamDownloader.ResponseSink, Error>?

    func waitForDiscovery() async throws -> Discovery {
        if let discovery { return try discovery.get() }
        return try await withCheckedThrowingContinuation { discoveryWaiter = $0 }
    }

    func prepare(_ response: HTTPURLResponse) async throws -> RangeStreamDownloader.ResponseSink {
        resolveDiscovery(.success(.response(response)))
        if let sink { return try sink.get() }
        return try await withCheckedThrowingContinuation { sinkWaiter = $0 }
    }

    func bind(_ value: RangeStreamDownloader.ResponseSink) {
        guard sink == nil else { return }
        sink = .success(value)
        sinkWaiter?.resume(returning: value); sinkWaiter = nil
    }

    func complete(_ result: Result<(URL, URLResponse), Error>) {
        resolveDiscovery(result.map { .finished($0.0, $0.1) })
        if case let .failure(error) = result, sink == nil {
            sink = .failure(error)
            sinkWaiter?.resume(throwing: error); sinkWaiter = nil
        }
    }

    private func resolveDiscovery(_ value: Result<Discovery, Error>) {
        guard discovery == nil else { return }
        discovery = value
        discoveryWaiter?.resume(with: value); discoveryWaiter = nil
    }
}
