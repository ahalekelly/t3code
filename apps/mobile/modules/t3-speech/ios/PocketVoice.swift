import CryptoKit
import Foundation

/// Immutable model files are verified before moving them into persistent storage.
enum PocketVoice {
  // The runtime indexes this complete voice bank in this order.
  static let names = ["Alba", "Marius", "Javert", "Jean", "Fantine", "Cosette", "Eponine", "Azelma"]
  private static let revision = "e81d79e8194ad4c7ce879c87a4258ef20cbf2487"
  private static let files = [
    ("tts_b6369a24.safetensors", "model.safetensors", "58aa704a88faad35f22c34ea1cb55c4c5629de8b8e035c6e4936e2673dc07617"),
    ("tokenizer.model", "tokenizer.model", "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6"),
    ("embeddings/alba.safetensors", "voices/alba.safetensors", "ad234695323e4030336b6afc8a050c97e3110603e11ecd8226d9562488300a50"),
    ("embeddings/azelma.safetensors", "voices/azelma.safetensors", "ef33fad34437cb187d2702f0a946d8ba7a01efdb8efbc8088c770d49c181ba73"),
    ("embeddings/cosette.safetensors", "voices/cosette.safetensors", "ca8926c4f234afa9d722173967e7bebdc6269538ca5910d65f41c3c1317717d3"),
    ("embeddings/eponine.safetensors", "voices/eponine.safetensors", "bb31940f62da665391de139da2e57d740757df26b73d7ec24152c78a3b8ac0c5"),
    ("embeddings/fantine.safetensors", "voices/fantine.safetensors", "b6918a2ece002d2d9037ff53c4ea38730175e8798786658b0958443edf49d355"),
    ("embeddings/javert.safetensors", "voices/javert.safetensors", "2e857904ee76657e083b0e92664d21bd133e37df320af6eb04f752e679422d91"),
    ("embeddings/jean.safetensors", "voices/jean.safetensors", "329530f87ce503061acefca8669300963420ff97e43647a326aa46bd987b983c"),
    ("embeddings/marius.safetensors", "voices/marius.safetensors", "33f75e45fac0005630671f4b1bb632d51b6a083b18417de94855bbd7596a0630"),
  ]
  private static var directory: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("PocketVoice/\(revision)", isDirectory: true)
  }

  static var isDownloaded: Bool {
    files.allSatisfy { FileManager.default.fileExists(atPath: directory.appendingPathComponent($0.1).path) }
  }

  static func prepare() async throws -> URL {
    var directory = self.directory
    try FileManager.default.createDirectory(at: directory.appendingPathComponent("voices"), withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try directory.setResourceValues(values)
    for (remoteName, localName, expectedHash) in files {
      try Task.checkCancellation()
      let destination = directory.appendingPathComponent(localName)
      if FileManager.default.fileExists(atPath: destination.path) { continue }
      let url = URL(string: "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/\(revision)/\(remoteName)")!
      let (temporary, response) = try await URLSession.shared.download(from: url)
      defer { try? FileManager.default.removeItem(at: temporary) }
      guard let response = response as? HTTPURLResponse, response.statusCode == 200 else {
        throw SpeechError("The offline voice could not be downloaded. Check your connection and try again.")
      }
      let file = try FileHandle(forReadingFrom: temporary)
      defer { try? file.close() }
      var hash = SHA256()
      while let data = try file.read(upToCount: 1_048_576), !data.isEmpty {
        try Task.checkCancellation()
        hash.update(data: data)
      }
      guard hash.finalize().map({ String(format: "%02x", $0) }).joined() == expectedHash else {
        throw SpeechError("The downloaded voice failed verification. Please try again.")
      }
      try FileManager.default.moveItem(at: temporary, to: destination)
    }
    return directory
  }
}
