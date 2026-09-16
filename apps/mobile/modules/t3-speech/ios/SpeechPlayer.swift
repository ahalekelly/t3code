import AVFoundation
import Foundation
import PocketTTSRuntime
import T3Supertonic

@MainActor
final class SpeechPlayer {
  static let shared = SpeechPlayer()
  private var operation: (id: UUID, task: Task<Bool, Error>)?
  private var playback: SpeechPlayback?

  func speak(_ text: String, rate: Float, model: SpeechModel) async throws -> Bool {
    guard rate.isFinite, (0.75...2).contains(rate) else {
      throw NSError(domain: "T3Speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Playback speed must be between 0.75× and 2×."])
    }
    await stop()
    let id = UUID()
    let task = Task.detached(priority: .userInitiated) {
      let synthesizer = try await SpeechSynthesizer.prepare(model)
      try Task.checkCancellation()
      let playback = try SpeechPlayback(sampleRate: synthesizer.sampleRate, rate: rate) {
        synthesizer.cancel()
      }
      defer { playback.close() }
      await MainActor.run { self.playback = playback }
      return try await withTaskCancellationHandler {
        do {
          for segment in speechSegments(text, maxLength: synthesizer.segmentLength) {
            try Task.checkCancellation()
            if playback.isCancelled { break }
            try await synthesizer.generate(segment, into: playback)
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
private final class SpeechPlayback: @unchecked Sendable {
  private let cancelGeneration: @Sendable () -> Void
  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let format: AVAudioFormat
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

  init(sampleRate: Double, rate: Float, cancelGeneration: @escaping @Sendable () -> Void) throws {
    self.cancelGeneration = cancelGeneration
    format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
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

  func append(_ data: Data) {
    guard !data.isEmpty else { return }
    condition.lock()
    defer { condition.unlock() }
    // Let synthesis wait while playback catches up, including after a rewind.
    while !cancelled && writtenFrames - completedFrames >= Int64(format.sampleRate * 4) { condition.wait() }
    guard !cancelled else { return }
    do {
      try cache.seek(toOffset: UInt64(writtenFrames) * 4)
      try cache.write(contentsOf: data)
      writtenFrames += Int64(data.count / 4)
      try scheduleBuffers()
    } catch {
      fail(error)
    }
  }

  // Called with the condition locked. Completion work leaves the audio callback
  // before taking the lock, so stopping the node cannot deadlock with a callback.
  private func scheduleBuffers() throws {
    while pendingBuffers < 8 && scheduledFrames < writtenFrames {
      let count = Int(min(Int64(format.sampleRate / 2), writtenFrames - scheduledFrames))
      try cache.seek(toOffset: UInt64(scheduledFrames) * 4)
      guard let data = try cache.read(upToCount: count * 4), data.count == count * 4 else {
        throw NSError(domain: "T3Speech", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not read cached speech audio."])
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
    let target = max(0, position - Int64(format.sampleRate * 10))
    epoch += 1
    player.stop()
    pendingBuffers = 0
    scheduledFrames = target
    completedFrames = target
    timelineStart = target
    do { try scheduleBuffers() }
    catch { fail(error); throw error }
  }

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
    cancelGeneration()
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


enum SpeechModel: String {
  case pocket, supertonic

  static func parse(_ value: String) throws -> SpeechModel {
    guard let model = SpeechModel(rawValue: value) else {
      throw SpeechError("Unknown speech model: \(value)")
    }
    return model
  }

  var isDownloaded: Bool {
    switch self {
    case .pocket: return PocketVoice.isDownloaded
    case .supertonic: return SupertonicVoice.isDownloaded
    }
  }
}

// The Pocket runtime supports concurrent cancellation; generation stays serial.
private enum SpeechSynthesizer: @unchecked Sendable {
  case pocket(PocketTtsEngine)
  case supertonic(SupertonicVoice)

  // Supertonic returns a whole segment; keep its first audio and cancellation prompt.
  var segmentLength: Int {
    switch self {
    case .pocket: return 400
    case .supertonic: return 110
    }
  }

  var sampleRate: Double {
    switch self {
    case .pocket: return 24_000
    case .supertonic: return 44_100
    }
  }

  static func prepare(_ model: SpeechModel) async throws -> SpeechSynthesizer {
    switch model {
    case .pocket:
      let directory = try await PocketVoice.prepare()
      try Task.checkCancellation()
      let engine = try PocketTtsEngine(modelPath: directory.path)
      try engine.configure(config: TtsConfig(
        voiceIndex: 0, temperature: 0.7, topP: 0.9, speed: 1,
        consistencySteps: 2, useFixedSeed: false, seed: 42
      ))
      return .pocket(engine)
    case .supertonic:
      return .supertonic(try await SupertonicVoice.prepare())
    }
  }

  func generate(_ text: String, into playback: SpeechPlayback) async throws {
    switch self {
    case .pocket(let engine):
      try engine.startTrueStreaming(text: text, handler: PocketChunks(playback))
    case .supertonic(let voice):
      let samples = try await voice.synthesize(text)
      samples.withUnsafeBytes { playback.append(Data($0)) }
    }
  }

  func cancel() {
    if case .pocket(let engine) = self { engine.cancel() }
  }
}

private final class PocketChunks: TtsEventHandler, @unchecked Sendable {
  private let playback: SpeechPlayback
  init(_ playback: SpeechPlayback) { self.playback = playback }
  func onAudioChunk(chunk: AudioChunk) { playback.append(chunk.audioData) }
  func onProgress(progress: Float) {}
  func onComplete() {}
  // startTrueStreaming throws the synthesis error to its caller.
  func onError(message: String) {}
}

struct SpeechError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
