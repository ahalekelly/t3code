import AVFoundation
import Foundation
import MediaPlayer
import os

/// Playback diagnostics. Read them with Console.app on a Mac, filtered to subsystem T3Speech.
let speechLog = Logger(subsystem: "T3Speech", category: "playback")

struct SpeechState: Sendable {
  let block: Int?
  let paused: Bool
}

/// One reading at a time. JS appends the response's paragraphs ("blocks") as they
/// complete; the session generates them in order and plays them as audio arrives.
@MainActor
final class SpeechPlayer {
  static let shared = SpeechPlayer()
  private var current: (id: UUID, session: SpeechSession, task: Task<Bool, Error>)?
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
    current = (id, session, task)
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
/// audio instead of regenerating it. All state is guarded by `lock`; every state
/// change calls `signal()`, which wakes the waiting generation.
private final class SpeechSession: @unchecked Sendable {
  private let settings: SpeechSettings
  private let onState: @Sendable (SpeechState) -> Void
  private let lock = NSLock()
  private var changes = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private let audioEngine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let timePitch = AVAudioUnitTimePitch()
  private let cacheURL = FileManager.default.temporaryDirectory.appendingPathComponent("t3-speech-\(UUID()).pcm")
  private var format: AVAudioFormat?
  private var cache: FileHandle?
  private let voice: CloudVoice
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
  /// Generation works up to 15 seconds ahead, so a slow response or brief coverage gap stays silent-free.
  private let lookaheadFrames = Int64(CloudVoice.sampleRate * 15)
  private var paused = false
  /// Set while an interruption holds the reading, so its end resumes only that pause.
  private var interrupted = false
  private var resumeFrame: Int64 = 0
  private var publishedBlock: Int?

  // Diagnostics: when the current segment first delivered audio, how long it waited
  // for room in the lookahead, and when playback last ran out of audio.
  private var segmentFirstAudio: ContinuousClock.Instant?
  private var segmentWaited: Duration = .zero
  private var starvedAt: ContinuousClock.Instant?

  private var cancelled = false
  private var ended = false
  private var failure: Error?

  init(settings: SpeechSettings, onState: @escaping @Sendable (SpeechState) -> Void) {
    self.settings = settings
    self.onState = onState
    voice = settings.voice
    pace = settings.pace
  }

  func run() async throws -> Bool {
    defer { close() }
    let opened = try lock.withLock {
      if cancelled { return false }
      try openAudio()
      return true
    }
    guard opened else { return false }
    speechLog.notice("start \(self.voice.model, privacy: .public) voice \(self.voice.voice, privacy: .public) pace \(self.settings.pace)")
    return try await withTaskCancellationHandler {
      while let (index, text, generation) = await takeBlock() {
        markStart(of: index, generation: generation)
        for segment in speechSegments(text, maxLength: CloudVoice.segmentLength) {
          guard isCurrent(generation) else { break }
          let started = ContinuousClock.now
          let framesBefore = lock.withLock {
            segmentFirstAudio = nil
            segmentWaited = .zero
            return writtenFrames
          }
          do {
            try await voice.generate(segment) { await self.append($0, generation: generation) }
          } catch {
            speechLog.error("block \(index) segment failed: \(error.localizedDescription, privacy: .public)")
            if isCurrent(generation) { throw error }
          }
          logSegment(block: index, characters: segment.count, started: started, framesBefore: framesBefore, generation: generation)
        }
      }
      if let failure = lock.withLock({ failure }) { throw failure }
      return lock.withLock { !cancelled }
    } onCancel: {
      cancel()
    }
  }

  // MARK: Input

  /// Replaces the blocks from `index`. A changed block that was already generated is
  /// read again from its start.
  func append(_ texts: [String], from index: Int) {
    lock.withLock {
      blocks = Array(blocks.prefix(index)) + texts
      generationIdle = false
      if index < nextIndex { regenerateLocked(from: index) }
      signal()
    }
  }

  func finish() {
    lock.withLock {
      inputFinished = true
      signal()
    }
  }

  // Called with the lock held.
  private func signal() {
    changes += 1
    for waiter in waiters { waiter.resume() }
    waiters = []
  }

  /// Returns once `signal()` has run since the caller read `changes`.
  private func changed(since seen: Int) async {
    await withCheckedContinuation { continuation in
      lock.withLock {
        if changes == seen { waiters.append(continuation) } else { continuation.resume() }
      }
    }
  }

