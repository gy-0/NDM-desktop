import Foundation
import Darwin
import NDMCore

/// Multi-connection HTTP(S) download engine.
///
/// State path: Unknown → Starting → Downloading → Merging → Completed.
/// Resume: reload `segments.bin` + partial `seg.xN` files.
public actor DownloadEngine {
    public private(set) var progress: DownloadProgress
    public private(set) var engineState: EngineState = .unknown

    private var offsetStorage: OffsetDownloadStorage?
    private var offsetCheckpointFailure: Error?
    private var lastOffsetCheckpoint = ProcessInfo.processInfo.systemUptime
    private var representation: HTTPRepresentationIdentity?
    private var provenanceEnabled = false
    private var provenancePlan: [SegmentRecord] = []
    private var provenanceState = TailSplitProvenance.State(origins: [:], rebalanceDisabled: false)
    private let mergeWriteObserver: (@Sendable (Int64) -> Void)?
    private let request: DownloadRequest
    private let taskID: Int64
    private let workDirectory: URL
    private let capacityProvider: @Sendable (URL) -> Int64?
    private let sameVolumeProvider: @Sendable (URL, URL) -> Bool
    private var session: URLSession
    private var activeProbeTask: Task<(Data, URLResponse), Error>?
    private var activeBootstrapTask: Task<(URL, URLResponse), Error>?
    private var bootstrapReceipt: MergeStagingReceipt?
    private let probeAuthentication: ProbeAuthenticationDelegate
    private let token = CancelToken()
    private var logHandle: FileHandle?
    /// Per-segment completed bytes (for live aggregate progress).
    private var segmentCompleted: [Int16: Int64] = [:]
    private var speedWindowStart = Date()
    private var speedWindowBytes: Int64 = 0
    private var lastSpeedSample: Int64 = 0
    private let limiter: BandwidthLimiter
    /// Extra Authorization header after Digest / NTLM negotiate.
    private var originAuthentication = RequestAuthentication()
    private var proxyAuthentication = RequestAuthentication()
    private let httpProxyCredentials: ProxySettings?
    private let socksProxySettings: SocksProxySettings?
    /// Mutable runtime equivalent of MaxAllowedConnection.
    private var currentConnections: Int
    /// Cancels only the active transfer round; pause/cancel continue to use `token`.
    private var activePlanToken: CancelToken?
    private var planGeneration: UInt64 = 0
    /// Smart connection tuning: probe upward from a low count, stop honestly.
    private let autoTune: Bool
    private let tuneConfig: AutoTuneConfig
    /// The user's configured max — tuning never exceeds it.
    private let connectionCap: Int
    private var tuneTask: Task<Void, Never>?
    private var tuneAborted = false
    private var serverRefusedWorkers = false
    private var activeRangeRequests = 0
    private var serverConnectionLimit: Int?
    private var nextAdmissionRecovery: TimeInterval = 0
    private var firstBodyTransportRetries = 0
    private var firstBodySegmentID: Int16?
    /// Recent request-to-response-header samples approximate the TCP/TLS/proxy
    /// setup cost that a speculative tail worker must earn back.
    private var connectionSetupSamples: [Double] = []

    private enum ReplanSignal: Error {
        case requested
    }

    private struct SegmentRoundFailure: Error, @unchecked Sendable {
        let segmentID: Int16
        let underlying: Error
    }

    private final class RoundFailureBox: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: SegmentRoundFailure?

        func record(segmentID: Int16, error: Error) {
            lock.lock()
            if stored == nil {
                stored = SegmentRoundFailure(
                    segmentID: segmentID,
                    underlying: error
                )
            }
            lock.unlock()
        }

        var failure: SegmentRoundFailure? {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
    }

    public enum EngineState: String, Sendable {
        case unknown = "Unknown"
        case starting = "Starting..."
        case downloading = "Downloading..."
        case merging = "Merging..."
        case completed = "Completed"
        case paused = "Paused"
        case error = "Error"
    }

    public init(
        taskID: Int64,
        request: DownloadRequest,
        workDirectory: URL,
        httpProxy: ProxySettings? = nil,
        socksProxy: SocksProxySettings? = nil,
        globalBandwidthLimit: Int64 = 0,
        autoTuneConnections: Bool = false,
        tuneConfig: AutoTuneConfig = .default,
        capacityProvider: @escaping @Sendable (URL) -> Int64? = {
            VolumeCapacity.availableBytes(at: $0)
        },
        sameVolumeProvider: @escaping @Sendable (URL, URL) -> Bool = {
            VolumeCapacity.areOnSameVolume($0, $1)
        },
        mergeWriteObserver: (@Sendable (Int64) -> Void)? = nil
    ) {
        self.mergeWriteObserver = mergeWriteObserver
        self.taskID = taskID
        self.request = request
        self.workDirectory = workDirectory
        self.capacityProvider = capacityProvider
        self.sameVolumeProvider = sameVolumeProvider
        self.httpProxyCredentials = httpProxy
        self.socksProxySettings = socksProxy
        self.autoTune = autoTuneConnections
        self.tuneConfig = tuneConfig
        self.connectionCap = max(1, min(request.connections, 32))
        self.currentConnections = max(1, min(request.connections, 32))
        let perTask = request.bandwidthLimitBytesPerSecond
        let limit = perTask > 0 ? perTask : globalBandwidthLimit
        self.progress = DownloadProgress(
            taskID: taskID,
            status: .waiting,
            currentConnections: self.currentConnections,
            effectiveBandwidthLimitBytesPerSecond: limit
        )
        self.limiter = BandwidthLimiter(bytesPerSecond: limit)
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.httpMaximumConnectionsPerHost = max(1, request.connections)
        config.httpAdditionalHeaders = ["Accept-Encoding": "identity"]
        config.connectionProxyDictionary = Self.proxyDictionary(http: httpProxy, socks: socksProxy)
        let authenticationDelegate = ProbeAuthenticationDelegate(origin: request.url, proxy: httpProxy)
        self.probeAuthentication = authenticationDelegate
        self.session = URLSession(configuration: config, delegate: authenticationDelegate, delegateQueue: nil)
    }

    /// URL without userinfo so URLSession won't auto-handle 401 with embedded credentials.
    private var cleanURL: URL {
        guard var comps = URLComponents(url: request.url, resolvingAgainstBaseURL: false) else {
            return request.url
        }
        comps.user = nil
        comps.password = nil
        return comps.url ?? request.url
    }

    private static func proxyDictionary(
        http: ProxySettings?,
        socks: SocksProxySettings?
    ) -> [AnyHashable: Any]? {
        if let socks, socks.enabled, !socks.host.isEmpty {
            var dict: [AnyHashable: Any] = [
                kCFStreamPropertySOCKSProxyHost as String: socks.host,
                kCFStreamPropertySOCKSProxyPort as String: NSNumber(value: socks.port),
            ]
            if socks.version == .v5 {
                dict[kCFStreamPropertySOCKSVersion as String] = kCFStreamSocketSOCKSVersion5
            } else {
                dict[kCFStreamPropertySOCKSVersion as String] = kCFStreamSocketSOCKSVersion4
            }
            if let u = socks.username { dict[kCFStreamPropertySOCKSUser as String] = u }
            if let p = socks.password { dict[kCFStreamPropertySOCKSPassword as String] = p }
            return dict
        }
        if let proxy = http, proxy.enabled, !proxy.host.isEmpty {
            return [
                kCFNetworkProxiesHTTPEnable as String: true,
                kCFNetworkProxiesHTTPProxy as String: proxy.host,
                kCFNetworkProxiesHTTPPort as String: NSNumber(value: proxy.port),
                kCFNetworkProxiesHTTPSEnable as String: true,
                kCFNetworkProxiesHTTPSProxy as String: proxy.host,
                kCFNetworkProxiesHTTPSPort as String: NSNumber(value: proxy.port),
            ]
        }
        return nil
    }

    // Can interrupt the synchronous copy loop before actor-isolated pause()
    // gets its turn. CancelToken synchronizes its cross-thread state.
    nonisolated func requestPause() { token.pause() }

    public func pause() {
        token.pause()
        // Probe requests have their own session, outside Range cancellation.
        activeProbeTask?.cancel()
        activeBootstrapTask?.cancel()
        engineState = .paused
        progress.status = .paused
        tuneTask?.cancel()
        log("DownloadEngine State Changed : Downloading... -> Paused")
    }

    public func cancel() {
        token.cancel()
        activeProbeTask?.cancel()
        activeBootstrapTask?.cancel()
        progress.status = .incomplete
        tuneTask?.cancel()
        log("Download Canceled By User.")
    }

    @discardableResult
    public func start() async throws -> URL {
        firstBodyTransportRetries = 0
        guard !Task.isCancelled else { throw EngineError.cancelled }
        // Manager creates a fresh engine for resume. A pause delivered before
        // this actor starts must not be erased by startup initialization.
        try throwIfStopped()
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        try MergeStagingReceipt.recover(taskID: taskID, in: workDirectory)
        let offsetInspection = try OffsetDownloadStorage.inspect(taskID: taskID, workDirectory: workDirectory)
        if case let .published(final) = offsetInspection {
            try OffsetDownloadStorage.renamePublished(taskID: taskID, workDirectory: workDirectory, to: final)
            let size = (try final.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0
            progress.totalBytes = Int64(size); progress.completedBytes = Int64(size)
            progress.status = .complete; setState(.completed)
            return final
        }
        if case .cleanupPending = offsetInspection { throw OffsetDownloadStorage.Failure.incomplete }
        if case .partialMissing = offsetInspection { throw OffsetDownloadStorage.Failure.identityMismatch }
        let hasOffsetReceipt: Bool
        if case .incomplete = offsetInspection { hasOffsetReceipt = true } else { hasOffsetReceipt = false }
        let names = try FileManager.default.contentsOfDirectory(atPath: workDirectory.path)
        let hasLegacyArtifacts = names.contains { $0 == "segments.bin" || $0.hasPrefix("seg.x") }
        openLog()
        defer { closeLog() }
        setState(.starting)
        log("DownloadID = \(taskID) , Protocol = HTTPS , OS = MAC , AppVersion = MacOpenRE")
        log("DownloadEngine is Starting...")
        log("Trying to Start Download for -> \(request.url.absoluteString)")

        let probe = try await probeRemoteWithAuth()
        defer { try? finishBootstrap() }
        try throwIfStopped()
        try Task.checkCancellation()
        let total = probe.contentLength ?? 0
        progress.totalBytes = total
        progress.status = .downloading

        representation = probe.validator.map { HTTPRepresentationIdentity(request: request, totalBytes: total, validator: $0) }
        let acceptRanges = probe.acceptRanges && total > 0 && representation != nil
        provenanceEnabled = acceptRanges
        if probe.acceptRanges && representation == nil {
            log("No strong representation validator; downloading one clean stream instead of joining unverifiable ranges.")
        }

        let filename = DownloadFilename.resolve(
            preferred: request.suggestedFilename,
            contentDispositionName: probe.suggestedFilename,
            url: request.url,
            mimeType: probe.mimeType ?? request.headers["Content-Type"],
            pageTitle: request.pageTitle
        )
        let finalURL = request.destinationDirectory.appendingPathComponent(filename)
        try FileManager.default.createDirectory(
            at: request.destinationDirectory,
            withIntermediateDirectories: true
        )
        // A new task refuses collisions; a redownload may replace only its recorded
        // destination, after the new bytes have been completely staged.
        guard canReplace(finalURL) || !FileManager.default.fileExists(atPath: finalURL.path) else {
            throw POSIXError(.EEXIST)
        }
        let useOffset = acceptRanges && (hasOffsetReceipt || !hasLegacyArtifacts)
        if hasOffsetReceipt {
            guard let representation, acceptRanges else { throw HTTPRepresentationIdentity.Failure.changed }
            offsetStorage = try OffsetDownloadStorage.recover(taskID: taskID, workDirectory: workDirectory,
                                                             resourceContextHash: representation.storageContextHash)
            guard offsetStorage?.destinationURL == finalURL else { throw OffsetDownloadStorage.Failure.identityMismatch }
        }
        if probe.downloadedBody == nil { try validateStorage(totalBytes: total, offsetMode: useOffset) }

        setState(.downloading)

        // Smart tuning: big resumable files start low and double while it pays off.
        let tuningActive = autoTune && acceptRanges && total >= tuneConfig.minTotalBytes
        if tuningActive {
            setCurrentConnections(max(1, min(tuneConfig.startConnections, connectionCap)))
            progress.tuning = ConnectionTuning(
                steps: [],
                currentConnections: currentConnections,
                outcome: .tuning
            )
            log("SmartTune enabled: starting at \(currentConnections), cap \(connectionCap)")
        } else if autoTune && !acceptRanges {
            setCurrentConnections(1)
            progress.tuning = ConnectionTuning(
                steps: [],
                currentConnections: 1,
                outcome: .rangeUnsupported
            )
        }

        if let downloadedBody = probe.downloadedBody {
            try discardSegmentArtifacts(reason: "adopting complete bootstrap response")
            try await downloadSingleStream(total: total, finalURL: finalURL, downloadedBody: downloadedBody)
        } else if acceptRanges {
            do {
                var segments: [SegmentRecord]
                if let storage = offsetStorage {
                    segments = offsetSegments(storage)
                    try restoreTailProvenance(for: segments)
                    installProgressPlan(segments)
                } else if !useOffset, let existing = try loadSegmentsForResume(total: total) {
                    segments = existing
                    try restoreTailProvenance(for: segments)
                } else if currentConnections > 1 {
                    // The probe already established the final byte length. Plan
                    // every useful Range now so workers can ramp immediately;
                    // waiting for a synthetic 960 KiB prefix made high-latency
                    // VPN paths visibly slower than a browser's single stream.
                    let planningConnections = tuningActive ? connectionCap : currentConnections
                    segments = SegmentFileFormat.planDynamicConnections(
                        totalBytes: total,
                        connections: planningConnections,
                        completedPrefixBytes: 0
                    )
                    installProgressPlan(segments)
                    if useOffset {
                        offsetStorage = try createOffsetStorage(segments, total: total, finalURL: finalURL)
                    } else { try writeSegmentsBin(segments) }
                    log("SegmentManager Created a New Segment and now has \(segments.count) Segments.")
                } else {
                    segments = SegmentFileFormat.planEqualSegments(totalBytes: total, connections: 1)
                    installProgressPlan(segments)
                    if useOffset {
                        offsetStorage = try createOffsetStorage(segments, total: total, finalURL: finalURL)
                    } else { try writeSegmentsBin(segments) }
                }

                try representation?.save(in: workDirectory)
                if tuningActive {
                    tuneTask = Task { await self.runAutoTune() }
                }
                let finalSegments = try await downloadSegmentsWithReplanning(segments, total: total)
                tuneTask?.cancel()
                tuneTask = nil
                try throwIfStopped()

                setState(.merging)
                log("DownloadEngine State Changed : Downloading... -> Merging...")
                // Output failures do not invalidate completed input parts.
                if let storage = offsetStorage {
                    try storage.publish(replacingExisting: canReplace(finalURL))
                } else { try mergeSegments(finalSegments, to: finalURL, total: total) }
            } catch EngineError.notResumable {
                tuneTask?.cancel()
                tuneTask = nil
                if autoTune {
                    setCurrentConnections(1)
                    progress.tuning = ConnectionTuning(
                        steps: progress.tuning?.steps ?? [],
                        currentConnections: 1,
                        outcome: .rangeUnsupported
                    )
                }
                log("Resume Failed. Server ignored a byte Range; retrying once as a clean single-stream download.")
                if offsetStorage != nil {
                    offsetStorage = nil
                    try OffsetDownloadStorage.removeIncomplete(taskID: taskID, workDirectory: workDirectory)
                    try validateStorage(totalBytes: total)
                }
                try discardSegmentArtifacts(reason: "server ignored Range")
                try await downloadSingleStream(total: total, finalURL: finalURL)
            } catch {
                tuneTask?.cancel()
                tuneTask = nil
                // Structured task groups have drained delegates before returning.
                // Commit only actual successful writes, even on pause/error.
                try offsetStorage?.checkpoint()
                if let failure = offsetCheckpointFailure { throw failure }
                throw error
            }
        } else {
            try discardSegmentArtifacts(reason: "server does not advertise byte ranges")
            try await downloadSingleStream(total: total, finalURL: finalURL)
        }

        progress.status = .complete
        progress.completedBytes = progress.totalBytes
        setState(.completed)
        log("DownloadEngine State Changed : Merging... -> Completed")
        return finalURL
    }

    public func currentProgress() -> DownloadProgress { progress }

    private func validateStorage(totalBytes: Int64, offsetMode: Bool = false) throws {
        guard totalBytes > 0 else { return }
        if offsetMode {
            let budget = DirectDownloadStorageBudget(totalBytes: totalBytes, sharesVolume: false,
                mode: .offsetDestination, verifiedAllocatedDestinationBytes: try offsetStorage?.verifiedAllocatedBytes() ?? 0)
            if let available = capacityProvider(request.destinationDirectory), budget.destinationBytesRequired > available {
                throw EngineError.insufficientStorage(requiredBytes: budget.destinationBytesRequired, availableBytes: available)
            }
            return
        }
        let existingWork = existingResumableBytes(totalBytes: totalBytes)
        let sharesVolume = sameVolumeProvider(workDirectory, request.destinationDirectory)
        let budget = DirectDownloadStorageBudget(
            totalBytes: totalBytes,
            existingWorkBytes: existingWork,
            // Staged publication never reclaims an existing destination.
            existingDestinationBytes: 0,
            sharesVolume: sharesVolume
        )

        if let required = budget.sharedVolumeBytesRequired {
            guard let available = capacityProvider(workDirectory) else { return }
            if required > available {
                throw EngineError.insufficientStorage(
                    requiredBytes: required,
                    availableBytes: available
                )
            }
            return
        }

        if let available = capacityProvider(workDirectory),
           budget.workBytesRequired > available {
            throw EngineError.insufficientStorage(
                requiredBytes: budget.workBytesRequired,
                availableBytes: available
            )
        }
        if let available = capacityProvider(request.destinationDirectory),
           budget.destinationBytesRequired > available {
            throw EngineError.insufficientStorage(
                requiredBytes: budget.destinationBytesRequired,
                availableBytes: available
            )
        }
    }

    private func existingResumableBytes(totalBytes: Int64) -> Int64 {
        guard let records = (try? SegmentFileFormat.loadSegmentsBin(from: workDirectory)) ?? nil,
              !records.isEmpty else { return 0 }
        let sorted = records.sorted { $0.start < $1.start }
        let contiguous = sorted.first?.start == 0 && zip(sorted, sorted.dropFirst()).allSatisfy {
            $0.end + 1 == $1.start
        }
        guard contiguous, sorted.last.map({ $0.end + 1 }) == totalBytes else { return 0 }
        return sorted.reduce(Int64(0)) { partial, segment in
            let bytes = SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
            let (sum, overflow) = partial.addingReportingOverflow(bytes)
            return overflow ? Int64.max : sum
        }
    }


    // MARK: - Segments plan / resume

    private func loadSegmentsForResume(total: Int64) throws -> [SegmentRecord]? {
        let existing: [SegmentRecord]?
        do {
            existing = try SegmentFileFormat.loadSegmentsBin(from: workDirectory)
        } catch {
            log("segments.bin is malformed; discarding incompatible resume data.")
            try discardSegmentArtifacts(reason: "malformed segments.bin")
            return nil
        }

        guard let existing, !existing.isEmpty else {
            // A crash between creating a part file and atomically writing the
            // plan can leave orphaned seg.xN files. They cannot be mapped safely.
            try discardOrphanedSegmentFiles()
            return nil
        }

        guard SegmentFileFormat.isValidResumePlan(existing, totalBytes: total) else {
            let covered = existing.map(\.end).max().map { $0 + 1 } ?? 0
            log("segments.bin is incompatible with remote (\(covered) vs \(total)); discarding resume data.")
            try discardSegmentArtifacts(reason: "invalid or stale segment plan")
            return nil
        }

        let sorted = existing.sorted { $0.start < $1.start }
        guard sorted.allSatisfy({ segment in
            SegmentFileFormat.rawExistingByteCount(for: segment, in: workDirectory) <= segment.length
        }) else {
            log("A partial segment is larger than its assigned Range; discarding unsafe resume data.")
            try discardSegmentArtifacts(reason: "oversized partial segment")
            return nil
        }

        let hasBytes = sorted.contains { SegmentFileFormat.rawExistingByteCount(for: $0, in: workDirectory) > 0 }
        if hasBytes && (representation == nil || HTTPRepresentationIdentity.load(in: workDirectory) != representation) {
            log("Resume identity missing or changed; discarding unverifiable old bytes before a fresh download.")
            try discardSegmentArtifacts(reason: "unverifiable representation")
            return nil
        }
        log("Segments were loaded from segments.bin file.")
        installProgressPlan(sorted)
        return sorted
    }

    private func discardOrphanedSegmentFiles() throws {
        let names = try FileManager.default.contentsOfDirectory(atPath: workDirectory.path)
        guard names.contains(where: { $0.hasPrefix("seg.x") }) else { return }
        try discardSegmentArtifacts(reason: "orphaned segment files without segments.bin")
    }

    private func discardSegmentArtifacts(reason: String) throws {
        let files = try FileManager.default.contentsOfDirectory(
            at: workDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        var removed = 0
        for file in files {
            let name = file.lastPathComponent
            guard name == "segments.bin" || name == "representation.json" || name == TailSplitProvenance.filename || name.hasPrefix("seg.x") else { continue }
            try FileManager.default.removeItem(at: file)
            removed += 1
        }
        if removed > 0 {
            log("Discarded \(removed) temporary segment artifact(s): \(reason).")
        }
        provenancePlan = []
        provenanceState = .init(origins: [:], rebalanceDisabled: false)
        segmentCompleted.removeAll(keepingCapacity: true)
        lastSpeedSample = 0
        speedWindowBytes = 0
        speedWindowStart = Date()
        progress.bytesPerSecond = 0
        progress.segmentStates = []
        recountProgress()
    }

    /// Runtime `applyConnectionsCount:` — user-driven; smart tuning steps aside.
    public func applyConnectionsCount(_ count: Int) throws {
        if autoTune {
            tuneAborted = true
            tuneTask?.cancel()
            tuneTask = nil
            progress.tuning = ConnectionTuning(
                steps: progress.tuning?.steps ?? [],
                currentConnections: max(1, min(count, 32)),
                outcome: .userOverride
            )
        }
        try replanConnections(count)
    }

    /// Apply a new effective cap without stopping the active range workers.
    /// BandwidthLimiter is lock-protected and resets its current token window,
    /// so the next received chunk observes the new value immediately.
    public func applyBandwidthLimit(_ bytesPerSecond: Int64) {
        let limit = max(0, bytesPerSecond)
        progress.effectiveBandwidthLimitBytesPerSecond = limit
        limiter.updateLimit(limit)
    }

    /// Replan unfinished ranges to a new concurrency (pause soft-stop not required).
    private func replanConnections(_ count: Int) throws {
        let n = max(1, min(count, 32))
        setCurrentConnections(n)
        planGeneration &+= 1
        if let activePlanToken {
            log("applyConnectionsCount: \(n) — cancelling active Range round for live replan.")
            activePlanToken.cancel()
            return
        }
        guard let existing = try offsetStorage.map(offsetSegments) ?? SegmentFileFormat.loadSegmentsBin(from: workDirectory), !existing.isEmpty else {
            return
        }
        let total = progress.totalBytes > 0
            ? progress.totalBytes
            : (existing.map(\.end).max().map { $0 + 1 } ?? 0)
        let replanned = try replanPersistedSegments(existing, total: total)
        log("applyConnectionsCount: \(n) — SegmentManager now has \(replanned.count) Segments.")
    }

    // MARK: - Probe

    private struct Probe {
        var contentLength: Int64?
        var acceptRanges: Bool
        var suggestedFilename: String?
        var mimeType: String?
        var validator: HTTPRepresentationIdentity.Validator?
        var downloadedBody: URL? = nil
    }

    private func probeData(for request: URLRequest) async throws -> (Data, URLResponse) {
        try throwIfStopped()
        try Task.checkCancellation()
        _ = probeAuthentication.takeFailure()
        // Cancel the request, not the session: invalidating a session can race
        // Foundation's async task creation and raise an Objective-C exception.
        let session = self.session
        let probeTask = Task {
            try Task.checkCancellation()
            return try await session.data(for: request)
        }
        activeProbeTask = probeTask
        defer { activeProbeTask = nil }
        do {
            let response = try await withTaskCancellationHandler {
                try await probeTask.value
            } onCancel: {
                probeTask.cancel()
            }
            try throwIfStopped()
            try Task.checkCancellation()
            return response
        } catch {
            try throwIfStopped()
            try Task.checkCancellation()
            throw probeAuthentication.takeFailure() ?? error
        }
    }

    /// Foundation streams a bootstrap response to a temporary file, rather than
    /// accumulating an ignored Range response (potentially the whole file) in RAM.
    private func probeDownload(for request: URLRequest) async throws -> (URL, URLResponse) {
        try throwIfStopped(); try Task.checkCancellation()
        try finishBootstrap()
        _ = probeAuthentication.takeFailure()
        let session = self.session
        let task = Task { try Task.checkCancellation(); return try await session.download(for: request) }
        activeBootstrapTask = task
        defer { activeBootstrapTask = nil }
        do {
            let (temporary, response) = try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
            defer { try? FileManager.default.removeItem(at: temporary) }
            try throwIfStopped(); try Task.checkCancellation()
            // Register an empty owned file before copying any response payload.
            // A crash is recovered by the ordinary staging receipt at next start.
            let bytes = Int64((try temporary.resourceValues(forKeys: [.fileSizeKey])).fileSize ?? 0)
            if let available = capacityProvider(workDirectory), available < bytes {
                throw EngineError.insufficientStorage(requiredBytes: bytes, availableBytes: available)
            }
            let owned = workDirectory.appendingPathComponent(".ndm-merge-\(taskID)-\(UUID()).partial")
            let descriptor = Darwin.open(owned.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
            guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            let output = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? output.close() }
            bootstrapReceipt = try MergeStagingReceipt.register(taskID: taskID, staging: owned, descriptor: descriptor, in: workDirectory)
            let input = try FileHandle(forReadingFrom: temporary)
            defer { try? input.close() }
            while true {
                try checkMergeCancellation()
                guard let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty else { break }
                try output.write(contentsOf: chunk)
            }
            try checkMergeCancellation()
            try output.synchronize()
            return (owned, response)
        } catch {
            try? finishBootstrap()
            try throwIfStopped(); try Task.checkCancellation()
            throw probeAuthentication.takeFailure() ?? error
        }
    }

    private func finishBootstrap() throws {
        guard let receipt = bootstrapReceipt else { return }
        try receipt.finish(in: workDirectory)
        bootstrapReceipt = nil
    }

    private func probeRemoteWithAuth() async throws -> Probe {
        var lastChallenge: String?
        var lastStatus = 401
        var transportRetries = 0
        for _ in 0..<5 {
            do {
                while true {
                    try throwIfStopped()
                    try Task.checkCancellation()
                    do { return try await probeRemote() }
                    catch {
                        let failure = error as NSError
                        // Only safe metadata methods may be replayed here. A body
                        // request can have taken effect before the connection died.
                        // Neat's starting budget is three reschedules, distinct
                        // from resumable downloading workers. DNS/offline, HTTP,
                        // authentication and TLS failures are not this branch.
                        guard normalizedMethod == "GET" || normalizedMethod == "HEAD",
                              failure.domain == NSURLErrorDomain,
                              [NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
                               NSURLErrorCannotConnectToHost].contains(failure.code),
                              transportRetries < 3 else { throw error }
                        transportRetries += 1
                        log("StartupRetry: transport NSURLErrorDomain(\(failure.code)), retry \(transportRetries)/3; rebuilding metadata request.")
                        // Rebuild and sign each new request; never reuse a Digest
                        // header with the preceding request's nonce count.
                        await Task.yield()
                    }
                }
            } catch let EngineError.authRequired(status, challenge) {
                lastChallenge = challenge
                lastStatus = status
                try prepareChallengeAuth(status: status, header: challenge)
            }
        }
        throw EngineError.authRequired(status: lastStatus, challenge: lastChallenge)
    }

    private func probeRemote() async throws -> Probe {
        // A body-bearing endpoint rarely answers HEAD usefully — it commonly 405s,
        // or worse, reports the length of a page instead of the attachment. Probe
        // such tasks with the real method so the size we plan against is the size
        // the download will actually produce.
        if carriesBody {
            return try await probeWithRangeGet()
        }
        var req = URLRequest(url: cleanURL)
        req.httpMethod = "HEAD"
        applyHeaders(to: &req)
        try applyAuthentication(to: &req)
        do {
            let (_, response) = try await probeData(for: req)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 || http.statusCode == 407 {
                    throw EngineError.authRequired(
                        status: http.statusCode,
                        challenge: http.value(forHTTPHeaderField: "WWW-Authenticate")
                            ?? http.value(forHTTPHeaderField: "Proxy-Authenticate")
                    )
                }
                if (200..<400).contains(http.statusCode) {
                    let length = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int64.init)
                    let accept = (http.value(forHTTPHeaderField: "Accept-Ranges") ?? "")
                        .lowercased().contains("bytes")
                    return Probe(
                        contentLength: length,
                        acceptRanges: accept || length != nil,
                        suggestedFilename: http.suggestedFilename,
                        mimeType: http.value(forHTTPHeaderField: "Content-Type"),
                        validator: .from(http)
                    )
                }
            }
        } catch let e as EngineError {
            throw e
        } catch let error as HTTPAuthenticationBoundary.Failure {
            throw error
        } catch {
            // fall through
        }
        return try await probeWithRangeGet()
    }

    private func probeWithRangeGet() async throws -> Probe {
        var req = URLRequest(url: cleanURL)
        if !carriesBody { req.setValue("bytes=0-0", forHTTPHeaderField: "Range") }
        applyHeaders(to: &req)
        applyMethodAndBody(to: &req)
        try applyAuthentication(to: &req)
        let (bodyFile, response) = try await probeDownload(for: req)
        var retained = false
        defer { if !retained { try? finishBootstrap() } }
        guard let http = response as? HTTPURLResponse else { throw EngineError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 407 {
            throw EngineError.authRequired(
                status: http.statusCode,
                challenge: http.value(forHTTPHeaderField: "WWW-Authenticate")
                    ?? http.value(forHTTPHeaderField: "Proxy-Authenticate")
            )
        }
        // A Range probe is still an HTTP request: an explicit server error
        // is not successful metadata and must not trigger a second full GET.
        // The sole empty-resource exception is an unsatisfiable byte zero range
        // whose response explicitly confirms a zero-length representation.
        let emptyRange = http.statusCode == 416 &&
            http.value(forHTTPHeaderField: "Content-Range")?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "bytes */0"
        guard (200..<300).contains(http.statusCode) || emptyRange else {
            throw EngineError.httpStatus(http.statusCode)
        }
        if carriesBody && http.statusCode == 206 { throw EngineError.invalidResponse }
        if (200..<300).contains(http.statusCode), http.statusCode != 206 {
            let actual = Int64(try bodyFile.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
            if let length = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int64.init), length != actual {
                throw EngineError.incompleteResponse(expected: length, received: actual)
            }
            retained = true
            return Probe(contentLength: actual, acceptRanges: false, suggestedFilename: http.suggestedFilename,
                         mimeType: http.value(forHTTPHeaderField: "Content-Type"), validator: .from(http), downloadedBody: bodyFile)
        }
        var length: Int64? = emptyRange ? 0 : nil
        if let range = http.value(forHTTPHeaderField: "Content-Range"),
           let total = range.split(separator: "/").last,
           let n = Int64(total), n > 0 {
            length = n
        }
        return Probe(
            contentLength: length,
            acceptRanges: http.statusCode == 206,
            suggestedFilename: http.suggestedFilename,
            mimeType: http.value(forHTTPHeaderField: "Content-Type"),
            validator: .from(http)
        )
    }

    /// Advance Digest (1-shot) or NTLM (Type1 → Type3) state from a WWW/Proxy-Authenticate header.
    private func prepareChallengeAuth(status: Int, header: String?) throws {
        let isProxy = status == 407
        let user = isProxy ? httpProxyCredentials?.username : (request.username ?? request.url.user)
        let pass = isProxy ? (httpProxyCredentials?.password ?? "") : (request.password ?? request.url.password ?? "")
        guard let user, !user.isEmpty else { throw EngineError.authRequired(status: status, challenge: header) }
        var state = isProxy ? proxyAuthentication : originAuthentication
        if header?.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("basic ") == true {
            state.setFixedHeader("Basic " + Data("\(user):\(pass)".utf8).base64EncodedString())
        } else if let header, let digest = DigestAuth.parseChallenge(from: header, isProxy: isProxy) {
            try state.adopt(digest)
        } else if NTLMAuth.isNTLMChallenge(header) {
            if let type2 = NTLMAuth.parseType2(from: header) {
                state.setFixedHeader(NTLMAuth.type3AuthorizationHeader(type2: type2, username: user, password: pass, isProxy: isProxy))
            } else {
                state.setFixedHeader(NTLMAuth.type1AuthorizationHeader(isProxy: isProxy))
            }
        } else { throw EngineError.authRequired(status: status, challenge: header) }
        if isProxy { proxyAuthentication = state } else { originAuthentication = state }
    }

    private func applyAuthentication(to req: inout URLRequest) throws {
        if let header = try originAuthentication.header(for: req, username: request.username ?? request.url.user,
            password: request.password ?? request.url.password ?? "", proxy: false,
            forwardProxy: httpProxyCredentials?.enabled == true && socksProxySettings?.enabled != true && req.url?.scheme?.lowercased() == "http") {
            req.setValue(header, forHTTPHeaderField: "Authorization")
        }
        if let header = try proxyAuthentication.header(for: req, username: httpProxyCredentials?.username,
            password: httpProxyCredentials?.password ?? "", proxy: true) {
            req.setValue(header, forHTTPHeaderField: "Proxy-Authorization")
        }
    }

    // MARK: - Smart connection tuning

    /// Probe loop: sample throughput, double connections while it pays off,
    /// revert the last step when it didn't, and record an honest conclusion.
    /// Runs concurrently with the transfer; every reconfiguration goes through
    /// the same live-replan path as a manual connection change.
    private func runAutoTune() async {
        var steps: [ConnectionTuning.Step] = []
        log("SmartTune: probe loop starting")
        try? await Task.sleep(nanoseconds: tuneConfig.settleNanos)
        while !Task.isCancelled, !tuneAborted, engineState == .downloading {
            guard let speed = await sampleThroughput() else {
                log("SmartTune: sample unavailable (cancelled=\(Task.isCancelled) state=\(engineState.rawValue))")
                break
            }
            steps.append(ConnectionTuning.Step(connections: currentConnections, bytesPerSecond: speed))
            publishTuning(steps: steps, outcome: .tuning)
            log("SmartTune: \(currentConnections) connections ≈ \(Int(speed / 1024)) KB/s")

            // Close to done? Finishing beats experimenting.
            let remaining = progress.totalBytes - progress.completedBytes
            if remaining < tuneConfig.minRemainingBytes || remaining < Int64(speed * 4) {
                publishTuning(steps: steps, outcome: SmartConnectionTuner.outcome(cap: connectionCap, steps: steps))
                return
            }

            if let next = SmartConnectionTuner.nextConnections(cap: connectionCap, steps: steps) {
                log("SmartTune: raising connections \(currentConnections) → \(next)")
                adjustTunedConnections(next)
                try? await Task.sleep(nanoseconds: tuneConfig.settleNanos)
            } else {
                if let back = SmartConnectionTuner.revertTarget(steps: steps) {
                    log("SmartTune: no gain at \(currentConnections); reverting to \(back)")
                    adjustTunedConnections(back)
                }
                publishTuning(steps: steps, outcome: SmartConnectionTuner.outcome(cap: connectionCap, steps: steps))
                return
            }
        }
    }

    private func sampleThroughput() async -> Double? {
        // A window can land inside a transient stall (throttle refill,
        // connection ramp-up) — retry a couple of times before giving up.
        for _ in 0..<3 {
            let startBytes = progress.completedBytes
            let started = Date()
            try? await Task.sleep(nanoseconds: tuneConfig.windowNanos)
            guard !Task.isCancelled, !tuneAborted, engineState == .downloading else { return nil }
            let dt = Date().timeIntervalSince(started)
            let delta = progress.completedBytes - startBytes
            if dt > 0, delta > 0 {
                return Double(delta) / dt
            }
        }
        return nil
    }

    private func publishTuning(steps: [ConnectionTuning.Step], outcome: ConnectionTuning.Outcome) {
        guard !tuneAborted else { return }
        progress.currentConnections = currentConnections
        progress.requestLimit = min(currentConnections, serverConnectionLimit ?? 32)
        progress.tuning = ConnectionTuning(
            steps: steps,
            currentConnections: currentConnections,
            outcome: outcome
        )
    }

    /// Keep the private worker target and the UI-facing progress field in lockstep.
    private func setCurrentConnections(_ n: Int) {
        let capped = max(1, min(n, 32))
        currentConnections = capped
        progress.currentConnections = capped
        progress.requestLimit = min(capped, serverConnectionLimit ?? 32)
    }

    /// Auto-tuning changes how many already-planned ranges may run next. It does
    /// not cancel healthy transfers; the worker pool converges as each Range
    /// finishes, avoiding the multi-second stop/reconnect gaps seen on VPNs.
    private func adjustTunedConnections(_ n: Int) {
        setCurrentConnections(n)
        log("SmartTune: worker target changed to \(currentConnections) without interrupting active ranges.")
    }

    // MARK: - Download

    private func downloadSegmentsWithReplanning(
        _ initial: [SegmentRecord],
        total: Int64
    ) async throws -> [SegmentRecord] {
        var segments = initial
        var automaticTailOrigins = provenanceState.origins
        var allowsAutomaticTailRebalance = !provenanceState.rebalanceDisabled
        while true {
            try throwIfStopped()
            let generation = planGeneration
            let roundToken = CancelToken()
            activePlanToken = roundToken
            do {
                let roundCap = autoTune && !tuneAborted
                    ? connectionCap
                    : currentConnections
                try await downloadRound(
                    &segments,
                    automaticTailOrigins: &automaticTailOrigins,
                    maxConcurrent: roundCap,
                    allowTailRebalance: allowsAutomaticTailRebalance,
                    planToken: roundToken
                )
            } catch ReplanSignal.requested {
                // Expected control flow: all URLSession tasks have acknowledged cancellation
                // and closed their FileHandles before the next plan reads file sizes.
            } catch let failure as SegmentRoundFailure {
                activePlanToken = nil
                roundToken.cancel()
                if isRangeNotSatisfiable(failure.underlying),
                   let parent = automaticTailOrigins[failure.segmentID],
                   let rollback = SegmentFileFormat.rollbackTailSplit(
                       existing: segments,
                       failedSegmentID: failure.segmentID,
                       originalParent: parent
                   ) {
                    let failedFile = SegmentFileFormat.segmentFileURL(
                        id: failure.segmentID,
                        in: workDirectory
                    )
                    let discarded = existingBytes(segments.first(where: { $0.segmentId == failure.segmentID }) ?? parent)
                    var nextOrigins = automaticTailOrigins
                    nextOrigins.removeValue(forKey: failure.segmentID)
                    nextOrigins = validTailOrigins(nextOrigins, for: rollback.records)
                    // All writers have drained. Remove the legacy speculative prefix
                    // before releasing its ID in the committed plan: a crash afterwards
                    // may require re-downloading it, but cannot reuse stale bytes under
                    // a different range. A removal failure must leave the old plan intact.
                    if offsetStorage == nil, FileManager.default.fileExists(atPath: failedFile.path) {
                        try FileManager.default.removeItem(at: failedFile)
                    }
                    try writeSegmentsBin(rollback.records, provenance: .init(origins: nextOrigins, rebalanceDisabled: true))
                    installProgressPlan(rollback.records)
                    automaticTailOrigins = provenanceState.origins
                    allowsAutomaticTailRebalance = false
                    segments = rollback.records
                    log("Segment Rolled Back To Socket ( \(Int(rollback.survivorID) + 1) ). Segment \(failure.segmentID) Merged To Segment \(rollback.survivorID); discarded \(discarded) speculative bytes and disabled further automatic tail stealing for this task.")
                    continue
                }
                throw failure.underlying
            } catch {
                activePlanToken = nil
                roundToken.cancel()
                throw error
            }
            activePlanToken = nil
            if let failure = offsetCheckpointFailure { throw failure }
            try offsetStorage?.checkpoint()
            try throwIfStopped()

            if generation != planGeneration || roundToken.isCancelled {
                segments = try replanPersistedSegments(segments, total: total)
                automaticTailOrigins.removeAll(keepingCapacity: true)
                log("Replanned active transfers: MaxAllowedConnection = \(currentConnections), Segments = \(segments.count).")
                continue
            }
            return segments
        }
    }

    private func downloadRound(
        _ segments: inout [SegmentRecord],
        automaticTailOrigins: inout [Int16: SegmentRecord],
        maxConcurrent: Int,
        allowTailRebalance: Bool,
        planToken: CancelToken
    ) async throws {
        var pending = segments.filter {
            existingBytes($0) < $0.length
        }
        guard !pending.isEmpty else { return }
        if !hasActualFileBytes { firstBodySegmentID = pending.first?.segmentId }
        let roundStartedAt = Date()
        let initialRemainingBytes = pending.reduce(Int64(0)) { sum, segment in
            sum + max(0, segment.length - existingBytes(segment))
        }
        let limit = max(1, min(currentConnections, maxConcurrent, pending.count))
        log("New Socket(s) Created. MaxAllowedConnection = \(currentConnections) And ActiveSockets = \(limit)")
        let failureBox = RoundFailureBox()
        do {
            try await withThrowingTaskGroup(of: Int16.self) { group in
                var workers: [Int16: CancelToken] = [:]
                var leases: [Int16: RangeTransferLease] = [:]
                // Structured task cancellation alone does not stop delegate-based
                // URLSession writes. Also drain them if persisting a split fails.
                defer { for worker in workers.values { worker.cancel() } }
                func enqueue(_ segment: SegmentRecord) {
                    let workerToken = CancelToken()
                    workers[segment.segmentId] = workerToken
                    let lease = RangeTransferLease(segment: segment, completed: existingBytes(segment))
                    leases[segment.segmentId] = lease
                    group.addTask {
                        do {
                            try await self.downloadSegmentWithRetries(
                                segment, planToken: planToken, workerToken: workerToken, lease: lease
                            )
                            return segment.segmentId
                        } catch {
                            // Draining siblings after a planner error must not replace
                            // that error with an expected worker cancellation.
                            if !workerToken.isCancelled && !(error is ReplanSignal) {
                                failureBox.record(segmentID: segment.segmentId, error: error)
                            }
                            planToken.cancel()
                            throw error
                        }
                    }
                }
                for _ in 0..<limit { enqueue(pending.removeFirst()) }
                while let segmentID = try await group.next() {
                    workers.removeValue(forKey: segmentID)
                    try throwIfStopped()
                    if planToken.isCancelled { throw ReplanSignal.requested }
                    leases.removeValue(forKey: segmentID)
                    markSegmentFinished(segmentID)
                    let desiredActive = max(1, min(currentConnections, maxConcurrent))
                    while !pending.isEmpty, workers.count < desiredActive {
                        enqueue(pending.removeFirst())
                    }
                    // Claim queued work first, then give an idle slot a live donor's tail.
                    if pending.isEmpty, allowTailRebalance, !serverRefusedWorkers,
                       workers.count > 0, workers.count < desiredActive {
                        let worthSplitting = !autoTune || tailRebalancePlan(
                            segments, activeConnections: workers.count,
                            targetConnections: currentConnections, useSetupPayback: true,
                            roundStartedAt: roundStartedAt,
                            initialRemainingBytes: initialRemainingBytes
                        ) != nil
                        let candidates = segments.filter { workers[$0.segmentId] != nil }
                        let donor = candidates.max { lhs, rhs in
                            let left = lhs.length - existingBytes(lhs)
                            let right = rhs.length - existingBytes(rhs)
                            // For equal tails prefer the earlier range, like the verified selector.
                            return left == right ? lhs.start > rhs.start : left < right
                        }
                        if worthSplitting, let donor,
                           donor.length - existingBytes(donor)
                            > SegmentFileFormat.originalHTTPPlanningQuantumBytes,
                           segments.count < Int(Int16.max) {
                            if let lease = leases[donor.segmentId] {
                                let split = try lease.withLock {
                                    guard let split = SegmentFileFormat.splitUnwrittenTail(
                                        existing: segments, donorID: donor.segmentId,
                                        completedBytes: lease.completed
                                    ) else { return nil as (records: [SegmentRecord], parent: SegmentRecord, child: SegmentRecord)? }
                                    var nextOrigins = automaticTailOrigins
                                    nextOrigins[split.child.segmentId] = donor
                                    try writeSegmentsBin(split.records, provenance: .init(origins: validTailOrigins(nextOrigins, for: split.records), rebalanceDisabled: provenanceState.rebalanceDisabled))
                                    lease.segment = split.parent
                                    return split
                                }
                                if let split {
                                    automaticTailOrigins = provenanceState.origins
                                    segments = split.records
                                    installProgressPlan(segments, resetSpeed: false)
                                    enqueue(split.child)
                                    log("TailHandoff: split segment \(donor.segmentId); child \(split.child.segmentId), \(max(0, workers.count - 2)) other workers preserved; parent HTTP request retained.")
                                }
                            }
                        } else {
                            log("TailBalance: \(workers.count) active of \(maxConcurrent); finishing without new sockets because reconnect payback is too small.")
                        }
                    }
                }
            }
        } catch {
            planToken.cancel()
            if let failure = failureBox.failure { throw failure }
            throw error
        }
        recountProgress()
    }

    private func isRangeNotSatisfiable(_ error: Error) -> Bool {
        guard let engineError = error as? EngineError else { return false }
        if case .httpStatus(416) = engineError { return true }
        return false
    }

    private func tailRebalancePlan(
        _ segments: [SegmentRecord],
        activeConnections: Int,
        targetConnections: Int,
        useSetupPayback: Bool,
        roundStartedAt: Date,
        initialRemainingBytes: Int64
    ) -> TailRebalancePlan? {
        let remaining = segments.map { segment in
            let have = existingBytes(segment)
            return max(0, segment.length - have)
        }
        // A fast local/CDN transfer may finish workers before the periodic
        // speed sample fires. Use this round's observed bytes instead of zero,
        // which would incorrectly classify a short tail as worth reconnecting.
        let received = max(0, initialRemainingBytes - remaining.reduce(0, +))
        let observedSpeed = Double(received) / max(0.001, Date().timeIntervalSince(roundStartedAt))
        return SegmentFileFormat.tailRebalancePlan(
            targetConnections: targetConnections,
            activeConnections: activeConnections,
            remainingBytesBySegment: remaining,
            bytesPerSecond: progress.bytesPerSecond > 0 ? progress.bytesPerSecond : observedSpeed,
            connectionSetupSeconds: estimatedConnectionSetupSeconds,
            useSetupPayback: useSetupPayback
        )
    }

    private var estimatedConnectionSetupSeconds: Double {
        SmartConnectionTuner.connectionSetupSeconds(
            samples: connectionSetupSamples
        )
    }

    private func recordConnectionSetupSample(_ seconds: Double) {
        guard seconds.isFinite, seconds > 0 else { return }
        connectionSetupSamples.append(seconds)
        if connectionSetupSamples.count > 9 {
            connectionSetupSamples.removeFirst(
                connectionSetupSamples.count - 9
            )
        }
    }

    private func markSegmentFinished(_ segmentID: Int16) {
        if let idx = progress.segmentStates.firstIndex(where: { $0.id == Int(segmentID) }) {
            progress.segmentStates[idx].isFinished = true
            progress.segmentStates[idx].completed = progress.segmentStates[idx].length
        }
    }

    /// Admission is separate from the segment table: queued ranges do not mean
    /// open network requests. A reduced ceiling drains naturally; healthy work
    /// is never cancelled just to meet it.
    private func performRangeAttempt(
        _ segment: SegmentRecord, planToken: CancelToken, workerToken: CancelToken, lease: RangeTransferLease
    ) async throws {
        while true {
            try throwIfStopped()
            if planToken.isCancelled { throw ReplanSignal.requested }
            if workerToken.isCancelled { throw EngineError.cancelled }
            let now = ProcessInfo.processInfo.systemUptime
            if let cap = serverConnectionLimit, cap < currentConnections,
               now >= nextAdmissionRecovery {
                serverConnectionLimit = cap + 1
                nextAdmissionRecovery = now + 5
                log("ServerAdmission: cautiously retrying capacity \(cap + 1).")
            }
            // HEAD metadata is not a successful file transfer. Bootstrap one
            // request until actual file bytes arrive, then admit the full pool.
            let ceiling = hasActualFileBytes ? min(currentConnections, serverConnectionLimit ?? 32) : 1
            if activeRangeRequests < ceiling,
               hasActualFileBytes || segment.segmentId == firstBodySegmentID { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        activeRangeRequests += 1
        progress.activeRequests = activeRangeRequests
        progress.requestLimit = min(currentConnections, serverConnectionLimit ?? 32)
        defer {
            activeRangeRequests -= 1
            progress.activeRequests = activeRangeRequests
        }
        try await downloadSegmentStreaming(lease.withLock { lease.segment }, planToken: planToken, workerToken: workerToken, lease: lease)
    }

    /// Retry only the refused worker. Other ranges keep their requests and data.
    /// Every retry reconstructs its Range from disk, never from a stale byte count.
    private func downloadSegmentWithRetries(
        _ segment: SegmentRecord, planToken: CancelToken, workerToken: CancelToken, lease: RangeTransferLease
    ) async throws {
        var retries = 0
        var transportRetries = 0
        while true {
            do {
                try await performRangeAttempt(
                    segment, planToken: planToken, workerToken: workerToken, lease: lease
                )
                return
            } catch let EngineError.temporarilyUnavailable(status, retryAfter) {
                // A service outage (503) does not establish a connection limit.
                // For explicit rate limiting, reduce admission temporarily and
                // cautiously try additional capacity after the quiet interval.
                if status == 429 {
                    serverRefusedWorkers = true
                    serverConnectionLimit = max(1, min(serverConnectionLimit ?? currentConnections, currentConnections) - 1)
                    nextAdmissionRecovery = ProcessInfo.processInfo.systemUptime + max(5, retryAfter ?? 0)
                    progress.requestLimit = min(currentConnections, serverConnectionLimit ?? 32)
                    log("ServerAdmission: HTTP 429, temporary ceiling \(serverConnectionLimit!); existing requests preserved.")
                }
                guard hasActualFileBytes || retries < 3 else { throw EngineError.httpStatus(status) }
                retries = min(retries + 1, 6)
                var delay = retryAfter ?? pow(2, Double(retries - 1))
                // A zero Retry-After must not create an immediate request storm.
                delay = max(0.1, delay)
                log("WorkerRetry: segment \(segment.segmentId), HTTP \(status), attempt \(retries), waiting \(delay)s; other workers preserved.")
                try await waitForWorkerRetry(delay, planToken: planToken, workerToken: workerToken)
            } catch {
                let failure = error as NSError
                guard failure.domain == NSURLErrorDomain,
                      Self.recoverableRangeTransportCodes.contains(failure.code) else { throw error }
                if !hasActualFileBytes && lease.withLock({ lease.completed == 0 }) {
                    guard firstBodyTransportRetries < 3 else { throw error }
                    firstBodyTransportRetries += 1
                    log("FirstBodyRetry: retry \(firstBodyTransportRetries)/3 before any file bytes; metadata success is not transfer success.")
                    try await waitForWorkerRetry(0, planToken: planToken, workerToken: workerToken)
                    continue
                }
                // A transfer interruption is not a server admission refusal. Keep
                // all healthy workers and reconstruct this worker's next Range
                // from its current lease and the bytes actually written to storage.
                // Verified Neat HTTP downloading path: ordinary disconnect enters
                // a 4500ms delayed reschedule; timeout reschedules directly. Its
                // startup-only budget must not cap progressing download workers.
                transportRetries += 1
                let delay: TimeInterval = failure.code == NSURLErrorTimedOut ? 0 : 4.5
                log("WorkerRetry: segment \(segment.segmentId), transport NSURLErrorDomain(\(failure.code)), attempt \(transportRetries), waiting \(delay)s; other workers preserved.")
                try await waitForWorkerRetry(delay, planToken: planToken, workerToken: workerToken)
            }
        }
    }

    private var hasActualFileBytes: Bool {
        if segmentCompleted.values.contains(where: { $0 > 0 }) { return true }
        if let storage = offsetStorage {
            return storage.snapshot().contains { (storage.writtenPrefix(segmentID: $0.id) ?? 0) > 0 }
        }
        return progress.segmentStates.contains {
            let file = SegmentFileFormat.segmentFileURL(id: Int16($0.id), in: workDirectory)
            return ((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) > 0
        }
    }

    /// Only transient transport errors: never reinterpret certificate/authentication,
    /// representation changes, invalid ranges, file I/O or user cancellation as a retry.
    private static let recoverableRangeTransportCodes: Set<Int> = [
        NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
        NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost,
        NSURLErrorDNSLookupFailed, NSURLErrorNotConnectedToInternet
    ]

    private func waitForWorkerRetry(_ seconds: TimeInterval, planToken: CancelToken, workerToken: CancelToken) async throws {
        var remaining = seconds
        repeat {
            try throwIfStopped()
            if Task.isCancelled { throw CancellationError() }
            if planToken.isCancelled { throw ReplanSignal.requested }
            if workerToken.isCancelled { throw EngineError.cancelled }
            guard remaining > 0 else { return }
            let step = min(0.1, remaining)
            try await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
            remaining -= step
        } while true
    }

    private func downloadSegmentStreaming(
        _ segment: SegmentRecord,
        planToken: CancelToken?,
        workerToken: CancelToken? = nil,
        lease: RangeTransferLease? = nil,
        usesByteRange: Bool = true
    ) async throws {
        let have = usesByteRange
            ? existingBytes(segment)
            : 0
        segmentCompleted[segment.segmentId] = have
        guard !usesByteRange || SegmentFileFormat.remainingRange(for: segment, have: have) != nil else {
            // Already complete
            return
        }

        var req = URLRequest(url: cleanURL)
        if usesByteRange,
           let remaining = SegmentFileFormat.remainingRange(for: segment, have: have) {
            if remaining.end < 0 {
                req.setValue("bytes=\(remaining.start)-", forHTTPHeaderField: "Range")
            } else {
                req.setValue("bytes=\(remaining.start)-\(remaining.end)", forHTTPHeaderField: "Range")
            }
            log("Sending Http-\(normalizedMethod) for Socket ( \(Int(segment.segmentId) + 1) ) Range = \(remaining.start)-\(remaining.end)")
        } else {
            log("Sending clean Http-\(normalizedMethod) for Socket ( \(Int(segment.segmentId) + 1) ) without Range")
        }
        applyHeaders(to: &req)
        applyMethodAndBody(to: &req)
        try applyAuthentication(to: &req)
        if usesByteRange, let representation {
            req.setValue(representation.validator.ifRange, forHTTPHeaderField: "If-Range")
        }

        let fileURL = SegmentFileFormat.segmentFileURL(id: segment.segmentId, in: workDirectory)
        let engine = self
        let token = self.token
        let cancellationTokens = [token] + [planToken, workerToken].compactMap { $0 }
        do {
            var lastChallenge: (Int, String?)?
            for _ in 0..<3 {
                do {
                    let response = try await RangeStreamDownloader.download(
                        request: req,
                        to: fileURL,
                        lease: lease,
                        offsetStorage: usesByteRange ? offsetStorage : nil,
                        expectedValidator: usesByteRange ? representation?.validator : nil,
                        expectedTotal: usesByteRange ? progress.totalBytes : nil,
                        append: usesByteRange && have > 0,
                        isCancelled: {
                            token.isCancelled || (planToken?.isCancelled ?? false) || (workerToken?.isCancelled ?? false)
                        },
                        cancellationTokens: cancellationTokens,
                        limiter: limiter,
                        httpProxy: httpProxyCredentials,
                        socksProxy: socksProxySettings,
                        onBytes: { deltaWritten in
                            Task {
                                await engine.noteSegmentProgress(
                                    segmentID: segment.segmentId,
                                    base: have,
                                    written: deltaWritten,
                                    planToken: planToken,
                                    workerToken: workerToken
                                )
                            }
                        }
                    )
                    recordConnectionSetupSample(
                        response.responseHeaderLatencySeconds
                    )
                    if usesByteRange,
                       let responseTotal = response.contentLengthHint,
                       progress.totalBytes > 0,
                       responseTotal != progress.totalBytes {
                        // A mutable URL changed between probe and a Range body.
                        // Mixing generations can produce a byte-perfect length
                        // with semantically corrupt content, so fail this attempt.
                        throw EngineError.invalidResponse
                    }
                    lastChallenge = nil
                    break
                } catch let EngineError.authRequired(status, challenge) {
                    lastChallenge = (status, challenge)
                    try prepareChallengeAuth(status: status, header: challenge)
                    if usesByteRange, let lease,
                       let remaining = lease.withLock({ SegmentFileFormat.remainingRange(for: lease.segment, have: lease.completed) }) {
                        req.setValue("bytes=\(remaining.start)-\(remaining.end)", forHTTPHeaderField: "Range")
                    }
                    applyHeaders(to: &req)
                    try applyAuthentication(to: &req)
                }
            }
            if let (status, challenge) = lastChallenge {
                throw EngineError.authRequired(status: status, challenge: challenge)
            }
        } catch {
            if token.isPaused { throw EngineError.paused }
            if token.isCancelled { throw EngineError.cancelled }
            if planToken?.isCancelled == true { throw ReplanSignal.requested }
            throw error
        }
        if token.isCancelled {
            if token.isPaused { throw EngineError.paused }
            throw EngineError.cancelled
        }
        let finalHave = existingBytes(segment)
        segmentCompleted[segment.segmentId] = finalHave
        recountProgress()
    }

    private func noteSegmentProgress(
        segmentID: Int16,
        base: Int64,
        written: Int64,
        planToken: CancelToken?,
        workerToken: CancelToken?
    ) {
        if planToken?.isCancelled == true || workerToken?.isCancelled == true { return }
        if offsetStorage != nil, ProcessInfo.processInfo.systemUptime - lastOffsetCheckpoint >= 1 {
            do {
                try offsetStorage?.checkpoint()
                lastOffsetCheckpoint = ProcessInfo.processInfo.systemUptime
            } catch {
                offsetCheckpointFailure = error
                activePlanToken?.cancel()
                return
            }
        }
        // A cancelled round is immediately followed by a disk-backed replan.
        // Ignore callbacks queued by the old URLSession delegate after that point,
        // otherwise a reused segment id can inflate the new plan's progress.
        let completed = max(segmentCompleted[segmentID] ?? 0, base + written)
        segmentCompleted[segmentID] = completed
        if let idx = progress.segmentStates.firstIndex(where: { $0.id == Int(segmentID) }) {
            progress.segmentStates[idx].completed = min(
                progress.segmentStates[idx].length,
                completed
            )
        }
        recountProgress()
    }

    private func recountProgress() {
        let sum = segmentCompleted.values.reduce(Int64(0), +)
        let delta = sum - lastSpeedSample
        if delta > 0 {
            speedWindowBytes += delta
            lastSpeedSample = sum
        }
        let dt = Date().timeIntervalSince(speedWindowStart)
        if dt >= 0.5 {
            progress.bytesPerSecond = Double(speedWindowBytes) / max(dt, 0.001)
            speedWindowStart = Date()
            speedWindowBytes = 0
        }
        progress.completedBytes = sum
    }

    private func installProgressPlan(_ segments: [SegmentRecord], resetSpeed: Bool = true) {
        segmentCompleted.removeAll(keepingCapacity: true)
        progress.segmentStates = segments.map { segment in
            let have = existingBytes(segment)
            segmentCompleted[segment.segmentId] = have
            return SegmentState(
                id: Int(segment.segmentId),
                start: segment.start,
                end: segment.end,
                completed: have,
                isFinished: have >= segment.length
            )
        }
        // Baseline the speed sampler to the bytes already on disk before this
        // resume. Without this, the first recount treats every previously
        // downloaded byte as if it arrived in this instant — the "resume →
        // fake 900 MB/s spike" bug. Real throughput starts from zero here.
        let resumedSum = segmentCompleted.values.reduce(Int64(0), +)
        if resetSpeed {
            lastSpeedSample = resumedSum
            speedWindowBytes = 0
            speedWindowStart = Date()
        }
        recountProgress()
    }

    private func replanPersistedSegments(
        _ existing: [SegmentRecord],
        total: Int64,
        connectionTarget: Int? = nil
    ) throws -> [SegmentRecord] {
        var completed: [Int16: Int64] = [:]
        for segment in existing {
            completed[segment.segmentId] = existingBytes(segment)
        }
        let replanned = SegmentFileFormat.replanConnections(
            existing: existing,
            totalBytes: total,
            newConnections: connectionTarget ?? currentConnections,
            completedByID: completed
        )
        try writeSegmentsBin(replanned, provenance: .init(origins: [:], rebalanceDisabled: provenanceState.rebalanceDisabled))
        installProgressPlan(replanned)
        return replanned
    }

    /// Servers that do not support Range still get a safe download path. It is
    /// intentionally non-resumable: an old prefix is never appended to a 200
    /// response, matching the original engine's silent fresh-redownload fallback.
    private func downloadSingleStream(total: Int64, finalURL: URL, downloadedBody: URL? = nil) async throws {
        // Unbounded/single-stream records are not resumable tail ownership plans.
        provenanceEnabled = false
        provenancePlan = []
        provenanceState = .init(origins: [:], rebalanceDisabled: false)
        var segment = SegmentRecord(
            order: 0,
            segmentId: 0,
            nextId: SegmentRecord.endOfList,
            start: 0,
            end: total > 0 ? total - 1 : -1
        )
        installProgressPlan([segment])
        try writeSegmentsBin([segment])
        log("New Socket(s) Created. MaxAllowedConnection = \(currentConnections) And ActiveSockets = 1")
        progress.activeRequests = 1
        progress.requestLimit = 1
        do {
            if let downloadedBody {
                let part = SegmentFileFormat.segmentFileURL(id: segment.segmentId, in: workDirectory)
                try FileManager.default.moveItem(at: downloadedBody, to: part)
                // Retire before a cross-volume merge can register its own receipt.
                try finishBootstrap()
                if let representation { try representation.save(in: workDirectory) }
            } else {
                try await downloadSegmentStreaming(segment, planToken: nil, usesByteRange: false)
            }
            progress.activeRequests = 0
        } catch {
            progress.activeRequests = 0
            throw error
        }
        try throwIfStopped()

        let part = SegmentFileFormat.segmentFileURL(id: segment.segmentId, in: workDirectory)
        let actualBytes = SegmentFileFormat.rawExistingByteCount(
            for: segment,
            in: workDirectory
        )
        if total > 0, actualBytes != total {
            // A completed response with the wrong length may be an error page,
            // not a prefix of the file. Never reuse it on a later Range resume.
            try discardSegmentArtifacts(reason: "server returned an invalid single-stream body")
            progress.completedBytes = 0
            progress.segmentStates = []
            throw EngineError.incompleteResponse(expected: total, received: actualBytes)
        }
        if total <= 0 {
            segment.end = actualBytes - 1
            progress.totalBytes = actualBytes
            try writeSegmentsBin([segment])
        }
        progress.completedBytes = actualBytes
        progress.segmentStates = [
            SegmentState(
                id: Int(segment.segmentId),
                start: segment.start,
                end: segment.end,
                completed: actualBytes,
                isFinished: true
            ),
        ]

        setState(.merging)
        log("DownloadEngine State Changed : Downloading... -> Merging...")
        // Publish the completed bytes atomically; explicit redownload replaces the old file.
        if renamex_np(part.path, finalURL.path, canReplace(finalURL) ? 0 : UInt32(RENAME_EXCL)) != 0 {
            let code = errno
            guard code == EXDEV else { throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO) }
            // The complete bootstrap is already on disk. Same-volume rename
            // needs no second payload allocation; only a cross-volume copy does.
            if downloadedBody != nil { try validateStorage(totalBytes: actualBytes) }
            try mergeSegments([segment], to: finalURL, total: actualBytes)
        }
    }

    private func mergeSegments(_ segments: [SegmentRecord], to finalURL: URL, total: Int64) throws {
        let staging = finalURL.deletingLastPathComponent().appendingPathComponent(".ndm-merge-\(taskID)-\(UUID()).partial")
        let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL, 0o666)
        guard descriptor >= 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let out = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? out.close() }
        let receipt = try MergeStagingReceipt.register(taskID: taskID, staging: staging, descriptor: descriptor, in: workDirectory)
        defer { try? receipt.finish(in: workDirectory) }
        if total > 0 {
            try out.truncate(atOffset: UInt64(total))
        }

        let ordered = segments.sorted { $0.start < $1.start }
        var assembledBytes: Int64 = 0
        for seg in ordered {
            try checkMergeCancellation()
            let part = SegmentFileFormat.segmentFileURL(id: seg.segmentId, in: workDirectory)
            guard FileManager.default.fileExists(atPath: part.path) else {
                throw EngineError.mergeFailed("Internal Error. Failed on Merging segments.")
            }
            let have = SegmentFileFormat.rawExistingByteCount(for: seg, in: workDirectory)
            // Tolerate a segment file that overran its planned length (e.g. a
            // bootstrap prefix that a later re-plan shrank): the leading
            // seg.length bytes are the correct contiguous data for this range.
            guard have >= seg.length else {
                throw EngineError.mergeFailed("Internal Error. Failed on Merging segments.")
            }
            try out.seek(toOffset: UInt64(seg.start))
            do {
                let input = try FileHandle(forReadingFrom: part)
                defer { try? input.close() }
                var remaining = seg.length
                while remaining > 0,
                      let chunk = try input.read(upToCount: Int(min(1_048_576, remaining))),
                      !chunk.isEmpty {
                    try checkMergeCancellation()
                    try out.write(contentsOf: chunk)
                    remaining -= Int64(chunk.count)
                    assembledBytes += Int64(chunk.count)
                    mergeWriteObserver?(assembledBytes)
                }
                guard remaining == 0 else {
                    throw EngineError.mergeFailed("Internal Error. Failed on Merging segments.")
                }
            }
        }
        try checkMergeCancellation()
        try out.synchronize()
        try out.close()
        try checkMergeCancellation()
        // The old complete file stays intact until this atomic publication succeeds.
        guard renamex_np(staging.path, finalURL.path, canReplace(finalURL) ? 0 : UInt32(RENAME_EXCL)) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        progress.completedBytes = total
        progress.totalBytes = total
        progress.segmentStates = segments.map {
            SegmentState(id: Int($0.segmentId), start: $0.start, end: $0.end, completed: $0.length, isFinished: true)
        }
    }

    private func canReplace(_ destination: URL) -> Bool {
        request.replacingDestination?.standardizedFileURL == destination.standardizedFileURL
    }

    private func checkMergeCancellation() throws {
        try throwIfStopped()
        do { try Task.checkCancellation() }
        catch { throw EngineError.cancelled }
    }

    private func existingBytes(_ segment: SegmentRecord) -> Int64 {
        if let storage = offsetStorage { return min(segment.length, storage.writtenPrefix(segmentID: segment.segmentId) ?? 0) }
        return SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
    }
    private func offsetSegments(_ storage: OffsetDownloadStorage) -> [SegmentRecord] {
        let ranges = storage.snapshot().sorted { $0.start < $1.start }
        return ranges.enumerated().map { index, range in
            SegmentRecord(order: Int16(index), segmentId: range.id,
                          nextId: index + 1 < ranges.count ? Int32(ranges[index + 1].id) : SegmentRecord.endOfList,
                          start: range.start, end: range.end)
        }
    }
    private func createOffsetStorage(_ segments: [SegmentRecord], total: Int64, finalURL: URL) throws -> OffsetDownloadStorage {
        guard let representation else { throw EngineError.invalidResponse }
        try prepareTailProvenance(segments, state: provenanceState)
        let storage = try OffsetDownloadStorage.create(taskID: taskID, workDirectory: workDirectory, destinationURL: finalURL,
            totalBytes: total, resourceContextHash: representation.storageContextHash,
            ranges: segments.map { .init(id: $0.segmentId, start: $0.start, end: $0.end, durablePrefix: 0) },
            replacingExisting: canReplace(finalURL))
        provenancePlan = segments
        return storage
    }

    private func restoreTailProvenance(for segments: [SegmentRecord]) throws {
        provenancePlan = segments
        guard let representation else { return }
        let journal = TailSplitProvenance(workDirectory: workDirectory, resourceContextHash: representation.storageContextHash)
        provenanceState = try journal.load(for: segments) ?? .init(origins: [:], rebalanceDisabled: false)
    }

    private func validTailOrigins(_ origins: [Int16: SegmentRecord], for segments: [SegmentRecord]) -> [Int16: SegmentRecord] {
        origins.filter { id, parent in
            SegmentFileFormat.rollbackTailSplit(existing: segments, failedSegmentID: id, originalParent: parent) != nil
        }
    }

    private func prepareTailProvenance(_ segments: [SegmentRecord], state: TailSplitProvenance.State) throws {
        guard provenanceEnabled, let representation else { return }
        try TailSplitProvenance(workDirectory: workDirectory, resourceContextHash: representation.storageContextHash)
            .prepare(from: provenancePlan, to: segments, state: state)
    }

    private func writeSegmentsBin(_ segments: [SegmentRecord], provenance: TailSplitProvenance.State? = nil) throws {
        let state = provenance ?? provenanceState
        try prepareTailProvenance(segments, state: state)
        if let storage = offsetStorage {
            try storage.replacePlanPreservingWritten(segments.map { .init(id: $0.segmentId, start: $0.start, end: $0.end, durablePrefix: 0) })
        } else {
            let data = SegmentFileFormat.serialize(segments)
            try data.write(to: workDirectory.appendingPathComponent("segments.bin"), options: .atomic)
        }
        provenancePlan = segments
        provenanceState = state
    }

    private func throwIfStopped() throws {
        if token.isPaused { throw EngineError.paused }
        if token.isCancelled { throw EngineError.cancelled }
    }

    // MARK: - Helpers

    private func setState(_ s: EngineState) {
        let old = engineState
        engineState = s
        if old != s {
            log("DownloadEngine State Changed : \(old.rawValue) -> \(s.rawValue)")
        }
    }

    /// Methods that may carry `request.body`. This allowlist is load-bearing:
    /// `DownloadTask.postData` doubles as storage for serialized yt-dlp options,
    /// and those tasks keep method GET. Gating the body on the method keeps media
    /// option JSON from ever being sent as a request body.
    private static let bodyBearingMethods: Set<String> = ["POST", "PUT", "PATCH"]

    private var normalizedMethod: String {
        let m = request.method.uppercased()
        return m.isEmpty ? "GET" : m
    }

    private var carriesBody: Bool {
        Self.bodyBearingMethods.contains(normalizedMethod)
            && !(request.body?.isEmpty ?? true)
    }

    /// Apply the task's real HTTP method and body. Must run *after*
    /// `applyHeaders` so a browser-captured Content-Type wins over our default.
    private func applyMethodAndBody(to req: inout URLRequest) {
        req.httpMethod = normalizedMethod
        guard carriesBody, let body = request.body else { return }
        req.httpBody = body
        if req.value(forHTTPHeaderField: "Content-Type") == nil {
            req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        }
    }

    private func applyHeaders(to req: inout URLRequest) {
        if let ua = request.userAgent {
            req.setValue(ua, forHTTPHeaderField: "User-Agent")
        } else {
            req.setValue(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Safari/537.36",
                forHTTPHeaderField: "User-Agent"
            )
        }
        req.setValue("*/*", forHTTPHeaderField: "Accept")
        req.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        req.setValue("en-US,en;q=0.9", forHTTPHeaderField: "Accept-Language")
        req.setValue("*", forHTTPHeaderField: "Accept-Charset")
        if let user = request.username ?? request.url.user, !user.isEmpty {
            let password = request.password ?? request.url.password ?? ""
            req.setValue("Basic " + Data("\(user):\(password)".utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        }
        // B05 — HTTP proxy Basic credentials (independent of origin Authorization).
        if let proxy = httpProxyCredentials, proxy.enabled,
           let u = proxy.username, !u.isEmpty {
            let raw = "\(u):\(proxy.password ?? "")"
            if let data = raw.data(using: .utf8) {
                req.setValue("Basic \(data.base64EncodedString())", forHTTPHeaderField: "Proxy-Authorization")
            }
        }
        for (k, v) in request.headers {
            req.setValue(v, forHTTPHeaderField: k)
        }
        if let page = request.pageURL {
            if req.value(forHTTPHeaderField: "Referer") == nil {
                req.setValue(page.absoluteString, forHTTPHeaderField: "Referer")
            }
            if req.value(forHTTPHeaderField: "Origin") == nil, let host = page.host {
                req.setValue("\(page.scheme ?? "https")://\(host)", forHTTPHeaderField: "Origin")
            }
        }
    }

    private func nonEmptyName(_ s: String) -> String {
        s.isEmpty ? "download.bin" : s
    }

    private func openLog() {
        let url = workDirectory.appendingPathComponent("LogFile.txt")
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        logHandle = try? FileHandle(forWritingTo: url)
        _ = try? logHandle?.seekToEnd()
        log("Opening LogFile...")
    }

    private func closeLog() {
        try? logHandle?.close()
        logHandle = nil
    }

    private func log(_ line: String) {
        let ts = Int(Date().timeIntervalSince1970)
        let formatted = "INFO   \(isoNow()) ( \(ts) )   \(line)\n"
        if let data = formatted.data(using: .utf8) {
            try? logHandle?.write(contentsOf: data)
        }
    }

    private func isoNow() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f.string(from: Date())
    }
}

public enum EngineError: Error, LocalizedError {
    case invalidResponse
    case incompleteResponse(expected: Int64, received: Int64)
    case httpStatus(Int)
    case temporarilyUnavailable(status: Int, retryAfter: TimeInterval?)
    case cancelled
    case paused
    case notResumable
    case mergeFailed(String)
    case insufficientStorage(requiredBytes: Int64, availableBytes: Int64)
    case authRequired(status: Int, challenge: String?)

    public var errorDescription: String? {
        switch self {
        case .incompleteResponse(let expected, let received):
            return L10n.t(
                "The server returned \(received) bytes instead of the expected \(expected). Retry shortly with fewer connections, or obtain a fresh download link.",
                "服务器只返回了 \(received) 字节，预期为 \(expected) 字节。请稍后降低连接数重试，或重新获取下载链接。"
            )
        case .invalidResponse: return "Invalid HTTP response"
        case .httpStatus(let c), .temporarilyUnavailable(let c, _): return "HTTP status \(c)"
        case .cancelled: return "Download Canceled By User."
        case .paused: return "Download paused"
        case .notResumable: return "Server does not support resume"
        case .mergeFailed(let m): return m
        case .insufficientStorage(let required, let available):
            return L10n.storageGuardError(
                requiredBytes: required,
                availableBytes: available
            )
        case .authRequired(let s, _): return "Authentication required (HTTP \(s))"
        }
    }
}
