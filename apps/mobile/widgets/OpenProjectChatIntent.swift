import AppIntents
import UIKit

struct OpenProjectChatIntent: OpenIntent {
  static var title: LocalizedStringResource = "New Chat"
  static var description = IntentDescription("Open a fresh T3 chat, in a project or without one.")
  static var isDiscoverable = false

  @Parameter(title: "Project") var target: ChatProject
  // Optional because an OpenIntent may have no required parameter besides `target`.
  @Parameter(title: "Start dictation") var dictate: Bool?

  init() {}

  init(project: ChatProject?, dictate: Bool) {
    target = project ?? .noProject
    self.dictate = dictate
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    #if T3_CONTROL_EXTENSION
    // OpenIntent must execute in the containing app, where navigation lives.
    throw NSError(domain: "NewProjectChatControl", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Open T3 before using the New Chat control."
    ])
    #else
    guard let url = URL(string: target.id + (dictate == true ? "&dictate=1" : "")) else {
      preconditionFailure("Could not parse the new chat link.")
    }
    // Every app delegate subscriber returns false here; expo-linking still passes the URL to JavaScript.
    _ = UIApplication.shared.delegate?.application?(UIApplication.shared, open: url, options: [:])
    #endif
    return .result()
  }
}
