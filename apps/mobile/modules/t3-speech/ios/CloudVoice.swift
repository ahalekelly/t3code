import Foundation

/// Streams OpenAI, Gemini, ElevenLabs, or Azure MAI speech as 24 kHz 16-bit PCM straight from the phone.
struct CloudVoice: Sendable {
  enum Model: String, Sendable {
    case openAi = "gpt-4o-mini-tts"
    case geminiFlash = "gemini-3.8-flash-tts"
    case geminiFlashLite = "gemini-3.8-flash-lite-tts"
    case elevenLabs = "eleven_v4"
    case elevenLabsTurbo = "eleven_v4_turbo"
    case maiVoice = "MAI-Voice-2"
    case maiVoiceFlash = "MAI-Voice-2-Flash"

    var provider: String {
      switch self {
      case .openAi: "OpenAI"
      case .geminiFlash, .geminiFlashLite: "Gemini"
      case .elevenLabs, .elevenLabsTurbo: "ElevenLabs"
      case .maiVoice, .maiVoiceFlash: "Azure Speech"
      }
    }
  }

  static let sampleRate: Double = 24_000
  /// Stopping discards at most one segment, a few cents of audio at most.
  static let segmentLength = 600
  private static let retryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(8)]

  let model: Model
  let apiKey: String
  let voice: String
  let instructions: String

  /// A dropped connection retries the whole segment, so part of it may repeat.
  func generate(_ text: String, append: @escaping @Sendable (Data) async -> Bool) async throws {
    for (attempt, delay) in ([Duration.zero] + Self.retryDelays).enumerated() {
      try await Task.sleep(for: delay)
      do {
        try await stream(text, append: append)
        return
      } catch let error as URLError where attempt < Self.retryDelays.count && error.code != .cancelled {
        speechLog.error("\(model.provider, privacy: .public) speech attempt \(attempt + 1) failed, retrying: \(error.localizedDescription, privacy: .public)")
        continue
      }
    }
  }

  private func stream(_ text: String, append: @escaping @Sendable (Data) async -> Bool) async throws {
    let (bytes, response) = try await URLSession.shared.bytes(for: request(text))
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    guard (200...299).contains(status) else {
      var data = Data()
      for try await byte in bytes { data.append(byte) }
      // OpenAI and Gemini send `error.message`, ElevenLabs `detail.message`; Azure sends no body.
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      let error = (json?["error"] ?? json?["detail"]) as? [String: Any]
      throw SpeechError("\(model.provider) speech failed (\(status)): \(error?["message"] as? String ?? "no details")")
    }

    // Pass samples on in quarter-second pieces.
    var pcm = Data()
    let piece = Int(Self.sampleRate / 4) * 2
    switch model {
    case .openAi, .elevenLabs, .elevenLabsTurbo, .maiVoice, .maiVoiceFlash:
      for try await byte in bytes {
        pcm.append(byte)
        if pcm.count >= piece, !(await Self.send(&pcm, to: append)) { return }
      }
    case .geminiFlash, .geminiFlashLite:
      // Server-sent events carry base64 audio in `step.delta` events, and sometimes
      // the first chunk in `step.start`.
      var completed = false
      for try await line in bytes.lines where line.hasPrefix("data: {") {
        let event = try JSONSerialization.jsonObject(with: Data(line.dropFirst(6).utf8)) as? [String: Any] ?? [:]
        let parts: [Any]
        switch event["event_type"] as? String {
        case "error":
          let error = event["error"] as? [String: Any]
          throw SpeechError("Gemini speech failed: \(error?["message"] as? String ?? "no details")")
        case "interaction.completed":
          let status = (event["interaction"] as? [String: Any])?["status"] as? String
          guard status == "completed" else { throw SpeechError("Gemini speech ended as \(status ?? "unknown").") }
          completed = true
          continue
        case "step.start": parts = (event["step"] as? [String: Any])?["content"] as? [Any] ?? []
        case "step.delta": parts = [event["delta"] as Any]
        default: continue
        }
        for case let part as [String: Any] in parts where part["type"] as? String == "audio" {
          guard let audio = (part["data"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
            throw SpeechError("Gemini sent unreadable audio.")
          }
          pcm.append(audio)
        }
        if pcm.count >= piece, !(await Self.send(&pcm, to: append)) { return }
      }
      // A stream that ends early retries like a dropped connection.
      guard completed else { throw URLError(.networkConnectionLost) }
    }
    _ = await Self.send(&pcm, to: append)
  }

  private func request(_ text: String) throws -> URLRequest {
    var request: URLRequest
    let body: [String: Any]
    switch model {
    case .openAi:
      request = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/speech")!)
      request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
      var openAi = ["model": model.rawValue, "input": text, "voice": voice, "response_format": "pcm"]
      if !instructions.isEmpty { openAi["instructions"] = instructions }
      body = openAi
    case .geminiFlash, .geminiFlashLite:
      request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!)
      request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
      var content: [String: Any] = ["type": "text", "text": text]
      if !instructions.isEmpty { content["annotations"] = [["type": "speech_metadata", "style": instructions]] }
      body = [
        "model": model.rawValue,
        "input": [["type": "user_input", "content": [content]]],
        "response_format": ["type": "audio", "mime_type": "audio/l16", "sample_rate": Int(Self.sampleRate)],
        "generation_config": ["speech_config": [["voice": voice]]],
        "stream": true,
      ]
    case .elevenLabs, .elevenLabsTurbo:
      var components = URLComponents(string: "https://api.elevenlabs.io/v1/text-to-speech")!
      components.path += "/\(voice)/stream"
      components.queryItems = [URLQueryItem(name: "output_format", value: "pcm_24000")]
      request = URLRequest(url: components.url!)
      request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
      body = ["text": text, "model_id": model.rawValue]
    case .maiVoice, .maiVoiceFlash:
      // MAI voices run only in East US and West US; the key must come from an East US resource.
      request = URLRequest(url: URL(string: "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1")!)
      request.httpMethod = "POST"
      request.setValue(apiKey, forHTTPHeaderField: "Ocp-Apim-Subscription-Key")
      request.setValue("application/ssml+xml", forHTTPHeaderField: "Content-Type")
      request.setValue("raw-24khz-16bit-mono-pcm", forHTTPHeaderField: "X-Microsoft-OutputFormat")
      request.setValue("T3Code", forHTTPHeaderField: "User-Agent")
      let escaped = text
        .replacingOccurrences(of: "&", with: "&amp;")
        .replacingOccurrences(of: "<", with: "&lt;")
        .replacingOccurrences(of: ">", with: "&gt;")
      request.httpBody = Data("""
        <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">\
        <voice name="en-US-\(voice):\(model.rawValue)">\(escaped)</voice></speak>
        """.utf8)
      return request
    }
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    return request
  }

  /// Converts the whole Int16 samples in `pcm` to Float32 and keeps a trailing odd byte.
  private static func send(_ pcm: inout Data, to append: @Sendable (Data) async -> Bool) async -> Bool {
    let whole = pcm.count & ~1
    let samples = pcm.prefix(whole).withUnsafeBytes { raw in
      raw.bindMemory(to: Int16.self).map { Float(Int16(littleEndian: $0)) / 32_768 }
    }
    pcm = Data(pcm.dropFirst(whole))
    return await append(samples.withUnsafeBytes { Data($0) })
  }
}
