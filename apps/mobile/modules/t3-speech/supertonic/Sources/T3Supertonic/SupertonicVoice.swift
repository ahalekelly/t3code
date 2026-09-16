import FluidAudio
import Foundation

public struct SupertonicVoice: Sendable {
  private let manager: Supertonic3Manager
  private let style: Supertonic3VoiceStyle
  private static let voice = Supertonic3Voice.f1
  private static var directory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("SupertonicVoice", isDirectory: true)
  }

  public static var isDownloaded: Bool {
    let repo = directory.appendingPathComponent(Repo.supertonic3.folderName)
    return ModelNames.Supertonic3.requiredFiles(veVariant: "ane-int4")
      .union([voice.fileName]).allSatisfy {
        FileManager.default.fileExists(atPath: repo.appendingPathComponent($0).path)
      }
  }

  public static func prepare() async throws -> SupertonicVoice {
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
    return SupertonicVoice(manager: manager, style: style)
  }

  public func synthesize(_ text: String) async throws -> [Float] {
    try Task.checkCancellation()
    let audio = try await manager.synthesize(text: text, language: "na", style: style, speed: 1)
    try Task.checkCancellation()
    return audio.samples
  }
}
