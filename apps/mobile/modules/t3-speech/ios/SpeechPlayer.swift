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
  private var current: (id: UUID, session: SpeechSession, task: Task<Bool, Error>, model: SpeechModel)?
  var isReading: Bool { current != nil }

  /// Resolves `true` when the reading played to the end, `false` when it was stopped.
  func start(_ settings: SpeechSettings, onState: @escaping @MainActor (SpeechState) -> Void) -> Task<Bool, Error> {
    let previous = current
    previous?.session.cancel()
    let id = UUID()
    let session = SpeechSession(settings: settings) { [weak self] state in
      Task { @MainActor in
        guard let self, self.current?.id == id else { return }
        RemoteControls.update(paused: state.paused)
        onState(state)
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

  func append(_ blocks: [String], from index: Int) { current?.session.append(blocks, from: index) }
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
/// audio instead of regenerating it. All state is guarded by `condition`; every
/// state change calls `signal()`, which wakes both async and blocking waiters.
private final class SpeechSession: @unchecked Sendable {
  private let settings: SpeechSettings
  private let onState: @Sendable (SpeechState) -> Void
  private let condition = NSCondition()
  private var changes = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
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
  /// Blocks from `contiguousFrom` up to the one being generated play back to back in
  /// the cache, starting at `runStart`.
  private var contiguousFrom = 0
  private var runStart: Int64 = 0
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
      while let (index, text, generation) = await takeBlock() {
        markStart(of: index, generation: generation)
        for segment in speechSegments(text, maxLength: synthesizer.segmentLength) {
          guard isCurrent(generation) else { break }
          do {
            try await synthesizer.generate(segment, into: self, generation: generation)
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

  /// Replaces the blocks from `index`. A changed block that was already generated is
  /// read again from its start.
  func append(_ texts: [String], from index: Int) {
    condition.withLock {
      blocks = Array(blocks.prefix(index)) + texts
      generationIdle = false
      if index < nextIndex { regenerateLocked(from: index) }
      signal()
    }
  }

  func finish() {
    condition.withLock {
      inputFinished = true
      signal()
    }
  }

  // Called with the condition locked.
  private func signal() {
    changes += 1
    for waiter in waiters { waiter.resume() }
    waiters = []
    condition.broadcast()
  }

  /// Returns once `signal()` has run since the caller read `changes`.
  private func changed(since seen: Int) async {
    await withCheckedContinuation { continuation in
      condition.withLock {
        if changes == seen { waiters.append(continuation) } else { continuation.resume() }
      }
    }
  }

  /// Waits for the next block to generate. Returns nil once playback has ended.
  private func takeBlock() async -> (Int, String, Int)? {
    while true {
      let (next, seen): ((Int, String, Int)??, Int) = condition.withLock {
        if cancelled || ended { return (.some(nil), changes) }
        if nextIndex < blocks.count {
          nextIndex += 1
          return (.some((nextIndex - 1, blocks[nextIndex - 1], generation)), changes)
        }
        if inputFinished && !generationIdle {
          generationIdle = true
          endIfDrained()
          if ended { return (.some(nil), changes) }
        }
        return (nil, changes)
      }
      if let next { return next }
      await changed(since: seen)
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

  /// Returns false when generation should stop: the session ended or jumped to another
  /// block. Waits while playback catches up, including after a rewind or pause.
  func append(_ data: Data, generation: Int) async -> Bool {
    while true {
      let (written, seen) = condition.withLock { (write(data, generation: generation), changes) }
      if let written { return written }
      await changed(since: seen)
    }
  }

  /// `append` for synthesizers that deliver audio on their own thread.
  func appendBlocking(_ data: Data, generation: Int) -> Bool {
    condition.withLock {
      while true {
        if let written = write(data, generation: generation) { return written }
        condition.wait()
      }
    }
  }

  /// Called with the condition locked; returns nil while the lookahead is full.
  private func write(_ data: Data, generation: Int) -> Bool? {
    guard !cancelled, generation == self.generation, let cache else { return false }
    guard !data.isEmpty else { return true }
    guard writtenFrames - completedFrames < lookaheadFrames else { return nil }
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
      let target = max(runStart, (paused ? resumeFrame : position()) - Int64(format.sampleRate * 10))
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
        publishedBlock = block
        onState(SpeechState(block: block, paused: paused))
      } else {
        regenerateLocked(from: block)
      }
    }
  }

  /// Generates again from this block and drops the audio queued after the playhead.
  private func regenerateLocked(from block: Int) {
    generation += 1
    nextIndex = block
    contiguousFrom = block
    runStart = writtenFrames
    generationIdle = false
    if paused { resumeFrame = writtenFrames } else { seekLocked(to: writtenFrames) }
    publishedBlock = block
    onState(SpeechState(block: block, paused: paused))
    signal()
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
    case .rewound: resumeFrame = max(runStart, position - Int64(format.sampleRate * 2))
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
    signal()
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
    signal()
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
    signal()
  }

  private func endIfDrained() {
    guard !paused, generationIdle, pendingBuffers == 0, scheduledFrames == writtenFrames else { return }
    ended = true
    signal()
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
    signal()
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

  /// Appends Float32 mono samples to the session until it stops accepting them.
  func generate(_ text: String, into session: SpeechSession, generation: Int) async throws {
    switch self {
    case .openai(let voice):
      try await voice.generate(text) { await session.append($0, generation: generation) }
    case .pocket(let engine):
      try engine.startTrueStreaming(text: text, handler: PocketChunks { session.appendBlocking($0, generation: generation) })
    case .supertonic(let voice, _):
      let samples = try await voice.synthesize(text)
      _ = await session.append(samples.withUnsafeBytes { Data($0) }, generation: generation)
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
