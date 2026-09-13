import Foundation

public enum AuxiliaryJSON: Codable, Sendable, Equatable {
    case object([String: AuxiliaryJSON]), array([AuxiliaryJSON]), string(String), number(Double), bool(Bool), null
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode([AuxiliaryJSON].self) { self = .array(value) }
        else { self = .object(try container.decode([String: AuxiliaryJSON].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
    public subscript(_ key: String) -> AuxiliaryJSON? { if case .object(let value) = self { return value[key] }; return nil }
    public var string: String? { if case .string(let value) = self { return value }; return nil }
    public var array: [AuxiliaryJSON]? { if case .array(let value) = self { return value }; return nil }
    public var object: [String: AuxiliaryJSON]? { if case .object(let value) = self { return value }; return nil }
    public var boolean: Bool? {
        if case .bool(let value) = self { return value }
        if case .string(let value) = self, value == "true" || value == "false" { return value == "true" }
        return nil
    }
    public var integer: Int64? {
        if case .string(let value) = self { return Int64(value) }
        if case .number(let value) = self, value.isFinite, value.rounded() == value,
           value >= -9_007_199_254_740_991, value <= 9_007_199_254_740_991 { return Int64(value) }
        return nil
    }
}

public enum AuxiliaryRPCError: Error, LocalizedError, Sendable, Equatable {
    case invalidEndpoint, invalidMethod, timeout, cancelled, disconnected, invalidResponse, responseTooLarge
    case httpStatus(Int), remote(code: Int, taskNotFound: Bool)
    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "辅助引擎 RPC 必须使用本机回环地址。"
        case .invalidMethod: return "辅助引擎 RPC 方法无效。"
        case .timeout: return "辅助引擎响应超时，请重试确认原任务。"
        case .cancelled: return "辅助引擎请求已取消。"
        case .disconnected: return "辅助引擎连接已断开。"
        case .invalidResponse: return "辅助引擎返回了无效响应。"
        case .responseTooLarge: return "辅助引擎响应超出允许大小。"
        case .httpStatus(let status): return "辅助引擎 RPC 返回 HTTP \(status)。"
        case .remote(let code, let missing): return missing ? "辅助引擎中尚无此任务。" : "辅助引擎拒绝了请求（错误代码 \(code)）。"
        }
    }
    public var isTaskNotFound: Bool { if case .remote(_, let missing) = self { return missing }; return false }
}

private final class AuxiliaryNoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

public actor AuxiliaryRPC {
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, Int)
    private let endpoint: URL
    private let secret: String
    private let timeout: TimeInterval
    private let transport: Transport
    private static let maximumResponseBytes = 8 * 1024 * 1024

    public init(endpoint: URL, secret: String, timeout: TimeInterval = 10, transport: Transport? = nil) throws {
        guard endpoint.scheme == "http", ["127.0.0.1", "::1", "[::1]"].contains(endpoint.host ?? ""),
              endpoint.user == nil, endpoint.password == nil, endpoint.port != nil,
              endpoint.path == "/jsonrpc", endpoint.query == nil, endpoint.fragment == nil,
              !secret.isEmpty, timeout > 0, timeout <= 120 else { throw AuxiliaryRPCError.invalidEndpoint }
        self.endpoint = endpoint; self.secret = secret; self.timeout = timeout
        if let transport { self.transport = transport }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = timeout
            configuration.timeoutIntervalForResource = timeout
            configuration.connectionProxyDictionary = [:]
            let session = URLSession(configuration: configuration, delegate: AuxiliaryNoRedirect(), delegateQueue: nil)
            self.transport = { request in
                let (stream, response) = try await session.bytes(for: request)
                guard let response = response as? HTTPURLResponse else { throw AuxiliaryRPCError.invalidResponse }
                if response.expectedContentLength > Self.maximumResponseBytes { throw AuxiliaryRPCError.responseTooLarge }
                var data = Data()
                for try await byte in stream {
                    guard data.count < Self.maximumResponseBytes else { throw AuxiliaryRPCError.responseTooLarge }
                    data.append(byte)
                }
                return (data, response.statusCode)
            }
        }
    }

    public func call(_ method: String, parameters: [AuxiliaryJSON] = []) async throws -> AuxiliaryJSON {
        guard method.range(of: "^(aria2|system)\\.[A-Za-z][A-Za-z0-9]*$", options: .regularExpression) != nil else { throw AuxiliaryRPCError.invalidMethod }
        guard !Task.isCancelled else { throw AuxiliaryRPCError.cancelled }
        let id = UUID().uuidString
        var request = URLRequest(url: endpoint, timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(AuxiliaryJSON.object([
            "jsonrpc": .string("2.0"), "id": .string(id), "method": .string(method),
            "params": .array([.string("token:\(secret)")] + parameters)
        ]))
        let data: Data, status: Int
        do { (data, status) = try await transport(request) }
        catch let error as AuxiliaryRPCError { throw error }
        catch {
            if Task.isCancelled || error is CancellationError || (error as NSError).code == NSURLErrorCancelled { throw AuxiliaryRPCError.cancelled }
            if (error as NSError).code == NSURLErrorTimedOut { throw AuxiliaryRPCError.timeout }
            throw AuxiliaryRPCError.disconnected
        }
        guard data.count <= Self.maximumResponseBytes else { throw AuxiliaryRPCError.responseTooLarge }
        // Aria2 Next sends valid JSON-RPC errors with HTTP 400/404/500.
        // Only a matching RPC envelope may supply the sanitized error code.
        guard let reply = try? JSONDecoder().decode(AuxiliaryJSON.self, from: data), reply["jsonrpc"]?.string == "2.0",
              reply["id"]?.string == id else {
            if !(200..<300).contains(status) { throw AuxiliaryRPCError.httpStatus(status) }
            throw AuxiliaryRPCError.invalidResponse
        }
        if let error = reply["error"] {
            guard let code = error["code"]?.integer, let message = error["message"]?.string else { throw AuxiliaryRPCError.invalidResponse }
            // Never expose the remote message: it may echo URLs, passwords,
            // headers or a private key path. Only a constrained lookup flag survives.
            let missing = method == "aria2.tellStatus" && code == 1 && message.lowercased().contains("not found")
            throw AuxiliaryRPCError.remote(code: Int(code), taskNotFound: missing)
        }
        guard (200..<300).contains(status) else { throw AuxiliaryRPCError.httpStatus(status) }
        guard let result = reply["result"] else { throw AuxiliaryRPCError.invalidResponse }
        return result
    }
}
