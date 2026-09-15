import ExpoModulesCore

public class T3PocketSpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3PocketSpeech")

    Function("isVoiceDownloaded") { PocketVoice.isDownloaded }

    AsyncFunction("speak") { (text: String, rate: Float, promise: Promise) in
      Task { @MainActor in
        do {
          let completed = try await PocketSpeechPlayer.shared.speak(text, rate: rate)
          promise.resolve(completed)
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("rewind") { (promise: Promise) in
      Task { @MainActor in
        do {
          try PocketSpeechPlayer.shared.rewind()
          promise.resolve()
        } catch {
          promise.reject(error)
        }
      }
    }

    AsyncFunction("stop") { (promise: Promise) in
      Task { @MainActor in
        await PocketSpeechPlayer.shared.stop()
        promise.resolve()
      }
    }
  }
}
