import AVFoundation

enum SpeechCue: String {
  case sent, attention, error

  var notes: [Double] {
    switch self {
    case .sent: return [880, 1_320]
    case .attention: return [660, 880, 660]
    case .error: return [440, 294]
    }
  }

  static let noteDuration = 0.11
  var duration: Double { Double(notes.count) * Self.noteDuration }
}

/// Tones and system-voice messages for hands-free use. They need no network or
/// download, so they still work when the chosen reading voice cannot.
@MainActor
final class SpeechCues: NSObject, AVAudioPlayerDelegate, AVSpeechSynthesizerDelegate {
  static let shared = SpeechCues()
  private let synthesizer = AVSpeechSynthesizer()
  private var player: AVAudioPlayer?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  func play(_ cue: SpeechCue) throws {
    try activate()
    let player = try AVAudioPlayer(data: Self.tones(cue.notes))
    player.delegate = self
    self.player = player
    player.play()
  }

  func announce(_ text: String, after cue: SpeechCue) throws {
    try play(cue)
    let utterance = AVSpeechUtterance(string: text)
    utterance.preUtteranceDelay = cue.duration
    synthesizer.speak(utterance)
  }

  private func activate() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playback, mode: .spokenAudio)
    try session.setActive(true)
  }

  private func deactivateWhenIdle() {
    guard player?.isPlaying != true, !synthesizer.isSpeaking, !SpeechPlayer.shared.isReading else { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    Task { @MainActor in self.deactivateWhenIdle() }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.deactivateWhenIdle() }
  }

  /// Short sine notes with a fade, as 16-bit mono WAV.
  private static func tones(_ notes: [Double]) -> Data {
    let rate = 44_100.0
    let noteFrames = Int(rate * SpeechCue.noteDuration)
    var samples: [Int16] = []
    for frequency in notes {
      for frame in 0..<noteFrames {
        let envelope = min(1, Double(frame) / 300, Double(noteFrames - frame) / 1_500)
        samples.append(Int16(sin(2 * .pi * frequency * Double(frame) / rate) * envelope * 9_000))
      }
    }
    var data = Data()
    func put<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
    let bytes = UInt32(samples.count * 2)
    data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes).littleEndian)
    data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16).littleEndian)
    put(UInt16(1).littleEndian); put(UInt16(1).littleEndian); put(UInt32(rate).littleEndian)
    put(UInt32(rate * 2).littleEndian); put(UInt16(2).littleEndian); put(UInt16(16).littleEndian)
    data.append(contentsOf: Array("data".utf8)); put(bytes.littleEndian)
    for sample in samples { put(sample.littleEndian) }
    return data
  }
}
