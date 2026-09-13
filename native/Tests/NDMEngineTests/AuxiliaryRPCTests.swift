import Foundation
import XCTest
@testable import NDMEngine

final class AuxiliaryRPCTests: XCTestCase {
    private let endpoint = URL(string: "http://127.0.0.1:19999/jsonrpc")!
    private static func response(_ request: URLRequest, result: AuxiliaryJSON) throws -> (Data, Int) {
        let input = try JSONDecoder().decode(AuxiliaryJSON.self, from: request.httpBody!)
        return (try JSONEncoder().encode(AuxiliaryJSON.object(["jsonrpc": .string("2.0"), "id": input["id"]!, "result": result])), 200)
    }
    func testRPCAuthenticatesAndChecksMatchingResponseIdentity() async throws {
        let rpc = try AuxiliaryRPC(endpoint: endpoint, secret: "fixture-secret", transport: { request in
            let input = try JSONDecoder().decode(AuxiliaryJSON.self, from: request.httpBody!)
            XCTAssertEqual(input["params"]?.array?.first?.string, "token:fixture-secret")
            XCTAssertEqual(input["method"]?.string, "aria2.getVersion")
            XCTAssertEqual(request.httpMethod, "POST")
            return try Self.response(request, result: .object(["version": .string("2.7.5")]))
        })
        let response = try await rpc.call("aria2.getVersion")
        XCTAssertEqual(response["version"]?.string, "2.7.5")
    }
    func testRejectsRemoteEndpointsAndRedirectTargets() throws {
        for raw in ["https://127.0.0.1:8080/jsonrpc", "http://example.test:8080/jsonrpc", "http://user:pass@127.0.0.1:8080/jsonrpc", "http://127.0.0.1:8080/jsonrpc?x=1"] {
            XCTAssertThrowsError(try AuxiliaryRPC(endpoint: URL(string: raw)!, secret: "secret"))
        }
    }
    func testMismatchedIDsMalformedJSONAndHTTPFailuresAreNotAcknowledgements() async throws {
        let cases: [(Data, Int, AuxiliaryRPCError)] = [
            (Data("{broken".utf8), 200, .invalidResponse),
            (Data("{\"jsonrpc\":\"2.0\",\"id\":\"other\",\"result\":true}".utf8), 200, .invalidResponse),
            (Data(), 302, .httpStatus(302)),
            (Data(repeating: 0x41, count: 8 * 1024 * 1024 + 1), 200, .responseTooLarge)
        ]
        for (data, status, expected) in cases {
            let rpc = try AuxiliaryRPC(endpoint: endpoint, secret: "secret", transport: { _ in (data, status) })
            do { _ = try await rpc.call("aria2.tellStatus"); XCTFail("Must reject response") }
            catch let error as AuxiliaryRPCError { XCTAssertEqual(error, expected) }
        }
    }
    func testRemoteErrorsNeverEchoCredentialsOrPrivatePaths() async throws {
        let rpc = try AuxiliaryRPC(endpoint: endpoint, secret: "rpc-secret", transport: { request in
            let input = try JSONDecoder().decode(AuxiliaryJSON.self, from: request.httpBody!)
            return (try JSONEncoder().encode(AuxiliaryJSON.object(["jsonrpc": .string("2.0"), "id": input["id"]!, "error": .object([
                "code": .number(1), "message": .string("GID not found sftp://user:password@host/private token:rpc-secret /private/id_rsa")])])), 400)
        })
        do { _ = try await rpc.call("aria2.tellStatus", parameters: [.string("0123456789abcdef")]); XCTFail("Must fail") }
        catch let error as AuxiliaryRPCError {
            XCTAssertTrue(error.isTaskNotFound)
            for secret in ["password", "rpc-secret", "id_rsa", "sftp://"] { XCTAssertFalse(error.localizedDescription.contains(secret)) }
        }
    }
    func testTransportTimeoutAndCancellationHaveTypedErrors() async throws {
        for (code, expected) in [(NSURLErrorTimedOut, AuxiliaryRPCError.timeout), (NSURLErrorCancelled, .cancelled), (NSURLErrorCannotConnectToHost, .disconnected)] {
            let rpc = try AuxiliaryRPC(endpoint: endpoint, secret: "secret", transport: { _ in throw NSError(domain: NSURLErrorDomain, code: code) })
            do { _ = try await rpc.call("aria2.getVersion"); XCTFail("Must fail") }
            catch let error as AuxiliaryRPCError { XCTAssertEqual(error, expected) }
        }
    }
}
