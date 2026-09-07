import Foundation

/// Live record of smart connection tuning: what was tried, what it measured,
/// and why the engine settled where it did. Rendered verbatim in the progress
/// window ("smartline") and the inspector — transparency is the feature.
public struct ConnectionTuning: Sendable, Equatable {
    public struct Step: Sendable, Equatable {
        public var connections: Int
        public var bytesPerSecond: Double

        public init(connections: Int, bytesPerSecond: Double) {
            self.connections = connections
            self.bytesPerSecond = bytesPerSecond
        }
    }

    public enum Outcome: String, Sendable, Equatable {
        /// Still probing.
        case tuning
        /// Found the server's ceiling below the configured cap.
        case settled
        /// Reached the configured max while still gaining.
        case cappedByLimit
        /// Extra connections never helped — this server pools them into one cap.
        case noBenefit
        /// The server doesn't accept Range requests at all.
        case rangeUnsupported
        /// The user picked a connection count manually; tuning stepped aside.
        case userOverride
    }

    public var steps: [Step]
    public var currentConnections: Int
    public var outcome: Outcome

    public init(steps: [Step], currentConnections: Int, outcome: Outcome) {
        self.steps = steps
        self.currentConnections = currentConnections
        self.outcome = outcome
    }

    // MARK: - Human rendering

    private static func speedText(_ bytesPerSecond: Double) -> String {
        let formatted = TaskPresentationFormatting.byteCount(Int64(max(0, bytesPerSecond)))
        return L10n.usesChinese ? "\(formatted)/秒" : "\(formatted)/s"
    }

    /// "2 → 4 ×1.9 · 4 → 8 ×1.8" — gains between consecutive probe steps.
    private var gainsText: String? {
        guard steps.count >= 2 else { return nil }
        var parts: [String] = []
        for i in 1..<steps.count {
            let prev = steps[i - 1]
            let cur = steps[i]
            guard prev.bytesPerSecond > 0 else { continue }
            let ratio = cur.bytesPerSecond / prev.bytesPerSecond
            let gain = ratio >= 1.15
                ? String(format: "×%.1f", ratio)
                : L10n.t("no gain", "无收益")
            parts.append("\(prev.connections) → \(cur.connections) \(gain)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Full explanation for the progress window.
    public var summaryLine: String {
        let prefix = L10n.t("Smart connections: ", "智能连接数：")
        let gains = gainsText

        switch outcome {
        case .tuning:
            if let gains {
                return prefix + gains + L10n.t(" · probing…", " · 试探中…")
            }
            if let first = steps.first {
                return prefix + L10n.t(
                    "measuring \(first.connections) connections (\(Self.speedText(first.bytesPerSecond)))…",
                    "正在测量 \(first.connections) 条连接（\(Self.speedText(first.bytesPerSecond))）…"
                )
            }
            return prefix + L10n.t("starting low, doubling while it pays off…", "从低连接数起步，有收益才翻倍…")
        case .settled:
            let base = gains.map { $0 + " · " } ?? ""
            return prefix + base + L10n.t(
                "settled at \(currentConnections) — that's the server's ceiling, not your network.",
                "已停在 \(currentConnections) 条——这是该服务器的上限，不是你的网络。"
            )
        case .cappedByLimit:
            let base = gains.map { $0 + " · " } ?? ""
            return prefix + base + L10n.t(
                "at your configured max of \(currentConnections), still gaining — raise the cap for more.",
                "已达设置上限 \(currentConnections) 条且仍有收益——调高上限还能更快。"
            )
        case .noBenefit:
            return prefix + L10n.t(
                "extra connections didn't help — this server caps them together. Staying at \(currentConnections) to be polite.",
                "增加连接没有提速——该服务器把所有连接算在同一限额里。已保持 \(currentConnections) 条，避免被误判为攻击。"
            )
        case .rangeUnsupported:
            return prefix + L10n.t(
                "this server doesn't support segmented download — single connection only.",
                "该服务器不支持分段下载——仅能单连接。"
            )
        case .userOverride:
            return prefix + L10n.t(
                "you set \(currentConnections) connections manually — auto-tuning is off for this task.",
                "你手动设置了 \(currentConnections) 条连接——本任务已停用自动调节。"
            )
        }
    }

    /// Short "why is it this fast" note for the inspector.
    public var inspectorNote: String? {
        guard let first = steps.first, let last = steps.last,
              first.bytesPerSecond > 0, steps.count >= 2 else { return nil }
        let ratio = last.bytesPerSecond / first.bytesPerSecond
        guard ratio >= 1.15 else { return nil }
        return L10n.t(
            "This server gives ~\(Self.speedText(first.bytesPerSecond)) at \(first.connections) connections. " +
            "Running \(last.connections) in parallel measured ×\(String(format: "%.1f", ratio)).",
            "该服务器 \(first.connections) 条连接约 \(Self.speedText(first.bytesPerSecond))。" +
            "并行 \(last.connections) 条实测 ×\(String(format: "%.1f", ratio))。"
        )
    }
}
