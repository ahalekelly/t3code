import ExpoModulesCore

public class T3PocketSpeechModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3PocketSpeech")

    Function("isVoiceDownloaded") { PocketVoice.isDownloaded }

    AsyncFunction("speak") { (text: String, promise: Promise) in
      Task { @MainActor in
        do {
          try await PocketSpeechPlayer.shared.speak(text)
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
