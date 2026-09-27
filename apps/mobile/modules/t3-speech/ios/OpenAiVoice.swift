import Foundation

/// Streams `gpt-4o-mini-tts` speech as 24 kHz 16-bit PCM straight from the phone.
struct OpenAiVoice: Sendable {
  static let voices = ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"]
  static let sampleRate: Double = 24_000
  /// Stopping discards at most one segment, about a cent of audio.
  static let segmentLength = 600
  private static let retryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(8)]

  let apiKey: String
  let voice: String
  let instructions: String

  /// A dropped connection retries the whole segment, so part of it may repeat.
  func generate(_ text: String, append: @escaping @Sendable (Data) -> Bool) async throws {
    for (attempt, delay) in ([Duration.zero] + Self.retryDelays).enumerated() {
      try await Task.sleep(for: delay)
      do {
        try await stream(text, append: append)
        return
      } catch let error as URLError where attempt < Self.retryDelays.count && error.code != .cancelled {
        continue
      }
    }
  }

  private func stream(_ text: String, append: @escaping @Sendable (Data) -> Bool) async throws {
    var request = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/speech")!)
    request.httpMethod = "POST"
    request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    var body = ["model": "gpt-4o-mini-tts", "input": text, "voice": voice, "response_format": "pcm"]
    if !instructions.isEmpty { body["instructions"] = instructions }
    request.httpBody = try JSONSerialization.data(withJSONObject: body)

    let (bytes, response) = try await URLSession.shared.bytes(for: request)
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200...299).contains(status) else {
      var data = Data()
      for try await byte in bytes { data.append(byte) }
      let error = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? [String: Any]
      throw SpeechError("OpenAI speech failed (\(status)): \(error?["message"] as? String ?? "no details")")
    }

    // Convert Int16 samples to Float32 in quarter-second pieces.
    var pcm = Data()
    let piece = Int(Self.sampleRate / 4) * 2
    for try await byte in bytes {
      pcm.append(byte)
      if pcm.count >= piece {
        guard append(Self.float32(pcm)) else { return }
        pcm.removeAll(keepingCapacity: true)
      }
    }
    _ = append(Self.float32(pcm.prefix(pcm.count & ~1)))
  }

  private static func float32(_ pcm: Data) -> Data {
    let samples = pcm.withUnsafeBytes { raw in
      raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32_768 }
    }
    return samples.withUnsafeBytes { Data($0) }
  }
}
