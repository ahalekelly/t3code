import Foundation

/// Packs whole sentences into segments of up to `maxLength` characters, which keeps
/// generation latency and model memory bounded on long responses.
func speechSegments(_ text: String, maxLength: Int) -> [String] {
  var segments: [String] = []
  var pending = ""
  func add(_ part: some StringProtocol) {
    if !pending.isEmpty && pending.count + 1 + part.count > maxLength {
      segments.append(pending)
      pending = ""
    }
    pending += pending.isEmpty ? String(part) : " \(part)"
  }
  text.enumerateSubstrings(in: text.startIndex..<text.endIndex, options: .bySentences) { sentence, _, _, _ in
    let sentence = sentence!.trimmingCharacters(in: .whitespacesAndNewlines)
    if sentence.isEmpty { return }
    if sentence.count <= maxLength { add(sentence); return }
    for word in sentence.split(whereSeparator: { $0.isWhitespace }) {
      var remainder = word
      while !remainder.isEmpty {
        add(remainder.prefix(maxLength))
        remainder = remainder.dropFirst(maxLength)
      }
    }
  }
  if !pending.isEmpty { segments.append(pending) }
  return segments
}
