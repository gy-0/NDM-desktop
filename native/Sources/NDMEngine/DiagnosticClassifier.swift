import Foundation
import NDMCore

public extension DownloadDiagnostic {
    /// Map any error surfaced by the download engines to a human diagnostic.
    /// `EngineError.paused` / `.cancelled` never reach the failure path
    /// (DownloadManager routes them to paused/incomplete states first).
    static func classify(_ error: Error) -> DownloadDiagnostic {
        switch error {
        case let engine as EngineError:
            return classify(engine: engine)
        case let ftp as FTPError:
            return classify(ftp: ftp)
        case let url as URLError:
            return fromURLError(url)
        default:
            let ns = error as NSError
            if let disk = fromCocoaError(ns) { return disk }
            if ns.domain == NSURLErrorDomain {
                return fromURLError(URLError(URLError.Code(rawValue: ns.code)))
            }
            return .generic(detail: error.localizedDescription)
        }
    }

    private static func classify(engine: EngineError) -> DownloadDiagnostic {
        switch engine {
        case .httpStatus(let code):
            return fromHTTPStatus(code)
        case .authRequired(let status, _):
            return .signInRequired(status: status)
        case .notResumable:
            return .rangeNotSupported
        case .invalidResponse:
            return .generic(detail: "Invalid HTTP response")
        case .mergeFailed(let message):
            return .classifyEngineMessage(message)
        case .insufficientStorage:
            return .diskFull
        case .cancelled, .paused:
            return .generic(detail: engine.errorDescription ?? "stopped")
        }
    }

    private static func classify(ftp: FTPError) -> DownloadDiagnostic {
        switch ftp {
        case .timeout:
            return .timeout
        case .disconnected:
            return .connectionLost
        case .loginFailed:
            return .signInRequired(status: 401)
        default:
            return .generic(detail: ftp.localizedDescription)
        }
    }
}
