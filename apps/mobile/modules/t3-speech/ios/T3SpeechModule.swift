import AVFoundation
import ExpoModulesCore

public class T3SpeechModule: Module {
  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("T3Speech")

    Events("onSpeechState", "onAudioDevicesChange")

    OnCreate {
      routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] _ in self?.sendEvent("onAudioDevicesChange") }
    }

    OnDestroy {
      if let routeObserver { NotificationCenter.default.removeObserver(routeObserver) }
    }

    // Every call runs on the main queue in call order, so blocks appended right
    // after `start` reach the session it created. Events carry the caller's
    // `reading` id, so a late event from a replaced reading can be told apart.
    AsyncFunction("start") { (options: SpeechOptionsRecord, reading: String, promise: Promise) in
      let settings: SpeechSettings
      do { settings = try options.validated() } catch {
        // Text sent for this reading must not reach the one it replaces.
        MainActor.assumeIsolated { SpeechPlayer.shared.end() }
        throw error
      }
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

    AsyncFunction("beginBackgroundTask") { (name: String) -> Int in
      MainActor.assumeIsolated { BackgroundTasks.begin(name) }
    }.runOnQueue(.main)

    AsyncFunction("endBackgroundTask") { (task: Int) in
      MainActor.assumeIsolated { BackgroundTasks.end(task) }
    }.runOnQueue(.main)

    // Playback routes list a car's A2DP output; recording routes list its HFP input instead.
    Function("audioDevices") { () -> [String: Any] in
      let session = AVAudioSession.sharedInstance()
      let ports = session.currentRoute.outputs + (session.availableInputs ?? [])
      let bluetooth: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE]
      var devices: [String: String] = [:]
      for port in ports where bluetooth.contains(port.portType) {
        // A device's A2DP and HFP port UIDs share its address before the profile suffix.
        devices[String(port.uid.prefix { $0 != "-" })] = port.portName
      }
      return [
        "carPlay": ports.contains { $0.portType == .carAudio },
        "devices": devices.map { ["id": $0.key, "name": $0.value] },
      ]
    }
  }
}

struct SpeechOptionsRecord: Record {
  @Field(.required) var provider: String = ""
  @Field(.required) var model: String = ""
  @Field(.required) var voice: String = ""
  @Field(.required) var pace: Float = 1
  @Field(.required) var instructions: String = ""
  @Field(.required) var apiKeys: [String] = []
  @Field(.required) var title: String = ""

  func validated() throws -> SpeechSettings {
    guard pace.isFinite, (0.75...2).contains(pace) else {
      throw SpeechError("Pace must be between 0.75× and 2×.")
    }
    guard let provider = CloudVoice.Provider(rawValue: provider) else { throw SpeechError("Unknown speech provider: \(provider)") }
    guard !apiKeys.isEmpty else { throw SpeechError("Add your \(provider.label) API key in Settings → Voice.") }
    guard !voice.isEmpty else { throw SpeechError("Choose a voice for \(provider.label) in Settings → Voice.") }
    let voice = CloudVoice(provider: provider, model: model, apiKeys: apiKeys, voice: voice, instructions: instructions)
    return SpeechSettings(voice: voice, pace: pace, title: title)
  }
}
