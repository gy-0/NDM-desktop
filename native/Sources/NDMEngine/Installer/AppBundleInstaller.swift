import Darwin
import Foundation

enum AppBundleInstaller {
    /// Build a complete bundle beside the destination, then publish it in one
    /// filesystem operation. A failed copy must leave an existing app usable.
    static func install(
        source: URL,
        destination: URL,
        replaceExisting: Bool,
        copyItem: (URL, URL) throws -> Void = { try FileManager.default.copyItem(at: $0, to: $1) },
        wait: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) throws -> InstallerRunner.Outcome {
        let fm = FileManager.default
        let name = source.lastPathComponent
        let target = destination.appendingPathComponent(name, isDirectory: true)
        if (try? fm.attributesOfItem(atPath: target.path)) != nil, !replaceExisting {
            return .needsReplaceConsent(appName: name)
        }
        let staging = destination.appendingPathComponent(".ndm-install-\(UUID().uuidString)", isDirectory: true)
        let stagedApp = staging.appendingPathComponent(name, isDirectory: true)
        defer { try? fm.removeItem(at: staging) }
        do {
            try fm.createDirectory(at: destination, withIntermediateDirectories: true)
            try fm.createDirectory(at: staging, withIntermediateDirectories: false,
                                   attributes: [.posixPermissions: 0o700])
            for attempt in 0..<3 {
                do {
                    try copyItem(source, stagedApp)
                    break
                } catch {
                    guard attempt < 2, isTransientCopyError(error) else { throw error }
                    // The next attempt starts clean, retaining all metadata;
                    // never ignore a failed resource-fork or library copy.
                    if (try? fm.attributesOfItem(atPath: stagedApp.path)) != nil {
                        try fm.removeItem(at: stagedApp)
                    }
                    wait(0.25 * Double(attempt + 1))
                }
            }
            try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: stagedApp.path)

            // EXCL also protects an app created by another installer after
            // our initial existence check. SWAP leaves the old app in staging
            // until the complete new version occupies its final location.
            if renamex_np(stagedApp.path, target.path, UInt32(RENAME_EXCL)) != 0 {
                let code = errno
                guard code == EEXIST else { throw posixError(code) }
                guard replaceExisting else { return .needsReplaceConsent(appName: name) }
                if renamex_np(stagedApp.path, target.path, UInt32(RENAME_SWAP)) != 0 {
                    let swapCode = errno
                    // The destination may have been removed after EXCL.
                    guard swapCode == ENOENT else { throw posixError(swapCode) }
                    guard renamex_np(stagedApp.path, target.path, UInt32(RENAME_EXCL)) == 0 else {
                        throw posixError(errno)
                    }
                }
            }
            return .installed(appName: name, at: target)
        } catch {
            let native = error as NSError
            fputs("NDM installer copy failed: \(native.domain) (\(native.code)), underlying=\(posixCode(error).map(String.init) ?? "none")\n", stderr)
            throw InstallerError.copyFailed(detail: failureMessage(error))
        }
    }

    private static func posixError(_ code: Int32) -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }

    private static func posixCode(_ error: Error) -> Int? {
        var current = error as NSError
        for _ in 0..<8 {
            if current.domain == NSPOSIXErrorDomain { return current.code }
            guard let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError else { break }
            current = underlying
        }
        return nil
    }

    private static func isTransientCopyError(_ error: Error) -> Bool {
        guard let code = posixCode(error) else { return false }
        return [Int(EIO), Int(EINTR), Int(EAGAIN), Int(EBUSY)].contains(code)
    }

    private static func failureMessage(_ error: Error) -> String {
        let native = error as NSError
        switch posixCode(error) {
        case Int(ENOSPC): return "磁盘空间不足。请释放空间后重试。"
        case Int(EACCES), Int(EPERM): return "无法写入安装位置。请检查文件夹权限。"
        case Int(EIO): return "复制应用时发生读写错误。请重试安装。"
        default:
            if native.domain == NSCocoaErrorDomain, native.code == NSFileWriteOutOfSpaceError {
                return "磁盘空间不足。请释放空间后重试。"
            }
            return "无法复制应用。请重试安装。"
        }
    }
}
