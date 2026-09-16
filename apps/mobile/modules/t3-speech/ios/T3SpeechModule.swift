import ExpoModulesCore

public class T3SpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3Speech")

    Function("isVoiceDownloaded") { (model: String) in
      try SpeechModel.parse(model).isDownloaded
    }

    AsyncFunction("speak") { (text: String, rate: Float, model: String, promise: Promise) in
      Task { @MainActor in
        do {
          let completed = try await SpeechPlayer.shared.speak(text, rate: rate, model: SpeechModel.parse(model))
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
