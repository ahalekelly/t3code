import Foundation

/// Streams OpenAI, Gemini, ElevenLabs, or Azure MAI speech as 24 kHz 16-bit PCM straight from the phone.
struct CloudVoice: Sendable {
  /// Matches `VOICE_API_PROVIDERS` in speechSettings.ts, which also lists each provider's models.
  enum Provider: String, Sendable {
    case openai, gemini, elevenlabs, azure

    var label: String {
      switch self {
      case .openai: "OpenAI"
      case .gemini: "Gemini"
      case .elevenlabs: "ElevenLabs"
      case .azure: "Azure Speech"
      }
    }
  }

  static let sampleRate: Double = 24_000
  /// Stopping discards at most one segment, a few cents of audio at most.
  static let segmentLength = 600
  private static let retryDelays: [Duration] = [.seconds(1), .seconds(3), .seconds(8)]

  let provider: Provider
  let model: String
  /// Tried in order: a 403 moves on to the next key, so Azure's free key serves until its quota runs out.
  let apiKeys: [String]
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
        speechLog.error("\(provider.label, privacy: .public) speech attempt \(attempt + 1) failed, retrying: \(error.localizedDescription, privacy: .public)")
        continue
      }
    }
  }

  private func stream(_ text: String, append: @escaping @Sendable (Data) async -> Bool) async throws {
    let (bytes, status) = try await open(text)
    guard (200...299).contains(status) else {
      var data = Data()
      for try await byte in bytes { data.append(byte) }
      // OpenAI and Gemini send `error.message`, ElevenLabs `detail.message`; Azure sends no body.
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      let error = (json?["error"] ?? json?["detail"]) as? [String: Any]
      throw SpeechError("\(provider.label) speech failed (\(status)): \(error?["message"] as? String ?? "no details")")
    }

    // Pass samples on in quarter-second pieces.
    var pcm = Data()
    let piece = Int(Self.sampleRate / 4) * 2
    switch provider {
    case .openai, .elevenlabs, .azure:
      for try await byte in bytes {
        pcm.append(byte)
        if pcm.count >= piece, !(await Self.send(&pcm, to: append)) { return }
      }
    case .gemini:
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

  /// Opens the response with the first key that isn't refused with a 403.
  private func open(_ text: String) async throws -> (URLSession.AsyncBytes, Int) {
    for (index, apiKey) in apiKeys.enumerated() {
      let (bytes, response) = try await URLSession.shared.bytes(for: request(text, apiKey: apiKey))
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      if status != 403 || index == apiKeys.count - 1 { return (bytes, status) }
    }
    throw SpeechError("Add your \(provider.label) API key in Settings → Voice.")
  }

  private func request(_ text: String, apiKey: String) throws -> URLRequest {
    var request: URLRequest
    let body: [String: Any]
    switch provider {
    case .openai:
      request = URLRequest(url: URL(string: "https://api.openai.com/v1/audio/speech")!)
      request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
      var openAi = ["model": model, "input": text, "voice": voice, "response_format": "pcm"]
      if !instructions.isEmpty { openAi["instructions"] = instructions }
      body = openAi
    case .gemini:
      request = URLRequest(url: URL(string: "https://generativelanguage.googleapis.com/v1beta/interactions")!)
      request.setValue(apiKey, forHTTPHeaderField: "x-goog-api-key")
      var content: [String: Any] = ["type": "text", "text": text]
      if !instructions.isEmpty { content["annotations"] = [["type": "speech_metadata", "style": instructions]] }
      body = [
        "model": model,
        "input": [["type": "user_input", "content": [content]]],
        "response_format": ["type": "audio", "mime_type": "audio/l16", "sample_rate": Int(Self.sampleRate)],
        "generation_config": ["speech_config": [["voice": voice]]],
        "stream": true,
      ]
    case .elevenlabs:
      var components = URLComponents(string: "https://api.elevenlabs.io/v1/text-to-speech")!
      components.path += "/\(voice)/stream"
      components.queryItems = [URLQueryItem(name: "output_format", value: "pcm_24000")]
      request = URLRequest(url: components.url!)
      request.setValue(apiKey, forHTTPHeaderField: "xi-api-key")
      body = ["text": text, "model_id": model]
    case .azure:
      // The key must come from a West US 2 resource, which serves MAI voices and MAI-Transcribe.
      request = URLRequest(url: URL(string: "https://westus2.tts.speech.microsoft.com/cognitiveservices/v1")!)
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
        <voice name="en-US-\(voice):\(model)">\(escaped)</voice></speak>
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
