import Foundation
import Network
let proxyPort = UInt16(CommandLine.arguments[1])!
let originPort = UInt16(CommandLine.arguments[2])!
var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: proxyPort)!))
proxy.allowFailover = false
proxy.excludedDomains = []
let parameters = NWParameters.tcp
parameters.defaultProtocolStack.applicationProtocols = []
let privacy = NWParameters.PrivacyContext(description: "Isolated NDM routing probe")
privacy.proxyConfigurations = [proxy]
parameters.setPrivacyContext(privacy)
let connection = NWConnection(host: NWEndpoint.Host(CommandLine.arguments[3]), port: NWEndpoint.Port(rawValue: originPort)!, using: parameters)
let done = DispatchSemaphore(value: 0)
connection.stateUpdateHandler = { state in
 switch state {
 case .ready:
  let request = "GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
  connection.send(content: Data(request.utf8), completion: .contentProcessed { error in
   if let error { print("send-error: \(error)"); done.signal(); return }
   connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, error in
    print("received=\(data?.count ?? 0) error=\(String(describing: error))"); done.signal()
   }
  })
 case .failed(let error): print("failed: \(error)"); done.signal()
 case .waiting(let error): print("waiting: \(error)"); done.signal()
 default: break
 }
}
connection.start(queue: DispatchQueue(label: "probe"))
if done.wait(timeout: .now() + 8) == .timedOut { print("timeout") }
connection.cancel()
