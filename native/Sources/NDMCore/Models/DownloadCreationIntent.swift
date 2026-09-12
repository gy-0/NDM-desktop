import Foundation
import CryptoKit

/// The caller's stable, explicit creation intent. No URLs or credentials are
/// stored in the receipt table; the hash binds retries to their original input.
public struct DownloadCreationIntent: Sendable, Equatable {
    public let key: String
    public let payloadHash: String

    public init(key: String, payload: [String: Any]) throws {
        self.key = try Self.normalizeKey(key)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        self.payloadHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func normalizeKey(_ key: String) throws -> String {
        guard let uuid = UUID(uuidString: key), key.count == 36 else { throw DownloadCreationError.invalidKey }
        return uuid.uuidString.lowercased()
    }
}

public struct DownloadCreationReceipt: Sendable, Equatable {
    public let taskID: Int64
    public let taskExists: Bool
}

public enum DownloadCreationCommit: Sendable {
    case committed(DownloadTask)
    case replayed(DownloadCreationReceipt)
}

public enum DownloadCreationError: Error, LocalizedError {
    case invalidKey, intentMismatch, missingCommit, collectionUnsupported

    public var kind: String {
        switch self {
        case .invalidKey: return "invalidCreationKey"
        case .intentMismatch: return "creationIntentMismatch"
        case .missingCommit: return "creationCommitMissing"
        case .collectionUnsupported: return "creationCollectionUnsupported"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .invalidKey: return "下载创建标识无效"
        case .intentMismatch: return "这次添加的内容与原请求不一致"
        case .missingCommit: return "未能确认下载是否已添加"
        case .collectionUnsupported: return "合集暂不支持恢复添加"
        }
    }
}
