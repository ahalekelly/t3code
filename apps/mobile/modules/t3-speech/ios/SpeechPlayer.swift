import AVFoundation
import Foundation
import MediaPlayer
import PocketTTSRuntime
import T3Supertonic

struct SpeechState: Sendable {
  let block: Int?
  let paused: Bool
}

/// One reading at a time. JS appends the response's paragraphs ("blocks") as they
/// complete; the session generates them in order and plays them as audio arrives.
@MainActor
final class SpeechPlayer {
  static let shared = SpeechPlayer()
  var onState: (SpeechState) -> Void = { _ in }
  private var current: (id: UUID, session: SpeechSession, task: Task<Bool, Error>, model: SpeechModel)?
  var isReading: Bool { current != nil }

  /// Resolves `true` when the reading played to the end, `false` when it was stopped.
  func start(_ settings: SpeechSettings) -> Task<Bool, Error> {
    let previous = current
    previous?.session.cancel()
    let id = UUID()
    let session = SpeechSession(settings: settings) { [weak self] state in
      Task { @MainActor in
        if let self, self.current?.id == id { self.publish(state) }
      }
    }
    previous?.task.cancel()
    let task = Task.detached(priority: .userInitiated) {
      _ = await previous?.task.result
      return try await session.run()
    }
    current = (id, session, task, settings.model)
    RemoteControls.attach(title: settings.title)
    Task { @MainActor in
      _ = await task.result
      if self.current?.id == id {
        self.current = nil
        RemoteControls.detach()
      }
    }
    return task
  }

  func append(_ blocks: [String]) { current?.session.append(blocks) }
  func finish() { current?.session.finish() }
  func rewind() { current?.session.rewind() }
  func nextBlock() { current?.session.nextBlock() }
  func seek(toBlock block: Int) { current?.session.seek(toBlock: block) }
  func pause() { current?.session.pause(resumeFrom: .position) }
  func resume() { current?.session.resume() }
  func togglePause() { current?.session.togglePause() }
  func setPace(_ pace: Float) { current?.session.setPace(pace) }

  func stop() async {
    guard let current else { return }
    current.session.cancel()
    current.task.cancel()
    _ = await current.task.result
  }

  func deleteVoice(_ model: SpeechModel) throws {
    guard current?.model != model else { throw SpeechError("Stop reading before deleting this voice.") }
    switch model {
    case .pocket: try PocketVoice.delete()
    case .supertonic: try SupertonicVoice.delete()
    case .openai: throw SpeechError("OpenAI voices have no downloaded files.")
    }
  }

  private func publish(_ state: SpeechState) {
    RemoteControls.update(paused: state.paused)
    onState(state)
  }
}

/// Headphone, steering-wheel, and Lock Screen buttons: previous rewinds 10 seconds,
/// next skips to the next paragraph.
@MainActor
private enum RemoteControls {
  static func attach(title: String) {
    let center = MPRemoteCommandCenter.shared()
    detachTargets(center)
    let player = SpeechPlayer.shared
    center.playCommand.addTarget { _ in player.resume(); return .success }
    center.pauseCommand.addTarget { _ in player.pause(); return .success }
    center.togglePlayPauseCommand.addTarget { _ in player.togglePause(); return .success }
    center.skipBackwardCommand.preferredIntervals = [10]
    center.skipBackwardCommand.addTarget { _ in player.rewind(); return .success }
    center.previousTrackCommand.addTarget { _ in player.rewind(); return .success }
    center.nextTrackCommand.addTarget { _ in player.nextBlock(); return .success }
    center.skipForwardCommand.isEnabled = false
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle: title,
      MPMediaItemPropertyArtist: "T3 Code",
      MPNowPlayingInfoPropertyPlaybackRate: 1.0,
    ]
  }

  static func update(paused: Bool) {
    MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPNowPlayingInfoPropertyPlaybackRate] = paused ? 0.0 : 1.0
  }

  static func detach() {
    detachTargets(MPRemoteCommandCenter.shared())
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  private static func detachTargets(_ center: MPRemoteCommandCenter) {
    for command in [center.playCommand, center.pauseCommand, center.togglePlayPauseCommand,
                    center.skipBackwardCommand, center.previousTrackCommand, center.nextTrackCommand] {
      command.removeTarget(nil)
    }
  }
}

