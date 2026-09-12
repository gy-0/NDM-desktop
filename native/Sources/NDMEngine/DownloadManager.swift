import Foundation
import CryptoKit
import NDMCore

/// Coordinates queue of download engines and persists task state (NeatDBHelper role).
public actor DownloadManager {
    public typealias FileRecycler = @Sendable (URL) async throws -> Void

    private let store: DownloadStore
    /// Full-text index over transcripts and task metadata. Optional so a search
    /// index that cannot be opened degrades search rather than breaking downloads.
    /// Held exactly like `store`: both are lock-guarded classes, so an actor can own
    /// them without further ceremony.
    private let searchIndex: SearchIndexStore?
    /// Index problems, most recent last. Indexing must never fail a download or a
    /// removal — it is derived data — but silence is how this class of bug hides, so
    /// failures are recorded where a caller or a test can see them.
    private var recordedSearchIndexFailures: [String] = []
    private var settings: AppSettings
    private let supportRoot: URL
    private let fileRecycler: FileRecycler?
    private let capacityProvider: @Sendable (URL) -> Int64?
    private let sameVolumeProvider: @Sendable (URL, URL) -> Bool
    private var engines: [Int64: DownloadEngine] = [:]
    private var hlsEngines: [Int64: HLSEngine] = [:]
    private var ftpEngines: [Int64: FTPEngine] = [:]
    private var mkvEngines: [Int64: MKVMergeEngine] = [:]
    private var ytDlpEngines: [Int64: YtDlpEngine] = [:]
    private var runningTasks: [Int64: Task<Void, Never>] = [:]
    /// One user-facing transfer rate per task. Every window receives this same
    /// cached one-second sample instead of independently sampling the same byte
    /// counter on slightly different clocks.
    private var presentationSpeedSamplers: [Int64: OneSecondSpeedSampler] = [:]
    private var presentationSpeeds: [Int64: Double] = [:]

    /// FIFO continuation queue for per-task operations (restart, remove, start).
    private var inFlightOperations: [Int64: [CheckedContinuation<Void, Never>]] = [:]

    private func acquireTaskLock(taskID: Int64) async {
        if inFlightOperations[taskID] == nil {
            inFlightOperations[taskID] = []
            return
        }
        await withCheckedContinuation { continuation in
            inFlightOperations[taskID]?.append(continuation)
        }
    }

    private func releaseTaskLock(taskID: Int64) {
        guard var queue = inFlightOperations[taskID] else { return }
        if !queue.isEmpty {
            let next = queue.removeFirst()
            inFlightOperations[taskID] = queue
            next.resume()
        } else {
            inFlightOperations.removeValue(forKey: taskID)
        }
    }
    /// Optional UI hook when a download completes successfully.
    public var onTaskCompleted: (@Sendable (DownloadTask) -> Void)?
    /// Fires after any engine-backed task persists a terminal state. Unlike
    /// `onTaskCompleted`, this includes fast failures, pauses, and cancellations.
    public var onTaskSettled: (@Sendable (DownloadTask) -> Void)?
    /// Optional UI hook when settings change (for ShowPanel push).
    public var onSettingsChanged: (@Sendable (AppSettings) -> Void)?

    public init(
        store: DownloadStore,
        settings: AppSettings,
        supportRoot: URL = DownloadStore.defaultSupportDirectory,
        fileRecycler: FileRecycler? = nil,
        searchIndex: SearchIndexStore? = nil,
        capacityProvider: @escaping @Sendable (URL) -> Int64? = {
            VolumeCapacity.availableBytes(at: $0)
        },
        sameVolumeProvider: @escaping @Sendable (URL, URL) -> Bool = {
            VolumeCapacity.areOnSameVolume($0, $1)
        },
        onTaskCompleted: (@Sendable (DownloadTask) -> Void)? = nil
    ) {
        self.store = store
        self.settings = settings
        self.supportRoot = supportRoot
        self.fileRecycler = fileRecycler
        self.searchIndex = searchIndex
        self.capacityProvider = capacityProvider
        self.sameVolumeProvider = sameVolumeProvider
        self.onTaskCompleted = onTaskCompleted
    }

    public func updateSettings(_ settings: AppSettings) async {
        let wasAllAtOnce = self.settings.downloadAllAtOnce
        self.settings = settings
        for (taskID, engine) in engines {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            let effectiveLimit = taskLimit > 0
                ? taskLimit
                : settings.bandwidthLimitBytesPerSecond
            await engine.applyBandwidthLimit(effectiveLimit)
        }
        // Switching from one-by-one to parallel is an immediate product
        // action: queued rows should begin without asking the user to pause,
        // close settings, and press Continue on every row. Never auto-resume
        // explicitly paused/incomplete rows, and keep collection entries
        // serialized so a playlist cannot fan out into dozens of processes.
        if settings.downloadAllAtOnce && !wasAllAtOnce {
            await startWaitingTasksAfterQueueModeChange()
        }
        onSettingsChanged?(settings)
    }

    private func startWaitingTasksAfterQueueModeChange() async {
        guard let tasks = try? store.allDownloads() else { return }
        let ordinaryWaiting = tasks.filter {
            $0.status == .waiting && !Self.isCollectionEntry($0)
        }
        for task in ordinaryWaiting {
            _ = try? await startWaitingTaskIfEligible(taskID: task.id)
        }

        // A collection is represented by many waiting rows, but its next item
        // is intentionally advanced one at a time by clearRunning(). Start
        // only the head here; the collection callback owns the rest.
        if let collectionHead = Self.queuedCollectionCandidate(in: tasks) {
            _ = try? await startWaitingTaskIfEligible(taskID: collectionHead.id)
        }
    }

    public func setCompletionHandler(_ handler: (@Sendable (DownloadTask) -> Void)?) {
        onTaskCompleted = handler
    }

    public func setTaskSettledHandler(_ handler: (@Sendable (DownloadTask) -> Void)?) {
        onTaskSettled = handler
    }

    public func setSettingsChangedHandler(_ handler: (@Sendable (AppSettings) -> Void)?) {
        onSettingsChanged = handler
    }

    // MARK: - Scheduled starts

    /// Fires due appointments. Driven by a timer the app owns, so the actor stays
    /// free of its own run loop.
    ///
    /// Deliberately thin: `DownloadSchedule` decides *what* is due (and is tested
    /// for it), this just does it. Clearing `startAt` before starting matters — a
    /// task that failed and returns to `.waiting` must not fire the same
    /// appointment again on the next tick.
    @discardableResult
    public func startDueScheduledTasks(now: Date = Date()) async -> [Int64] {
        guard let tasks = try? store.allDownloads() else { return [] }
        var started: [Int64] = []
        for task in DownloadSchedule.due(in: tasks, now: now) {
            do {
                if try await startWaitingTaskIfEligible(taskID: task.id, scheduledAt: task.startAt) {
                    started.append(task.id)
                }
            } catch {
                // Leave it visible as an error rather than silently rescheduling:
                // a download that cannot start at 3am will not start at 3:01 either.
                continue
            }
        }
        return started
    }

    /// When the next appointment falls due, so the caller can size its timer
    /// instead of waking every second.
    public func nextScheduledWakeUp(now: Date = Date()) -> Date? {
        guard let tasks = try? store.allDownloads() else { return nil }
        return DownloadSchedule.nextWakeUp(in: tasks, now: now)
    }

    /// Park a task until `date`, or clear its appointment when nil.
    public func schedule(taskID: Int64, at date: Date?) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        guard var task = try store.allDownloads().first(where: { $0.id == taskID }) else { return }
        guard task.awaitingDestination != true else { throw ManagerError.destinationConfirmationRequired }
        if let date {
            await pauseUnlocked(taskID: taskID)
            task = try store.allDownloads().first(where: { $0.id == taskID }) ?? task
            task.status = .waiting
            task.startAt = DownloadSchedule.normalized(date, now: Date())
        } else {
            task.startAt = nil
        }
        try store.update(task)
    }

    public func listTasks() throws -> [DownloadTask] {
        try store.allDownloads()
    }

    public func progress(taskID: Int64) async -> DownloadProgress? {
        if let engine = engines[taskID] {
            return progressForPresentation(
                await engine.currentProgress(),
                taskID: taskID
            )
        }
        if let engine = hlsEngines[taskID] {
            return progressForPresentation(
                await engine.currentProgress(),
                taskID: taskID
            )
        }
        if let engine = ftpEngines[taskID] {
            return progressForPresentation(
                await engine.currentProgress(),
                taskID: taskID
            )
        }
        if let engine = mkvEngines[taskID] {
            return progressForPresentation(
                await engine.currentProgress(),
                taskID: taskID
            )
        }
        if let engine = ytDlpEngines[taskID] {
            return progressForPresentation(
                await engine.currentProgress(),
                taskID: taskID
            )
        }
        return nil
    }

    /// Internal for deterministic tests. The raw engine snapshot remains
    /// untouched except for its presentation rate.
    func progressForPresentation(
        _ progress: DownloadProgress,
        taskID: Int64,
        now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> DownloadProgress {
        var sampler = presentationSpeedSamplers[taskID] ?? OneSecondSpeedSampler()
        let isFirstSample = presentationSpeedSamplers[taskID] == nil
        let average = sampler.consume(
            completedBytes: progress.completedBytes,
            reset: isFirstSample,
            now: now
        )
        presentationSpeedSamplers[taskID] = sampler
        if let average {
            presentationSpeeds[taskID] = average
        }

        var presented = progress
        presented.bytesPerSecond = presentationSpeeds[taskID] ?? 0
        return presented
    }

    private func resetPresentationSpeed(taskID: Int64) {
        presentationSpeedSamplers[taskID] = nil
        presentationSpeeds[taskID] = nil
    }

    public func addURL(
        _ urlString: String,
        connections: Int? = nil,
        pageURL: String? = nil,
        pageTitle: String? = nil,
        headers: [String] = [],
        method: String = "GET",
        postData: Data? = nil,
        ltype: String = "normal",
        destinationDirectory: URL? = nil,
        awaitingDestination: Bool = false
    ) async throws -> DownloadTask {
        try store.insert(makeURLTask(urlString, connections: connections, pageURL: pageURL,
            pageTitle: pageTitle, headers: headers, method: method, postData: postData,
            ltype: ltype, destinationDirectory: destinationDirectory, awaitingDestination: awaitingDestination))
    }

    /// Build the complete row before persistence, so bridge metadata and its
    /// receipt can be committed in one transaction without an intermediate task.
    private func makeURLTask(
        _ urlString: String, connections: Int? = nil, pageURL: String? = nil,
        pageTitle: String? = nil, headers: [String] = [], method: String = "GET",
        postData: Data? = nil, ltype: String = "normal", destinationDirectory: URL? = nil,
        awaitingDestination: Bool = false
    ) throws -> DownloadTask {
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" || scheme == "ftp" else {
            throw ManagerError.invalidURL
        }
        var resolvedType = ltype
        if resolvedType == "normal", Self.looksLikeHLS(url: urlString, filename: url.lastPathComponent) {
            resolvedType = "hls"
        }
        let filename = DownloadFilename.resolve(
            preferred: nil,
            contentDispositionName: nil,
            url: url,
            mimeType: nil,
            pageTitle: pageTitle
        )
        var task = DownloadTask(
            url: urlString,
            method: method,
            filename: filename,
            linkType: resolvedType,
            connections: connections ?? settings.maxConnections,
            lastTry: Date(),
            firstTry: Date(),
            userAgent: settings.useCustomUserAgent ? settings.customUserAgent : nil,
            pageURL: pageURL,
            pageTitle: pageTitle,
            postData: postData,
            folderPath: nil,
            headers: headers
        )
        task.category = DownloadCategory.infer(filename: task.filename, mimeType: nil)
        task.folderPath = DownloadDestinationPolicy.directory(
            defaultDirectory: settings.downloadDirectory,
            override: destinationDirectory,
            category: task.category,
            organizeByCategory: settings.useCategoryFolders
        ).path
        if awaitingDestination {
            task.awaitingDestination = true
            task.status = .paused
        }
        return task
    }

    /// Persist an already-finished file (e.g. yt-dlp) as a completed task and
    /// fire the same completion hook as engine-backed downloads.
    @discardableResult
    public func recordCompletedFile(
        url: String,
        fileURL: URL,
        pageTitle: String? = nil,
        linkType: String = "ytdlp"
    ) async throws -> DownloadTask {
        let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
        var task = DownloadTask(
            url: url,
            filename: fileURL.lastPathComponent,
            linkType: linkType,
            fileSize: size,
            category: DownloadCategory.infer(filename: fileURL.lastPathComponent, mimeType: nil),
            status: .complete,
            connections: 1,
            lastTry: Date(),
            firstTry: Date(),
            completedAt: Date(),
            resumable: true,
            pageTitle: pageTitle,
            mimeType: "video/mp4",
            folderPath: fileURL.deletingLastPathComponent().path
        )
        task = try store.insert(task)
        onTaskCompleted?(task)
        onTaskSettled?(task)
        return task
    }

    /// Create a yt-dlp-backed task that lands in the same download directory as
    /// ordinary downloads, then runs with live progress for the progress window.
    @discardableResult
    public func startYtDlp(
        url: String,
        formatID: String,
        options: YtDlpDownloadOptions = .init(),
        pageTitle: String?,
        pageURL: String? = nil,
        thumbnailURL: String? = nil,
        estimatedBytes: Int64?,
        estimatedComponentBytes: [Int64] = [],
        preferredFilename: String?,
        destinationDirectory: URL? = nil
    ) async throws -> DownloadTask {
        if !settings.downloadAllAtOnce, !runningTasks.isEmpty {
            throw ManagerError.queueBusy
        }
        try validateStorage(StorageBudget.media(
            sampleFinalBytes: estimatedBytes,
            sampleComponentBytes: estimatedComponentBytes,
            sampleDurationSeconds: nil
        ), destinationDirectory: destinationDirectory)
        let stem: String
        if let preferredFilename, !preferredFilename.isEmpty {
            stem = YtDlpTool.sanitizeFilename(preferredFilename)
        } else if let pageTitle, !pageTitle.isEmpty {
            stem = YtDlpTool.sanitizeFilename(pageTitle)
        } else {
            stem = "video"
        }
        let ext = options.container.fileExtension
        let filename = stem.lowercased().hasSuffix(".\(ext)") ? stem : "\(stem).\(ext)"

        let dest = DownloadDestinationPolicy.directory(
            defaultDirectory: settings.downloadDirectory,
            override: destinationDirectory,
            category: .video,
            organizeByCategory: settings.useCategoryFolders
        )
        var task = DownloadTask(
            url: url,
            filename: filename,
            linkType: "ytdlp",
            fileSize: max(0, estimatedBytes ?? 0),
            category: .video,
            status: .downloading,
            connections: max(1, min(32, settings.maxConnections)),
            lastTry: Date(),
            firstTry: Date(),
            resumable: false,
            pageURL: pageURL,
            pageTitle: pageTitle,
            thumbnailURL: thumbnailURL,
            hitTitle: formatID,
            mimeType: options.container.mimeType,
            postData: try? JSONEncoder().encode(options),
            folderPath: dest.path
        )
        task = try store.insert(task)
        let taskID = task.id

        let engine = YtDlpEngine(
            taskID: taskID,
            estimatedBytes: estimatedBytes ?? 0,
            estimatedComponentBytes: estimatedComponentBytes,
            connections: task.connections
        )
        ytDlpEngines[taskID] = engine
        let onComplete = onTaskCompleted
        runningTasks[taskID] = Task {
            await self.runEngine(
                taskID: taskID,
                task: task,
                store: store,
                onComplete: onComplete
            ) {
                try await engine.run(
                    url: url,
                    formatID: formatID,
                    directory: dest,
                    preferredName: stem,
                    options: options
                )
            }
            self.ytDlpEngines[taskID] = nil
        }
        return task
    }

    /// Add a collection as independent, recoverable tasks. Only one entry is
    /// launched automatically at a time so a 32-connection preference cannot
    /// multiply into hundreds of simultaneous sockets for a large playlist.
    @discardableResult
    public func enqueueYtDlpCollection(
        _ items: [YtDlpCollectionItem],
        formatID: String,
        options: YtDlpDownloadOptions = .init(),
        collectionURL: String,
        collectionTitle: String?,
        collectionThumbnailURL: String? = nil,
        estimatedSampleBytes: Int64? = nil,
        estimatedSampleComponentBytes: [Int64] = [],
        sampleDurationSeconds: Double? = nil,
        destinationDirectory: URL? = nil
    ) async throws -> [DownloadTask] {
        try validateStorage(StorageBudget.media(
            sampleFinalBytes: estimatedSampleBytes,
            sampleComponentBytes: estimatedSampleComponentBytes,
            sampleDurationSeconds: sampleDurationSeconds,
            collectionDurations: items.map(\.durationSeconds)
        ), destinationDirectory: destinationDirectory)
        let inserted = try insertYtDlpCollection(
            items,
            formatID: formatID,
            options: options,
            collectionURL: collectionURL,
            collectionTitle: collectionTitle,
            collectionThumbnailURL: collectionThumbnailURL,
            destinationDirectory: destinationDirectory
        )
        if runningTasks.isEmpty, let first = inserted.first {
            _ = try await startWaitingTaskIfEligible(taskID: first.id)
        }
        return inserted
    }

    private func validateStorage(
        _ budget: StorageBudget,
        destinationDirectory: URL? = nil
    ) throws {
        guard let available = capacityProvider(destinationDirectory ?? settings.downloadDirectory),
              let required = budget.peakBytes else { return }
        let confidence = StorageConfidence(
            budget: budget,
            availableBytes: available
        )
        guard confidence.level != .insufficient else {
            throw ManagerError.insufficientStorage(
                requiredBytes: required,
                availableBytes: available
            )
        }
    }

    /// Injectable persistence boundary used by queue tests without launching
    /// the external media process.
    func insertYtDlpCollection(
        _ items: [YtDlpCollectionItem],
        formatID: String,
        options: YtDlpDownloadOptions = .init(),
        collectionURL: String,
        collectionTitle: String?,
        collectionThumbnailURL: String? = nil,
        destinationDirectory: URL? = nil
    ) throws -> [DownloadTask] {
        guard !items.isEmpty else { return [] }
        let width = max(2, String(items.count).count)
        let collectionID = UUID().uuidString.lowercased()
        var inserted: [DownloadTask] = []
        inserted.reserveCapacity(items.count)

        for (offset, item) in items.enumerated() {
            let number = String(format: "%0*d", width, offset + 1)
            let cleanTitle = YtDlpTool.sanitizeFilename(item.title)
            let stem = "\(number) - \(cleanTitle)"
            let ext = options.container.fileExtension
            let dest = DownloadDestinationPolicy.directory(
                defaultDirectory: settings.downloadDirectory,
                override: destinationDirectory,
                category: .video,
                organizeByCategory: settings.useCategoryFolders
            )
            var itemOptions = options
            itemOptions.collectionID = collectionID
            itemOptions.collectionTitle = collectionTitle
            itemOptions.collectionIndex = offset + 1
            itemOptions.collectionCount = items.count
            var task = DownloadTask(
                url: item.url,
                filename: "\(stem).\(ext)",
                linkType: "ytdlp",
                fileSize: 0,
                category: .video,
                status: .waiting,
                connections: max(1, min(32, settings.maxConnections)),
                firstTry: Date(),
                resumable: false,
                pageURL: collectionURL,
                pageTitle: item.title.isEmpty ? collectionTitle : item.title,
                thumbnailURL: item.thumbnailURL ?? collectionThumbnailURL,
                hitTitle: formatID,
                mimeType: options.container.mimeType,
                postData: try? JSONEncoder().encode(itemOptions),
                folderPath: dest.path
            )
            task = try store.insert(task)
            inserted.append(task)
        }

        return inserted
    }

    /// Host-side entry for browser extension messages (`handleBrowserDownloadRequest:`).
    public func addFromBridge(_ message: ParsedBridgeMessage, awaitingDestination: Bool = false) async throws -> DownloadTask {
        let prepared = try prepareBridgeTask(message, awaitingDestination: awaitingDestination)
        if prepared.updatingExisting {
            try store.update(prepared.task)
            return prepared.task
        }
        return try store.insert(prepared.task)
    }

    /// Durable ordinary-file admission. A replay returns only its receipt and
    /// must not cause Host to start or focus the task again. No network is started
    /// here. Host capability negotiation is enabled separately from this API.
    public func acceptRelayHandoff(
        _ message: ParsedBridgeMessage, requestID: String, originalMessage: ParsedBridgeMessage? = nil,
        awaitingDestination: Bool = false
    ) throws -> DownloadStore.RelayHandoffCommit {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let payloadHash = SHA256.hash(data: try encoder.encode(originalMessage ?? message)).map { String(format: "%02x", $0) }.joined()
        if let receipt = try store.relayHandoffReceipt(requestID: requestID, payloadHash: payloadHash) { return receipt }
        let prepared = try prepareBridgeTask(message, awaitingDestination: awaitingDestination)
        return try store.commitRelayHandoff(requestID: requestID, payloadHash: payloadHash, task: prepared.task,
                                            updatingExisting: prepared.updatingExisting)
    }

    private func prepareBridgeTask(
        _ message: ParsedBridgeMessage, awaitingDestination: Bool
    ) throws -> (task: DownloadTask, updatingExisting: Bool) {
        guard let scheme = URL(string: message.url)?.scheme?.lowercased(),
              ["http", "https", "ftp"].contains(scheme) else { throw ManagerError.invalidURL }
        let headers = Self.bridgeHeaders(from: message)

        // Link Rescue: when the browser captures a fresh signed URL from the
        // same source page, attach it to the failed task instead of creating a
        // duplicate. The existing task id and partial seg.xN files stay intact,
        // so AppDelegate's normal start call resumes the original download.
        if var task = try linkRescueCandidate(for: message) {
            task.url = message.url
            task.method = message.method
            task.headers = headers
            task.errorText = nil
            task.status = .incomplete
            task.lastTry = Date()
            task.completedAt = nil
            if !message.pageURL.isEmpty {
                task.pageURL = message.pageURL
            } else if !message.referer.isEmpty {
                task.pageURL = message.referer
            }
            if !message.pageTitle.isEmpty { task.pageTitle = message.pageTitle }
            if !message.userAgent.isEmpty { task.userAgent = message.userAgent }
            if !message.contentType.isEmpty { task.mimeType = message.contentType }
            if message.fileSize > 0 { task.fileSize = Int64(message.fileSize) }
            task.postData = message.postData.map { Data($0.utf8) }
            task.alternateURL = message.alternateURL.isEmpty ? nil : message.alternateURL
            if !message.ltype.isEmpty { task.linkType = message.ltype }
            if Self.looksLikeHLS(url: task.url, filename: task.filename) {
                task.linkType = "hls"
            } else if task.alternateURL != nil {
                task.linkType = "media"
            }
            task.category = DownloadCategory.infer(filename: task.filename, mimeType: task.mimeType)
            return (task, true)
        }

        var task = try makeURLTask(
            message.url,
            pageURL: message.pageURL.isEmpty ? message.referer : message.pageURL,
            pageTitle: message.pageTitle,
            headers: headers,
            method: message.method,
            ltype: message.ltype,
            awaitingDestination: awaitingDestination
        )
        if !message.filename.isEmpty {
            let clean = DownloadFilename.sanitize(message.filename)
            if !clean.isEmpty { task.filename = clean }
            if Self.looksLikeHLS(url: task.url, filename: task.filename) {
                task.linkType = "hls"
            }
        }
        if message.fileSize > 0 {
            task.fileSize = Int64(message.fileSize)
        }
        if !message.contentType.isEmpty {
            task.mimeType = message.contentType
        }
        if let post = message.postData {
            task.postData = Data(post.utf8)
        }
        if !message.alternateURL.isEmpty {
            task.alternateURL = message.alternateURL
            if task.linkType.lowercased() == "media" || task.linkType.lowercased() == "normal" {
                task.linkType = "media"
            }
        }
        if !message.userAgent.isEmpty {
            task.userAgent = message.userAgent
        }
        task.category = DownloadCategory.infer(filename: task.filename, mimeType: task.mimeType)
        task.folderPath = DownloadDestinationPolicy.directory(
            defaultDirectory: settings.downloadDirectory, override: nil,
            category: task.category, organizeByCategory: settings.useCategoryFolders
        ).path
        return (task, false)
    }

    private func linkRescueCandidate(for message: ParsedBridgeMessage) throws -> DownloadTask? {
        let incomingPage = message.pageURL.isEmpty ? message.referer : message.pageURL
        guard let incomingKey = DuplicateDownloadMatcher.canonicalKey(for: incomingPage) else {
            return nil
        }
        return try store.allDownloads().first { task in
            guard task.status == .error,
                  task.linkType.lowercased() != "ytdlp",
                  let pageURL = task.pageURL,
                  DuplicateDownloadMatcher.canonicalKey(for: pageURL) == incomingKey,
                  let diagnostic = DownloadDiagnostic.fromStoredErrorText(task.errorText) else {
                return false
            }
            switch diagnostic {
            case .linkExpired, .signInRequired:
                // A dual-track task needs a fresh pair; mixing a new video URL
                // with stale audio authorization is worse than adding a new task.
                if task.alternateURL?.isEmpty == false, message.alternateURL.isEmpty {
                    return false
                }
                return true
            default:
                return false
            }
        }
    }

    private static func bridgeHeaders(from message: ParsedBridgeMessage) -> [String] {
        var headers: [String] = []
        if !message.origin.isEmpty { headers.append("Origin: \(message.origin)") }
        if !message.referer.isEmpty { headers.append("Referer: \(message.referer)") }
        if !message.cookies.isEmpty { headers.append("Cookie: \(message.cookies)") }
        if !message.reqContentType.isEmpty { headers.append("Content-Type: \(message.reqContentType)") }
        for (key, value) in message.extraHeaders.sorted(by: { $0.key < $1.key }) {
            headers.append("\(key): \(value)")
        }
        return headers
    }

    /// Fire-and-forget start (UI / bridge). Does not wait for completion.
    public func start(
        taskID: Int64,
        destinationDirectory: URL? = nil,
        isRestart: Bool = false
    ) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        try startUnlocked(
            taskID: taskID,
            destinationDirectory: destinationDirectory,
            isRestart: isRestart
        )
    }

    /// Automatic queue callbacks must re-check intent after taking the task lock.
    /// An earlier waiting snapshot is not permission to undo a later pause or
    /// appointment change. A nil appointment denotes the ordinary ready queue.
    @discardableResult
    func startWaitingTaskIfEligible(taskID: Int64, scheduledAt: Date? = nil) async throws -> Bool {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        guard var task = try task(id: taskID), task.status == .waiting,
              task.awaitingDestination != true, task.startAt == scheduledAt else { return false }
        if scheduledAt != nil {
            task.startAt = nil
            try store.update(task)
        }
        try startUnlocked(taskID: taskID)
        return true
    }

    /// Start only a newly accepted browser intent. A pause/delete that wins the
    /// actor/task lock boundary must not be undone by a delayed Host callback.
    public func startAcceptedRelayHandoff(taskID: Int64) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        guard var task = try store.allDownloads().first(where: { $0.id == taskID }),
              task.status == .incomplete, task.awaitingDestination != true else { return }
        do { try startUnlocked(taskID: taskID) }
        catch ManagerError.queueBusy {
            task.status = .waiting
            try store.update(task)
        } catch {
            task = try store.allDownloads().first(where: { $0.id == taskID }) ?? task
            task.status = .error
            task.errorText = DownloadDiagnostic.classify(error).storageString
            try store.update(task)
            onTaskSettled?(task)
        }
    }

    /// Choose a destination only for a never-started browser handoff. Confirmation
    /// is durable before any writer can start; repeated confirmations cannot move it.
    @discardableResult
    public func confirmDestination(taskID: Int64, directory: URL) async throws -> DownloadTask {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        return try confirmDestinationUnlocked(taskID: taskID, directory: directory)
    }

    @discardableResult
    public func confirmDestinationAndStart(taskID: Int64, directory: URL) async throws -> DownloadTask {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        guard let original = try store.allDownloads().first(where: { $0.id == taskID }) else { throw ManagerError.taskNotFound }
        var confirmed = try confirmDestinationUnlocked(taskID: taskID, directory: directory)
        if original.awaitingDestination == true {
            do { try startUnlocked(taskID: taskID) }
            catch ManagerError.queueBusy {
                confirmed.status = .waiting
                try store.update(confirmed)
            } catch {
                // Destination acceptance succeeded, but no writer could start.
                // Expose the same durable failure model as an asynchronous run;
                // a repeated confirmation must not act as an implicit retry.
                confirmed = try store.allDownloads().first(where: { $0.id == taskID }) ?? confirmed
                confirmed.status = .error
                confirmed.errorText = DownloadDiagnostic.classify(error).storageString
                try store.update(confirmed)
                onTaskSettled?(confirmed)
            }
        }
        return try store.allDownloads().first(where: { $0.id == taskID }) ?? confirmed
    }

    private func confirmDestinationUnlocked(taskID: Int64, directory: URL) throws -> DownloadTask {
        guard var task = try store.allDownloads().first(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }
        guard task.awaitingDestination == true else { return task }
        guard runningTasks[taskID] == nil, task.status == .paused else {
            throw ManagerError.destinationConfirmationRequired
        }
        let work = supportRoot.appendingPathComponent(String(taskID), isDirectory: true)
        if FileManager.default.fileExists(atPath: work.path),
           !(try FileManager.default.contentsOfDirectory(atPath: work.path)).isEmpty {
            throw ManagerError.unsafeFileLocation
        }
        guard directory.isFileURL else { throw ManagerError.unsafeFileLocation }
        let destination = directory.standardizedFileURL
        var isDirectory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory) {
            // Only the recorded, one-level category directory may be created.
            // Never recreate an absent download root (for example an offline volume).
            let parent = destination.deletingLastPathComponent()
            var parentIsDirectory: ObjCBool = false
            guard settings.useCategoryFolders,
                  task.folderPath.map({ URL(fileURLWithPath: $0).standardizedFileURL.path }) == destination.path,
                  parent.path == settings.downloadDirectory.standardizedFileURL.path,
                  FileManager.default.fileExists(atPath: parent.path, isDirectory: &parentIsDirectory),
                  parentIsDirectory.boolValue else { throw ManagerError.unsafeFileLocation }
            try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false)
            isDirectory = false
            guard FileManager.default.fileExists(atPath: destination.path, isDirectory: &isDirectory) else { throw ManagerError.unsafeFileLocation }
        }
        guard isDirectory.boolValue else { throw ManagerError.unsafeFileLocation }
        task.folderPath = destination.path
        task.awaitingDestination = false
        try store.update(task)
        return task
    }

    /// Starts while the caller owns this task's lifecycle lock.
    /// Keeping this synchronous prevents actor reentrancy between queue admission,
    /// work-directory reset, persistence, and engine registration.
    private func startUnlocked(
        taskID: Int64,
        destinationDirectory: URL? = nil,
        isRestart: Bool = false
    ) throws {
        if runningTasks[taskID] != nil { return }
        resetPresentationSpeed(taskID: taskID)
        // One-by-one queue (original radioOneByOne): wait until no other engine is active.
        if !settings.downloadAllAtOnce, !runningTasks.isEmpty {
            throw ManagerError.queueBusy
        }
        let tasks = try store.allDownloads()
        guard var task = tasks.first(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }
        guard task.awaitingDestination != true else { throw ManagerError.destinationConfirmationRequired }
        guard let url = URL(string: task.url) else { throw ManagerError.invalidURL }

        let persistedDestination = task.folderPath
            .flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0, isDirectory: true) }
        let dest = DownloadDestinationPolicy.directory(
            defaultDirectory: settings.downloadDirectory,
            override: destinationDirectory ?? persistedDestination,
            category: task.category,
            organizeByCategory: settings.useCategoryFolders
        )
        task.folderPath = dest.path

        // Per-task work dir: Application Support/.../<id>/  (original layout)
        let workDir = supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)

        // Full re-download of a finished or restarted task — wipe stale segments so the engine
        // does not treat the previous merge as already done.
        let redownloadComplete = isRestart || task.status == .complete
            || DownloadDiagnostic.fromStoredErrorText(task.errorText) == .fileAlreadyExists
        let fileManager = FileManager.default
        if redownloadComplete, fileManager.fileExists(atPath: workDir.path) {
            do {
                // restart() has drained the old writer under the lifecycle lock;
                // recover its owned candidate before destroying the only receipt.
                try MergeStagingReceipt.recover(taskID: taskID, in: workDir)
                try OffsetDownloadStorage.removeIncomplete(taskID: taskID, workDirectory: workDir)
                try fileManager.removeItem(at: workDir)
            } catch {
                throw ManagerError.downloadFailed(
                    "Failed to clean task work directory: \(error.localizedDescription)"
                )
            }
            task.errorText = nil
        }
        do {
            try fileManager.createDirectory(at: workDir, withIntermediateDirectories: true)
        } catch {
            throw ManagerError.downloadFailed(
                "Failed to create task work directory: \(error.localizedDescription)"
            )
        }

        // yt-dlp page downloads (retry after complete / error / incomplete).
        if task.linkType.lowercased() == "ytdlp" {
            // yt-dlp tasks created by earlier builds were persisted as one
            // connection. Reapply the current global setting on every start so
            // an old completed row also gets real concurrency when retried.
            task.connections = max(1, min(32, settings.maxConnections))
            let formatID: String
            if let stored = task.hitTitle, !stored.isEmpty {
                formatID = stored
            } else {
                formatID = "bv*+ba/b"
            }
            let preferredStem = (task.filename as NSString).deletingPathExtension
            let options = try MediaSessionSelection.resumeOptions(data: task.postData, filename: task.filename)
            let engine = YtDlpEngine(
                taskID: taskID,
                estimatedBytes: task.fileSize,
                connections: task.connections,
                temporaryDirectory: workDir.appendingPathComponent("yt-dlp", isDirectory: true)
            )
            ytDlpEngines[taskID] = engine
            task.status = .downloading
            task.lastTry = Date()
            task.completedAt = nil
            try store.update(task)
            let onComplete = onTaskCompleted
            let pageTitle = task.pageTitle
            let sourceURL = task.url
            runningTasks[taskID] = Task {
                await self.runEngine(
                    taskID: taskID,
                    task: task,
                    store: store,
                    onComplete: onComplete
                ) {
                    try await engine.run(
                        url: sourceURL,
                        formatID: formatID,
                        directory: dest,
                        preferredName: preferredStem.isEmpty ? pageTitle : preferredStem,
                        forceOverwrite: redownloadComplete,
                        options: options
                    )
                }
                self.ytDlpEngines[taskID] = nil
            }
            return
        }

        var headerMap: [String: String] = [:]
        for line in task.headers {
            if let idx = line.firstIndex(of: ":") {
                let name = String(line[..<idx]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
                headerMap[name] = value
            }
        }

        var username = url.user
        var password = url.password
        if username == nil, let host = url.host,
           let cred = try? store.auth(forHost: host) {
            username = cred.username
            password = cred.password
        }

        // Replace opaque CDN / branch names before the engine opens the file.
        if !DownloadFilename.isUseful(task.filename) {
            task.filename = DownloadFilename.resolve(
                preferred: task.filename,
                url: url,
                mimeType: task.mimeType,
                pageTitle: task.pageTitle
            )
            task.category = DownloadCategory.infer(filename: task.filename, mimeType: task.mimeType)
        }

        // Keep replacement intent with this run so pause/relaunch does not turn a
        // redownload back into an unrelated-file collision. The engine stages all
        // new bytes and replaces only this exact destination at publication.
        let replacementReceipt = workDir.appendingPathComponent("redownload-destination.json")
        let destination = dest.appendingPathComponent(task.filename).standardizedFileURL
        if redownloadComplete, !task.filename.isEmpty, fileManager.fileExists(atPath: destination.path) {
            try JSONEncoder().encode(destination.path).write(to: replacementReceipt, options: .atomic)
        }
        let replacementPath = (try? Data(contentsOf: replacementReceipt))
            .flatMap { try? JSONDecoder().decode(String.self, from: $0) }
        let replacingDestination = replacementPath == destination.path ? destination : nil

        let request = DownloadRequest(
            url: url,
            method: task.method,
            headers: headerMap,
            body: task.postData,
            userAgent: task.userAgent ?? (settings.useCustomUserAgent ? settings.customUserAgent : nil),
            connections: task.connections > 0 ? task.connections : settings.maxConnections,
            bandwidthLimitBytesPerSecond: task.bandwidthLimit,
            destinationDirectory: dest,
            suggestedFilename: task.filename.isEmpty ? nil : task.filename,
            replacingDestination: replacingDestination,
            pageURL: task.pageURL.flatMap(URL.init(string:)),
            pageTitle: task.pageTitle,
            username: username,
            password: password
        )

        let scheme = url.scheme?.lowercased() ?? ""
        let useFTP = scheme == "ftp"
        let useHLS = !useFTP && Self.isHLS(task)
        let useMKV = !useFTP && !useHLS
            && !(task.alternateURL ?? "").isEmpty
            && (task.linkType.lowercased() == "media" || (task.alternateURL ?? "").contains("://"))
        task.status = .downloading
        task.lastTry = Date()
        task.completedAt = nil
        try store.update(task)

        let onComplete = onTaskCompleted
        if useFTP {
            let engine = FTPEngine(
                taskID: taskID,
                request: request,
                workDirectory: workDir,
                ftpProxy: settings.ftpProxy
            )
            ftpEngines[taskID] = engine
            runningTasks[taskID] = Task { [store] in
                await self.runEngine(
                    taskID: taskID,
                    task: task,
                    store: store,
                    onComplete: onComplete
                ) {
                    try await engine.start()
                }
            }
        } else if useMKV, let audioStr = task.alternateURL, let audioURL = URL(string: audioStr) {
            var audioReq = request
            audioReq.url = audioURL
            audioReq.suggestedFilename = "audio.bin"
            let engine = MKVMergeEngine(
                taskID: taskID,
                videoRequest: request,
                audioRequest: audioReq,
                workDirectory: workDir,
                httpProxy: settings.httpProxy,
                socksProxy: settings.socksProxy,
                globalBandwidthLimit: settings.bandwidthLimitBytesPerSecond
            )
            mkvEngines[taskID] = engine
            runningTasks[taskID] = Task { [store] in
                await self.runEngine(
                    taskID: taskID,
                    task: task,
                    store: store,
                    onComplete: onComplete
                ) {
                    try await engine.start()
                }
            }
        } else if useHLS {
            let engine = HLSEngine(
                taskID: taskID,
                request: request,
                workDirectory: workDir,
                audioPlaylistURL: task.alternateURL.flatMap(URL.init(string:)),
                httpProxy: settings.httpProxy,
                socksProxy: settings.socksProxy
            )
            hlsEngines[taskID] = engine
            runningTasks[taskID] = Task { [store] in
                await self.runEngine(
                    taskID: taskID,
                    task: task,
                    store: store,
                    onComplete: onComplete,
                    deliveryNote: { await engine.currentProgress().deliveryNote }
                ) {
                    try await engine.start()
                }
            }
        } else {
            let engine = DownloadEngine(
                taskID: taskID,
                request: request,
                workDirectory: workDir,
                httpProxy: settings.httpProxy,
                socksProxy: settings.socksProxy,
                globalBandwidthLimit: settings.bandwidthLimitBytesPerSecond,
                autoTuneConnections: settings.smartConnectionsEnabled,
                capacityProvider: capacityProvider,
                sameVolumeProvider: sameVolumeProvider
            )
            engines[taskID] = engine
            runningTasks[taskID] = Task { [store] in
                await self.runEngine(
                    taskID: taskID,
                    task: task,
                    store: store,
                    onComplete: onComplete
                ) {
                    try await engine.start()
                }
            }
        }
    }

    private func runEngine(
        taskID: Int64,
        task: DownloadTask,
        store: DownloadStore,
        onComplete: (@Sendable (DownloadTask) -> Void)?,
        /// Reads a non-fatal delivery note from the engine once it has finished.
        /// Only engines that can degrade a successful delivery supply one.
        deliveryNote: () async -> DeliveryNote? = { nil },
        start: () async throws -> URL
    ) async {
        do {
            let fileURL = try await start()
            // Runtime edits (connections, bandwidth, renewed metadata) may have been
            // persisted while the engine was running. Do not overwrite them with the
            // stale task snapshot captured at start.
            var done = (try? store.allDownloads().first { $0.id == taskID }) ?? task
            done.status = .complete
            done.completedAt = Date()
            let producedCategory = DownloadCategory.infer(
                filename: fileURL.lastPathComponent,
                mimeType: done.mimeType
            )
            // Prefer the on-disk name, but never keep extensionless CDN tokens when
            // we can recover a real name + extension from the page title / MIME.
            let completionWork = supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
            let usesOffsetPublished: Bool
            switch try OffsetDownloadStorage.inspect(taskID: taskID, workDirectory: completionWork) {
            case .absent: usesOffsetPublished = false
            case .published(let ownedURL):
                guard ownedURL.standardizedFileURL == fileURL.standardizedFileURL else {
                    throw OffsetDownloadStorage.Failure.identityMismatch
                }
                usesOffsetPublished = true
            case .incomplete, .cleanupPending, .partialMissing:
                throw OffsetDownloadStorage.Failure.incomplete
            }
            let renamePrimary: (URL, URL) throws -> Void = { source, destination in
                if usesOffsetPublished {
                    _ = try OffsetDownloadStorage.renamePublished(taskID: taskID, workDirectory: completionWork, to: destination)
                } else {
                    try FileManager.default.moveItem(at: source, to: destination)
                }
            }
            var workingURL = fileURL
            let diskName = fileURL.lastPathComponent
            if !DownloadFilename.isUseful(diskName) {
                var recovered = DownloadFilename.resolve(
                    preferred: done.filename,
                    contentDispositionName: nil,
                    url: URL(string: done.url) ?? fileURL,
                    mimeType: done.mimeType,
                    pageTitle: done.pageTitle
                )
                // The engine already produced the real container — HLS in
                // particular remuxes to MP4 — while `recovered` is derived from the
                // request URL, whose extension may be a playlist or nothing at all.
                // Recovery exists to replace a meaningless *stem*; it must never
                // downgrade or drop the extension, or the delivered file stops
                // opening despite holding perfectly good video.
                let diskExtension = fileURL.pathExtension
                if !diskExtension.isEmpty,
                   (recovered as NSString).pathExtension.caseInsensitiveCompare(diskExtension) != .orderedSame {
                    recovered = (recovered as NSString).deletingPathExtension
                        + "." + diskExtension
                }
                if recovered != diskName {
                    let dest = fileURL.deletingLastPathComponent().appendingPathComponent(recovered)
                    let unique = uniqueDestination(dest)
                    if usesOffsetPublished {
                        // Transaction errors may follow the rename itself. Do not
                        // acknowledge the old path as a completed download.
                        try renamePrimary(fileURL, unique)
                        workingURL = unique
                    } else if (try? renamePrimary(fileURL, unique)) != nil {
                        workingURL = unique
                    }
                }
            }
            let finalizedURL: URL
            if producedCategory == .video || producedCategory == .audio {
                if usesOffsetPublished {
                    finalizedURL = try SmartFinalize.applySmartNaming(primary: workingURL,
                        pageTitle: done.pageTitle, primaryRenamer: renamePrimary).primaryURL
                } else {
                    finalizedURL = (try? SmartFinalize.applySmartNaming(primary: workingURL,
                        pageTitle: done.pageTitle))?.primaryURL ?? workingURL
                }
            } else {
                finalizedURL = workingURL
            }
            done.filename = finalizedURL.lastPathComponent
            done.folderPath = finalizedURL.deletingLastPathComponent().path
            let attrs = try? FileManager.default.attributesOfItem(atPath: finalizedURL.path)
            done.fileSize = (attrs?[.size] as? NSNumber)?.int64Value ?? done.fileSize
            done.category = DownloadCategory.infer(filename: done.filename, mimeType: done.mimeType)
            done.resumable = true
            done.errorText = nil
            done.deliveryNote = await deliveryNote()?.storageKey
            try store.update(done)
            let workDir = supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
            Self.cleanCompletedWorkDirectory(at: workDir)
            // Metadata only: it makes search useful from the first download, long
            // before any transcript exists, and a task with no spoken content can
            // still be found by what it is called.
            indexMetadata(for: done)
            onComplete?(done)
            onTaskSettled?(done)
        } catch {
            var failed = (try? store.allDownloads().first { $0.id == taskID }) ?? task
            if case .paused = error as? EngineError {
                failed.status = .paused
            } else if case .cancelled = error as? EngineError {
                failed.status = .incomplete
            } else {
                failed.status = .error
            }
            if failed.status == .error {
                // Persist the structured diagnostic key; presentation re-localizes
                // it at render time (see DownloadDiagnostic.fromStoredErrorText).
                failed.errorText = DownloadDiagnostic.classify(error).storageString
            } else {
                failed.errorText = error.localizedDescription
            }
            try? store.update(failed)
            onTaskSettled?(failed)
        }
        clearRunning(taskID)
    }

    // MARK: - Search index

    /// Non-fatal index failures, oldest first. Exposed so the app or a test can see
    /// that search is quietly degraded instead of guessing.
    public func searchIndexFailures() -> [String] {
        recordedSearchIndexFailures
    }

    /// Index a finished download's name, title and site.
    ///
    /// Deliberately separate from transcript indexing: most downloads never get a
    /// transcript, and being findable by name is the baseline that makes a search box
    /// worth opening at all.
    private func indexMetadata(for task: DownloadTask) {
        guard let searchIndex else { return }
        var entries: [SearchIndexStore.Entry] = []
        if !task.filename.isEmpty {
            entries.append(.init(taskID: task.id, source: .filename, text: task.filename))
        }
        if let title = task.pageTitle, !title.isEmpty {
            entries.append(.init(taskID: task.id, source: .title, text: title))
        }
        if let page = task.pageURL, let host = URL(string: page)?.host, !host.isEmpty {
            entries.append(.init(taskID: task.id, source: .site, text: host))
        }
        guard !entries.isEmpty else { return }
        do {
            try searchIndex.replaceEntries(taskID: task.id, entries: entries)
        } catch {
            recordedSearchIndexFailures.append(
                "indexing metadata for task \(task.id): \(error.localizedDescription)"
            )
        }
    }

    /// Index a transcript alongside the download's metadata.
    ///
    /// Both go in together because `replaceEntries` replaces everything for a task:
    /// writing only the transcript would drop the name and title from the index, and
    /// writing only metadata later would drop the transcript. Re-running a transcript
    /// therefore cannot accumulate duplicates.
    public func indexTranscript(taskID: Int64, segments: [TranscriptSegment]) {
        guard let searchIndex else { return }
        guard let task = try? store.allDownloads().first(where: { $0.id == taskID }) else {
            recordedSearchIndexFailures.append("indexing transcript for unknown task \(taskID)")
            return
        }
        var entries: [SearchIndexStore.Entry] = []
        if !task.filename.isEmpty {
            entries.append(.init(taskID: taskID, source: .filename, text: task.filename))
        }
        if let title = task.pageTitle, !title.isEmpty {
            entries.append(.init(taskID: taskID, source: .title, text: title))
        }
        if let page = task.pageURL, let host = URL(string: page)?.host, !host.isEmpty {
            entries.append(.init(taskID: taskID, source: .site, text: host))
        }
        for segment in segments {
            entries.append(.init(
                taskID: taskID,
                source: .transcript,
                text: segment.text,
                startSeconds: segment.start,
                endSeconds: segment.end
            ))
        }
        do {
            try searchIndex.replaceEntries(taskID: taskID, entries: entries)
        } catch {
            recordedSearchIndexFailures.append(
                "indexing transcript for task \(taskID): \(error.localizedDescription)"
            )
        }
    }

    // MARK: - Rebuilding the index from disk

    /// Whether the index has nothing to serve and should be rebuilt.
    ///
    /// Only when it was discarded or is empty. Rescanning every launch would spend the
    /// user's first seconds re-deriving something already correct.
    public func searchIndexNeedsRebuild() -> Bool {
        guard let searchIndex else { return false }
        if searchIndex.wasRebuilt { return true }
        return (try? searchIndex.entryCount()) == 0
    }

    public struct RebuildProgress: Equatable, Sendable {
        public var processed: Int
        public var total: Int
        public var indexedTranscripts: Int

        public init(processed: Int, total: Int, indexedTranscripts: Int) {
            self.processed = processed
            self.total = total
            self.indexedTranscripts = indexedTranscripts
        }

        public var fractionCompleted: Double {
            total > 0 ? Double(processed) / Double(total) : 1
        }
    }

    /// Rebuild the index from what is already on disk.
    ///
    /// The subtitle files are the truth here, not the `.txt` transcript: only the
    /// subtitles carry timings, and an index rebuilt without them could find a
    /// download but never jump to the moment — a downgrade wearing the costume of a
    /// recovery.
    ///
    /// Cancellable and progress-reporting because a large inbox makes this slow, and a
    /// slow rebuild must never be something the user has to sit through.
    @discardableResult
    public func rebuildSearchIndex(
        cancelToken: CancelToken? = nil,
        onProgress: (@Sendable (RebuildProgress) -> Void)? = nil
    ) -> RebuildProgress {
        guard let searchIndex else {
            return RebuildProgress(processed: 0, total: 0, indexedTranscripts: 0)
        }
        let tasks = (try? store.allDownloads()) ?? []
        var processed = 0
        var indexedTranscripts = 0

        for task in tasks {
            if cancelToken?.isCancelled == true { break }
            var entries: [SearchIndexStore.Entry] = []
            if !task.filename.isEmpty {
                entries.append(.init(taskID: task.id, source: .filename, text: task.filename))
            }
            if let title = task.pageTitle, !title.isEmpty {
                entries.append(.init(taskID: task.id, source: .title, text: title))
            }
            if let page = task.pageURL, let host = URL(string: page)?.host, !host.isEmpty {
                entries.append(.init(taskID: task.id, source: .site, text: host))
            }
            if let segments = Self.subtitleSegments(for: task), !segments.isEmpty {
                indexedTranscripts += 1
                for segment in segments {
                    entries.append(.init(
                        taskID: task.id,
                        source: .transcript,
                        text: segment.text,
                        startSeconds: segment.start,
                        endSeconds: segment.end
                    ))
                }
            }
            if !entries.isEmpty {
                do {
                    try searchIndex.replaceEntries(taskID: task.id, entries: entries)
                } catch {
                    recordedSearchIndexFailures.append(
                        "rebuilding task \(task.id): \(error.localizedDescription)"
                    )
                }
            }
            processed += 1
            onProgress?(RebuildProgress(
                processed: processed,
                total: tasks.count,
                indexedTranscripts: indexedTranscripts
            ))
        }
        return RebuildProgress(
            processed: processed,
            total: tasks.count,
            indexedTranscripts: indexedTranscripts
        )
    }

    /// Read a task's subtitles, following the naming C1-5 settled on: `Movie.srt`,
    /// or `Movie.transcribed.srt` when the site had already supplied one.
    ///
    /// Public because the command line outlines a file from its existing subtitles, and
    /// duplicating the naming rules there would be how the two conventions drift apart.
    public static func subtitleSegments(for task: DownloadTask) -> [TranscriptSegment]? {
        guard let folder = task.folderPath, !task.filename.isEmpty else { return nil }
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        let stem = (task.filename as NSString).deletingPathExtension
        guard !stem.isEmpty else { return nil }
        let candidates = [
            directory.appendingPathComponent("\(stem).srt"),
            directory.appendingPathComponent("\(stem).transcribed.srt"),
        ]
        for candidate in candidates {
            guard let text = try? String(contentsOf: candidate, encoding: .utf8) else { continue }
            let segments = TranscriptDocument.parseSRT(text)
            if !segments.isEmpty { return segments }
        }
        return nil
    }

    private static func isHLS(_ task: DownloadTask) -> Bool {
        if task.linkType.lowercased() == "hls" { return true }
        return looksLikeHLS(url: task.url, filename: task.filename)
    }

    private static func looksLikeHLS(url: String, filename: String) -> Bool {
        let name = filename.lowercased()
        let u = url.lowercased()
        return name.hasSuffix(".m3u8") || u.contains(".m3u8")
    }

    /// Await until the download finishes (tests / CLI).
    public func startAndWait(taskID: Int64) async throws {
        try await start(taskID: taskID)
        while runningTasks[taskID] != nil {
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let tasks = try store.allDownloads()
        guard let task = tasks.first(where: { $0.id == taskID }) else { return }
        if task.status == .error {
            let stored = task.errorText
            let readable = DownloadDiagnostic.fromStoredErrorText(stored)
                .map { "\($0.title) [\($0.rawLabel)]" }
            throw ManagerError.downloadFailed(readable ?? stored ?? "error")
        }
        if task.status == .paused {
            throw EngineError.paused
        }
    }

    private func clearRunning(_ taskID: Int64) {
        runningTasks[taskID] = nil
        resetPresentationSpeed(taskID: taskID)
        guard runningTasks.isEmpty,
              let tasks = try? store.allDownloads() else { return }
        if let next = Self.queuedCollectionCandidate(in: tasks) {
            Task { try? await self.startWaitingTaskIfEligible(taskID: next.id) }
        } else if !settings.downloadAllAtOnce {
            if let nextWaiting = tasks.first(where: { $0.status == .waiting && $0.startAt == nil && $0.awaitingDestination != true && !Self.isCollectionEntry($0) }) {
                Task { try? await self.startWaitingTaskIfEligible(taskID: nextWaiting.id) }
            }
        }
    }

    /// Finder-style `name (2).ext` when the recovered name already exists.
    /// Delegates to the shared helper so every producer of a neighbouring file
    /// numbers collisions identically.
    private func uniqueDestination(_ url: URL) -> URL {
        DownloadFilename.uniqueURL(url)
    }

    static func queuedCollectionCandidate(in tasks: [DownloadTask]) -> DownloadTask? {
        tasks
            .filter {
                $0.status == .waiting
                    && $0.startAt == nil
                    && $0.awaitingDestination != true
                    && $0.linkType.lowercased() == "ytdlp"
                    && isCollectionEntry($0)
            }
            .min { $0.id < $1.id }
    }

    private static func isCollectionEntry(_ task: DownloadTask) -> Bool {
        if let data = task.postData,
           let options = try? JSONDecoder().decode(YtDlpDownloadOptions.self, from: data),
           options.collectionID?.isEmpty == false {
            return true
        }
        // Keep pre-metadata queues recoverable without letting an ordinary
        // single-video task with a pageURL masquerade as a playlist entry.
        guard let pageURL = task.pageURL else { return false }
        return MediaLinkClassifier.looksLikeCollectionURL(pageURL)
            && !MediaLinkClassifier.hasExplicitSingleMedia(pageURL)
    }

    public func pause(taskID: Int64) async {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        await pauseUnlocked(taskID: taskID)
    }

    /// The caller owns the lifecycle lock, including restart and schedule.
    private func pauseUnlocked(taskID: Int64) async {
        let runningTask = runningTasks[taskID]
        if var task = try? task(id: taskID), task.status != .complete, task.status != .error {
            let changed = (runningTask == nil && task.status != .paused) || task.startAt != nil
            // A queue entry has no engine to persist the pause for it. Retain
            // destination consent, bytes, and all recovery artifacts unchanged.
            if runningTask == nil { task.status = .paused }
            task.startAt = nil
            if changed, (try? store.update(task)) != nil, runningTask == nil {
                resetPresentationSpeed(taskID: taskID)
                onTaskSettled?(task)
            }
        }
        // Signal before awaiting the actor: it may currently be synchronously
        // copying a merge chunk. The loop observes this thread-safe pause token.
        engines[taskID]?.requestPause()
        // Soft-stop sockets; partial `seg.xN` kept for resume on next start().
        await engines[taskID]?.pause()
        await hlsEngines[taskID]?.pause()
        await ftpEngines[taskID]?.pause()
        await mkvEngines[taskID]?.pause()
        await ytDlpEngines[taskID]?.pause()
        // Do not acknowledge the command while the persisted row still says
        // `downloading`. The host broadcasts immediately after this returns; if
        // we return early, the renderer can remain stuck on a stale active state
        // even though the engine has already stopped.
        if let runningTask {
            await runningTask.value
        }
    }

    /// Clean restart for a task (single or retried complete/error task).
    ///
    /// Serialized per-task. Validates queue admission and task existence BEFORE
    /// wiping the work directory, preventing data loss when the queue is busy.
    public func restart(taskID: Int64) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }

        guard try store.allDownloads().contains(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }

        // Check queue admission BEFORE wiping workDir or updating store
        if !settings.downloadAllAtOnce {
            let otherRunning = runningTasks.keys.contains(where: { $0 != taskID })
            if otherRunning {
                throw ManagerError.queueBusy
            }
        }

        await pauseUnlocked(taskID: taskID)

        // The pause may have allowed the old run to persist fresher naming or
        // destination metadata. Re-check after the suspension before starting.
        guard try store.allDownloads().contains(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }

        // startUnlocked owns the strict reset. Calling the public start() here
        // would attempt to acquire the same task lock and deadlock.
        try startUnlocked(taskID: taskID, isRestart: true)
    }

    /// A06 — apply new connection count to a running/paused task (persisted + engine replan).
    public func applyConnections(taskID: Int64, count: Int) async throws {
        let n = max(1, min(count, 32))
        guard var task = try task(id: taskID) else { throw ManagerError.taskNotFound }
        task.connections = n
        try store.update(task)
        try await engines[taskID]?.applyConnectionsCount(n)
    }

    /// Persist a per-task cap and apply it to an active HTTP transfer now.
    /// Setting zero falls back to the current global cap.
    public func applyBandwidth(taskID: Int64, bytesPerSecond: Int64) async throws {
        guard var task = try task(id: taskID) else { throw ManagerError.taskNotFound }
        task.bandwidthLimit = max(0, bytesPerSecond)
        try store.update(task)
        let effectiveLimit = task.bandwidthLimit > 0
            ? task.bandwidthLimit
            : settings.bandwidthLimitBytesPerSecond
        await engines[taskID]?.applyBandwidthLimit(effectiveLimit)
    }

    /// A08 — renew expired URL while keeping task id / partial segments.
    public func renewURL(taskID: Int64, newURL: String) throws {
        guard var task = try task(id: taskID) else { throw ManagerError.taskNotFound }
        guard URL(string: newURL) != nil else { throw ManagerError.invalidURL }
        task.url = newURL
        task.errorText = nil
        if task.status == .error { task.status = .incomplete }
        try store.update(task)
    }

    /// D08 — import rows from original Neat DB.
    public func importLegacyDB(from url: URL) throws -> Int {
        try LegacyDBImporter.importDownloads(from: url, into: store)
    }

    public func currentSettings() -> AppSettings { settings }

    public func hasActiveDownloads() -> Bool {
        !runningTasks.isEmpty
    }

    /// Resume the head of a persisted collection queue after relaunch. Each
    /// completion schedules the next entry through clearRunning.
    public func resumeQueuedCollectionIfIdle() async {
        guard runningTasks.isEmpty,
              let tasks = try? store.allDownloads(),
              let next = Self.queuedCollectionCandidate(in: tasks) else { return }
        _ = try? await startWaitingTaskIfEligible(taskID: next.id)
    }

    public func updateTask(_ task: DownloadTask) throws {
        try store.update(task)
    }

    public func task(id: Int64) throws -> DownloadTask? {
        try store.allDownloads().first { $0.id == id }
    }

    public func allAuths() throws -> [AuthCredential] {
        try store.allAuths()
    }

    public func saveAuth(_ auth: AuthCredential) throws -> AuthCredential {
        try store.insertAuth(auth)
    }

    public func deleteAuth(id: Int64) throws {
        try store.deleteAuth(id: id)
    }

    public func remove(taskID: Int64, deleteFile: Bool) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }

        guard let task = try store.allDownloads().first(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }
        let fileURL = deleteFile ? try Self.validatedRemovalURL(for: task) : nil

        // A removed task must not keep writing invisibly. Cancel every engine
        // first, then await the owning task so no late completion can recreate
        // the file after it has been moved to Trash.
        let runningTask = runningTasks[taskID]
        runningTask?.cancel()
        await engines[taskID]?.cancel()
        await hlsEngines[taskID]?.cancel()
        await ftpEngines[taskID]?.cancel()
        await mkvEngines[taskID]?.cancel()
        await ytDlpEngines[taskID]?.cancel()
        if let runningTask {
            await runningTask.value
        }

        // Past this point nothing is running for this task, whatever the row says.
        // A live download's own cancellation path records that, but a stored
        // `downloading` with no engine behind it does not — a crash leaves such
        // rows and nothing resets them at launch. If the removal below fails the
        // row survives, and a task presenting as downloading with no engine has no
        // progress, no speed and no way for the user to stop it. Re-read rather
        // than reusing the snapshot above so a concurrent update is not clobbered.
        if var current = try? store.allDownloads().first(where: { $0.id == taskID }),
           current.status == .downloading {
            current.status = .incomplete
            try? store.update(current)
        }

        // The engines above are already cancelled, and that cannot be undone, so
        // dropping their registrations is correct whether or not the removal goes
        // on to succeed — a cancelled engine must not stay registered.
        defer {
            engines[taskID] = nil
            hlsEngines[taskID] = nil
            ftpEngines[taskID] = nil
            mkvEngines[taskID] = nil
            ytDlpEngines[taskID] = nil
            runningTasks[taskID] = nil
            resetPresentationSpeed(taskID: taskID)
        }

        // The old runningTask has been awaited above while this task's lifecycle
        // lock is held. No writer may still be using its crash-recovery candidate.
        // If cleanup fails, retain both the task and its receipt for retry.
        try MergeStagingReceipt.recover(
            taskID: taskID,
            in: supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
        )

        try OffsetDownloadStorage.removeIncomplete(
            taskID: taskID,
            workDirectory: supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
        )

        if let fileURL,
           FileManager.default.fileExists(atPath: fileURL.path) {
            guard let fileRecycler else {
                throw ManagerError.fileRecyclingUnavailable
            }
            try await fileRecycler(fileURL)
        }

        try store.delete(id: taskID)

        // A removed download must stop being findable. Same position and same reason
        // as the resume-data cleanup below: only once the row is really gone. A
        // failure here must not fail the removal — the index is derived data and the
        // task is already deleted — but it must not be silent either, or a stale
        // entry keeps serving content the user believes they erased.
        if let searchIndex {
            do {
                try searchIndex.deleteAll(taskID: taskID)
            } catch {
                recordedSearchIndexFailures.append(
                    "clearing index for task \(taskID): \(error.localizedDescription)"
                )
            }
        }

        // Only now, with the row actually gone, is it safe to discard the resume
        // data. This deliberately does not run on the failure paths above: the
        // work directory holds `segments.bin` and the partial `seg.xN` files, so
        // deleting it while the row survives would leave a task that still
        // advertises itself as resumable with nothing to resume from — the user
        // would be told the removal failed while their partial transfer was
        // already destroyed.
        try? FileManager.default.removeItem(
            at: supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
        )
    }

    /// Resolve the persisted task destination without trusting filename path
    /// components. Both lexical traversal and symlink escape fail closed.
    static func validatedRemovalURL(for task: DownloadTask) throws -> URL? {
        guard let folderPath = task.folderPath?.trimmingCharacters(in: .whitespacesAndNewlines),
              !folderPath.isEmpty,
              !task.filename.isEmpty else {
            return nil
        }
        let filename = task.filename
        guard (folderPath as NSString).isAbsolutePath,
              (filename as NSString).lastPathComponent == filename,
              filename != ".",
              filename != ".." else {
            throw ManagerError.unsafeFileLocation
        }

        let folder = URL(fileURLWithPath: folderPath, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let lexicalCandidate = URL(fileURLWithPath: folderPath, isDirectory: true)
            .appendingPathComponent(filename, isDirectory: false)
            .standardizedFileURL
        if let values = try? lexicalCandidate.resourceValues(forKeys: [
            .isDirectoryKey,
            .isSymbolicLinkKey,
        ]), values.isDirectory == true || values.isSymbolicLink == true {
            throw ManagerError.unsafeFileLocation
        }
        let candidate = lexicalCandidate
            .resolvingSymlinksInPath()
        let folderPrefix = folder.path.hasSuffix("/") ? folder.path : folder.path + "/"
        guard candidate.path.hasPrefix(folderPrefix) else {
            throw ManagerError.unsafeFileLocation
        }
        return candidate
    }

    /// Safely discards temporary slice files and subdirectories from a completed task's work directory.
    static func cleanCompletedWorkDirectory(at workDir: URL) {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: workDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for fileURL in entries {
            let name = fileURL.lastPathComponent
            let isSegmentOrPartial = name.hasPrefix("seg.x")
                || name == "merged.ts"
                || name == "audio.ts"
                || name == "ftp.partial"
                || name.hasSuffix(".part")
                || name.hasSuffix(".ytdl")
            let isSubdir = (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            let isCleanableSubdir = isSubdir
                && (name == "ts" || name == "audio" || name == "video" || name == "yt-dlp")
            if isSegmentOrPartial || isCleanableSubdir {
                _ = measureAndRemove(at: fileURL, isDirectory: isCleanableSubdir, fm: fm)
            }
        }
    }

    /// Reclaims stale temporary segment and slice files left behind in supportRoot
    /// for downloads that have already reached .complete status.
    ///
    /// Preserves log files and task directories, but frees orphaned multi-gigabyte
    /// `seg.x*`, `ts/`, `audio/`, and partial files.
    /// Non-blocking: file traversal runs off the actor thread.
    @discardableResult
    public func reclaimCompletedArtifacts() async -> Int64 {
        guard let tasks = try? store.allDownloads() else { return 0 }
        let completedTaskIDs = tasks.filter { $0.status == .complete }.map(\.id)
        guard !completedTaskIDs.isEmpty else { return 0 }

        var reclaimed: Int64 = 0
        for taskID in completedTaskIDs {
            // Hold the same per-task lifecycle lock used by start/restart/remove.
            // Disk traversal runs detached, so unrelated tasks remain responsive,
            // while this completed task cannot be restarted into the directory
            // that the historical cleanup is currently deleting.
            await acquireTaskLock(taskID: taskID)
            if runningTasks[taskID] == nil,
               let current = try? store.allDownloads().first(where: { $0.id == taskID }),
               current.status == .complete {
                let workDir = supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
                reclaimed += await Task.detached(priority: .utility) {
                    do {
                        switch try OffsetDownloadStorage.inspect(taskID: taskID, workDirectory: workDir) {
                        case .published:
                            // A completed row alone never authorizes deleting payload.
                            // Retire only metadata after verifying the published inode.
                            try OffsetDownloadStorage.retirePublished(taskID: taskID, workDirectory: workDir)
                        case .absent: break
                        case .incomplete, .cleanupPending, .partialMissing: return Int64(0)
                        }
                    } catch {
                        // Preserve the receipt and work directory for recovery.
                        return Int64(0)
                    }
                    return Self.reclaimCompletedWorkDirectory(at: workDir)
                }.value
            }
            releaseTaskLock(taskID: taskID)
        }
        return reclaimed
    }

    nonisolated static func reclaimCompletedWorkDirectory(at workDir: URL) -> Int64 {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: workDir,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }

        var reclaimed: Int64 = 0
        for fileURL in entries {
            let name = fileURL.lastPathComponent
            let isSegmentOrPartial = name.hasPrefix("seg.x")
                || name == "merged.ts"
                || name == "audio.ts"
                || name == "ftp.partial"
                || name.hasSuffix(".part")
                || name.hasSuffix(".ytdl")
            let isDirectory = (try? fileURL.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            let isCleanableDirectory = isDirectory
                && (name == "ts" || name == "audio" || name == "video" || name == "yt-dlp")
            if (isSegmentOrPartial || isCleanableDirectory),
               let freed = measureAndRemove(
                   at: fileURL,
                   isDirectory: isCleanableDirectory,
                   fm: fm
               ) {
                reclaimed += freed
            }
        }
        return reclaimed
    }

    /// Non-isolated compatibility helper used by focused cleanup tests.
    nonisolated static func reclaimCompletedFiles(completedTaskIDs: Set<Int64>, supportRoot: URL) -> Int64 {
        completedTaskIDs.reduce(into: Int64(0)) { total, taskID in
            total += reclaimCompletedWorkDirectory(
                at: supportRoot.appendingPathComponent("\(taskID)", isDirectory: true)
            )
        }
    }

    /// Recursively measures regular file bytes in a target file/directory and removes it.
    /// Returns the exact freed bytes ONLY IF removeItem succeeds.
    nonisolated static func measureAndRemove(at url: URL, isDirectory: Bool, fm: FileManager) -> Int64? {
        let size: Int64
        if isDirectory {
            var subTotal: Int64 = 0
            if let enumerator = fm.enumerator(
                at: url,
                includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                options: [.skipsHiddenFiles]
            ) {
                for case let fileURL as URL in enumerator {
                    if let values = try? fileURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                       values.isRegularFile == true,
                       let s = values.fileSize {
                        subTotal += Int64(s)
                    }
                }
            }
            size = subTotal
        } else {
            size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        }

        do {
            try fm.removeItem(at: url)
            return size
        } catch {
            return nil
        }
    }
}

public enum ManagerError: Error, LocalizedError {
    case invalidURL
    case taskNotFound
    case downloadFailed(String)
    case queueBusy
    case insufficientStorage(requiredBytes: Int64, availableBytes: Int64)
    case unsafeFileLocation
    case fileRecyclingUnavailable
    case destinationConfirmationRequired

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .taskNotFound: return "Task not found"
        case .downloadFailed(let m): return m
        case .queueBusy: return "Another download is active (one-by-one mode)"
        case .insufficientStorage(let required, let available):
            return L10n.storageGuardError(
                requiredBytes: required,
                availableBytes: available
            )
        case .unsafeFileLocation:
            return "The downloaded file is outside its recorded download folder. Nothing was removed."
        case .fileRecyclingUnavailable:
            return "This environment cannot move files to Trash. Nothing was removed."
        case .destinationConfirmationRequired:
            return L10n.t("Choose where to save this download before starting it.", "请先选择这个下载的保存目录。")
        }
    }
}
