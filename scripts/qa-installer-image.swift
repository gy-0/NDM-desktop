// Compile with the current NDMCore/NDMEngine build products, then pass a DMG
// path. Installs only in an owned temporary directory; never touches /Applications.
import Foundation
import NDMEngine

@main struct InstallerImageQA {
    static func main() async throws {
        guard CommandLine.arguments.count == 2 else { fatalError("Pass a DMG path") }
        let image = URL(fileURLWithPath: CommandLine.arguments[1])
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ndm-installer-image-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let ready = DispatchSemaphore(value: 0)
        let releasePeek = DispatchSemaphore(value: 0)
        let peekFinished = DispatchSemaphore(value: 0)
        let peek = Task.detached {
            defer { peekFinished.signal() }
            return try await DiskImagePeek.withPrimaryApp(dmgURL: image) { app in
                ready.signal()
                guard await waitFor(releasePeek) else { throw QAError.timeout }
                return app.lastPathComponent
            }
        }
        guard await waitFor(ready) else { throw QAError.timeout }
        let outcome = try await InstallerRunner.process(dmgURL: image, destination: root, onStep: { step in
            if case .copying = step {
                // Release the icon reader exactly as installation starts.
                // The old implementation ejects the copy source here.
                releasePeek.signal()
                precondition(peekFinished.wait(timeout: .now() + 20) == .success,
                             "Icon reader must finish before copying starts")
            }
        })
        let peekName = try await peek.value
        guard case .installed(let name, let at) = outcome, peekName == name else { throw QAError.notInstalled }
        try verifySignature(at)
        let replaced = try await InstallerRunner.process(dmgURL: image, destination: root, replaceExisting: true)
        guard replaced == outcome else { throw QAError.notInstalled }
        try verifySignature(at)
        let remaining = try FileManager.default.contentsOfDirectory(atPath: root.path)
        guard remaining == [name] else { throw QAError.stagingLeftBehind }
        print("PASS: concurrent icon release + real DMG install + atomic replacement + both code signatures; \(name)")
    }

    static func verifySignature(_ app: URL) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        process.arguments = ["--verify", "--deep", "--strict", app.path]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw QAError.signature }
    }

    static func waitFor(_ semaphore: DispatchSemaphore) async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: semaphore.wait(timeout: .now() + 60) == .success)
            }
        }
    }

    enum QAError: Error { case timeout, notInstalled, stagingLeftBehind, signature }
}