private enum ResumePoint {
  case position, blockStart, rewound
}

/// Generates queued blocks through a bounded playback queue. Every generated sample
/// goes to a temporary PCM file, so rewinding and seeking to earlier blocks replay
/// audio instead of regenerating it. All state is guarded by `condition`.
private final class SpeechSession: @unchecked Sendable {
  private let settings: SpeechSettings
  private let onState: @Sendable (SpeechState) -> Void
  private let condition = NSCondition()
  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent("t3-speech-\(UUID()).pcm")
  private var format: AVAudioFormat?
  private var cache: FileHandle?
  private var synthesizer: SpeechSynthesizer?
  private var pace: Float
  private var observers: [NSObjectProtocol] = []

  // Input and generation.
  private var blocks: [String] = []
  private var inputFinished = false
  private var nextIndex = 0
  /// Bumped when generation jumps to another block; audio from an older generation is dropped.
  private var generation = 0
  private var generationIdle = false
  /// Blocks from `contiguousFrom` up to the one being generated play back to back in the cache.
  private var contiguousFrom = 0
  /// Where each generated block starts in the cache, in cache order.
  private var marks: [(frame: Int64, block: Int)] = []

  // Playback timeline, in frames of the cache.
  private var writtenFrames: Int64 = 0
  private var scheduledFrames: Int64 = 0
  private var completedFrames: Int64 = 0
  private var timelineStart: Int64 = 0
  private var epoch = 0
  private var pendingBuffers = 0
  private var lookaheadFrames: Int64 = 0
  private var paused = false
  /// Set while an interruption holds the reading, so its end resumes only that pause.
  private var interrupted = false
  private var resumeFrame: Int64 = 0
  private var publishedBlock: Int?

  private var cancelled = false
  private var ended = false
  private var failure: Error?

  init(settings: SpeechSettings, onState: @escaping @Sendable (SpeechState) -> Void) {
    self.settings = settings
    self.onState = onState
    pace = settings.pace
  }

  func run() async throws -> Bool {
    let synthesizer: SpeechSynthesizer
    do { synthesizer = try await SpeechSynthesizer.prepare(settings) }
    catch is CancellationError { return false }
    defer { close() }
    let opened = try condition.withLock {
      if cancelled { return false }
      self.synthesizer = synthesizer
      try openAudio(sampleRate: synthesizer.sampleRate, lookahead: synthesizer.lookaheadFrames)
      return true
    }
    guard opened else { return false }
    return try await withTaskCancellationHandler {
      while let (index, text, generation) = takeBlock() {
        markStart(of: index, generation: generation)
        for segment in speechSegments(text, maxLength: synthesizer.segmentLength) {
          guard isCurrent(generation) else { break }
          do {
            try await synthesizer.generate(segment) { self.append($0, generation: generation) }
          } catch {
            if isCurrent(generation) { throw error }
          }
        }
      }
      if let failure = condition.withLock({ failure }) { throw failure }
      return condition.withLock { !cancelled }
    } onCancel: {
      cancel()
    }
  }

  // MARK: Input

  func append(_ texts: [String]) {
    condition.withLock {
      blocks += texts
      generationIdle = false
      condition.broadcast()
    }
  }

  func finish() {
    condition.withLock {
      inputFinished = true
      condition.broadcast()
    }
  }

  /// Waits for the next block to generate. Returns nil once playback has ended.
  private func takeBlock() -> (Int, String, Int)? {
    condition.lock()
    defer { condition.unlock() }
    while true {
      if cancelled || ended { return nil }
      if nextIndex < blocks.count {
        let index = nextIndex
        nextIndex += 1
        return (index, blocks[index], generation)
      }
      if inputFinished && !generationIdle {
        generationIdle = true
        endIfDrained()
        continue
      }
      condition.wait()
    }
  }

