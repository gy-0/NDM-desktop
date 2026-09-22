import XCTest
import Foundation
import Network

final class LocalRangeServerLifecycleTests: XCTestCase {
    func testStopClosesAnAcceptedConnectionWhileResponseIsHeld() async throws {
        let server = LocalRangeServer(payload: Data(repeating: 1, count: 1024), responseReady: { _ in false })
        try server.start()
        defer { server.stop() }
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: server.port)!, using: .tcp)
        defer { connection.cancel() }
        let ready = expectation(description: "client connected")
        connection.stateUpdateHandler = { state in
            if case .ready = state { ready.fulfill() }
        }
        connection.start(queue: DispatchQueue(label: "ndm.test.range-lifecycle"))
        await fulfillment(of: [ready], timeout: 5)
        let closed = expectation(description: "accepted socket closed by fixture stop")
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, complete, error in
            XCTAssertTrue(data?.isEmpty ?? true, "Held response must not be sent after stop")
            XCTAssertTrue(complete || error != nil)
            closed.fulfill()
        }
        connection.send(content: Data("GET /file.bin HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-1023\r\n\r\n".utf8),
                        completion: .contentProcessed { error in XCTAssertNil(error) })
        let deadline = Date().addingTimeInterval(3)
        while server.recordedRanges.isEmpty, Date() < deadline {
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(server.recordedRanges.count, 1)
        server.stop()
        await fulfillment(of: [closed], timeout: 3)
    }
}
