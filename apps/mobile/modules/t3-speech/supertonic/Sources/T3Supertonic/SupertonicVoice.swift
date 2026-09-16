import FluidAudio
import Foundation

public struct SupertonicVoice: Sendable {
  private let manager: Supertonic3Manager
  private let style: Supertonic3VoiceStyle
  private let pace: Float
  private let steps: Int
  public static let voiceNames = Supertonic3Voice.allCases.map(\.rawValue)
  private static var directory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SupertonicVoice", isDirectory: true)
  }

  public static func isDownloaded(voice: String) -> Bool {
    guard let voice = Supertonic3Voice(rawValue: voice) else { return false }
    let repo = directory.appendingPathComponent(Repo.supertonic3.folderName)
    return ModelNames.Supertonic3.requiredFiles(veVariant: "ane-int4")
      .union([voice.fileName]).allSatisfy {
        FileManager.default.fileExists(atPath: repo.appendingPathComponent($0).path)
      }
  }

  public static func prepare(voice: String, pace: Float, steps: Int) async throws -> SupertonicVoice {
    guard let voice = Supertonic3Voice(rawValue: voice) else {
      throw NSError(domain: "T3Speech", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unknown Supertonic voice."])
    }
    var directory = directory
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    let manager = try await Supertonic3Manager.downloadAndCreate(
      cacheDirectory: directory, vectorEstimator: .aneBucketed(.int4))
    try Task.checkCancellation()
    let style = try await Supertonic3ResourceDownloader.loadVoiceStyle(voice, directory: directory)
    try Task.checkCancellation()
    return SupertonicVoice(manager: manager, style: style, pace: pace, steps: steps)
  }

  public func synthesize(_ text: String) async throws -> [Float] {
    try Task.checkCancellation()
    let audio = try await manager.synthesize(text: text, language: "na", style: style, totalSteps: steps, speed: pace)
    try Task.checkCancellation()
    return audio.samples
  }
}
