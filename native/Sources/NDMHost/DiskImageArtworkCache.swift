import AppKit
import CryptoKit
import Foundation
import NDMEngine

/// Serial, on-disk cache of the app icon living inside a downloaded disk image.
///
/// Mounting is expensive and the disk-images helper hates parallel attaches, so
/// every peek is queued. Hits from memory or `dmg-icons/` skip the mount.
actor DiskImageArtworkCache {
    static let shared = DiskImageArtworkCache()

    private var memory: [String: String] = [:]
    private var inflight: [String: Task<String?, Never>] = [:]
    private var tail: Task<Void, Never> = Task {}

    func artwork(for path: String, support: URL) async -> [String: Any]? {
        let key = Self.cacheKey(path: path)
        if let dataURL = memory[key] {
            return dataURL.isEmpty ? nil : ["dataURL": dataURL, "kind": "icon"]
        }
        if let dataURL = Self.readDisk(key: key, support: support) {
            memory[key] = dataURL
            return ["dataURL": dataURL, "kind": "icon"]
        }
        if let existing = inflight[key] {
            guard let dataURL = await existing.value, !dataURL.isEmpty else { return nil }
            return ["dataURL": dataURL, "kind": "icon"]
        }
        let previous = tail
        let pathCopy = path
        let task = Task.detached {
            await previous.value
            return await Self.peek(path: pathCopy)
        }
        inflight[key] = task
        tail = Task { _ = await task.value }
        let dataURL = await task.value
        inflight[key] = nil
        memory[key] = dataURL ?? ""
        guard let dataURL, !dataURL.isEmpty else { return nil }
        Self.writeDisk(key: key, support: support, dataURL: dataURL)
        return ["dataURL": dataURL, "kind": "icon"]
    }

    private static func peek(path: String) async -> String? {
        do {
            return try await DiskImagePeek.withPrimaryApp(dmgURL: URL(fileURLWithPath: path)) { appURL in
                guard let dataURL = await MainActor.run(body: {
                    pngDataURL(appBundleIcon(at: appURL), maxDimension: 128)
                }) else {
                    throw InstallerError.enumerationFailed(detail: "no app icon")
                }
                return dataURL
            }
        } catch {
            fputs("NDMHost: disk-image peek failed for \(URL(fileURLWithPath: path).lastPathComponent): \(error)\n", stderr)
            return nil
        }
    }

    /// Prefer the icns inside the bundle. `NSWorkspace.icon(forFile:)` on a
    /// just-mounted (or reconstructed) app often returns the generic purple
    /// placeholder before Launch Services has registered it.
    private static func appBundleIcon(at appURL: URL) -> NSImage {
        let resources = appURL.appendingPathComponent("Contents/Resources")
        let info = appURL.appendingPathComponent("Contents/Info.plist")
        if let plist = NSDictionary(contentsOf: info) {
            for key in ["CFBundleIconFile", "CFBundleIconName"] {
                guard let raw = plist[key] as? String, !raw.isEmpty else { continue }
                let name = raw.lowercased().hasSuffix(".icns") ? raw : "\(raw).icns"
                if let image = NSImage(contentsOf: resources.appendingPathComponent(name)), image.isValid {
                    return image
                }
            }
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: resources,
            includingPropertiesForKeys: nil
        )) ?? []
        for file in files where file.pathExtension.lowercased() == "icns" {
            if let image = NSImage(contentsOf: file), image.isValid {
                return image
            }
        }
        return NSWorkspace.shared.icon(forFile: appURL.path)
    }

    private static func cacheKey(path: String) -> String {
        let url = URL(fileURLWithPath: path)
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        let mtime = Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
        let digest = SHA256.hash(data: Data("\(path)|\(size)|\(mtime)".utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private static func folder(in support: URL) -> URL {
        support.appendingPathComponent("dmg-icons", isDirectory: true)
    }

    private static func readDisk(key: String, support: URL) -> String? {
        let file = folder(in: support).appendingPathComponent("\(key).png")
        guard let data = try? Data(contentsOf: file), !data.isEmpty else { return nil }
        return "data:image/png;base64,\(data.base64EncodedString())"
    }

    private static func writeDisk(key: String, support: URL, dataURL: String) {
        let dir = folder(in: support)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              !data.isEmpty else { return }
        try? data.write(to: dir.appendingPathComponent("\(key).png"), options: .atomic)
    }
}