  private func isCurrent(_ generation: Int) -> Bool {
    condition.withLock { !cancelled && generation == self.generation }
  }

  private func markStart(of block: Int, generation: Int) {
    condition.withLock {
      guard generation == self.generation else { return }
      marks.append((writtenFrames, block))
    }
  }

  /// Returns false when generation should stop: the session ended or jumped to another block.
  private func append(_ data: Data, generation: Int) -> Bool {
    guard !data.isEmpty else { return true }
    condition.lock()
    defer { condition.unlock() }
    // Let synthesis wait while playback catches up, including after a rewind or pause.
    while !cancelled && generation == self.generation && writtenFrames - completedFrames >= lookaheadFrames {
      condition.wait()
    }
    guard !cancelled, generation == self.generation else { return false }
    guard let cache else { return false }
    do {
      try cache.seek(toOffset: UInt64(writtenFrames) * 4)
      try cache.write(contentsOf: data)
      writtenFrames += Int64(data.count / 4)
      try scheduleBuffers()
    } catch {
      fail(error)
      return false
    }
    return true
  }

  // MARK: Controls

  func rewind() {
    condition.withLock {
      guard let format, !cancelled, !ended else { return }
      let target = max(0, (paused ? resumeFrame : position()) - Int64(format.sampleRate * 10))
      if paused { resumeFrame = target } else { seekLocked(to: target) }
      publishBlock(at: target)
    }
  }

  func nextBlock() {
    let block = condition.withLock { currentBlock() }
    seek(toBlock: (block ?? -1) + 1)
  }

  func seek(toBlock block: Int) {
    condition.withLock {
      guard format != nil, !cancelled, !ended, block >= 0 else { return }
      if block >= contiguousFrom, block < nextIndex, let start = marks.last(where: { $0.block == block })?.frame {
        if paused { resumeFrame = start } else { seekLocked(to: start) }
      } else {
        // Regenerate from this block and drop the audio queued after the playhead.
        generation += 1
        nextIndex = block
        contiguousFrom = block
        generationIdle = false
        if paused { resumeFrame = writtenFrames } else { seekLocked(to: writtenFrames) }
        condition.broadcast()
      }
      publishedBlock = block
      onState(SpeechState(block: block, paused: paused))
    }
  }

  func pause(resumeFrom point: ResumePoint) {
    condition.withLock {
      interrupted = false
      pauseLocked(resumeFrom: point)
    }
  }

  func resume() {
    condition.withLock { resumeLocked() }
  }

  private func interruptionBegan() {
    condition.withLock {
      guard !paused else { return }
      pauseLocked(resumeFrom: .rewound)
      interrupted = paused
    }
  }

  private func interruptionEnded(shouldResume: Bool) {
    condition.withLock {
      if interrupted && shouldResume { resumeLocked() }
      interrupted = false
    }
  }

  func togglePause() {
    condition.withLock {
      if paused { resumeLocked() } else { pauseLocked(resumeFrom: .position) }
    }
  }

  func setPace(_ pace: Float) {
    condition.withLock {
      self.pace = pace
      if let synthesizer { timePitch.rate = pace / synthesizer.synthesisPace }
    }
  }

  private func pauseLocked(resumeFrom point: ResumePoint) {
    guard let format, !cancelled, !ended, !paused else { return }
    let position = position()
    switch point {
    case .position: resumeFrame = position
    case .rewound: resumeFrame = max(0, position - Int64(format.sampleRate * 2))
    case .blockStart: resumeFrame = marks.last(where: { $0.frame <= position })?.frame ?? 0
    }
    paused = true
    epoch += 1
    player.stop()
    pendingBuffers = 0
    scheduledFrames = position
    completedFrames = position
    timelineStart = position
    audioEngine.pause()
    onState(SpeechState(block: publishedBlock, paused: true))
    condition.broadcast()
  }

  private func resumeLocked() {
    guard !cancelled, !ended, paused else { return }
    paused = false
    interrupted = false
    do {
      try AVAudioSession.sharedInstance().setActive(true)
      try audioEngine.start()
    } catch { fail(error); return }
    seekLocked(to: resumeFrame)
    publishBlock(at: resumeFrame, force: true)
    endIfDrained()
  }

