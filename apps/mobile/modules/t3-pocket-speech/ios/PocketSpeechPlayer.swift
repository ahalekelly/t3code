import AVFoundation
import Foundation
import PocketTTSRuntime

@MainActor
final class PocketSpeechPlayer {
  static let shared = PocketSpeechPlayer()
  private var operation: (id: UUID, task: Task<Void, Error>)?

  func speak(_ text: String) async throws {
    await stop()
    let id = UUID()
    let task = Task.detached(priority: .userInitiated) {
      let directory = try await PocketVoice.prepare()
      try Task.checkCancellation()
      let engine = try PocketTtsEngine(modelPath: directory.path)
      try Task.checkCancellation()
      try engine.configure(config: TtsConfig(
        voiceIndex: 0, temperature: 0.7, topP: 0.9, speed: 1,
        consistencySteps: 2, useFixedSeed: false, seed: 42
      ))
      let playback = try SpeechPlayback(engine: engine)
      defer { playback.close() }
      try await withTaskCancellationHandler {
        for segment in pocketSpeechSegments(text) {
          try Task.checkCancellation()
          if playback.isCancelled { break }
          try engine.startTrueStreaming(text: segment, handler: playback)
        }
        playback.finishGeneration()
        playback.waitForPlayback()
        try Task.checkCancellation()
      } onCancel: {
        playback.cancel()
      }
    }
    operation = (id, task)
    defer { if operation?.id == id { operation = nil } }
    do { try await task.value }
    catch is CancellationError { }
  }

  func stop() async {
    guard let operation else { return }
    operation.task.cancel()
    _ = await operation.task.result
  }
}

/// Keeps at most eight generated chunks queued and resolves after the last plays.
private final class SpeechPlayback: TtsEventHandler, @unchecked Sendable {
  private let synthesizer: PocketTtsEngine
  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
  private let lock = NSLock()
  private let capacity = DispatchSemaphore(value: 8)
  private let finished = DispatchSemaphore(value: 0)
  private var cancelled = false
  private var generationFinished = false
  private var pendingBuffers = 0
  private var observers: [NSObjectProtocol] = []

  var isCancelled: Bool { lock.withLock { cancelled } }

  init(engine: PocketTtsEngine) throws {
    synthesizer = engine
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
    audioEngine.attach(player)
    audioEngine.connect(player, to: audioEngine.mainMixerNode, format: format)
    do { try audioEngine.start() }
    catch {
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      throw error
    }
    observers = [
      NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] notification in
        if notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue { self?.cancel() }
      },
      NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] notification in
        if notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { self?.cancel() }
      },
    ]
  }

  func onAudioChunk(chunk: AudioChunk) {
    guard !chunk.audioData.isEmpty else { return }
    capacity.wait()
    lock.lock()
    if cancelled {
      lock.unlock()
      capacity.signal()
      synthesizer.cancel()
      return
    }
    let count = chunk.audioData.count / MemoryLayout<Float>.size
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
    buffer.frameLength = buffer.frameCapacity
    _ = chunk.audioData.withUnsafeBytes { bytes in
      memcpy(buffer.floatChannelData![0], bytes.baseAddress!, chunk.audioData.count)
    }
    pendingBuffers += 1
    player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
      guard let self else { return }
      self.lock.lock()
      self.pendingBuffers -= 1
      if self.pendingBuffers == 0 && self.generationFinished { self.finished.signal() }
      self.lock.unlock()
      self.capacity.signal()
    }
    if !player.isPlaying { player.play() }
    lock.unlock()
  }

  func onProgress(progress: Float) {}
  func onComplete() {}
  // startTrueStreaming also throws the synthesis error to its caller.
  func onError(message: String) {}

  func finishGeneration() {
    lock.lock()
    generationFinished = true
    if pendingBuffers == 0 { finished.signal() }
    lock.unlock()
  }

  func waitForPlayback() { finished.wait() }

  func cancel() {
    lock.lock()
    cancelled = true
    lock.unlock()
    synthesizer.cancel()
    player.stop()
    for _ in 0..<8 { capacity.signal() }
    finished.signal()
  }

  func close() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    player.stop()
    audioEngine.stop()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
