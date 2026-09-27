import ExpoModulesCore
import T3Supertonic

public class T3SpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Speech")

    Events("onSpeechState")

    OnCreate {
      SpeechPlayer.shared.onState = { [weak self] state in
        self?.sendEvent("onSpeechState", ["block": state.block.map { $0 as Any } ?? NSNull(), "paused": state.paused])
      }
    }

    Function("isVoiceDownloaded") { (options: SpeechOptionsRecord) in
      try options.validated().isDownloaded
    }

    Function("downloadedBytes") { (model: String) -> Int in
      switch try SpeechModel.parse(model) {
      case .openai: return 0
      case .pocket: return PocketVoice.downloadedBytes
      case .supertonic: return SupertonicVoice.downloadedBytes
      }
    }

    // Every call runs on the main queue in call order, so blocks appended right
    // after `start` reach the session it created.
    AsyncFunction("start") { (options: SpeechOptionsRecord, promise: Promise) in
      let settings = try options.validated()
      let task = MainActor.assumeIsolated { SpeechPlayer.shared.start(settings) }
      Task {
        do { promise.resolve(try await task.value) }
        catch is CancellationError { promise.resolve(false) }
        catch { promise.reject(error) }
      }
    }.runOnQueue(.main)

    AsyncFunction("append") { (blocks: [String]) in
      MainActor.assumeIsolated { SpeechPlayer.shared.append(blocks) }
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

    AsyncFunction("deleteVoice") { (model: String) in
      let model = try SpeechModel.parse(model)
      try MainActor.assumeIsolated { try SpeechPlayer.shared.deleteVoice(model) }
    }.runOnQueue(.main)

    AsyncFunction("playCue") { (cue: String) in
      guard let cue = SpeechCue(rawValue: cue) else { throw SpeechError("Unknown cue: \(cue)") }
      try MainActor.assumeIsolated { try SpeechCues.shared.play(cue) }
    }.runOnQueue(.main)

    AsyncFunction("announce") { (text: String) in
      try MainActor.assumeIsolated { try SpeechCues.shared.announce(text) }
    }.runOnQueue(.main)
  }
}

struct SpeechOptionsRecord: Record {
  @Field(.required) var model: String = ""
  @Field(.required) var voice: String = ""
  @Field(.required) var pace: Float = 1
  @Field(.required) var quality: String = ""
  @Field(.required) var instructions: String = ""
  @Field(.required) var apiKey: String = ""
  @Field(.required) var title: String = ""

  func validated() throws -> SpeechSettings {
    let model = try SpeechModel.parse(model)
    guard pace.isFinite, (0.75...2).contains(pace) else {
      throw SpeechError("Pace must be between 0.75× and 2×.")
    }
    let steps: Int
    switch quality {
    case "fast": steps = model == .pocket ? 1 : 5
    case "balanced": steps = model == .pocket ? 2 : 8
    case "high": steps = model == .pocket ? 4 : 12
    default: throw SpeechError("Unknown speech quality: \(quality)")
    }
    switch model {
    case .openai:
      guard !apiKey.isEmpty else { throw SpeechError("Add your OpenAI API key in Settings → Voice.") }
      guard OpenAiVoice.voices.contains(voice) else { throw SpeechError("Unknown OpenAI voice: \(voice)") }
    case .pocket:
      guard PocketVoice.names.contains(voice) else { throw SpeechError("Unknown Pocket voice: \(voice)") }
    case .supertonic:
      guard SupertonicVoice.voiceNames.contains(voice) else { throw SpeechError("Unknown Supertonic voice: \(voice)") }
    }
    return SpeechSettings(
      model: model, voice: voice, pace: pace, steps: steps,
      instructions: instructions, apiKey: apiKey, title: title
    )
  }
}
