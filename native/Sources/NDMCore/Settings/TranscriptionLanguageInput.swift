import Foundation

extension SettingsInputValidation {
    /// A transcription language override, or nil for "decide automatically".
    ///
    /// Deliberately strict, and deliberately not a list of the 45 languages the
    /// system happens to support today: whether a tag is actually available is the
    /// running system's answer, not this file's. What this rejects is text that
    /// could never be a language tag, so a typo becomes "automatic" rather than a
    /// silently broken setting.
    public static func transcriptionLanguageTag(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard (1...3).contains(parts.count) else { return nil }
        guard let language = parts.first,
              (2...3).contains(language.count),
              language.allSatisfy({ $0.isASCII && $0.isLetter })
        else { return nil }
        for part in parts.dropFirst() {
            guard (2...4).contains(part.count),
                  part.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) })
            else { return nil }
        }
        return value
    }
}
