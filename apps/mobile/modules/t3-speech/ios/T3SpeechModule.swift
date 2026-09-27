import ExpoModulesCore

public class T3SpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Speech")

    Events("onSpeechState")

    // Every call runs on the main queue in call order, so blocks appended right
    // after `start` reach the session it created. Events carry the caller's
    // `reading` id, so a late event from a replaced reading can be told apart.
    AsyncFunction("start") { (options: SpeechOptionsRecord, reading: String, promise: Promise) in
      let settings = try options.validated()
      let task = MainActor.assumeIsolated {
        SpeechPlayer.shared.start(settings) { [weak self] state in
          self?.sendEvent("onSpeechState", [
            "reading": reading, "block": state.block.map { $0 as Any } ?? NSNull(), "paused": state.paused,
          ])
        }
      }
      Task {
        do { promise.resolve(try await task.value) }
        catch is CancellationError { promise.resolve(false) }
        catch { promise.reject(error) }
      }
    }.runOnQueue(.main)

    AsyncFunction("append") { (blocks: [String], from: Int) in
      MainActor.assumeIsolated { SpeechPlayer.shared.append(blocks, from: from) }
    }.runOnQueue(.main)

    AsyncFunction("finish") {
      MainActor.assumeIsolated { SpeechPlayer.shared.finish() }
    }.runOnQueue(.main)

    AsyncFunction("rewind") {
      MainActor.assumeIsolated { SpeechPlayer.shared.rewind() }
    }.runOnQueue(.main)

    AsyncFunction("nextBlock") {
      MainActor.assumeIsolated { SpeechPlayer.shared.nextBlock() }
    }.runOnQueue(.main)

    AsyncFunction("seekToBlock") { (block: Int) in
      MainActor.assumeIsolated { SpeechPlayer.shared.seek(toBlock: block) }
    }.runOnQueue(.main)

    AsyncFunction("pause") {
      MainActor.assumeIsolated { SpeechPlayer.shared.pause() }
    }.runOnQueue(.main)

    AsyncFunction("resume") {
      MainActor.assumeIsolated { SpeechPlayer.shared.resume() }
    }.runOnQueue(.main)

    AsyncFunction("setPace") { (pace: Float) in
      guard pace.isFinite, (0.75...2).contains(pace) else { throw SpeechError("Pace must be between 0.75× and 2×.") }
      MainActor.assumeIsolated { SpeechPlayer.shared.setPace(pace) }
    }.runOnQueue(.main)

    AsyncFunction("stop") { (promise: Promise) in
      Task { @MainActor in
        await SpeechPlayer.shared.stop()
        promise.resolve()
      }
    }.runOnQueue(.main)

    AsyncFunction("playCue") { (cue: String) in
      guard let cue = SpeechCue(rawValue: cue) else { throw SpeechError("Unknown cue: \(cue)") }
      try MainActor.assumeIsolated { try SpeechCues.shared.play(cue) }
    }.runOnQueue(.main)

    AsyncFunction("announce") { (text: String, cue: String) in
      guard let cue = SpeechCue(rawValue: cue) else { throw SpeechError("Unknown cue: \(cue)") }
      try MainActor.assumeIsolated { try SpeechCues.shared.announce(text, after: cue) }
    }.runOnQueue(.main)
  }
}

struct SpeechOptionsRecord: Record {
  @Field(.required) var voice: String = ""
  @Field(.required) var pace: Float = 1
  @Field(.required) var instructions: String = ""
  @Field(.required) var apiKey: String = ""
  @Field(.required) var title: String = ""

  func validated() throws -> SpeechSettings {
    guard pace.isFinite, (0.75...2).contains(pace) else {
      throw SpeechError("Pace must be between 0.75× and 2×.")
    }
    guard !apiKey.isEmpty else { throw SpeechError("Add your OpenAI API key in Settings → Voice.") }
    guard OpenAiVoice.voices.contains(voice) else { throw SpeechError("Unknown OpenAI voice: \(voice)") }
    return SpeechSettings(voice: voice, pace: pace, instructions: instructions, apiKey: apiKey, title: title)
  }
}
