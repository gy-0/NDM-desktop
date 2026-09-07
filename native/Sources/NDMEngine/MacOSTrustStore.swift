import Foundation

/// Builds an OpenSSL-compatible CA bundle from macOS' system trust store.
///
/// The standalone yt-dlp executable carries its own Python CA snapshot, which
/// cannot see roots installed by local HTTPS proxies, schools, or workplaces.
/// We keep certificate validation enabled and bridge the administrator-managed
/// System keychain into the child process instead.
enum MacOSTrustStore {
    static let certificateBundleURL: URL? = makeCertificateBundle()

    private static func makeCertificateBundle() -> URL? {
        let fileManager = FileManager.default
        let systemPEM = URL(fileURLWithPath: "/etc/ssl/cert.pem")
        guard let base = try? Data(contentsOf: systemPEM), !base.isEmpty else {
            return nil
        }

        let cacheRoot = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? fileManager.temporaryDirectory
        let directory = cacheRoot
            .appendingPathComponent("dev.ndm.open", isDirectory: true)
            .appendingPathComponent("Trust", isDirectory: true)
        let destination = directory.appendingPathComponent("macos-system-ca.pem")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = [
            "find-certificate", "-a", "-p",
            "/Library/Keychains/System.keychain",
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
            // Read while the process is alive so a large keychain cannot fill
            // the pipe buffer and deadlock the first media request.
            let administratorCertificates = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }

            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            try combinedPEM(base: base, administratorCertificates: administratorCertificates)
                .write(to: destination, options: .atomic)
            return destination
        } catch {
            return nil
        }
    }

    static func combinedPEM(base: Data, administratorCertificates: Data) -> Data {
        var result = base
        if result.last != 0x0A { result.append(0x0A) }
        result.append(administratorCertificates)
        return result
    }
}
