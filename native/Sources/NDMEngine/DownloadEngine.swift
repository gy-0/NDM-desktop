import Foundation
import NDMCore

/// Multi-connection HTTP(S) download engine.
///
/// State path: Unknown → Starting → Downloading → Merging → Completed.
/// Resume: reload `segments.bin` + partial `seg.xN` files.
public actor DownloadEngine {
    public private(set) var progress: DownloadProgress
    public private(set) var engineState: EngineState = .unknown

    private let request: DownloadRequest
    private let taskID: Int64
    private let workDirectory: URL
    private let capacityProvider: @Sendable (URL) -> Int64?
    private let sameVolumeProvider: @Sendable (URL, URL) -> Bool
    private var session: URLSession
    private let token = CancelToken()
    private var logHandle: FileHandle?
    /// Per-segment completed bytes (for live aggregate progress).
    private var segmentCompleted: [Int16: Int64] = [:]
    private var speedWindowStart = Date()
    private var speedWindowBytes: Int64 = 0
    private var lastSpeedSample: Int64 = 0
    private let limiter: BandwidthLimiter
    /// Extra Authorization header after Digest / NTLM negotiate.
    private var authAuthorization: String?
    private var authIsProxy = false
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
        }
    ) {
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
        self.session = URLSession(configuration: config)
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

    public func pause() {
        token.pause()
        engineState = .paused
        progress.status = .paused
        tuneTask?.cancel()
        log("DownloadEngine State Changed : Downloading... -> Paused")
    }

    public func cancel() {
        token.cancel()
        session.invalidateAndCancel()
        progress.status = .incomplete
        tuneTask?.cancel()
        log("Download Canceled By User.")
    }

    @discardableResult
    public func start() async throws -> URL {
        guard !Task.isCancelled else { throw EngineError.cancelled }
        try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        token.reset()
        openLog()
        defer { closeLog() }
        setState(.starting)
        log("DownloadID = \(taskID) , Protocol = HTTPS , OS = MAC , AppVersion = MacOpenRE")
        log("DownloadEngine is Starting...")
        log("Trying to Start Download for -> \(request.url.absoluteString)")

        let probe = try await probeRemoteWithAuth()
        let total = probe.contentLength ?? 0
        progress.totalBytes = total
        progress.status = .downloading

        let acceptRanges = probe.acceptRanges && total > 0

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
        try validateStorage(totalBytes: total, finalURL: finalURL)

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

        if acceptRanges {
            do {
                var segments: [SegmentRecord]
                if let existing = try loadSegmentsForResume(total: total) {
                    segments = existing
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
                    try writeSegmentsBin(segments)
                    log("SegmentManager Created a New Segment and now has \(segments.count) Segments.")
                } else {
                    segments = SegmentFileFormat.planEqualSegments(totalBytes: total, connections: 1)
                    installProgressPlan(segments)
                    try writeSegmentsBin(segments)
                }

                if tuningActive {
                    tuneTask = Task { await self.runAutoTune() }
                }
                let finalSegments = try await downloadSegmentsWithReplanning(segments, total: total)
                tuneTask?.cancel()
                tuneTask = nil
                try throwIfStopped()

                setState(.merging)
                log("DownloadEngine State Changed : Downloading... -> Merging...")
                do {
                    try mergeSegments(finalSegments, to: finalURL, total: total)
                } catch {
                    // A failed merge leaves an unusable half-assembled state.
                    // Discard the segment artifacts so a Retry re-downloads from
                    // scratch instead of hitting the same broken merge forever.
                    try? discardSegmentArtifacts(reason: "merge failed")
                    throw error
                }
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
                try discardSegmentArtifacts(reason: "server ignored Range")
                try await downloadSingleStream(total: total, finalURL: finalURL)
            } catch {
                tuneTask?.cancel()
                tuneTask = nil
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

    private func validateStorage(totalBytes: Int64, finalURL: URL) throws {
        guard totalBytes > 0 else { return }
        let existingWork = existingResumableBytes(totalBytes: totalBytes)
        let existingDestination = Self.fileSize(at: finalURL)
        let sharesVolume = sameVolumeProvider(workDirectory, request.destinationDirectory)
        let budget = DirectDownloadStorageBudget(
            totalBytes: totalBytes,
            existingWorkBytes: existingWork,
            existingDestinationBytes: existingDestination,
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

    private static func fileSize(at url: URL) -> Int64 {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attributes[.size] as? NSNumber else { return 0 }
        return max(0, size.int64Value)
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
            guard name == "segments.bin" || name.hasPrefix("seg.x") else { continue }
            try FileManager.default.removeItem(at: file)
            removed += 1
        }
        if removed > 0 {
            log("Discarded \(removed) temporary segment artifact(s): \(reason).")
        }
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
        guard let existing = try SegmentFileFormat.loadSegmentsBin(from: workDirectory), !existing.isEmpty else {
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
    }

    private func probeRemoteWithAuth() async throws -> Probe {
        var lastChallenge: String?
        for _ in 0..<3 {
            do {
                return try await probeRemote()
            } catch let EngineError.authRequired(status, challenge) {
                lastChallenge = challenge
                try prepareChallengeAuth(status: status, header: challenge)
            }
        }
        throw EngineError.authRequired(status: 401, challenge: lastChallenge)
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
        do {
            let (_, response) = try await session.data(for: req)
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
                        mimeType: http.value(forHTTPHeaderField: "Content-Type")
                    )
                }
            }
        } catch let e as EngineError {
            throw e
        } catch {
            // fall through
        }
        return try await probeWithRangeGet()
    }

    private func probeWithRangeGet() async throws -> Probe {
        var req = URLRequest(url: cleanURL)
        req.setValue("bytes=0-0", forHTTPHeaderField: "Range")
        applyHeaders(to: &req)
        applyMethodAndBody(to: &req)
        let (_, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw EngineError.invalidResponse }
        if http.statusCode == 401 || http.statusCode == 407 {
            throw EngineError.authRequired(
                status: http.statusCode,
                challenge: http.value(forHTTPHeaderField: "WWW-Authenticate")
                    ?? http.value(forHTTPHeaderField: "Proxy-Authenticate")
            )
        }
        var length: Int64?
        if let range = http.value(forHTTPHeaderField: "Content-Range"),
           let total = range.split(separator: "/").last,
           let n = Int64(total), n > 0 {
            length = n
        }
        return Probe(
            contentLength: length,
            acceptRanges: http.statusCode == 206,
            suggestedFilename: http.suggestedFilename,
            mimeType: http.value(forHTTPHeaderField: "Content-Type")
        )
    }

    /// Advance Digest (1-shot) or NTLM (Type1 → Type3) state from a WWW/Proxy-Authenticate header.
    private func prepareChallengeAuth(status: Int, header: String?) throws {
        authIsProxy = (status == 407)
        let user = request.username ?? request.url.user
        let pass = request.password ?? request.url.password ?? ""
        guard let user, !user.isEmpty else {
            throw EngineError.authRequired(status: status, challenge: header)
        }

        if let header, let digest = DigestAuth.parseChallenge(from: header, isProxy: authIsProxy) {
            let uri = request.url.path.isEmpty ? "/" : request.url.path
            authAuthorization = DigestAuth.authorizationHeader(
                challenge: digest,
                username: user,
                password: pass,
                method: request.method,
                uri: uri
            )
            log("Applied Digest auth for realm=\(digest.realm)")
            return
        }

        if NTLMAuth.isNTLMChallenge(header) {
            if let type2 = NTLMAuth.parseType2(from: header) {
                authAuthorization = NTLMAuth.type3AuthorizationHeader(
                    type2: type2,
                    username: user,
                    password: pass,
                    isProxy: authIsProxy
                )
                log("Applied NTLM Type3 auth")
            } else {
                authAuthorization = NTLMAuth.type1AuthorizationHeader(isProxy: authIsProxy)
                log("Applied NTLM Type1 negotiate")
            }
            return
        }

        throw EngineError.authRequired(status: status, challenge: header)
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
        var automaticTailOrigins: [Int16: SegmentRecord] = [:]
        var allowsAutomaticTailRebalance = true
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
                    let discarded = SegmentFileFormat.rawExistingByteCount(
                        for: segments.first(where: {
                            $0.segmentId == failure.segmentID
                        }) ?? parent,
                        in: workDirectory
                    )
                    try writeSegmentsBin(rollback.records)
                    installProgressPlan(rollback.records)
                    if FileManager.default.fileExists(atPath: failedFile.path) {
                        try? FileManager.default.removeItem(at: failedFile)
                    }
                    automaticTailOrigins.removeValue(forKey: failure.segmentID)
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
            SegmentFileFormat.existingByteCount(for: $0, in: workDirectory) < $0.length
        }
        guard !pending.isEmpty else { return }
        let roundStartedAt = Date()
        let initialRemainingBytes = pending.reduce(Int64(0)) { sum, segment in
            sum + max(0, segment.length - SegmentFileFormat.existingByteCount(for: segment, in: workDirectory))
        }
        let limit = max(1, min(currentConnections, maxConcurrent, pending.count))
        log("New Socket(s) Created. MaxAllowedConnection = \(currentConnections) And ActiveSockets = \(limit)")
        let failureBox = RoundFailureBox()
        do {
            try await withThrowingTaskGroup(of: Int16.self) { group in
                var workers: [Int16: CancelToken] = [:]
                // Structured task cancellation alone does not stop delegate-based
                // URLSession writes. Also drain them if persisting a split fails.
                defer { for worker in workers.values { worker.cancel() } }
                var donorID: Int16?
                func enqueue(_ segment: SegmentRecord) {
                    let workerToken = CancelToken()
                    workers[segment.segmentId] = workerToken
                    group.addTask {
                        do {
                            try await self.downloadSegmentWithRetries(
                                segment, planToken: planToken, workerToken: workerToken
                            )
                            return segment.segmentId
                        } catch {
                            // Only the selected donor yields. Its writer is closed before
                            // this result is delivered; unrelated URLSession tasks stay live.
                            if workerToken.isCancelled && !planToken.isCancelled,
                               let engineError = error as? EngineError,
                               case .cancelled = engineError {
                                return segment.segmentId
                            }
                            if !(error is ReplanSignal) {
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
                    if donorID == segmentID {
                        donorID = nil
                        if let parent = segments.first(where: { $0.segmentId == segmentID }) {
                            let have = SegmentFileFormat.existingByteCount(for: parent, in: workDirectory)
                            if !serverRefusedWorkers, let split = SegmentFileFormat.splitUnwrittenTail(
                                existing: segments, donorID: segmentID, completedBytes: have
                            ) {
                                // Persist the shortened parent and new child together, before
                                // either writer starts. Existing prefixes never move or truncate.
                                try writeSegmentsBin(split.records)
                                segments = split.records
                                automaticTailOrigins[split.child.segmentId] = parent
                                installProgressPlan(segments, resetSpeed: false)
                                pending.append(split.parent)
                                pending.append(split.child)
                                log("TailHandoff: split segment \(segmentID); child \(split.child.segmentId), \(workers.count) other workers preserved.")
                            } else if have < parent.length {
                                pending.append(parent)
                            } else {
                                markSegmentFinished(segmentID)
                            }
                        }
                    } else {
                        markSegmentFinished(segmentID)
                    }
                    let desiredActive = max(1, min(currentConnections, maxConcurrent))
                    while !pending.isEmpty, workers.count < desiredActive {
                        enqueue(pending.removeFirst())
                    }
                    // Claim queued work first. Only one donor can be yielding at a time;
                    // requests never exceed the user's cap while its file is being closed.
                    if pending.isEmpty, donorID == nil, allowTailRebalance, !serverRefusedWorkers,
                       workers.count > 0, workers.count < desiredActive {
                        let worthSplitting = !autoTune || tailRebalancePlan(
                            segments, activeConnections: workers.count,
                            targetConnections: currentConnections, useSetupPayback: true,
                            roundStartedAt: roundStartedAt,
                            initialRemainingBytes: initialRemainingBytes
                        ) != nil
                        let candidates = segments.filter { workers[$0.segmentId] != nil }
                        let donor = candidates.max { lhs, rhs in
                            let left = lhs.length - SegmentFileFormat.existingByteCount(for: lhs, in: workDirectory)
                            let right = rhs.length - SegmentFileFormat.existingByteCount(for: rhs, in: workDirectory)
                            // For equal tails prefer the earlier range, like the verified selector.
                            return left == right ? lhs.start > rhs.start : left < right
                        }
                        if worthSplitting, let donor,
                           donor.length - SegmentFileFormat.existingByteCount(for: donor, in: workDirectory)
                            > SegmentFileFormat.originalHTTPPlanningQuantumBytes,
                           segments.count < Int(Int16.max) {
                            donorID = donor.segmentId
                            workers[donor.segmentId]?.cancel()
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
            let have = SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
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
        _ segment: SegmentRecord, planToken: CancelToken, workerToken: CancelToken
    ) async throws {
        while true {
            try throwIfStopped()
            if planToken.isCancelled { throw ReplanSignal.requested }
            if workerToken.isCancelled { throw EngineError.cancelled }
            let ceiling = min(currentConnections, serverConnectionLimit ?? 32)
            if activeRangeRequests < ceiling { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        activeRangeRequests += 1
        progress.activeRequests = activeRangeRequests
        progress.requestLimit = min(currentConnections, serverConnectionLimit ?? 32)
        defer {
            activeRangeRequests -= 1
            progress.activeRequests = activeRangeRequests
        }
        try await downloadSegmentStreaming(segment, planToken: planToken, workerToken: workerToken)
    }

    /// Retry only the refused worker. Other ranges keep their requests and data.
    /// Every retry reconstructs its Range from disk, never from a stale byte count.
    private func downloadSegmentWithRetries(
        _ segment: SegmentRecord, planToken: CancelToken, workerToken: CancelToken
    ) async throws {
        var retries = 0
        while true {
            do {
                try await performRangeAttempt(
                    segment, planToken: planToken, workerToken: workerToken
                )
                return
            } catch let EngineError.temporarilyUnavailable(status, retryAfter) {
                serverRefusedWorkers = true
                // Each explicit refusal lowers admission by one. In a 32 -> 4
                // cap test, the 28 rejected requests leave four healthy workers.
                // This is a conservative NDM policy, not a reverse-engineered
                // claim that a single 429 reveals the server's exact capacity.
                serverConnectionLimit = max(1, min(serverConnectionLimit ?? currentConnections, currentConnections) - 1)
                progress.requestLimit = min(currentConnections, serverConnectionLimit ?? 32)
                log("ServerAdmission: HTTP \(status), ceiling \(serverConnectionLimit!), configured \(currentConnections); existing requests preserved.")
                guard retries < 3 else { throw EngineError.httpStatus(status) }
                retries += 1
                var delay = retryAfter ?? pow(2, Double(retries - 1))
                // A zero Retry-After must not create an immediate request storm.
                delay = max(0.1, delay)
                log("WorkerRetry: segment \(segment.segmentId), HTTP \(status), attempt \(retries), waiting \(delay)s; other workers preserved.")
                while delay > 0 {
                    try throwIfStopped()
                    if planToken.isCancelled { throw ReplanSignal.requested }
                    if workerToken.isCancelled { throw EngineError.cancelled }
                    let step = min(0.1, delay)
                    try await Task.sleep(nanoseconds: UInt64(step * 1_000_000_000))
                    delay -= step
                }
            }
        }
    }

    private func downloadSegmentStreaming(
        _ segment: SegmentRecord,
        planToken: CancelToken?,
        workerToken: CancelToken? = nil,
        usesByteRange: Bool = true
    ) async throws {
        let have = usesByteRange
            ? SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
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
                    applyHeaders(to: &req)
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
        let finalHave = SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
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
        // A cancelled round is immediately followed by a disk-backed replan.
        // Ignore callbacks queued by the old URLSession delegate after that point,
        // otherwise a reused segment id can inflate the new plan's progress.
        if planToken?.isCancelled == true || workerToken?.isCancelled == true { return }
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
            let have = SegmentFileFormat.existingByteCount(for: segment, in: workDirectory)
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
            completed[segment.segmentId] = SegmentFileFormat.existingByteCount(
                for: segment,
                in: workDirectory
            )
        }
        let replanned = SegmentFileFormat.replanConnections(
            existing: existing,
            totalBytes: total,
            newConnections: connectionTarget ?? currentConnections,
            completedByID: completed
        )
        try writeSegmentsBin(replanned)
        installProgressPlan(replanned)
        return replanned
    }

    /// Servers that do not support Range still get a safe download path. It is
    /// intentionally non-resumable: an old prefix is never appended to a 200
    /// response, matching the original engine's silent fresh-redownload fallback.
    private func downloadSingleStream(total: Int64, finalURL: URL) async throws {
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
        try await downloadSegmentStreaming(
            segment,
            planToken: nil,
            usesByteRange: false
        )
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
        if FileManager.default.fileExists(atPath: finalURL.path) {
            try FileManager.default.removeItem(at: finalURL)
        }
        do {
            try FileManager.default.moveItem(at: part, to: finalURL)
        } catch {
            try FileManager.default.copyItem(at: part, to: finalURL)
            try? FileManager.default.removeItem(at: part)
        }
    }

    private func mergeSegments(_ segments: [SegmentRecord], to finalURL: URL, total: Int64) throws {
        if FileManager.default.fileExists(atPath: finalURL.path) {
            try FileManager.default.removeItem(at: finalURL)
        }
        FileManager.default.createFile(atPath: finalURL.path, contents: nil)
        let out = try FileHandle(forWritingTo: finalURL)
        defer { try? out.close() }
        if total > 0 {
            try out.truncate(atOffset: UInt64(total))
        }

        let ordered = segments.sorted { $0.start < $1.start }
        for seg in ordered {
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
                    try out.write(contentsOf: chunk)
                    remaining -= Int64(chunk.count)
                }
                guard remaining == 0 else {
                    throw EngineError.mergeFailed("Internal Error. Failed on Merging segments.")
                }
            }
        }
        progress.completedBytes = total
        progress.totalBytes = total
        progress.segmentStates = segments.map {
            SegmentState(id: Int($0.segmentId), start: $0.start, end: $0.end, completed: $0.length, isFinished: true)
        }
    }

    private func writeSegmentsBin(_ segments: [SegmentRecord]) throws {
        let data = SegmentFileFormat.serialize(segments)
        try data.write(to: workDirectory.appendingPathComponent("segments.bin"), options: .atomic)
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
        if let auth = authAuthorization {
            let field = authIsProxy ? "Proxy-Authorization" : "Authorization"
            req.setValue(auth, forHTTPHeaderField: field)
        } else {
            // Preemptive Basic for simple servers; Digest/NTLM overwrite via authAuthorization.
            let user = request.username ?? request.url.user
            let pass = request.password ?? request.url.password ?? ""
            if let user, !user.isEmpty {
                let raw = "\(user):\(pass)"
                if let data = raw.data(using: .utf8) {
                    req.setValue("Basic \(data.base64EncodedString())", forHTTPHeaderField: "Authorization")
                }
            }
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
