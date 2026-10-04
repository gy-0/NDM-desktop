import Foundation
import Network
import CFNetwork
let mode = CommandLine.arguments[1]
let port = UInt16(CommandLine.arguments[2])!
let url = URL(string: CommandLine.arguments[3])!
let config = URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = 5
config.timeoutIntervalForResource = 7
if mode == "modern" {
    if #available(macOS 14, *) {
        var proxy = ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!))
        proxy.allowFailover = false
        proxy.excludedDomains = []
        config.proxyConfigurations = [proxy]
    } else { fatalError("Requires macOS 14") }
} else {
    var dictionary: [AnyHashable: Any] = [
        kCFStreamPropertySOCKSProxyHost as String: "127.0.0.1",
        kCFStreamPropertySOCKSProxyPort as String: Int(port),
        kCFStreamPropertySOCKSVersion as String: kCFStreamSocketSOCKSVersion5
    ]
    if mode == "dictionary-explicit" {
        dictionary[kCFNetworkProxiesSOCKSEnable as String] = true
        dictionary[kCFNetworkProxiesExceptionsList as String] = [String]()
        dictionary[kCFNetworkProxiesExcludeSimpleHostnames as String] = false
    }
    config.connectionProxyDictionary = dictionary
}
let semaphore = DispatchSemaphore(value: 0)
let session = URLSession(configuration: config)
session.dataTask(with: url) { data, response, error in
    let row: [String: Any] = ["mode": mode, "bytes": data?.count ?? 0, "status": (response as? HTTPURLResponse)?.statusCode ?? 0, "error": error.map { String(describing: $0) } ?? ""]
    print(String(data: try! JSONSerialization.data(withJSONObject: row), encoding: .utf8)!)
    semaphore.signal()
}.resume()
if semaphore.wait(timeout: .now() + 10) == .timedOut { print("{\"timeout\":true}") }
session.invalidateAndCancel()
