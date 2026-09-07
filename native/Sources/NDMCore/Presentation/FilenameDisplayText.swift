/// Adds invisible, filename-aware line-break opportunities for compact UI.
///
/// Generic character wrapping can strand the extension separator at the end of
/// a line (`name.\nmp4`). We instead prefer breaks after separators in the stem
/// and keep the final `.extension` together as one visual unit.
public enum FilenameDisplayText {
    public static let softBreak = "\u{200B}"
    public static let wordJoiner = "\u{2060}"

    public static func wrapping(_ filename: String) -> String {
        guard let extensionDot = filename.lastIndex(of: "."),
              extensionDot != filename.startIndex,
              filename.index(after: extensionDot) != filename.endIndex else {
            return addStemBreaks(to: filename)
        }

        let stem = String(filename[..<extensionDot])
        let fileExtension = String(filename[filename.index(after: extensionDot)...])
        return addStemBreaks(to: stem)
            + wordJoiner + "." + wordJoiner + fileExtension
    }

    private static func addStemBreaks(to stem: String) -> String {
        var result = ""
        result.reserveCapacity(stem.count + 8)
        for character in stem {
            result.append(character)
            if character == "." || character == "_" || character == "-" {
                result.append(contentsOf: softBreak)
            }
        }
        return result
    }
}
