import Foundation
import NDMCore

public struct DownloadCreationResult: Sendable {
    public let receipt: DownloadCreationReceipt?
    public let task: DownloadTask?
    public let pending: Bool
}

/// Covers asynchronous preparation as well as the atomic insertion. RPC socket
/// lifetime does not own this operation: disconnecting must not cancel admission.
public actor DownloadCreationCoordinator {
    private struct Flight {
        let hash: String
        let work: Task<Void, Error>
    }
    private let store: DownloadStore
    private var flights: [String: Flight] = [:]

    public init(store: DownloadStore) { self.store = store }

    public func lookup(key: String) throws -> DownloadCreationResult {
        let key = try DownloadCreationIntent.normalizeKey(key)
        let receipt = try store.creationReceipt(key: key)
        let task = try receipt.flatMap { receipt in
            try store.allDownloads().first { $0.id == receipt.taskID }
        }
        return DownloadCreationResult(receipt: receipt, task: task,
                                      pending: receipt == nil && flights[key] != nil)
    }

    public func create(
        _ intent: DownloadCreationIntent,
        operation: @escaping @Sendable (DownloadCreationIntent) async throws -> Void
    ) async throws -> DownloadCreationResult {
        if try store.reserveCreation(intent) != nil { return try lookup(key: intent.key) }
        if let flight = flights[intent.key] {
            guard flight.hash == intent.payloadHash else { throw DownloadCreationError.intentMismatch }
            do { try await flight.work.value }
            catch {
                if try store.creationReceipt(key: intent.key) == nil { throw error }
            }
            return try committedResult(key: intent.key)
        }
        // Registration happens before this actor yields, including before media
        // preparation starts. A concurrent query can never see a false absence.
        let work = Task { try await operation(intent) }
        flights[intent.key] = Flight(hash: intent.payloadHash, work: work)
        defer { flights[intent.key] = nil }
        do { try await work.value }
        catch {
            // Creation may have committed before subsequent startup failed.
            // That outcome is still an accepted task, never permission to add.
            if try store.creationReceipt(key: intent.key) == nil { throw error }
        }
        return try committedResult(key: intent.key)
    }

    private func committedResult(key: String) throws -> DownloadCreationResult {
        let result = try lookup(key: key)
        guard result.receipt != nil else { throw DownloadCreationError.missingCommit }
        return result
    }
}
