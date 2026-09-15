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
    private let directoryRules: DownloadDirectoryRuleStore
    private let fileRecycler: FileRecycler?
    private let capacityProvider: @Sendable (URL) -> Int64?
    private let sameVolumeProvider: @Sendable (URL, URL) -> Bool
    private var engines: [Int64: DownloadEngine] = [:]
    private var mirrorEngines: [Int64: MirrorDownloadEngine] = [:]
    private var hlsEngines: [Int64: HLSEngine] = [:]
    private var ftpEngines: [Int64: FTPEngine] = [:]
    private var mkvEngines: [Int64: MKVMergeEngine] = [:]
    private var ytDlpEngines: [Int64: YtDlpEngine] = [:]
    private var auxiliaryDaemon: AuxiliaryDaemon?
    private var auxiliaryTransfers: [Int64: AuxiliaryTransfer] = [:]
    private var auxiliaryCredentials: [Int64: AuxiliaryCredentials] = [:]
    private var auxiliarySnapshots: [Int64: AuxiliarySnapshot] = [:]
    private var auxiliaryTokens: [Int64: CancelToken] = [:]
    private var auxiliaryBTGlobalBusy = false
    private var auxiliaryBTGlobalWaiters: [CheckedContinuation<Void, Never>] = []
    private var auxiliaryBTMutationIDs: Set<Int64> = []
    private var auxiliaryProxyUpdateTail: Task<AuxiliaryProxyError?, Never>?
    private var auxiliaryProxyUnavailable = false
    private var auxiliaryProxyRevision: UInt64 = 0
    /// Metadata fetching and seeding do not consume the ordinary payload slot.
    private var auxiliaryNonblockingTaskIDs: Set<Int64> = []
    private var queueIsIdle: Bool { runningTasks.keys.allSatisfy { auxiliaryNonblockingTaskIDs.contains($0) } }
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
        onTaskCompleted: (@Sendable (DownloadTask) -> Void)? = nil,
        auxiliaryDaemon: AuxiliaryDaemon? = nil
    ) {
        self.store = store
        self.settings = settings
        self.supportRoot = supportRoot
        self.directoryRules = DownloadDirectoryRuleStore(path: supportRoot.appendingPathComponent("directory-rules.json"))
        self.fileRecycler = fileRecycler
        self.searchIndex = searchIndex
        self.capacityProvider = capacityProvider
        self.sameVolumeProvider = sameVolumeProvider
        self.onTaskCompleted = onTaskCompleted
        self.auxiliaryDaemon = auxiliaryDaemon
    }

    @discardableResult
    public func updateSettings(_ settings: AppSettings) async -> AuxiliaryProxyError? {
        let wasAllAtOnce = self.settings.downloadAllAtOnce
        let oldProxy = AuxiliaryProxyPlan(settings: self.settings)
        self.settings = settings
        if oldProxy != AuxiliaryProxyPlan(settings: settings) || auxiliaryProxyUnavailable {
            auxiliaryProxyRevision &+= 1
            let revision = auxiliaryProxyRevision, previous = auxiliaryProxyUpdateTail
            let transition = Task<AuxiliaryProxyError?, Never> {
                _ = await previous?.value
                do { try await self.pauseAuxiliaryForProxyChange(); return nil }
                catch { return .proxyUnavailable }
            }
            auxiliaryProxyUpdateTail = transition
            let failure = await transition.value
            if auxiliaryProxyRevision == revision { auxiliaryProxyUpdateTail = nil }
            if let failure { return failure }
        }
        for (taskID, engine) in engines {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            let effectiveLimit = taskLimit > 0
                ? taskLimit
                : self.settings.bandwidthLimitBytesPerSecond
            await engine.applyBandwidthLimit(effectiveLimit)
        }
        for (taskID, engine) in mirrorEngines {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            await engine.applyBandwidthLimit(taskLimit > 0 ? taskLimit : self.settings.bandwidthLimitBytesPerSecond)
        }
        for (taskID, engine) in ftpEngines {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            await engine.applyBandwidthLimit(taskLimit > 0 ? taskLimit : self.settings.bandwidthLimitBytesPerSecond)
        }
        for (taskID, engine) in hlsEngines {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            await engine.applyBandwidthLimit(taskLimit > 0 ? taskLimit : self.settings.bandwidthLimitBytesPerSecond)
        }
        for (taskID, engine) in auxiliaryTransfers {
            let taskLimit = (try? task(id: taskID))?.bandwidthLimit ?? 0
            try? await engine.applyBandwidthLimit(taskLimit > 0 ? taskLimit : self.settings.bandwidthLimitBytesPerSecond)
        }
        for engine in mkvEngines.values {
            // Read the current setting after actor suspension; an earlier update
            // must not restore its captured temporary cap onto a dual-track task.
            await engine.applyDefaultBandwidthLimit(self.settings.bandwidthLimitBytesPerSecond)
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
        return nil
    }

    public func reloadDirectoryRules() throws { try directoryRules.reload() }

    public func fallbackDirectory(url: String, filename: String?) -> URL {
        let name = filename?.isEmpty == false ? filename! : URL(string: url)?.lastPathComponent ?? ""
        return DownloadDestinationPolicy.directory(defaultDirectory: settings.downloadDirectory,
            override: nil, category: DownloadCategory.infer(filename: name, mimeType: nil),
            organizeByCategory: settings.useCategoryFolders)
    }

    private func resolvedDirectory(url: String, filename: String, explicit: URL?, category: DownloadCategory) throws -> URL {
        let fallback = DownloadDestinationPolicy.directory(defaultDirectory: settings.downloadDirectory,
            override: explicit, category: category, organizeByCategory: settings.useCategoryFolders)
        return try directoryRules.directory(url: url, filename: filename, explicit: explicit, fallback: fallback)
    }

    private func startWaitingTasksAfterQueueModeChange() async {
        guard let tasks = try? store.allDownloads(), let ordinaryWaiting = try? ordinaryWaiting(in: tasks) else { return }
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
        if let task = try? task(id: taskID), let record = task.auxiliary {
            let snapshot = auxiliarySnapshots[taskID]
            return progressForPresentation(DownloadProgress(taskID: taskID, totalBytes: task.fileSize,
                completedBytes: snapshot?.completedBytes ?? record.completedBytes,
                bytesPerSecond: Double(snapshot?.downloadSpeed ?? 0), status: task.status,
                phase: ["metadata", "checking"].contains(record.phase) ? .preparing : .transferring,
                effectiveBandwidthLimitBytesPerSecond: task.bandwidthLimit > 0 ? task.bandwidthLimit : settings.bandwidthLimitBytesPerSecond), taskID: taskID)
        }
        if let engine = mirrorEngines[taskID] {
            return progressForPresentation(await engine.currentProgress(), taskID: taskID)
        }
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

    /// Ordinary UI admission includes all metadata in the same transaction as
    /// its optional receipt. Replays return the original row and never start it.
    public func createURL(
        _ urlString: String, mirrors: [String] = [], connections: Int? = nil, pageURL: String? = nil,
        pageTitle: String? = nil, headers: [String] = [], method: String = "GET",
        postData: Data? = nil, ltype: String = "normal", destinationDirectory: URL? = nil,
        thumbnailURL: String? = nil, formatID: String? = nil, filename: String? = nil,
        filenameIsExplicit: Bool = true,
        autoStart: Bool = true, creationIntent: DownloadCreationIntent? = nil
    ) async throws -> DownloadTask? {
        if urlString.hasPrefix("magnet:?") {
            guard mirrors.isEmpty, headers.isEmpty, pageURL == nil, method.uppercased() == "GET", postData == nil else { throw AuxiliaryProductError.invalidSource }
            return try await createAuxiliary(source: .magnet(urlString), destinationDirectory: destinationDirectory,
                autoStart: false, creationIntent: creationIntent)
        }
        try MirrorDownloadPolicy.validate(primary: urlString, mirrors: mirrors, headers: headers, pageURL: pageURL)
        if !mirrors.isEmpty, method.uppercased() != "GET" || postData != nil { throw MirrorDownloadError.invalidSources }
        if let creationIntent, let receipt = try store.reserveCreation(creationIntent) {
            return try task(id: receipt.taskID)
        }
        var task = try makeURLTask(urlString, connections: connections, pageURL: pageURL,
            pageTitle: pageTitle, headers: headers, method: method, postData: postData,
            ltype: ltype, destinationDirectory: destinationDirectory)
        if !mirrors.isEmpty {
            guard !Self.isHLS(task), task.linkType.lowercased() == "normal" else { throw MirrorDownloadError.invalidSources }
            task.mirrorURLs = mirrors
        }
        if let thumbnailURL, URL(string: thumbnailURL)?.scheme?.lowercased() == "https" {
            task.thumbnailURL = thumbnailURL
        }
        if let formatID, !formatID.isEmpty { task.hitTitle = formatID }
        if let filename {
            let clean = DownloadFilename.sanitize(filename)
            if !clean.isEmpty {
                task.filename = clean
                if filenameIsExplicit { task.requestedFilename = clean }
                task.category = DownloadCategory.infer(filename: clean, mimeType: task.mimeType)
                task.folderPath = try resolvedDirectory(url: task.url, filename: clean,
                    explicit: destinationDirectory, category: task.category).path
            }
        }
        if let creationIntent {
            switch try store.commitCreation(creationIntent, task: task) {
            case .committed(let saved): task = saved
            case .replayed(let receipt): return try self.task(id: receipt.taskID)
            }
        } else { task = try store.insert(task) }
        if autoStart {
            // This takes the usual task lock and will not undo a pause/delete
            // arriving while admission is handing the task over to the queue.
            try await startCreatedTask(taskID: task.id)
        }
        return try self.task(id: task.id)
    }

    private func startCreatedTask(taskID: Int64) async throws {
        var enteredOrdinaryQueue = false
        do {
            await acquireTaskLock(taskID: taskID)
            defer { releaseTaskLock(taskID: taskID) }
            await waitForBTGlobalOperation(taskID: taskID)
            guard var task = try self.task(id: taskID), task.status == .incomplete,
                  task.awaitingDestination != true else { return }
            if !settings.downloadAllAtOnce, !Self.isCollectionEntry(task) {
                // A newly created automatic task joins the queue even when the
                // current writer has just finished. Otherwise it can take the
                // idle slot before an older queued callback obtains its lock.
                task.status = .waiting
                try store.update(task)
                enteredOrdinaryQueue = true
            } else {
                do { try startUnlocked(taskID: taskID) }
                catch ManagerError.queueBusy {
                    task.status = .waiting
                    try store.update(task)
                } catch {
                    task = try self.task(id: taskID) ?? task
                    task.status = .error
                    task.errorText = DownloadDiagnostic.classify(error).storageString
                    try store.update(task)
                    onTaskSettled?(task)
                }
            }
        }
        // Release this task's lock before the queue may select the same task.
        if enteredOrdinaryQueue { await startNextWaitingTaskIfIdle() }
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
        task.folderPath = try resolvedDirectory(url: task.url, filename: task.filename,
            explicit: destinationDirectory, category: task.category).path
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
        destinationDirectory: URL? = nil,
        connections: Int? = nil,
        creationIntent: DownloadCreationIntent? = nil
    ) async throws -> DownloadTask {
        if let creationIntent, let receipt = try store.reserveCreation(creationIntent) {
            guard let original = try task(id: receipt.taskID) else { throw ManagerError.taskNotFound }
            return original
        }
        if !settings.downloadAllAtOnce, !queueIsIdle {
            throw ManagerError.queueBusy
        }
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

        let dest = try resolvedDirectory(url: url, filename: filename, explicit: destinationDirectory, category: .video)
        try validateStorage(StorageBudget.media(
            sampleFinalBytes: estimatedBytes,
            sampleComponentBytes: estimatedComponentBytes,
            sampleDurationSeconds: nil
        ), destinationDirectory: dest)
        var task = DownloadTask(
            url: url,
            filename: filename,
            linkType: "ytdlp",
            fileSize: max(0, estimatedBytes ?? 0),
            category: .video,
            status: .downloading,
            connections: max(1, min(32, connections ?? settings.maxConnections)),
            lastTry: Date(),
            firstTry: Date(),
            resumable: false,
            pageURL: pageURL,
            pageTitle: pageTitle,
            thumbnailURL: thumbnailURL,
            hitTitle: formatID,
            mimeType: options.container.mimeType,
            postData: try? JSONEncoder().encode(options),
            folderPath: dest.path,
            requestedFilename: preferredFilename?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? filename : nil
        )
        if let creationIntent {
            switch try store.commitCreation(creationIntent, task: task) {
            case .committed(let saved): task = saved
            case .replayed(let receipt):
                guard let original = try self.task(id: receipt.taskID) else { throw ManagerError.taskNotFound }
                return original
            }
        } else { task = try store.insert(task) }
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
        if queueIsIdle, let first = inserted.first {
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
            let dest = try resolvedDirectory(url: item.url, filename: "\(stem).\(ext)", explicit: destinationDirectory, category: .video)
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

        // A source page identifies a browsing context, not a downloadable object.
        // Only an unambiguous replay of the same request may resume an old task.
        // New URLs or session headers take the ordinary new-task admission path;
        // the original task keeps both its request provenance and owned files.
        if var task = try linkRescueCandidate(for: message) {
            task.errorText = nil
            task.status = .incomplete
            task.lastTry = Date()
            task.completedAt = nil
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
        task.folderPath = try resolvedDirectory(url: task.url, filename: task.filename, explicit: nil, category: task.category).path
        return (task, false)
    }

    private func linkRescueCandidate(for message: ParsedBridgeMessage) throws -> DownloadTask? {
        let incomingPage = message.pageURL.isEmpty ? message.referer : message.pageURL
        guard let incomingKey = DuplicateDownloadMatcher.canonicalKey(for: incomingPage) else {
            return nil
        }
        let headers = Self.requestHeaders(Self.bridgeHeaders(from: message))
        guard ["", "normal"].contains(message.ltype.lowercased()), message.alternateURL.isEmpty,
              !Self.looksLikeHLS(url: message.url, filename: message.filename) else { return nil }
        let candidates = try store.allDownloads().filter { task in
            guard task.status == .error, runningTasks[task.id] == nil, inFlightOperations[task.id] == nil,
                  ["http", "https"].contains(URL(string: task.url)?.scheme?.lowercased() ?? ""),
                  ["", "normal"].contains(task.linkType.lowercased()), !Self.isHLS(task),
                  task.alternateURL?.isEmpty != false,
                  let pageURL = task.pageURL,
                  DuplicateDownloadMatcher.canonicalKey(for: pageURL) == incomingKey,
                  let diagnostic = DownloadDiagnostic.fromStoredErrorText(task.errorText),
                  task.url == message.url, task.method == message.method,
                  task.postData == message.postData.map({ Data($0.utf8) }),
                  Self.requestHeaders(task.headers) == headers,
                  task.userAgent == (message.userAgent.isEmpty ? nil : message.userAgent) else {
                return false
            }
            switch diagnostic {
            case .linkExpired, .signInRequired: return true
            default: return false
            }
        }
        // Never select the first of several failed downloads from one page.
        return candidates.count == 1 ? candidates[0] : nil
    }

    /// Keep admission comparison identical to the engine request construction.
    private static func requestHeaders(_ lines: [String]) -> [String: String] {
        var result: [String: String] = [:]
        for line in lines {
            if let idx = line.firstIndex(of: ":") {
                let name = String(line[..<idx]).trimmingCharacters(in: .whitespaces)
                let value = String(line[line.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
                result[name] = value
            }
        }
        return result
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
        await waitForBTGlobalOperation(taskID: taskID)
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
        await waitForBTGlobalOperation(taskID: taskID)
        guard var task = try task(id: taskID), task.status == .waiting,
              task.awaitingDestination != true, task.startAt == scheduledAt else { return false }
        if scheduledAt == nil, !settings.downloadAllAtOnce, !Self.isCollectionEntry(task) {
            let tasks = try store.allDownloads()
            guard Self.queuedCollectionCandidate(in: tasks) == nil,
                  try ordinaryWaiting(in: tasks).first?.id == taskID else { return false }
        }
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
        try await startCreatedTask(taskID: taskID)
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
        await waitForBTGlobalOperation(taskID: taskID)
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
        let tasks = try store.allDownloads()
        guard var task = tasks.first(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }
        guard task.awaitingDestination != true else { throw ManagerError.destinationConfirmationRequired }
        let metadataOnly = task.auxiliary.map { $0.engineKind == "bittorrent" && $0.selectedFiles == nil && !$0.published } ?? false
        if !settings.downloadAllAtOnce, !queueIsIdle, !metadataOnly { throw ManagerError.queueBusy }
        if task.auxiliary != nil {
            try startAuxiliaryUnlocked(taskID: taskID, destinationDirectory: destinationDirectory, isRestart: isRestart)
            return
        }
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

        let headerMap = Self.requestHeaders(task.headers)

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
        let mirrorEngine: MirrorDownloadEngine?
        if let mirrors = task.mirrorURLs, !mirrors.isEmpty {
            guard !useFTP, !useHLS, !useMKV else { throw MirrorDownloadError.invalidSources }
            mirrorEngine = try MirrorDownloadEngine(taskID: taskID, request: request, mirrors: mirrors,
                workDirectory: workDir, httpProxy: settings.httpProxy, socksProxy: settings.socksProxy,
                globalBandwidthLimit: settings.bandwidthLimitBytesPerSecond,
                autoTuneConnections: settings.smartConnectionsEnabled,
                capacityProvider: capacityProvider, sameVolumeProvider: sameVolumeProvider)
        } else { mirrorEngine = nil }
        task.status = .downloading
        task.lastTry = Date()
        task.completedAt = nil
        try store.update(task)

        let onComplete = onTaskCompleted
        if let engine = mirrorEngine {
            mirrorEngines[taskID] = engine
            runningTasks[taskID] = Task { [store] in
                await self.runEngine(taskID: taskID, task: task, store: store, onComplete: onComplete) {
                    try await engine.start()
                }
            }
        } else if useFTP {
            let engine = FTPEngine(
                taskID: taskID,
                request: request,
                workDirectory: workDir,
                ftpProxy: settings.ftpProxy,
                socksProxy: settings.socksProxy,
                globalBandwidthLimit: settings.bandwidthLimitBytesPerSecond
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
                socksProxy: settings.socksProxy,
                globalBandwidthLimit: settings.bandwidthLimitBytesPerSecond
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
            if done.requestedFilename == nil && !DownloadFilename.isUseful(diskName) {
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
                if usesOffsetPublished || done.requestedFilename != nil {
                    finalizedURL = try SmartFinalize.applySmartNaming(primary: workingURL,
                        pageTitle: done.pageTitle, requestedFilename: done.requestedFilename,
                        primaryRenamer: renamePrimary).primaryURL
                } else {
                    finalizedURL = (try? SmartFinalize.applySmartNaming(primary: workingURL,
                        pageTitle: done.pageTitle, requestedFilename: done.requestedFilename))?.primaryURL ?? workingURL
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

    // MARK: - Auxiliary protocols in the same download ledger

    private func sharedAuxiliaryDaemon() throws -> AuxiliaryDaemon {
        if let auxiliaryDaemon { return auxiliaryDaemon }
        let daemon = try AuxiliaryBundledEngine.daemon(supportRoot: supportRoot)
        auxiliaryDaemon = daemon
        return daemon
    }

    private func configuredAuxiliaryDaemon() async throws -> AuxiliaryDaemon {
        guard !auxiliaryProxyUnavailable else { throw AuxiliaryProxyError.proxyUnavailable }
        guard auxiliaryProxyUpdateTail == nil else { throw AuxiliaryProxyError.proxyChanged }
        let plan = AuxiliaryProxyPlan(settings: settings)
        let daemon = try sharedAuxiliaryDaemon()
        await daemon.setProxyPlan(plan)
        return daemon
    }
    public func auxiliaryCapabilities() async throws -> AuxiliaryCapabilities { try await configuredAuxiliaryDaemon().start() }

    private func pauseAuxiliaryForProxyChange() async throws {
        auxiliaryProxyUnavailable = true
        // Stop known live work before touching the ledger. Even a failed read
        // must not leave an old-proxy connection alive or permit a new launch.
        let knownIDs = Set(auxiliaryTokens.keys).union(auxiliaryTransfers.keys)
        knownIDs.forEach { auxiliaryTokens[$0]?.pause() }
        let daemon = auxiliaryDaemon
        await daemon?.beginProxyTransition()
        for id in knownIDs { await runningTasks[id]?.value }
        auxiliaryTransfers.removeAll(); auxiliarySnapshots.removeAll()
        let all = try store.allDownloads()
        let ids = all.filter { $0.auxiliary != nil && $0.auxiliary?.published != true }.map(\.id)
        let plan = AuxiliaryProxyPlan(settings: settings)
        for id in ids {
            guard var task = try self.task(id: id), var record = task.auxiliary, !record.published else { continue }
            let pauseReason: AuxiliaryProxyError
            do { try plan.validate(kind: record.engineKind); pauseReason = .proxyChanged }
            catch let failure as AuxiliaryProxyError { pauseReason = failure }
            catch { pauseReason = .proxyUnavailable }
            task.status = .paused; task.startAt = nil; task.errorText = pauseReason.localizedDescription
            if record.phase != "awaitingSelection" { record.phase = "paused" }
            record.errorCode = pauseReason.rawValue; task.auxiliary = record
            try store.update(task); onTaskSettled?(task)
        }
        // Do not release either gate until every paused row is durable. Retrying
        // the same settings after disk recovery repeats this entire transition.
        await daemon?.finishProxyTransition(plan)
        auxiliaryProxyUnavailable = false
    }

    public func createAuxiliary(source: AuxiliarySource, credentials: AuxiliaryCredentials? = nil,
                                destinationDirectory: URL? = nil, autoStart: Bool = false,
                                creationIntent: DownloadCreationIntent? = nil) async throws -> DownloadTask? {
        var record = try AuxiliaryTaskRecord(source: source)
        guard record.engineKind != "bittorrent" || !autoStart else { throw AuxiliaryProductError.selectionRequired }
        if record.kind == "sftp", credentials == nil { throw AuxiliaryProductError.credentialsRequired }
        var proxyFailure: AuxiliaryProxyError?
        do {
            if auxiliaryProxyUnavailable { throw AuxiliaryProxyError.proxyUnavailable }
            try AuxiliaryProxyPlan(settings: settings).validate(kind: record.engineKind)
        }
        catch let failure as AuxiliaryProxyError { proxyFailure = failure }
        if let creationIntent, let receipt = try store.reserveCreation(creationIntent) { return try task(id: receipt.taskID) }
        record.phase = proxyFailure == nil && record.engineKind == "bittorrent" ? "metadata" : "paused"
        record.errorCode = proxyFailure?.rawValue
        let filename = record.initialFilename
        let category = DownloadCategory.infer(filename: filename, mimeType: nil)
        let destination = try resolvedDirectory(url: record.displayURL, filename: filename, explicit: destinationDirectory, category: category)
        var task = DownloadTask(url: record.displayURL, filename: filename, linkType: record.engineKind,
            category: category, connections: 1, lastTry: Date(), firstTry: Date(), resumable: true,
            folderPath: destination.path, auxiliary: record)
        if let proxyFailure { task.status = .paused; task.errorText = proxyFailure.localizedDescription }
        if let creationIntent {
            switch try store.commitCreation(creationIntent, task: task) {
            case .committed(let saved): task = saved
            case .replayed(let receipt): return try self.task(id: receipt.taskID)
            }
        } else { task = try store.insert(task) }
        auxiliaryCredentials[task.id] = credentials
        // Proxy refusal is a persisted, recoverable task outcome. The atomic
        // receipt ACK still proves acceptance and prevents duplicate creation.
        if proxyFailure != nil { onTaskSettled?(task); return task }
        if record.engineKind == "bittorrent" {
            // Reading metadata is the first explicit BT action. Payload remains
            // gated even if an older composer submitted autoStart for a magnet.
            do { try await start(taskID: task.id) }
            catch { try persistAuxiliaryFailure(taskID: task.id, generation: record.generation, error: error) }
        } else if autoStart { try await startCreatedTask(taskID: task.id) }
        else { task.status = .paused; try store.update(task) }
        return try self.task(id: task.id)
    }

    public func auxiliaryStatus(taskID: Int64) throws -> AuxiliaryTaskStatus {
        guard let task = try task(id: taskID), task.auxiliary != nil else { throw AuxiliaryProductError.notFound }
        return try AuxiliaryTaskStatus(task: task, live: runningTasks[taskID] == nil ? nil : auxiliarySnapshots[taskID])
    }

    public func auxiliaryAuthenticate(taskID: Int64, generation: Int64, credentials: AuxiliaryCredentials, autoStart: Bool) async throws {
        await acquireTaskLock(taskID: taskID)
        do {
            guard var task = try task(id: taskID), var record = task.auxiliary, record.kind == "sftp", !record.published else { throw AuxiliaryProductError.notFound }
            guard record.generation == generation else { throw AuxiliaryProductError.staleGeneration }
            _ = try await configuredAuxiliaryDaemon()
            try AuxiliaryProxyPlan(settings: settings).validate(kind: record.engineKind)
            await pauseAuxiliaryUnlocked(taskID: taskID)
            try await auxiliaryTransfers[taskID]?.releaseAdmissionForCredentialRefresh()
            task = try self.task(id: taskID) ?? task
            auxiliaryCredentials[taskID] = credentials
            auxiliaryTransfers[taskID] = nil
            record = task.auxiliary ?? record; record.phase = "paused"; record.errorCode = nil
            task.auxiliary = record; task.status = autoStart ? .incomplete : .paused; task.errorText = nil
            try store.update(task)
            releaseTaskLock(taskID: taskID)
        } catch { releaseTaskLock(taskID: taskID); throw error }
        if autoStart { try await startCreatedTask(taskID: taskID) }
    }

    public func auxiliarySelectFiles(taskID: Int64, generation: Int64, indices: [Int], autoStart: Bool) async throws {
        await acquireTaskLock(taskID: taskID)
        do {
            guard var task = try task(id: taskID), var record = task.auxiliary, record.engineKind == "bittorrent" else { throw AuxiliaryProductError.notFound }
            guard record.generation == generation else { throw AuxiliaryProductError.staleGeneration }
            guard runningTasks[taskID] == nil, !record.published, ["paused", "awaitingSelection"].contains(record.phase) else { throw AuxiliaryProductError.selectionRequired }
            guard !indices.isEmpty, Set(indices).count == indices.count,
                  indices.allSatisfy({ index in record.files.contains { $0.index == index } }) else { throw AuxiliaryTransferError.invalidSelection }
            _ = try await configuredAuxiliaryDaemon()
            let transfer = try auxiliaryTransfer(for: task)
            // Durable user selection precedes helper mutation. A lost RPC ACK
            // can be replayed only for this exact task and generation.
            record.selectedFiles = indices.sorted(); record.errorCode = nil; task.auxiliary = record
            try store.update(task)
            let snapshot = try await transfer.selectFiles(indices)
            task = try persistAuxiliarySnapshot(snapshot)
            task.status = autoStart ? .incomplete : .paused
            try store.update(task)
            releaseTaskLock(taskID: taskID)
        } catch { releaseTaskLock(taskID: taskID); throw error }
        if autoStart { try await startCreatedTask(taskID: taskID) }
    }

    public func auxiliaryStopSeeding(taskID: Int64, generation: Int64) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        await waitForBTGlobalOperation(taskID: taskID)
        guard var task = try task(id: taskID), var record = task.auxiliary, ["bittorrent", "ed2k"].contains(record.engineKind) else { throw AuxiliaryProductError.notFound }
        guard record.generation == generation else { throw AuxiliaryProductError.staleGeneration }
        if record.published { return }
        guard record.payloadCompleted, ["seeding", "paused"].contains(record.phase) else { throw AuxiliaryProductError.notSeeding }
        let plan = AuxiliaryProxyPlan(settings: settings)
        if record.kind == "ed2k", plan.enabled, record.phase == "paused", record.errorCode == AuxiliaryProxyError.proxyUnsupported.rawValue,
           auxiliaryTransfers[taskID] == nil, runningTasks[taskID] == nil {
            // The proxy transition persisted this state only after terminating
            // the old helper. Publishing verified local bytes needs no new
            // ED2K admission and must not require disabling the user's proxy.
            let offline = try AuxiliaryTransfer(taskID: taskID, generation: generation, source: record.source(),
                workDirectory: auxiliaryWorkDirectory(taskID: taskID, generation: generation), daemon: sharedAuxiliaryDaemon(), filename: task.filename)
            let snapshot = try await offline.offlineED2KPublicationSnapshot(files: record.files)
            record.stopSeedingRequested = true; task.auxiliary = record; try store.update(task)
            let token = CancelToken(); auxiliaryTokens[taskID] = token
            defer { auxiliaryTokens[taskID] = nil }
            try await publishAuxiliary(task: task, snapshot: snapshot, token: token)
            return
        }
        _ = try await configuredAuxiliaryDaemon()
        try plan.validate(kind: record.engineKind)
        record.stopSeedingRequested = true; task.auxiliary = record; try store.update(task)
        let transfer = try auxiliaryTransfer(for: task)
        _ = try await transfer.pause()
        if let running = runningTasks[taskID] { await running.value }
        else { try startAuxiliaryUnlocked(taskID: taskID); await runningTasks[taskID]?.value }
        guard (try self.task(id: taskID))?.auxiliary?.published == true else { throw AuxiliaryProductError.storage }
    }

    private func btTask(taskID: Int64, generation: Int64) throws -> DownloadTask {
        guard let task = try task(id: taskID), let record = task.auxiliary else { throw AuxiliaryBTError.notFound }
        guard record.engineKind == "bittorrent" else { throw AuxiliaryBTError.unsupported }
        guard record.generation == generation else { throw AuxiliaryBTError.staleGeneration }
        return task
    }
    private func requireBTPaused(_ task: DownloadTask) throws {
        guard !auxiliaryBTGlobalBusy, runningTasks[task.id] == nil, task.auxiliary?.published == false,
              ["paused", "awaitingSelection"].contains(task.auxiliary?.phase ?? "") else { throw AuxiliaryBTError.notPaused }
    }
    public func auxiliaryBTStatus(taskID: Int64, generation: Int64) async throws -> AuxiliaryBTState {
        await acquireTaskLock(taskID: taskID); defer { releaseTaskLock(taskID: taskID) }
        guard !auxiliaryBTGlobalBusy else { throw AuxiliaryBTError.unconfirmed }
        auxiliaryBTMutationIDs.insert(taskID); defer { auxiliaryBTMutationIDs.remove(taskID) }
        return try await btStatusUnlocked(taskID: taskID, generation: generation)
    }
    private func btStatusUnlocked(taskID: Int64, generation: Int64) async throws -> AuxiliaryBTState {
        var task = try btTask(taskID: taskID, generation: generation)
        if task.auxiliary?.published == true {
            let record = task.auxiliary!.bt ?? .init(config: .init())
            return AuxiliaryBTState(taskID: taskID, generation: generation, revision: record.revision, phase: "complete", config: record.config, trackers: [], peers: [])
        }
        _ = try await configuredAuxiliaryDaemon()
        let transfer = try auxiliaryTransfer(for: task)
        let readback: AuxiliaryBTReadback
        if let bt = task.auxiliary?.bt, runningTasks[taskID] == nil, ["paused", "awaitingSelection"].contains(task.auxiliary?.phase ?? "") {
            do { readback = try await transfer.applyBTConfiguration(bt.config) } catch { throw AuxiliaryBTError.unconfirmed }
        } else { readback = try await transfer.btControls() }
        // The row may have progressed while awaiting the RPC. Never replace a
        // newer manifest with the snapshot read at the beginning of this call.
        task = try btTask(taskID: taskID, generation: generation)
        if var bt = task.auxiliary?.bt {
            guard AuxiliaryBTValidation.equivalent(bt.config, readback.config) else { throw AuxiliaryBTError.unconfirmed }
            if bt.pending { bt.pending = false; task.auxiliary?.bt = bt; try store.update(task) }
        } else if task.auxiliary?.phase != "metadata" {
            task.auxiliary?.bt = .init(config: readback.config); try store.update(task)
        }
        let saved = task.auxiliary?.bt
        return AuxiliaryBTState(taskID: taskID, generation: generation, revision: saved?.revision ?? 0,
            phase: try auxiliaryStatus(taskID: taskID).phase, config: saved?.config ?? readback.config, trackers: readback.trackers, peers: readback.peers)
    }
    public func auxiliaryBTConfigure(taskID: Int64, generation: Int64, expectedRevision: Int64, config value: AuxiliaryBTConfig) async throws -> AuxiliaryBTState {
        let config = try AuxiliaryBTValidation.config(value)
        await acquireTaskLock(taskID: taskID); defer { releaseTaskLock(taskID: taskID) }
        var task = try btTask(taskID: taskID, generation: generation); try requireBTPaused(task)
        auxiliaryBTMutationIDs.insert(taskID); defer { auxiliaryBTMutationIDs.remove(taskID) }
        let current = try await btStatusUnlocked(taskID: taskID, generation: generation)
        guard current.revision == expectedRevision else { throw AuxiliaryBTError.conflict }
        guard expectedRevision < AuxiliaryBTValidation.safeInteger else { throw AuxiliaryBTError.storage }
        task = try btTask(taskID: taskID, generation: generation); try requireBTPaused(task)
        task.auxiliary?.bt = .init(revision: expectedRevision + 1, config: config, pending: true)
        do { try store.update(task) } catch { throw AuxiliaryBTError.storage }
        let transfer = try auxiliaryTransfer(for: task)
        do { _ = try await transfer.applyBTConfiguration(config) } catch { throw AuxiliaryBTError.unconfirmed }
        return try await btStatusUnlocked(taskID: taskID, generation: generation)
    }
    public func auxiliaryBTAddPeers(taskID: Int64, generation: Int64, peers: [String]) async throws -> AuxiliaryBTAddedPeers {
        let peers = try AuxiliaryBTValidation.peers(peers)
        await acquireTaskLock(taskID: taskID); defer { releaseTaskLock(taskID: taskID) }
        let task = try btTask(taskID: taskID, generation: generation); try requireBTPaused(task)
        auxiliaryBTMutationIDs.insert(taskID); defer { auxiliaryBTMutationIDs.remove(taskID) }
        _ = try await btStatusUnlocked(taskID: taskID, generation: generation)
        return try await auxiliaryTransfer(for: task).addBTPeers(peers)
    }
    private func canConfigureBTGlobal() throws -> Bool {
        guard auxiliaryBTMutationIDs.isEmpty else { return false }
        return try store.allDownloads().allSatisfy { task in
            guard let record = task.auxiliary, record.engineKind == "bittorrent" else { return true }
            return runningTasks[task.id] == nil && inFlightOperations[task.id] == nil && (record.published || ["paused", "awaitingSelection", "complete", "error", "removed"].contains(record.phase))
        }
    }
    private func finishBTGlobalOperation() {
        auxiliaryBTGlobalBusy = false
        let waiting = auxiliaryBTGlobalWaiters; auxiliaryBTGlobalWaiters = []
        waiting.forEach { $0.resume() }
    }
    public func auxiliaryBTGlobalStatus() async throws -> AuxiliaryBTGlobalState {
        guard !auxiliaryBTGlobalBusy else { throw AuxiliaryBTError.unconfirmed }
        let canConfigure = try canConfigureBTGlobal()
        auxiliaryBTGlobalBusy = true; defer { finishBTGlobalOperation() }
        return try await configuredAuxiliaryDaemon().btGlobalState(canConfigure: canConfigure)
    }
    public func auxiliaryBTGlobalConfigure(expectedRevision: Int64, encryption: AuxiliaryBTEncryption) async throws -> AuxiliaryBTGlobalState {
        guard !auxiliaryBTGlobalBusy, try canConfigureBTGlobal() else { throw AuxiliaryBTError.allTasksMustPause }
        auxiliaryBTGlobalBusy = true; defer { finishBTGlobalOperation() }
        return try await configuredAuxiliaryDaemon().configureBTGlobal(expectedRevision: expectedRevision, encryption: encryption)
    }

    private func auxiliaryWorkDirectory(taskID: Int64, generation: Int64) -> URL {
        supportRoot.appendingPathComponent(String(taskID)).appendingPathComponent("auxiliary-\(generation)", isDirectory: true)
    }

    private func auxiliaryTransfer(for task: DownloadTask) throws -> AuxiliaryTransfer {
        guard !auxiliaryProxyUnavailable else { throw AuxiliaryProxyError.proxyUnavailable }
        guard let record = task.auxiliary else { throw AuxiliaryProductError.notFound }
        if let transfer = auxiliaryTransfers[task.id], transfer.generation == record.generation { return transfer }
        let plan = AuxiliaryProxyPlan(settings: settings)
        try plan.validate(kind: record.engineKind)
        let transfer = try AuxiliaryTransfer(taskID: task.id, generation: record.generation, source: record.source(),
            workDirectory: auxiliaryWorkDirectory(taskID: task.id, generation: record.generation),
            daemon: sharedAuxiliaryDaemon(), credentials: auxiliaryCredentials[task.id],
            filename: record.engineKind == "bittorrent" ? nil : task.filename, btConfig: record.bt?.config, proxyPlan: plan)
        auxiliaryTransfers[task.id] = transfer
        return transfer
    }

    private func waitForBTGlobalOperation(taskID: Int64) async {
        guard let kind = (try? task(id: taskID))?.auxiliary?.engineKind else { return }
        while let transition = auxiliaryProxyUpdateTail { _ = await transition.value }
        guard kind == "bittorrent" else { return }
        while auxiliaryBTGlobalBusy { await withCheckedContinuation { auxiliaryBTGlobalWaiters.append($0) } }
    }
    private func startAuxiliaryUnlocked(taskID: Int64, destinationDirectory: URL? = nil, isRestart: Bool = false) throws {
        guard !auxiliaryProxyUnavailable else { throw AuxiliaryProxyError.proxyUnavailable }
        guard runningTasks[taskID] == nil, var task = try task(id: taskID), var record = task.auxiliary else { return }
        if isRestart || record.published {
            guard record.generation < Int64.max else { throw AuxiliaryProductError.storage }
            record.generation += 1; record.phase = "paused"; record.files = []; record.selectedFiles = nil
            record.completedBytes = 0; record.payloadCompleted = false; record.published = false; record.stopSeedingRequested = false; record.errorCode = nil
            auxiliaryTransfers[taskID] = nil; auxiliarySnapshots[taskID] = nil
            task.auxiliary = record; task.fileSize = 0
        }
        if let destinationDirectory {
            guard record.completedBytes == 0, record.files.isEmpty else { throw AuxiliaryProductError.storage }
            task.folderPath = destinationDirectory.path
        }
        if record.kind == "sftp", auxiliaryCredentials[taskID] == nil {
            record.phase = "error"; task.auxiliary = record; task.status = .error
            task.errorText = AuxiliaryProductError.credentialsRequired.localizedDescription; try store.update(task)
            throw AuxiliaryProductError.credentialsRequired
        }
        let transfer = try auxiliaryTransfer(for: task)
        let token = CancelToken(); auxiliaryTokens[taskID] = token
        if record.engineKind == "bittorrent", record.selectedFiles == nil { auxiliaryNonblockingTaskIDs.insert(taskID) }
        task.status = .downloading; task.lastTry = Date(); task.completedAt = nil; task.errorText = nil
        try store.update(task)
        let generation = record.generation
        runningTasks[taskID] = Task { await self.runAuxiliary(taskID: taskID, generation: generation, transfer: transfer, token: token) }
    }

    private func persistAuxiliarySnapshot(_ snapshot: AuxiliarySnapshot) throws -> DownloadTask {
        guard var task = try task(id: snapshot.taskID), var record = task.auxiliary else { throw AuxiliaryProductError.notFound }
        guard record.generation == snapshot.generation else { throw AuxiliaryProductError.staleGeneration }
        guard !record.published else { return task }
        record.phase = snapshot.phase == .complete ? "checking" : snapshot.phase.rawValue
        record.completedBytes = snapshot.completedBytes; record.payloadCompleted = snapshot.payloadCompleted; record.errorCode = snapshot.errorCode
        record.files = snapshot.files.map { .init(index: $0.index, relativePath: $0.relativePath, length: $0.length, completedLength: $0.completedLength, selected: $0.selected) }
        task.auxiliary = record; task.fileSize = snapshot.totalBytes
        if !snapshot.files.isEmpty, record.engineKind == "bittorrent" {
            task.filename = snapshot.files.count == 1 ? (snapshot.files[0].relativePath as NSString).lastPathComponent : snapshot.files[0].relativePath.split(separator: "/").first.map(String.init) ?? task.filename
        }
        task.status = [.paused, .awaitingSelection, .removed].contains(snapshot.phase) ? .paused : snapshot.phase == .error ? .error : .downloading
        task.errorText = snapshot.errorCode.map { "辅助引擎下载失败（代码 \($0)）。" }
        if try self.task(id: task.id) != task { try store.update(task) }
        auxiliarySnapshots[task.id] = snapshot
        return task
    }

    private func persistAuxiliaryFailure(taskID: Int64, generation: Int64, error: Error) throws {
        guard var task = try task(id: taskID), var record = task.auxiliary, record.generation == generation, !record.published else { return }
        let paused: Bool
        if case .paused = error as? EngineError { paused = true } else { paused = error is CancellationError }
        task.status = paused ? .paused : .error
        record.phase = task.status == .paused ? "paused" : "error"
        if let proxy = error as? AuxiliaryProxyError { record.errorCode = proxy.rawValue; record.phase = "paused"; task.status = .paused }
        task.auxiliary = record; task.errorText = error.localizedDescription
        try store.update(task); onTaskSettled?(task)
    }

    private func runAuxiliary(taskID: Int64, generation: Int64, transfer: AuxiliaryTransfer, token: CancelToken) async {
        defer { auxiliaryTokens[taskID] = nil; auxiliarySnapshots[taskID] = nil; clearRunning(taskID) }
        do {
            let daemon = try await configuredAuxiliaryDaemon()
            let plan = AuxiliaryProxyPlan(settings: settings)
            try await daemon.verifyProxyPlan(plan)
            var snapshot = try await transfer.prepare()
            guard !token.isCancelled else { throw EngineError.paused }
            let task = try self.task(id: taskID)
            if let selected = task?.auxiliary?.selectedFiles, snapshot.phase == .awaitingSelection { snapshot = try await transfer.selectFiles(selected) }
            if let bt = task?.auxiliary?.bt {
                _ = try await transfer.applyBTConfiguration(bt.config)
                if bt.pending, var latest = try self.task(id: taskID), latest.auxiliary?.generation == generation {
                    latest.auxiliary?.bt?.pending = false; try store.update(latest)
                }
            }
            let stoppingSeed = task?.auxiliary?.stopSeedingRequested == true
            let taskLimit = task?.bandwidthLimit ?? 0
            try await transfer.applyBandwidthLimit(taskLimit > 0 ? taskLimit : settings.bandwidthLimitBytesPerSecond)
            if !stoppingSeed { snapshot = try await transfer.start() }
            while true {
                guard !token.isCancelled else { throw EngineError.paused }
                let current = try persistAuxiliarySnapshot(snapshot)
                if snapshot.phase == .seeding, auxiliaryNonblockingTaskIDs.insert(taskID).inserted { Task { await self.startNextWaitingTaskIfIdle() } }
                if snapshot.phase == .complete || current.auxiliary?.stopSeedingRequested == true && snapshot.engineStatus == "paused" && snapshot.payloadCompleted {
                    try await publishAuxiliary(task: current, snapshot: snapshot, token: token)
                    return
                }
                if [.awaitingSelection, .paused, .removed].contains(snapshot.phase) { onTaskSettled?(current); return }
                if snapshot.phase == .error { onTaskSettled?(current); return }
                try await Task.sleep(nanoseconds: 250_000_000)
                snapshot = try await transfer.currentSnapshot()
            }
        } catch { try? persistAuxiliaryFailure(taskID: taskID, generation: generation, error: error) }
    }

    private func publishAuxiliary(task: DownloadTask, snapshot: AuxiliarySnapshot, token: CancelToken) async throws {
        guard let record = task.auxiliary, snapshot.payloadCompleted, let folder = task.folderPath else { throw AuxiliaryProductError.storage }
        let work = auxiliaryWorkDirectory(taskID: task.id, generation: record.generation)
        let destination = URL(fileURLWithPath: folder, isDirectory: true)
        try validateStorage(StorageBudget(finalBytes: snapshot.totalBytes), destinationDirectory: destination)
        let fileURL = try await Task.detached(priority: .utility) {
            try AuxiliaryPublication.publish(taskID: task.id, generation: record.generation,
                filesDirectory: work.appendingPathComponent("auxiliary-files"), files: record.files,
                destination: destination, preferredName: task.filename, workDirectory: work, token: token,
                expectedED2KHash: record.kind == "ed2k" ? record.url?.components(separatedBy: "|").dropFirst(4).first?.lowercased() : nil)
        }.value
        guard var current = try self.task(id: task.id), var latest = current.auxiliary, latest.generation == record.generation else { throw AuxiliaryProductError.staleGeneration }
        latest.published = true; latest.payloadCompleted = true; latest.phase = "complete"
        current.auxiliary = latest; current.status = .complete; current.completedAt = Date(); current.errorText = nil
        current.filename = fileURL.lastPathComponent; current.folderPath = fileURL.deletingLastPathComponent().path
        current.category = record.files.filter(\.selected).count == 1 ? DownloadCategory.infer(filename: current.filename, mimeType: nil) : .misc
        try store.update(current); indexMetadata(for: current); onTaskCompleted?(current); onTaskSettled?(current)
        // The helper is already complete/paused. Relinquish its state only after
        // the published row and identity receipt are durable.
        do {
            try await auxiliaryTransfers[task.id]?.cancel()
            try? FileManager.default.removeItem(at: work.appendingPathComponent("auxiliary-files"))
        } catch { /* Retain helper bytes when its stop ACK is uncertain. */ }
        auxiliaryTransfers[task.id] = nil; auxiliaryCredentials[task.id] = nil
    }

    private func pauseAuxiliaryUnlocked(taskID: Int64) async {
        let running = runningTasks[taskID]
        auxiliaryTokens[taskID]?.pause()
        do {
            if let transfer = auxiliaryTransfers[taskID] { _ = try await transfer.pause() }
            if let running { await running.value }
            guard var task = try task(id: taskID), var record = task.auxiliary, !record.published else { return }
            task.status = .paused; task.startAt = nil
            if record.phase != "awaitingSelection" { record.phase = "paused" }
            task.auxiliary = record; try store.update(task); onTaskSettled?(task)
        } catch { if let record = (try? task(id: taskID))?.auxiliary { try? persistAuxiliaryFailure(taskID: taskID, generation: record.generation, error: error) } }
    }

    private func removeAuxiliaryUnlocked(task: DownloadTask, deleteFile: Bool) async throws {
        guard let record = task.auxiliary else { return }
        auxiliaryTokens[task.id]?.cancel()
        if let transfer = auxiliaryTransfers[task.id] { try await transfer.cancel() }
        if let running = runningTasks[task.id] { await running.value }
        let work = auxiliaryWorkDirectory(taskID: task.id, generation: record.generation)
        try AuxiliaryPublication.cleanStaging(taskID: task.id, generation: record.generation, workDirectory: work)
        if deleteFile, let final = try AuxiliaryPublication.publishedURL(taskID: task.id, generation: record.generation, workDirectory: work), FileManager.default.fileExists(atPath: final.path) {
            guard let fileRecycler else { throw ManagerError.fileRecyclingUnavailable }; try await fileRecycler(final)
        }
        try store.delete(id: task.id)
        auxiliaryTransfers[task.id] = nil; auxiliaryCredentials[task.id] = nil; auxiliarySnapshots[task.id] = nil; auxiliaryTokens[task.id] = nil
        try? FileManager.default.removeItem(at: supportRoot.appendingPathComponent(String(task.id)))
        try? searchIndex?.deleteAll(taskID: task.id)
        clearRunning(task.id)
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
        auxiliaryNonblockingTaskIDs.remove(taskID)
        resetPresentationSpeed(taskID: taskID)
        guard queueIsIdle else { return }
        Task { await self.startNextWaitingTaskIfIdle() }
    }

    private func ordinaryWaiting(in tasks: [DownloadTask]) throws -> [DownloadTask] {
        DownloadQueuePolicy.ordinaryWaiting(in: tasks, isCollectionEntry: Self.isCollectionEntry,
            preferredOrder: try store.queueOrder())
    }

    public func waitingQueue() throws -> [DownloadTask] {
        try ordinaryWaiting(in: store.allDownloads())
    }

    /// No actor suspension between validation and the durable order update.
    public func moveQueuedTask(taskID: Int64, beforeTaskID: Int64?, expectedIDs: [Int64]) throws {
        let ids = try waitingQueue().map(\.id)
        guard ids == expectedIDs, ids.contains(taskID), beforeTaskID != taskID,
              beforeTaskID == nil || ids.contains(beforeTaskID!) else { throw ManagerError.queueChanged }
        var reordered = ids.filter { $0 != taskID }
        let index = beforeTaskID.flatMap { reordered.firstIndex(of: $0) } ?? reordered.endIndex
        reordered.insert(taskID, at: index)
        try store.setQueueOrder(reordered)
    }

    private func startNextWaitingTaskIfIdle() async {
        while queueIsIdle {
            guard let tasks = try? store.allDownloads(), let ordinary = try? ordinaryWaiting(in: tasks) else { return }
            let next = Self.queuedCollectionCandidate(in: tasks)
                ?? (settings.downloadAllAtOnce ? nil : ordinary.first)
            guard let next else { return }
            do {
                if try await startWaitingTaskIfEligible(taskID: next.id) { return }
                // Pause, appointment changes, or another admission may win the
                // lifecycle lock. Read the queue again instead of starting the
                // stale candidate or leaving the following task stranded.
            } catch ManagerError.queueBusy {
                return
            } catch {
                await acquireTaskLock(taskID: next.id)
                defer { releaseTaskLock(taskID: next.id) }
                guard var failed = try? task(id: next.id), failed.status == .waiting,
                      failed.startAt == nil, failed.awaitingDestination != true else { continue }
                failed.status = .error
                failed.errorText = DownloadDiagnostic.classify(error).storageString
                do { try store.update(failed) } catch { return }
                onTaskSettled?(failed)
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
        if (try? task(id: taskID))?.auxiliary != nil {
            await pauseAuxiliaryUnlocked(taskID: taskID)
            return
        }
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
        mirrorEngines[taskID]?.requestPause()
        // Soft-stop sockets; partial `seg.xN` kept for resume on next start().
        await engines[taskID]?.pause()
        await mirrorEngines[taskID]?.pause()
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
        await waitForBTGlobalOperation(taskID: taskID)

        guard try store.allDownloads().contains(where: { $0.id == taskID }) else {
            throw ManagerError.taskNotFound
        }

        // Check queue admission BEFORE wiping workDir or updating store
        if !settings.downloadAllAtOnce {
            let otherRunning = runningTasks.keys.contains(where: { $0 != taskID && !auxiliaryNonblockingTaskIDs.contains($0) })
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
        try await mirrorEngines[taskID]?.applyConnectionsCount(n)
    }

    /// Persist a per-task cap and apply it to an active transfer now.
    /// Setting zero falls back to the current global cap.
    public func applyBandwidth(taskID: Int64, bytesPerSecond: Int64) async throws {
        guard var task = try task(id: taskID) else { throw ManagerError.taskNotFound }
        task.bandwidthLimit = max(0, bytesPerSecond)
        try store.update(task)
        let effectiveLimit = task.bandwidthLimit > 0
            ? task.bandwidthLimit
            : settings.bandwidthLimitBytesPerSecond
        await engines[taskID]?.applyBandwidthLimit(effectiveLimit)
        await mirrorEngines[taskID]?.applyBandwidthLimit(effectiveLimit)
        await ftpEngines[taskID]?.applyBandwidthLimit(effectiveLimit)
        await hlsEngines[taskID]?.applyBandwidthLimit(effectiveLimit)
        try await auxiliaryTransfers[taskID]?.applyBandwidthLimit(effectiveLimit)
    }

    /// Renew only when it cannot relabel saved bytes or carry credentials to a
    /// different origin. Rejection leaves the complete task record untouched.
    public func renewURL(taskID: Int64, newURL: String) async throws {
        await acquireTaskLock(taskID: taskID)
        defer { releaseTaskLock(taskID: taskID) }
        guard var task = try task(id: taskID) else { throw ManagerError.taskNotFound }
        guard let incoming = URL(string: newURL), let scheme = incoming.scheme?.lowercased(),
              ["http", "https", "ftp"].contains(scheme), incoming.host?.isEmpty == false else {
            throw ManagerError.invalidURL
        }
        guard runningTasks[taskID] == nil, task.status != .downloading, task.status != .complete else {
            throw ManagerError.renewalUnavailable
        }
        if task.url != newURL {
            guard let original = URL(string: task.url), Self.sameRenewalOrigin(original, incoming) else {
                throw ManagerError.renewalRequiresNewTask
            }
            let work = supportRoot.appendingPathComponent(String(taskID), isDirectory: true)
            if FileManager.default.fileExists(atPath: work.path) {
                // Include ownership receipts even before their first payload write,
                // unknown/legacy artifacts and media subdirectories. A log alone
                // is safe. Do not infer absence of bytes from UI progress or size.
                let names = try FileManager.default.contentsOfDirectory(atPath: work.path)
                guard names.allSatisfy({ $0 == "LogFile.txt" }) else {
                    throw ManagerError.renewalRequiresNewTask
                }
            }
        }
        task.url = newURL
        task.errorText = nil
        if task.status == .error { task.status = .incomplete }
        try store.update(task)
    }

    private static func sameRenewalOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        func port(_ url: URL) -> Int? {
            url.port ?? ["http": 80, "https": 443, "ftp": 21][url.scheme?.lowercased() ?? ""]
        }
        return lhs.scheme?.lowercased() == rhs.scheme?.lowercased()
            && lhs.host?.lowercased() == rhs.host?.lowercased() && port(lhs) == port(rhs)
            && lhs.user == rhs.user && lhs.password == rhs.password
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
        guard queueIsIdle,
              let tasks = try? store.allDownloads(),
              let next = Self.queuedCollectionCandidate(in: tasks) else { return }
        _ = try? await startWaitingTaskIfEligible(taskID: next.id)
    }

    public func updateTask(_ task: DownloadTask) throws {
        try store.update(task)
    }

    public func task(id: Int64) throws -> DownloadTask? {
        try store.download(id: id)
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
        if task.auxiliary != nil {
            try await removeAuxiliaryUnlocked(task: task, deleteFile: deleteFile)
            return
        }
        let fileURL = deleteFile ? try Self.validatedRemovalURL(for: task) : nil

        // A removed task must not keep writing invisibly. Cancel every engine
        // first, then await the owning task so no late completion can recreate
        // the file after it has been moved to Trash.
        let runningTask = runningTasks[taskID]
        runningTask?.cancel()
        await engines[taskID]?.cancel()
        await mirrorEngines[taskID]?.cancel()
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
            mirrorEngines[taskID] = nil
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
               let current = try? store.download(id: taskID),
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
    case queueChanged
    case insufficientStorage(requiredBytes: Int64, availableBytes: Int64)
    case unsafeFileLocation
    case fileRecyclingUnavailable
    case destinationConfirmationRequired
    case renewalRequiresNewTask
    case renewalUnavailable

    public var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .taskNotFound: return "Task not found"
        case .downloadFailed(let m): return m
        case .queueBusy: return "Another download is active (one-by-one mode)"
        case .queueChanged: return "队列已变化，请查看最新顺序后重试。已开始、预约和手动暂停的任务不能在这里重排。"
        case .insufficientStorage(let required, let available):
            return L10n.storageGuardError(
                requiredBytes: required,
                availableBytes: available
            )
        case .unsafeFileLocation:
            return "The downloaded file is outside its recorded download folder. Nothing was removed."
        case .fileRecyclingUnavailable:
            return "This environment cannot move files to Trash. Nothing was removed."
        case .renewalRequiresNewTask:
            return L10n.t("This link cannot safely replace the saved request. The original task and files were kept. Add the new link as a separate download.",
                          "无法确认新链接可以安全替换原请求，原任务和文件已保留。请将新链接新建为独立下载任务。")
        case .renewalUnavailable:
            return L10n.t("Pause the download before updating its link. For a completed download, add a new task.",
                          "请先暂停下载再更新链接。已完成的下载请新建任务。")
        case .destinationConfirmationRequired:
            return L10n.t("Choose where to save this download before starting it.", "请先选择这个下载的保存目录。")
        }
    }
}
