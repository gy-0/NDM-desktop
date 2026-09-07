import Foundation

/// Peak on-disk budget for one delivery choice.
///
/// `finalBytes` is what remains after delivery. `temporaryBytes` is the extra
/// peak needed while separate media streams are being assembled. Collections
/// run one item at a time, so their temporary budget is only one item's merge
/// workspace rather than a second copy of the whole collection.
public struct StorageBudget: Equatable, Sendable {
    public var finalBytes: Int64?
    public var temporaryBytes: Int64
    public var isCollectionEstimate: Bool

    public init(
        finalBytes: Int64?,
        temporaryBytes: Int64 = 0,
        isCollectionEstimate: Bool = false
    ) {
        self.finalBytes = finalBytes.flatMap { $0 > 0 ? $0 : nil }
        self.temporaryBytes = max(0, temporaryBytes)
        self.isCollectionEstimate = isCollectionEstimate
    }

    public var peakBytes: Int64? {
        guard let finalBytes else { return nil }
        return Self.saturatingAdd(finalBytes, temporaryBytes)
    }

    /// Estimate a selected media tier. For a collection, durations provide a
    /// much better projection than blindly multiplying the first item's size.
    public static func media(
        sampleFinalBytes: Int64?,
        sampleComponentBytes: [Int64],
        sampleDurationSeconds: Double?,
        collectionDurations: [Double?]? = nil
    ) -> StorageBudget {
        guard let sampleFinalBytes, sampleFinalBytes > 0 else {
            return StorageBudget(
                finalBytes: nil,
                isCollectionEstimate: collectionDurations != nil
            )
        }

        let components = sampleComponentBytes.filter { $0 > 0 }
        // A single progressive stream becomes the final file directly. Two or
        // more components need a second output file while merging.
        let mergeWorkspace = components.count > 1
            ? components.reduce(Int64(0), saturatingAdd)
            : 0

        guard let collectionDurations else {
            return StorageBudget(
                finalBytes: sampleFinalBytes,
                temporaryBytes: mergeWorkspace
            )
        }

        guard !collectionDurations.isEmpty else {
            return StorageBudget(finalBytes: nil, isCollectionEstimate: true)
        }
        let known = collectionDurations.compactMap { value -> Double? in
            guard let value, value > 0, value.isFinite else { return nil }
            return value
        }
        let sampleDuration = sampleDurationSeconds.flatMap {
            $0 > 0 && $0.isFinite ? $0 : nil
        }
        let fallbackDuration: Double
        if !known.isEmpty {
            fallbackDuration = known.reduce(0, +) / Double(known.count)
        } else if let sampleDuration {
            fallbackDuration = sampleDuration
        } else {
            fallbackDuration = 1
        }
        let projectedDuration = collectionDurations.reduce(0.0) { partial, value in
            guard let value, value > 0, value.isFinite else {
                return partial + fallbackDuration
            }
            return partial + value
        }
        let denominator = sampleDuration ?? fallbackDuration
        let multiplier = max(1, projectedDuration / max(0.001, denominator))
        let projected = Double(sampleFinalBytes) * multiplier
        let finalBytes = projected >= Double(Int64.max)
            ? Int64.max
            : Int64(projected.rounded(.up))
        return StorageBudget(
            finalBytes: finalBytes,
            temporaryBytes: mergeWorkspace,
            isCollectionEstimate: true
        )
    }

    private static func saturatingAdd(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        let (value, overflow) = lhs.addingReportingOverflow(rhs)
        return overflow ? Int64.max : value
    }
}

public struct StorageConfidence: Equatable, Sendable {
    public enum Level: Equatable, Sendable {
        case unknown
        case comfortable
        case tight
        case insufficient
    }

    public static let defaultSafetyReserve: Int64 = 512 * 1024 * 1024

    public var budget: StorageBudget
    public var availableBytes: Int64?
    public var safetyReserveBytes: Int64

    public init(
        budget: StorageBudget,
        availableBytes: Int64?,
        safetyReserveBytes: Int64 = StorageConfidence.defaultSafetyReserve
    ) {
        self.budget = budget
        self.availableBytes = availableBytes.flatMap { $0 >= 0 ? $0 : nil }
        self.safetyReserveBytes = max(0, safetyReserveBytes)
    }

