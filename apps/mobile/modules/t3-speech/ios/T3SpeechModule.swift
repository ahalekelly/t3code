import ExpoModulesCore
import T3Supertonic

public class T3SpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Speech")

    Function("isVoiceDownloaded") { (options: SpeechOptionsRecord) in
      try options.validated().isDownloaded
    }

    AsyncFunction("speak") { (text: String, options: SpeechOptionsRecord, promise: Promise) in
      let settings = try options.validated()
      Task { @MainActor in
        do {
          let completed = try await SpeechPlayer.shared.speak(text, settings: settings)
          promise.resolve(completed)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("rewind") { (promise: Promise) in
      Task { @MainActor in
        do {
          try SpeechPlayer.shared.rewind()
          promise.resolve()
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      Task { @MainActor in
        await SpeechPlayer.shared.stop()
        promise.resolve()
      }
    }
  }
}

struct SpeechOptionsRecord: Record {
  @Field(.required) var model: String = ""
  @Field(.required) var voice: String = ""
  @Field(.required) var pace: Float = 1
  @Field(.required) var quality: String = ""

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
    case .pocket:
      guard PocketVoice.names.contains(voice) else { throw SpeechError("Unknown Pocket voice: \(voice)") }
    case .supertonic:
      guard SupertonicVoice.voiceNames.contains(voice) else { throw SpeechError("Unknown Supertonic voice: \(voice)") }
    }
    return SpeechSettings(model: model, voice: voice, pace: pace, steps: steps)
  }
}
