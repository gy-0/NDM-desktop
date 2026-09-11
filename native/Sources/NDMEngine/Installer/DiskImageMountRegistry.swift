import Foundation

/// Peeking at an icon and installing can use the same system mount. Serialize
/// acquisition/release and keep it mounted until the last reader finishes.
final class DiskImageMountRegistry: @unchecked Sendable {
    private let lock = NSLock()
    private var images: [URL: URL] = [:]
    private var readers: [URL: Int] = [:]

    func acquire(image: URL, mount: () throws -> URL) rethrows -> URL {
        lock.lock()
        defer { lock.unlock() }
        let key = image.resolvingSymlinksInPath().standardizedFileURL
        if let existing = images[key] {
            readers[existing, default: 0] += 1
            return existing
        }
        let mounted = try mount()
        images[key] = mounted
        // Different paths (including hard links) may resolve to one OS mount.
        readers[mounted, default: 0] += 1
        return mounted
    }

    func release(mount: URL, unmount: () throws -> Void) rethrows {
        lock.lock()
        defer { lock.unlock() }
        guard let count = readers[mount] else { return }
        if count > 1 {
            readers[mount] = count - 1
            return
        }
        readers.removeValue(forKey: mount)
        images = images.filter { $0.value != mount }
        // Hold the lock through unmount so another acquire cannot borrow a
        // volume that the system is in the middle of ejecting.
        try unmount()
    }
}