  // MARK: Playback

  private func openAudio(sampleRate: Double, lookahead: Int64) throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
    self.format = format
    lookaheadFrames = lookahead
    try Data().write(to: cacheURL)
    cache = try FileHandle(forUpdating: cacheURL)
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
    timePitch.rate = pace / (synthesizer?.synthesisPace ?? 1)
    audioEngine.attach(player)
    audioEngine.attach(timePitch)
    audioEngine.connect(player, to: timePitch, format: format)
    audioEngine.connect(timePitch, to: audioEngine.mainMixerNode, format: format)
    try audioEngine.start()
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] notification in
        guard let self, let info = notification.userInfo,
              let type = (info[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) else { return }
        // Navigation prompts and calls pause the reading; it resumes when iOS says so.
        if type == .began { self.interruptionBegan(); return }
        let options = AVAudioSession.InterruptionOptions(rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
        self.interruptionEnded(shouldResume: options.contains(.shouldResume))
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] notification in
        // Headphones removed or disconnected: pause, and resume at the paragraph's start.
        if notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
          self?.pause(resumeFrom: .blockStart)
        }
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: nil) { [weak self] _ in
        self?.restartEngine()
      },
    ]
  }

  /// A new output route (Bluetooth connecting, a sample-rate change) stops the engine.
  private func restartEngine() {
    condition.withLock {
      guard format != nil, !cancelled, !ended, !paused else { return }
      let position = position()
      do { try audioEngine.start() } catch { fail(error); return }
      seekLocked(to: position)
    }
  }

  // Called with the condition locked. Completion work leaves the audio callback
  // before taking the lock, so stopping the node cannot deadlock with a callback.
  private func scheduleBuffers() throws {
    guard let format, let cache, !paused else { return }
    while pendingBuffers < 8 && scheduledFrames < writtenFrames {
      let count = Int(min(Int64(format.sampleRate / 2), writtenFrames - scheduledFrames))
      try cache.seek(toOffset: UInt64(scheduledFrames) * 4)
      guard let data = try cache.read(upToCount: count * 4), data.count == count * 4 else {
        throw SpeechError("Could not read cached speech audio.")
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
      endIfDrained()
    }
    publishBlock(at: position())
    condition.broadcast()
  }

  private func seekLocked(to target: Int64) {
    epoch += 1
    player.stop()
    pendingBuffers = 0
    scheduledFrames = min(target, writtenFrames)
    completedFrames = scheduledFrames
    timelineStart = scheduledFrames
    do { try scheduleBuffers() }
    catch { fail(error) }
    condition.broadcast()
  }

  private func endIfDrained() {
    guard !paused, generationIdle, pendingBuffers == 0, scheduledFrames == writtenFrames else { return }
    ended = true
    condition.broadcast()
  }

  private func position() -> Int64 {
    let elapsed = player.lastRenderTime.flatMap { player.playerTime(forNodeTime: $0) }?.sampleTime ?? 0
    return min(scheduledFrames, max(completedFrames, timelineStart + elapsed))
  }

  private func currentBlock() -> Int? {
    let position = paused ? resumeFrame : position()
    return marks.last(where: { $0.frame <= position })?.block
  }

  private func publishBlock(at frame: Int64, force: Bool = false) {
    let block = marks.last(where: { $0.frame <= frame })?.block
    guard force || block != publishedBlock else { return }
    publishedBlock = block
    onState(SpeechState(block: block, paused: paused))
  }

  // MARK: Lifecycle

  private func fail(_ error: Error) {
    failure = error
    cancelLocked()
  }

  private func cancelLocked() {
    cancelled = true
    synthesizer?.cancel()
    player.stop()
    condition.broadcast()
  }

  func cancel() {
    condition.withLock { cancelLocked() }
  }

  private func close() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    condition.withLock {
      cancelled = true
      player.stop()
      audioEngine.stop()
      try? cache?.close()
      try? FileManager.default.removeItem(at: cacheURL)
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

enum SpeechModel: String, Sendable {
  case openai, pocket, supertonic

  static func parse(_ value: String) throws -> SpeechModel {
    guard let model = SpeechModel(rawValue: value) else {
      throw SpeechError("Unknown speech model: \(value)")
    }
    return model
  }
}

struct SpeechSettings: Sendable {
  let model: SpeechModel
  let voice: String
  let pace: Float
  let steps: Int
  let instructions: String
  let apiKey: String
  let title: String

  var isDownloaded: Bool {
    switch model {
    case .openai: return true
    case .pocket: return PocketVoice.isDownloaded
    case .supertonic: return SupertonicVoice.isDownloaded(voice: voice)
    }
  }
}

// The Pocket runtime supports concurrent cancellation; generation stays serial.
private enum SpeechSynthesizer: @unchecked Sendable {
  case openai(OpenAiVoice)
  case pocket(PocketTtsEngine)
  case supertonic(SupertonicVoice, pace: Float)

  // Supertonic returns a whole segment; keep its first audio and cancellation prompt.
  var segmentLength: Int {
    switch self {
    case .openai: return OpenAiVoice.segmentLength
    case .pocket: return 400
    case .supertonic: return 110
    }
  }

  var sampleRate: Double {
    switch self {
    case .openai: return OpenAiVoice.sampleRate
    case .pocket: return 24_000
    case .supertonic: return 44_100
    }
  }

  /// OpenAI works further ahead so a slow response or brief coverage gap stays silent-free.
  var lookaheadFrames: Int64 {
    switch self {
    case .openai: return Int64(sampleRate * 15)
    case .pocket, .supertonic: return Int64(sampleRate * 4)
    }
  }

  /// Supertonic speaks at the chosen pace; the others generate at 1× and play faster.
  var synthesisPace: Float {
    if case .supertonic(_, let pace) = self { return pace }
    return 1
  }

  static func prepare(_ settings: SpeechSettings) async throws -> SpeechSynthesizer {
    switch settings.model {
    case .openai:
      return .openai(OpenAiVoice(apiKey: settings.apiKey, voice: settings.voice, instructions: settings.instructions))
    case .pocket:
      let directory = try await PocketVoice.prepare()
      try Task.checkCancellation()
      let engine = try PocketTtsEngine(modelPath: directory.path)
      try engine.configure(config: TtsConfig(
        voiceIndex: UInt32(PocketVoice.names.firstIndex(of: settings.voice)!), temperature: 0.7, topP: 0.9, speed: 1,
        consistencySteps: UInt32(settings.steps), useFixedSeed: false, seed: 42
      ))
      return .pocket(engine)
    case .supertonic:
      let voice = try await SupertonicVoice.prepare(voice: settings.voice, pace: settings.pace, steps: settings.steps)
      return .supertonic(voice, pace: settings.pace)
    }
  }

  /// Delivers Float32 mono samples to `append` until it returns false.
  func generate(_ text: String, append: @escaping @Sendable (Data) -> Bool) async throws {
    switch self {
    case .openai(let voice):
      try await voice.generate(text, append: append)
    case .pocket(let engine):
      try engine.startTrueStreaming(text: text, handler: PocketChunks(append))
    case .supertonic(let voice, _):
      let samples = try await voice.synthesize(text)
      _ = samples.withUnsafeBytes { append(Data($0)) }
    }
  }

  func cancel() {
    if case .pocket(let engine) = self { engine.cancel() }
  }
}

private final class PocketChunks: TtsEventHandler, @unchecked Sendable {
  private let append: @Sendable (Data) -> Bool
  init(_ append: @escaping @Sendable (Data) -> Bool) { self.append = append }
  // The runtime cannot stop mid-segment for a seek; the session drops the stale audio.
  func onAudioChunk(chunk: AudioChunk) { _ = append(chunk.audioData) }
  func onProgress(progress: Float) {}
  func onComplete() {}
  // startTrueStreaming throws the synthesis error to its caller.
  func onError(message: String) {}
}

struct SpeechError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
