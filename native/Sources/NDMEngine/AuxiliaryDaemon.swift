import Foundation
import CryptoKit
import Darwin

public struct AuxiliaryCapabilities: Sendable, Equatable {
    public let version: String
    public let features: Set<String>
    public let methods: Set<String>
    public let rpcPort: UInt16
    public let bittorrentPort: UInt16
    public let ed2kTCPPort: UInt16
    public let ed2kUDPPort: UInt16
    public var supportsBitTorrent: Bool { features.contains("BitTorrent") && methods.contains("aria2.addTorrent") }
    public var supportsSFTP: Bool { features.contains("SFTP") }
    public var supportsED2K: Bool { features.contains("ED2K") }
}

public enum AuxiliaryDaemonError: Error, LocalizedError, Sendable {
    case unavailable, binaryMismatch, portUnavailable, launchFailed, incompatibleVersion, missingCapabilities, stopped
    public var errorDescription: String? {
        switch self {
        case .unavailable: return "辅助下载引擎尚未安装。"
        case .binaryMismatch: return "辅助引擎校验失败，请重新安装官方工具。"
        case .portUnavailable: return "无法为辅助引擎分配独立端口。"
        case .launchFailed: return "辅助下载引擎未能启动。"
        case .incompatibleVersion: return "辅助引擎版本与当前适配器不兼容。"
        case .missingCapabilities: return "辅助引擎缺少当前操作要求的功能。"
        case .stopped: return "辅助引擎已停止。"
        }
    }
}

private final class AuxiliaryPortReservation {
    let port: UInt16
    private var descriptors: [Int32] = []
    init(tcp: Bool, udp: Bool) throws {
        let first = socket(AF_INET, tcp ? SOCK_STREAM : SOCK_DGRAM, 0)
        guard first >= 0 else { throw AuxiliaryDaemonError.portUnavailable }
        var descriptors = [first]
        do {
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(first, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
            guard bound == 0 else { throw AuxiliaryDaemonError.portUnavailable }
            var size = socklen_t(MemoryLayout<sockaddr_in>.size)
            guard withUnsafeMutablePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(first, $0, &size) } }) == 0 else { throw AuxiliaryDaemonError.portUnavailable }
            self.port = UInt16(bigEndian: address.sin_port)
            if tcp && udp {
                let second = socket(AF_INET, SOCK_DGRAM, 0)
                guard second >= 0 else { throw AuxiliaryDaemonError.portUnavailable }
                descriptors.append(second)
                guard withUnsafePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(second, $0, size) } }) == 0 else { throw AuxiliaryDaemonError.portUnavailable }
            }
            self.descriptors = descriptors
        } catch { descriptors.forEach { close($0) }; throw error }
    }
    func release() { descriptors.forEach { close($0) }; descriptors.removeAll() }
    deinit { release() }
}

