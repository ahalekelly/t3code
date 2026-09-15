import AVFoundation
import Foundation
import PocketTTSRuntime

@MainActor
final class PocketSpeechPlayer {
  static let shared = PocketSpeechPlayer()
  private var operation: (id: UUID, task: Task<Bool, Error>)?
  private var playback: SpeechPlayback?

  func speak(_ text: String, rate: Float) async throws -> Bool {
    guard rate.isFinite, (0.75...2).contains(rate) else {
      throw NSError(domain: "T3PocketSpeech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Playback speed must be between 0.75× and 2×."])
    }
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
      let playback = try SpeechPlayback(engine: engine, rate: rate)
      defer { playback.close() }
      await MainActor.run { self.playback = playback }
      return try await withTaskCancellationHandler {
        do {
          for segment in pocketSpeechSegments(text) {
            try Task.checkCancellation()
            if playback.isCancelled { break }
            try engine.startTrueStreaming(text: segment, handler: playback)
          }
          playback.finishGeneration()
          try playback.waitForPlayback()
          try Task.checkCancellation()
          return !playback.isCancelled
        } catch {
          if let failure = playback.playbackError { throw failure }
          if playback.isCancelled { return false }
          throw error
        }
      } onCancel: {
        playback.cancel()
      }
    }
    operation = (id, task)
    defer {
      if operation?.id == id {
        operation = nil
        playback = nil
      }
    }
    do { return try await task.value }
    catch is CancellationError { return false }
  }

  func rewind() throws { try playback?.rewind() }

  func stop() async {
    guard let operation else { return }
    operation.task.cancel()
    _ = await operation.task.result
  }
}

/// Streams through a bounded playback queue; a temporary PCM file keeps past audio seekable.
private final class SpeechPlayback: TtsEventHandler, @unchecked Sendable {
  private let synthesizer: PocketTtsEngine
  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let format = AVAudioFormat(standardFormatWithSampleRate: 24_000, channels: 1)!
  private let condition = NSCondition()
  private let finished = DispatchSemaphore(value: 0)
  private let cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent("t3-speech-\(UUID()).pcm")
  private let cache: FileHandle
  private var cancelled = false
  private var generationFinished = false
  private var ended = false
  private var failure: Error?
  private var writtenFrames: Int64 = 0
  private var scheduledFrames: Int64 = 0
  private var completedFrames: Int64 = 0
  private var timelineStart: Int64 = 0
  private var epoch = 0
  private var pendingBuffers = 0
  private var observers: [NSObjectProtocol] = []

  var isCancelled: Bool { condition.withLock { cancelled } }
  var playbackError: Error? { condition.withLock { failure } }

  init(engine: PocketTtsEngine, rate: Float) throws {
    synthesizer = engine
    try Data().write(to: cacheURL)
    cache = try FileHandle(forUpdating: cacheURL)
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio)
      try session.setActive(true)
      timePitch.rate = rate
      audioEngine.attach(player)
      audioEngine.attach(timePitch)
      audioEngine.connect(player, to: timePitch, format: format)
      audioEngine.connect(timePitch, to: audioEngine.mainMixerNode, format: format)
      try audioEngine.start()
    } catch {
      try? cache.close()
      try? FileManager.default.removeItem(at: cacheURL)
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
    condition.lock()
    defer { condition.unlock() }
    // Let synthesis wait while playback catches up, including after a rewind.
    while !cancelled && writtenFrames - completedFrames >= 96_000 { condition.wait() }
    guard !cancelled else { return }
    do {
      try cache.seek(toOffset: UInt64(writtenFrames) * 4)
      try cache.write(contentsOf: chunk.audioData)
      writtenFrames += Int64(chunk.audioData.count / 4)
      try scheduleBuffers()
    } catch {
      fail(error)
    }
  }

  // Called with the condition locked. Completion work leaves the audio callback
  // before taking the lock, so stopping the node cannot deadlock with a callback.
  private func scheduleBuffers() throws {
    while pendingBuffers < 8 && scheduledFrames < writtenFrames {
      let count = Int(min(12_000, writtenFrames - scheduledFrames))
      try cache.seek(toOffset: UInt64(scheduledFrames) * 4)
      guard let data = try cache.read(upToCount: count * 4), data.count == count * 4 else {
        throw NSError(domain: "T3PocketSpeech", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not read cached speech audio."])
      }
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
      buffer.frameLength = buffer.frameCapacity
      _ = data.withUnsafeBytes { memcpy(buffer.floatChannelData![0], $0.baseAddress!, data.count) }
      scheduledFrames += Int64(count)
      pendingBuffers += 1
      let endFrame = scheduledFrames
      let scheduledEpoch = epoch
      player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        DispatchQueue.global(qos: .userInitiated).async { self?.didPlay(endFrame: endFrame, epoch: scheduledEpoch) }
      }
    }
    if pendingBuffers > 0 && !player.isPlaying { player.play() }
  }

  private func didPlay(endFrame: Int64, epoch scheduledEpoch: Int) {
    condition.lock()
    defer { condition.unlock() }
    guard !cancelled, epoch == scheduledEpoch else { return }
    completedFrames = max(completedFrames, endFrame)
    pendingBuffers -= 1
    do { try scheduleBuffers() }
    catch { fail(error); return }
    if pendingBuffers == 0 {
      // Reset an empty timeline so a synthesis gap does not count as played audio.
      epoch += 1
      player.stop()
      timelineStart = completedFrames
      if generationFinished {
        ended = true
        finished.signal()
      }
    }
    condition.broadcast()
  }

  func rewind() throws {
    condition.lock()
    defer { condition.unlock() }
    guard !cancelled, !ended else { return }
    let elapsed = player.lastRenderTime.flatMap { player.playerTime(forNodeTime: $0) }?.sampleTime ?? 0
    let position = min(scheduledFrames, max(completedFrames, timelineStart + elapsed))
    let target = max(0, position - 240_000)
    epoch += 1
    player.stop()
    pendingBuffers = 0
    scheduledFrames = target
    completedFrames = target
    timelineStart = target
    do { try scheduleBuffers() }
    catch { fail(error); throw error }
  }

  func onProgress(progress: Float) {}
  func onComplete() {}
  // startTrueStreaming also throws the synthesis error to its caller.
  func onError(message: String) {}

  func finishGeneration() {
    condition.lock()
    generationFinished = true
    if pendingBuffers == 0 {
      ended = true
      finished.signal()
    }
    condition.unlock()
  }

  func waitForPlayback() throws {
    finished.wait()
    if let failure = playbackError { throw failure }
  }

  private func fail(_ error: Error) {
    failure = error
    cancelLocked()
  }

  private func cancelLocked() {
    cancelled = true
    synthesizer.cancel()
    player.stop()
    condition.broadcast()
    finished.signal()
  }

  func cancel() {
    condition.lock()
    cancelLocked()
    condition.unlock()
  }

  func close() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    condition.lock()
    cancelled = true
    player.stop()
    audioEngine.stop()
    try? cache.close()
    try? FileManager.default.removeItem(at: cacheURL)
    condition.unlock()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}