    public var level: Level {
        guard let peak = budget.peakBytes,
              let availableBytes else { return .unknown }
        if peak > availableBytes { return .insufficient }
        if peak > max(0, availableBytes - safetyReserveBytes) { return .tight }
        return .comfortable
    }

    public var shortfallBytes: Int64 {
        guard let peak = budget.peakBytes,
              let availableBytes,
              peak > availableBytes else { return 0 }
        return peak - availableBytes
    }

    public var projectedFreeBytes: Int64? {
        guard let peak = budget.peakBytes,
              let availableBytes else { return nil }
        return max(0, availableBytes - peak)
    }
}

/// Additional bytes a normal segmented download still needs from this moment
/// until the finished file is safely in its destination.
///
/// The temporary segments and final file coexist during assembly. Existing
/// resume bytes and an existing destination file already consume capacity, so
/// only their missing portions need to be budgeted again.
public struct DirectDownloadStorageBudget: Equatable, Sendable {
    public var totalBytes: Int64
    public var existingWorkBytes: Int64
    public var existingDestinationBytes: Int64
    public var sharesVolume: Bool

    public init(
        totalBytes: Int64,
        existingWorkBytes: Int64 = 0,
        existingDestinationBytes: Int64 = 0,
        sharesVolume: Bool
    ) {
        self.totalBytes = max(0, totalBytes)
        self.existingWorkBytes = min(max(0, existingWorkBytes), self.totalBytes)
        self.existingDestinationBytes = min(max(0, existingDestinationBytes), self.totalBytes)
        self.sharesVolume = sharesVolume
    }

    public var workBytesRequired: Int64 {
        max(0, totalBytes - existingWorkBytes)
    }

    public var destinationBytesRequired: Int64 {
        max(0, totalBytes - existingDestinationBytes)
    }

    public var sharedVolumeBytesRequired: Int64? {
        guard sharesVolume else { return nil }
        let (value, overflow) = workBytesRequired.addingReportingOverflow(destinationBytesRequired)
        return overflow ? Int64.max : value
    }
}

/// Reads the capacity of the volume that will actually receive the file.
public enum VolumeCapacity {
    public static func availableBytes(at requestedURL: URL) -> Int64? {
        let fileManager = FileManager.default
        let url = existingAncestor(of: requestedURL, fileManager: fileManager)

        if let value = try? url.resourceValues(
            forKeys: [.volumeAvailableCapacityForImportantUsageKey]
        ).volumeAvailableCapacityForImportantUsage,
           value > 0 {
            return value
        }
        let attributes = try? fileManager.attributesOfFileSystem(forPath: url.path)
        return (attributes?[.systemFreeSize] as? NSNumber)?.int64Value
    }

    public static func areOnSameVolume(_ lhs: URL, _ rhs: URL) -> Bool {
        let fileManager = FileManager.default
        let left = existingAncestor(of: lhs, fileManager: fileManager)
        let right = existingAncestor(of: rhs, fileManager: fileManager)
        let leftID = try? left.resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier
        let rightID = try? right.resourceValues(forKeys: [.volumeIdentifierKey]).volumeIdentifier
        if let leftID = leftID as? NSObject,
           let rightID = rightID as? NSObject {
            return leftID.isEqual(rightID)
        }
        let leftAttributes = try? fileManager.attributesOfFileSystem(forPath: left.path)
        let rightAttributes = try? fileManager.attributesOfFileSystem(forPath: right.path)
        guard let leftNumber = leftAttributes?[.systemNumber] as? NSNumber,
              let rightNumber = rightAttributes?[.systemNumber] as? NSNumber else {
            // Conservative fallback: if identity is unavailable, assume one
            // volume so the larger combined peak is checked.
            return true
        }
        return leftNumber == rightNumber
    }

    private static func existingAncestor(of requestedURL: URL, fileManager: FileManager) -> URL {
        var url = requestedURL.standardizedFileURL
        while !fileManager.fileExists(atPath: url.path), url.path != "/" {
            url.deleteLastPathComponent()
        }
        return url
    }
}
