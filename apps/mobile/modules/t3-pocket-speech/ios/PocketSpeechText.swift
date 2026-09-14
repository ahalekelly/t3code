import Foundation

/// Sentence boundaries keep generation latency and model memory bounded on long responses.
func pocketSpeechSegments(_ text: String) -> [String] {
  var segments: [String] = []
  text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .bySentences) { sentence, _, _, _ in
    var pending = ""
    for word in sentence!.split(whereSeparator: { $0.isWhitespace }) {
      var remainder = word
      while !remainder.isEmpty {
        let part = remainder.prefix(400)
        if pending.count + part.count + 1 > 400 {
          if !pending.isEmpty { segments.append(pending) }
          pending = ""
        }
        if !pending.isEmpty { pending += " " }
        pending += part
        remainder = remainder.dropFirst(part.count)
      }
    }
    if !pending.isEmpty { segments.append(pending) }
  }
  return segments
}
