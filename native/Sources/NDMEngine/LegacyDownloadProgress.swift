import Foundation
import NDMCore

/// Read-only display of retained legacy parts. This is not permission to resume:
/// the engine still validates the remote representation before joining bytes.
enum LegacyDownloadProgress {
    static func read(totalBytes: Int64, workDirectory: URL) throws -> (totalBytes: Int64, completedBytes: Int64)? {
        guard totalBytes >= 0 else { return nil }
        let manager = FileManager.default
        let planURL = workDirectory.appendingPathComponent("segments.bin")
        guard let attributes = try? manager.attributesOfItem(atPath: planURL.path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber,
              size.int64Value > 0,
              size.int64Value <= (Int64(Int16.max) + 1) * Int64(SegmentRecord.recordSize) else { return nil }
        // Never fall back from an invalid or unavailable v2 ownership receipt.
        if (try? manager.attributesOfItem(atPath: workDirectory.appendingPathComponent("offset-storage-v2.json").path)) != nil {
            return nil
        }
        guard let directory = try? manager.attributesOfItem(atPath: workDirectory.path),
              directory[.type] as? FileAttributeType == .typeDirectory else { return nil }
        guard let records = try SegmentFileFormat.loadSegmentsBin(from: workDirectory),
              let last = records.map(\.end).max() else { return nil }
        let (plannedTotal, overflow) = last.addingReportingOverflow(1)
        guard !overflow, totalBytes == 0 || totalBytes == plannedTotal,
              SegmentFileFormat.isValidResumePlan(records, totalBytes: plannedTotal) else { return nil }
        var completed: Int64 = 0
        for record in records {
            let file = SegmentFileFormat.segmentFileURL(id: record.segmentId, in: workDirectory)
            guard let part = try? manager.attributesOfItem(atPath: file.path) else { continue }
            guard part[.type] as? FileAttributeType == .typeRegular,
                  let size = part[.size] as? NSNumber,
                  size.int64Value >= 0, size.int64Value <= record.length else { return nil }
            // Validated ranges do not overlap and are bounded by plannedTotal.
            completed += size.int64Value
        }
        return (plannedTotal, completed)
    }
}
