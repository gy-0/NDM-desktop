import Foundation
import NDMCore

/// Requests go to connected extensions, but only the originating browser
/// profile owns the opaque session ID and can answer. Cookies never enter a
/// renderer event, diagnostic log, or persistent task record.
public actor RelaySessionRequests {
    public struct Response: Sendable, Decodable {
        public let requestId: String
        public let sessionID: String
        public let cookies: String
    }
    private struct Pending {
        let sessionID: String
        let continuation: CheckedContinuation<String?, Never>
    }
    private var pending: [String: Pending] = [:]
    private let send: @Sendable (String) -> Void
    private let timeout: UInt64

    public init(timeoutMilliseconds: UInt64 = 3000, send: @escaping @Sendable (String) -> Void) {
        self.send = send
        self.timeout = timeoutMilliseconds
    }

    public static func parseResponse(_ raw: String) -> Response? {
        let prefix = "NDMRelaySessionResponse:"
        guard raw.hasPrefix(prefix), raw.utf8.count <= BridgeConstants.maxMessageBytes,
              let response = try? JSONDecoder().decode(Response.self, from: Data(raw.dropFirst(prefix.count).utf8)),
              BridgeDurableProtocol.validRequestID(response.requestId),
              BridgeDurableProtocol.validRequestID(response.sessionID),
              response.cookies.utf8.count <= 90_000 else { return nil }
        return response
    }

    public func request(sessionID: String, url: String) async -> String? {
        guard pending.count < 64, BridgeDurableProtocol.validRequestID(sessionID),
              let data = try? JSONSerialization.data(withJSONObject: ["requestId": UUID().uuidString, "sessionID": sessionID, "url": url]),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
              let requestID = object["requestId"] else { return nil }
        return await withCheckedContinuation { continuation in
            pending[requestID] = Pending(sessionID: sessionID, continuation: continuation)
            send("NDMRelaySessionRequest:" + String(decoding: data, as: UTF8.self))
            Task {
                try? await Task.sleep(nanoseconds: timeout * 1_000_000)
                expire(requestID)
            }
        }
    }

    public func receive(_ response: Response) {
        guard let item = pending[response.requestId], item.sessionID == response.sessionID else { return }
        pending[response.requestId] = nil
        item.continuation.resume(returning: response.cookies)
    }

    private func expire(_ id: String) {
        guard let item = pending.removeValue(forKey: id) else { return }
        item.continuation.resume(returning: nil)
    }
}