  /// Waits for the next block to generate. Returns nil once playback has ended.
  private func takeBlock() async -> (Int, String, Int)? {
    while true {
      let (next, seen): ((Int, String, Int)??, Int) = lock.withLock {
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
    lock.withLock { !cancelled && generation == self.generation }
  }

  private func markStart(of block: Int, generation: Int) {
    lock.withLock {
      guard generation == self.generation else { return }
      marks.append((writtenFrames, block))
    }
  }

  /// Returns false when generation should stop: the session ended or jumped to another
  /// block. Waits while playback catches up, including after a rewind or pause.
  func append(_ data: Data, generation: Int) async -> Bool {
    while true {
      let (written, seen) = lock.withLock { (write(data, generation: generation), changes) }
      if let written { return written }
      let waitStarted = ContinuousClock.now
      await changed(since: seen)
      lock.withLock { segmentWaited += waitStarted.duration(to: .now) }
    }
  }

  /// Called with the lock held; returns nil while the lookahead is full.
  private func write(_ data: Data, generation: Int) -> Bool? {
    guard !cancelled, generation == self.generation, let cache else { return false }
    guard !data.isEmpty else { return true }
    guard writtenFrames - completedFrames < lookaheadFrames else { return nil }
    if segmentFirstAudio == nil { segmentFirstAudio = .now }
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

  /// Generation speed excludes time spent waiting for playback to make room, so a
  /// rate below the playback pace means playback will run out of audio.
  private func logSegment(block: Int, characters: Int, started: ContinuousClock.Instant, framesBefore: Int64, generation: Int) {
    lock.withLock {
      guard let format, generation == self.generation else { return }
      let rate = format.sampleRate
      let audio = Double(writtenFrames - framesBefore) / rate
      let working = started.duration(to: .now) - segmentWaited
      let firstAudio = segmentFirstAudio.map { started.duration(to: $0) / .milliseconds(1) } ?? -1
      let ahead = Double(writtenFrames - position()) / rate
      speechLog.notice("block \(block) segment \(characters) chars: \(audio, format: .fixed(precision: 1))s audio in \(working / .seconds(1), format: .fixed(precision: 1))s (\(audio / max(working / .seconds(1), 0.001), format: .fixed(precision: 2))x), first audio \(Int(firstAudio))ms, waited \(self.segmentWaited / .seconds(1), format: .fixed(precision: 1))s, \(ahead, format: .fixed(precision: 1))s buffered")
    }
  }

  // MARK: Controls

  func rewind() {
    lock.withLock {
      guard let format, !cancelled, !ended else { return }
      speechLog.notice("rewind")
      let target = max(runStart, (paused ? resumeFrame : position()) - Int64(format.sampleRate * 10))
      if paused { resumeFrame = target } else { seekLocked(to: target) }
      publishBlock(at: target)
    }
  }

  func nextBlock() {
    let block = lock.withLock { currentBlock() }
    seek(toBlock: (block ?? -1) + 1)
  }

  func seek(toBlock block: Int) {
    lock.withLock {
      guard format != nil, !cancelled, !ended, block >= 0 else { return }
      speechLog.notice("seek to block \(block)")
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
    speechLog.notice("regenerate from block \(block)")
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
    lock.withLock {
      interrupted = false
      pauseLocked(resumeFrom: point)
    }
  }

  func resume() {
    lock.withLock { resumeLocked() }
  }

  private func interruptionBegan() {
    speechLog.notice("interruption began")
    lock.withLock {
      guard !paused else { return }
      pauseLocked(resumeFrom: .rewound)
      interrupted = paused
    }
  }

  private func interruptionEnded(shouldResume: Bool) {
    speechLog.notice("interruption ended, should resume \(shouldResume)")
    lock.withLock {
      if interrupted && shouldResume { resumeLocked() }
      interrupted = false
    }
  }

  func togglePause() {
    lock.withLock {
      if paused { resumeLocked() } else { pauseLocked(resumeFrom: .position) }
    }
  }

  func setPace(_ pace: Float) {
    lock.withLock {
      self.pace = pace
      timePitch.rate = pace
    }
  }

  private func pauseLocked(resumeFrom point: ResumePoint) {
    guard let format, !cancelled, !ended, !paused else { return }
    starvedAt = nil
    speechLog.notice("pause")
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
    speechLog.notice("resume")
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

  private func openAudio() throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: CloudVoice.sampleRate, channels: 1)!
    self.format = format
    try Data().write(to: cacheURL)
    cache = try FileHandle(forUpdating: cacheURL)
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
    timePitch.rate = pace
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
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        speechLog.notice("route change, reason \(reason ?? 0)")
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
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
    speechLog.notice("engine configuration changed")
    lock.withLock {
      guard format != nil, !cancelled, !ended, !paused else { return }
      let position = position()
      do { try audioEngine.start() } catch { fail(error); return }
      seekLocked(to: position)
    }
  }

  // Called with the lock held. Completion work leaves the audio callback
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
    if pendingBuffers > 0 && !player.isPlaying {
      if let starvedAt {
        speechLog.notice("playback resumed after \(Int(starvedAt.duration(to: .now) / .milliseconds(1)))ms without audio")
        self.starvedAt = nil
      }
      player.play()
    }
  }

  private func didPlay(endFrame: Int64, epoch scheduledEpoch: Int) {
    lock.lock()
    defer { lock.unlock() }
    guard !cancelled, epoch == scheduledEpoch else { return }
    completedFrames = max(completedFrames, endFrame)
    pendingBuffers -= 1
    do { try scheduleBuffers() }
    catch { fail(error); return }
    if pendingBuffers == 0 {
      if !(generationIdle && scheduledFrames == writtenFrames) {
        starvedAt = .now
        let at = Double(completedFrames) / format!.sampleRate
        let waiting = nextIndex >= blocks.count ? "waiting for text" : "generating block \(nextIndex - 1)"
        speechLog.notice("ran out of audio at \(at, format: .fixed(precision: 1))s, \(waiting, privacy: .public)")
      }
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
    starvedAt = nil
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
    speechLog.error("failed: \(error.localizedDescription, privacy: .public)")
    failure = error
    cancelLocked()
  }

  private func cancelLocked() {
    cancelled = true
    player.stop()
    signal()
  }

  func cancel() {
    lock.withLock { cancelLocked() }
  }

  private func close() {
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    lock.withLock {
      cancelled = true
      player.stop()
      audioEngine.stop()
      try? cache?.close()
      try? FileManager.default.removeItem(at: cacheURL)
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

struct SpeechSettings: Sendable {
  let voice: CloudVoice
  let pace: Float
  let title: String
}

struct SpeechError: LocalizedError {
  let errorDescription: String?
  init(_ message: String) { errorDescription = message }
}
