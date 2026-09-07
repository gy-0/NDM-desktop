import Foundation
import NDMCore

/// Tracks live progress for a page-level yt-dlp download so the UI can reuse
/// the same progress window / list strip as multi-connection HTTP tasks.
public actor YtDlpEngine {
    public let taskID: Int64
    private let token = CancelToken()
    private var progress: DownloadProgress
    /// yt-dlp reports each selected stream independently. Track them by format
    /// id so this works for every extractor, not just a particular site.
    private let estimatedTotalBytes: Int64
    private let estimatedComponentBytes: [Int64]
    private let connections: Int
    /// App-owned staging directory for yt-dlp intermediary streams and sidecars.
    /// Final files still land in the user's selected destination directory.
    private let temporaryDirectory: URL?

    private struct ComponentState {
        var downloaded: Int64 = 0
        var total: Int64 = 0
        var finished = false
    }

    private var components: [String: ComponentState] = [:]
    private var componentOrder: [String] = []
    private var activeKeyByReportedID: [String: String] = [:]
    private var anonymousComponentIndex = 0
    private var lastAnonymousDownloaded: Int64 = 0
    private var lastAnonymousTotal: Int64 = 0

    public init(
        taskID: Int64,
        estimatedBytes: Int64 = 0,
        estimatedComponentBytes: [Int64] = [],
        connections: Int = 1,
        temporaryDirectory: URL? = nil
    ) {
        self.taskID = taskID
        self.estimatedTotalBytes = max(0, estimatedBytes)
        self.estimatedComponentBytes = estimatedComponentBytes.filter { $0 > 0 }
        self.connections = max(1, min(32, connections))
        self.temporaryDirectory = temporaryDirectory
        self.progress = DownloadProgress(
            taskID: taskID,
            totalBytes: self.estimatedTotalBytes,
            completedBytes: 0,
            bytesPerSecond: 0,
            segmentStates: Self.segment(total: max(0, estimatedBytes), completed: 0),
            status: .downloading,
            phase: .preparing,
            journeyFraction: 0,
            currentConnections: self.connections
        )
    }

    public func currentProgress() -> DownloadProgress { progress }

    public func pause() {
        token.pause()
    }

    public func cancel() {
        token.cancel()
        progress.status = .incomplete
    }

    /// Downloads into `directory`, updating progress for the progress window.
    public func run(
        url: String,
        formatID: String,
        directory: URL,
        preferredName: String?,
        forceOverwrite: Bool = false,
        options: YtDlpDownloadOptions = .init()
    ) async throws -> URL {
        guard !Task.isCancelled, !token.isCancelled else {
            throw EngineError.cancelled
        }
        progress.status = .downloading
        do {
            let dest = try await YtDlpTool.download(
                url: url,
                formatID: formatID,
                directory: directory,
                preferredName: preferredName,
                connections: connections,
                forceOverwrite: forceOverwrite,
                options: options,
                estimatedBytes: estimatedTotalBytes,
                temporaryDirectory: temporaryDirectory,
                cancelToken: token
            ) { report in
                Task { await self.apply(report: report) }
            }
            let attrs = try? FileManager.default.attributesOfItem(atPath: dest.path)
            let size = (attrs?[.size] as? NSNumber)?.int64Value ?? 0
            let transferred = components.values.reduce(Int64(0)) {
                $0 + max($1.total, $1.downloaded)
            }
            progress.totalBytes = max(1, transferred, size, progress.completedBytes)
            progress.completedBytes = progress.totalBytes
            progress.bytesPerSecond = 0
            progress.status = .complete
            progress.phase = nil
            progress.journeyFraction = 1
            progress.segmentStates = Self.segment(
                total: progress.totalBytes,
                completed: progress.totalBytes,
                finished: true
            )
            return dest
        } catch let error as EngineError {
            if case .paused = error {
                progress.status = .paused
            } else if case .cancelled = error {
                progress.status = .incomplete
            } else {
                progress.status = .error
                progress.errorDescription = error.localizedDescription
            }
            throw error
        } catch {
            if token.isPaused {
                progress.status = .paused
                throw EngineError.paused
            }
            if token.isCancelled {
                progress.status = .incomplete
                throw EngineError.cancelled
            }
            progress.status = .error
            progress.errorDescription = error.localizedDescription
            throw error
        }
    }

    func apply(report: YtDlpTool.ProgressReport) {
        guard progress.status == .downloading else { return }
        if let phase = report.phase {
            applyPostprocessPhase(phase)
            return
        }
        progress.phase = .transferring

        let reportedDownloaded = max(0, report.downloadedBytes)
        let reportedTotal = max(0, report.totalBytes)
        let key = resolveComponentKey(
            reportedID: report.componentID,
            downloaded: reportedDownloaded,
            total: reportedTotal,
            status: report.status
        )
        if components[key] == nil { componentOrder.append(key) }
        var state = components[key] ?? ComponentState()
        state.downloaded = max(state.downloaded, reportedDownloaded)
        state.total = max(state.total, reportedTotal, state.downloaded)
        if report.status == "finished" {
            state.finished = true
            state.downloaded = max(state.downloaded, state.total)
        }
        components[key] = state

        let aggregateDownloaded = components.values.reduce(Int64(0)) { $0 + $1.downloaded }
        let aggregateActualTotal = components.values.reduce(Int64(0)) {
            $0 + max($1.total, $1.downloaded)
        }
        var aggregateTotal: Int64
        if !estimatedComponentBytes.isEmpty {
            aggregateTotal = 0
            for (index, key) in componentOrder.enumerated() {
                let actual = components[key].map { max($0.total, $0.downloaded) } ?? 0
                let estimate = index < estimatedComponentBytes.count
                    ? estimatedComponentBytes[index]
                    : 0
                aggregateTotal += actual > 0 ? actual : estimate
            }
            if componentOrder.count < estimatedComponentBytes.count {
                aggregateTotal += estimatedComponentBytes
                    .dropFirst(componentOrder.count)
                    .reduce(0, +)
            }
            aggregateTotal = max(aggregateTotal, aggregateActualTotal)
        } else if componentOrder.count >= 2 {
            // Once all common video+audio components are visible, prefer their
            // real totals over a possibly inflated probe/final-file estimate.
            aggregateTotal = aggregateActualTotal
        } else {
            aggregateTotal = max(estimatedTotalBytes, aggregateActualTotal)
        }
        aggregateTotal = max(aggregateTotal, aggregateDownloaded, 1)

        let previousJourney = progress.fractionCompleted
        let actualCompleted = min(aggregateTotal, aggregateDownloaded)
        let transferFraction = Double(actualCompleted) / Double(aggregateTotal)
        // Reserve the final four percent for real postprocessing stages. Byte
        // counters stay exact; only the end-to-end journey waits for the file.
        let transferJourney = min(0.96, transferFraction * 0.96)
        progress.totalBytes = aggregateTotal
        progress.completedBytes = actualCompleted
        progress.journeyFraction = max(previousJourney, transferJourney)
        progress.bytesPerSecond = report.bytesPerSecond
        progress.segmentStates = Self.segment(
            total: max(progress.totalBytes, progress.completedBytes),
            completed: progress.completedBytes
        )
        if transferFraction >= 0.995, report.status == "finished" {
            progress.phase = .finalizing
        }
    }

    private func applyPostprocessPhase(_ phase: DownloadPhase) {
        progress.phase = phase
        progress.bytesPerSecond = 0
        let floor: Double
        switch phase {
        case .preparing: floor = 0
        case .transferring: floor = 0
        case .merging: floor = 0.972
        case .subtitles: floor = 0.985
        case .finalizing: floor = 0.992
        }
        // yt-dlp runs subtitle postprocessors as soon as the subs are written —
        // which is BEFORE the video transfer starts. Applying the floor then
        // would jump the journey to 98% at the beginning of the download, and
        // the ratchet in `apply(report:)` keeps it stuck there. Only honor
        // postprocess floors once the transfer itself is essentially done.
        let transferDone = !components.isEmpty
            && components.values.allSatisfy(\.finished)
        guard transferDone || progress.fractionCompleted >= 0.9 else { return }
        progress.journeyFraction = max(progress.fractionCompleted, floor)
    }

    private func resolveComponentKey(
        reportedID: String?,
        downloaded: Int64,
        total: Int64,
        status: String?
    ) -> String {
        if let reportedID, !reportedID.isEmpty {
            let active = activeKeyByReportedID[reportedID] ?? reportedID
            if let current = components[active],
               current.finished,
               status != "finished",
               downloaded < current.downloaded {
                var generation = 2
                var next = "\(reportedID)#\(generation)"
                while components[next] != nil {
                    generation += 1
                    next = "\(reportedID)#\(generation)"
                }
                activeKeyByReportedID[reportedID] = next
                return next
            }
            activeKeyByReportedID[reportedID] = active
            return active
        }

        let previousWasComplete = lastAnonymousTotal > 0
            && Double(lastAnonymousDownloaded) / Double(lastAnonymousTotal) >= 0.90
        let clearlyRestarted = lastAnonymousDownloaded > 0
            && downloaded < lastAnonymousDownloaded
            && (previousWasComplete || downloaded * 4 < lastAnonymousDownloaded)
        if clearlyRestarted { anonymousComponentIndex += 1 }
        lastAnonymousDownloaded = max(
            clearlyRestarted ? 0 : lastAnonymousDownloaded,
            downloaded
        )
        lastAnonymousTotal = max(
            clearlyRestarted ? 0 : lastAnonymousTotal,
            total,
            downloaded
        )
        return "anonymous-\(anonymousComponentIndex)"
    }

    private static func segment(total: Int64, completed: Int64, finished: Bool = false) -> [SegmentState] {
        let end = max(0, total - 1)
        return [
            SegmentState(
                id: 0,
                start: 0,
                end: end,
                completed: max(0, completed),
                isFinished: finished || (total > 0 && completed >= total)
            ),
        ]
    }
}