/// One shared process. Transfer actors use this RPC owner; they never spawn
/// per-task daemons or write a second download-task ledger.
public actor AuxiliaryDaemon {
    public struct Configuration: Sendable {
        public let executableURL: URL
        public let stateDirectory: URL
        public let expectedSHA256: String
        public let expectedVersion: String
        public let peerDiscoveryEnabled: Bool
        public let loopbackTransfersOnly: Bool
        public init(executableURL: URL, stateDirectory: URL, expectedSHA256: String,
                    expectedVersion: String = "2.7.5", peerDiscoveryEnabled: Bool = false, loopbackTransfersOnly: Bool = false) {
            self.executableURL = executableURL; self.stateDirectory = stateDirectory
            self.expectedSHA256 = expectedSHA256; self.expectedVersion = expectedVersion
            self.peerDiscoveryEnabled = peerDiscoveryEnabled; self.loopbackTransfersOnly = loopbackTransfersOnly
        }
    }
    private let configuration: Configuration
    private var process: Process?
    private var client: AuxiliaryRPC?
    private var capabilities: AuxiliaryCapabilities?
    private var starting: Task<AuxiliaryCapabilities, Error>?
    private var generation: UInt64 = 0
    private var btGlobalTail: Task<Void, Never>?
    private var proxyPlan: AuxiliaryProxyPlan = .direct
    private var proxyTail: Task<Void, Never>?
    private var pendingProxyChanges = 0
    private var proxySuspended = false
    private var proxyPolicyEpoch: UInt64 = 0

    public init(configuration: Configuration) { self.configuration = configuration }
    public var isRunning: Bool { process?.isRunning == true && capabilities != nil }

    public func start() async throws -> AuxiliaryCapabilities {
        guard pendingProxyChanges == 0, !proxySuspended else { throw AuxiliaryProxyError.proxyUnavailable }
        try proxyPlan.validate(kind: "bittorrent")
        if let capabilities, process?.isRunning == true { return capabilities }
        if let starting { return try await starting.value }
        generation &+= 1
        let expectedGeneration = generation
        let pending = Task { try await self.launch(generation: expectedGeneration) }
        starting = pending
        defer { if generation == expectedGeneration { starting = nil } }
        return try await pending.value
    }

    public func rpcClient() async throws -> AuxiliaryRPC {
        _ = try await start()
        guard let client, process?.isRunning == true else { throw AuxiliaryDaemonError.stopped }
        return client
    }

    public func stop() async {
        generation &+= 1
        starting?.cancel(); starting = nil
        let child = process; let rpc = client
        process = nil; client = nil; capabilities = nil
        if child?.isRunning == true { _ = try? await rpc?.call("aria2.forceShutdown") }
        await terminate(child)
    }

    /// A proxy transition always terminates the old owned process before ACK.
    /// The replacement environment and authenticated URI remain memory-only.
    public func setProxyPlan(_ plan: AuxiliaryProxyPlan) async {
        if proxyPlan == plan, pendingProxyChanges == 0 { return }
        let previous = proxyTail, expectedEpoch = proxyPolicyEpoch
        pendingProxyChanges += 1
        let next = Task {
            await previous?.value
            guard !self.proxySuspended, self.proxyPolicyEpoch == expectedEpoch else { return }
            if self.proxyPlan != plan {
                await self.stop()
                guard !self.proxySuspended, self.proxyPolicyEpoch == expectedEpoch else { return }
                self.proxyPlan = plan
            }
        }
        proxyTail = next
        await next.value
        pendingProxyChanges -= 1
    }
    public func beginProxyTransition() async {
        proxyPolicyEpoch &+= 1; proxySuspended = true
        await stop()
    }
    public func finishProxyTransition(_ plan: AuxiliaryProxyPlan) {
        proxyPolicyEpoch &+= 1; proxyPlan = plan; proxySuspended = false
    }
    public func verifyProxyPlan(_ expected: AuxiliaryProxyPlan) async throws {
        guard proxyPlan == expected, pendingProxyChanges == 0, !proxySuspended else { throw AuxiliaryProxyError.proxyUnavailable }
        let rpc = try await rpcClient()
        let options = try await rpc.call("aria2.getGlobalOption")
        guard (options["bt-proxy"]?.string ?? "") == expected.uri else { throw AuxiliaryProxyError.proxyUnavailable }
    }
    private func applyProxyAtLaunch(_ plan: AuxiliaryProxyPlan, rpc: AuxiliaryRPC) async throws {
        let ack = try await rpc.call("aria2.changeGlobalOption", parameters: [.object([
            "bt-proxy": .string(plan.uri),
            "enable-dht": .string(configuration.peerDiscoveryEnabled && !plan.enabled ? "true" : "false"),
            "bt-enable-lpd": .string(configuration.peerDiscoveryEnabled && !plan.enabled ? "true" : "false"),
            "bt-port-mapping": .string("false")])])
        guard ack.string == "OK" else { throw AuxiliaryProxyError.proxyUnavailable }
        let actual = try await rpc.call("aria2.getGlobalOption")
        guard (actual["bt-proxy"]?.string ?? "") == plan.uri else { throw AuxiliaryProxyError.proxyUnavailable }
    }

    private func btGlobalSerialized<T: Sendable>(_ body: @escaping @Sendable () async throws -> T) async throws -> T {
        let previous = btGlobalTail
        let next = Task { await previous?.value; return try await body() }
        btGlobalTail = Task { _ = try? await next.value }
        return try await next.value
    }
    public func btGlobalState(canConfigure: Bool) async throws -> AuxiliaryBTGlobalState {
        try await btGlobalSerialized {
            var record = try AuxiliaryBTGlobalStore(directory: self.configuration.stateDirectory).read()
            let rpc = try await self.rpcClient()
            if record.pending {
                guard canConfigure else { throw AuxiliaryBTError.unconfirmed }
                try await self.applyBTGlobal(record, rpc: rpc)
                record.pending = false; try AuxiliaryBTGlobalStore(directory: self.configuration.stateDirectory).write(record)
            }
            let actual = try await rpc.call("aria2.getGlobalOption")
            guard actual["bt-encryption"]?.string == record.encryption.rawValue else { throw AuxiliaryBTError.unconfirmed }
            return AuxiliaryBTGlobalState(revision: record.revision, encryption: record.encryption, canConfigure: canConfigure)
        }
    }
    public func configureBTGlobal(expectedRevision: Int64, encryption: AuxiliaryBTEncryption) async throws -> AuxiliaryBTGlobalState {
        try await btGlobalSerialized {
            let store = AuxiliaryBTGlobalStore(directory: self.configuration.stateDirectory)
            var record = try store.read()
            guard expectedRevision == record.revision else { throw AuxiliaryBTError.conflict }
            guard record.revision < AuxiliaryBTValidation.safeInteger else { throw AuxiliaryBTError.storage }
            let rpc = try await self.rpcClient()
            record.revision += 1; record.encryption = encryption; record.pending = true
            try store.write(record)
            do { try await self.applyBTGlobal(record, rpc: rpc) } catch { throw AuxiliaryBTError.unconfirmed }
            record.pending = false; try store.write(record)
            return AuxiliaryBTGlobalState(revision: record.revision, encryption: record.encryption, canConfigure: true)
        }
    }
    private func applyBTGlobal(_ record: AuxiliaryBTGlobalRecord, rpc: AuxiliaryRPC) async throws {
        guard (try await start()).methods.contains("aria2.changeGlobalOption") else { throw AuxiliaryBTError.unsupported }
        let ack = try await rpc.call("aria2.changeGlobalOption", parameters: [.object(["bt-encryption": .string(record.encryption.rawValue)])])
        guard ack.string == "OK" else { throw AuxiliaryBTError.unconfirmed }
        for _ in 0..<30 {
            if try await rpc.call("aria2.getGlobalOption")["bt-encryption"]?.string == record.encryption.rawValue { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw AuxiliaryBTError.unconfirmed
    }

    private func terminate(_ child: Process?) async {
        guard let child else { return }
        for _ in 0..<20 {
            if !child.isRunning { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        if child.isRunning { child.terminate() }
        for _ in 0..<20 {
            if !child.isRunning { return }
            try? await Task.sleep(nanoseconds: 25_000_000)
        }
        if child.isRunning { Darwin.kill(child.processIdentifier, SIGKILL) }
        while child.isRunning { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    private func launch(generation expectedGeneration: UInt64) async throws -> AuxiliaryCapabilities {
        guard FileManager.default.isExecutableFile(atPath: configuration.executableURL.path) else { throw AuxiliaryDaemonError.unavailable }
        let handle = try FileHandle(forReadingFrom: configuration.executableURL)
        var digest = SHA256()
        do {
            while let data = try handle.read(upToCount: 1024 * 1024), !data.isEmpty { digest.update(data: data) }
            try handle.close()
        } catch { try? handle.close(); throw AuxiliaryDaemonError.binaryMismatch }
        guard digest.finalize().map({ String(format: "%02x", $0) }).joined() == configuration.expectedSHA256.lowercased() else { throw AuxiliaryDaemonError.binaryMismatch }
        try FileManager.default.createDirectory(at: configuration.stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let rpcPort = try AuxiliaryPortReservation(tcp: true, udp: false)
        let btPort = try AuxiliaryPortReservation(tcp: true, udp: true)
        let ed2kTCP = try AuxiliaryPortReservation(tcp: true, udp: false)
        var ed2kUDP = try AuxiliaryPortReservation(tcp: false, udp: true)
        for _ in 0..<16 where [rpcPort.port, btPort.port, ed2kTCP.port].contains(ed2kUDP.port) {
            ed2kUDP.release()
            ed2kUDP = try AuxiliaryPortReservation(tcp: false, udp: true)
        }
        guard ![rpcPort.port, btPort.port, ed2kTCP.port].contains(ed2kUDP.port) else { throw AuxiliaryDaemonError.portUnavailable }
        var generator = SystemRandomNumberGenerator()
        let secret = (0..<32).map { _ in String(format: "%02x", UInt8.random(in: .min ... .max, using: &generator)) }.joined()
        let rpc = try AuxiliaryRPC(endpoint: URL(string: "http://127.0.0.1:\(rpcPort.port)/jsonrpc")!, secret: secret, timeout: 5)
        let child = Process()
        let launchProxy = proxyPlan
        child.environment = launchProxy.environment(from: ProcessInfo.processInfo.environment)
        child.executableURL = configuration.executableURL
        let btGlobal = try AuxiliaryBTGlobalStore(directory: configuration.stateDirectory).read()
        child.arguments = ["--bt-encryption=\(btGlobal.encryption.rawValue)", "--no-conf=true", "--no-netrc=true", "--enable-rpc=true", "--rpc-listen-all=false", "--rpc-listen-port=\(rpcPort.port)",
            "--rpc-secret=\(secret)", "--state-dir=\(configuration.stateDirectory.path)",
            "--dir=\(configuration.stateDirectory.appendingPathComponent("unassigned").path)", "--stop-with-process=\(getpid())",
            "--listen-port=\(btPort.port)", "--ed2k-listen-port=\(ed2kTCP.port)", "--ed2k-udp-listen-port=\(ed2kUDP.port)",
            "--enable-dht=false", "--bt-enable-lpd=false",
            "--bt-port-mapping=false", "--disable-ipv6=true", "--auto-file-renaming=false", "--allow-overwrite=false", "--console-log-level=error"]
        if configuration.loopbackTransfersOnly { child.arguments! += ["--interface=127.0.0.1", "--bt-interface=127.0.0.1"] }
        // Credentials may appear in helper diagnostics. They never enter app logs.
        child.standardOutput = FileHandle.nullDevice; child.standardError = FileHandle.nullDevice
        child.standardInput = FileHandle.nullDevice
        rpcPort.release(); btPort.release(); ed2kTCP.release(); ed2kUDP.release()
        do { try child.run() } catch { throw AuxiliaryDaemonError.launchFailed }
        process = child; client = rpc; capabilities = nil
        do {
            for _ in 0..<60 {
                guard generation == expectedGeneration, !Task.isCancelled else { throw AuxiliaryDaemonError.stopped }
                guard child.isRunning else { throw AuxiliaryDaemonError.launchFailed }
                do {
                    let version = try await rpc.call("aria2.getVersion")
                    guard version["version"]?.string == configuration.expectedVersion else { throw AuxiliaryDaemonError.incompatibleVersion }
                    guard let features = version["enabledFeatures"]?.array, features.allSatisfy({ $0.string != nil }) else { throw AuxiliaryRPCError.invalidResponse }
                    let result = try await rpc.call("system.listMethods")
                    guard let methods = result.array, methods.allSatisfy({ $0.string != nil }) else { throw AuxiliaryRPCError.invalidResponse }
                    let methodNames = Set(methods.compactMap(\.string))
                    guard Set(["aria2.addUri", "aria2.tellStatus", "aria2.forcePause", "aria2.unpause", "aria2.forceRemove", "aria2.changeOption", "aria2.getFiles"]).isSubset(of: methodNames) else { throw AuxiliaryDaemonError.missingCapabilities }
                    guard generation == expectedGeneration, child.isRunning else { throw AuxiliaryDaemonError.stopped }
                    let supported = AuxiliaryCapabilities(version: configuration.expectedVersion, features: Set(features.compactMap(\.string)), methods: methodNames,
                        rpcPort: rpcPort.port, bittorrentPort: btPort.port, ed2kTCPPort: ed2kTCP.port, ed2kUDPPort: ed2kUDP.port)
                    // Network discovery remains disabled until the proxy
                    // applied through RPC has been independently read back.
                    try await applyProxyAtLaunch(launchProxy, rpc: rpc)
                    guard generation == expectedGeneration, child.isRunning else { throw AuxiliaryDaemonError.stopped }
                    capabilities = supported
                    return supported
                } catch AuxiliaryRPCError.disconnected {
                    try await Task.sleep(nanoseconds: 100_000_000)
                }
            }
            throw AuxiliaryDaemonError.launchFailed
        } catch {
            await terminate(child)
            if process === child { process = nil; client = nil; capabilities = nil }
            throw error
        }
    }
}
