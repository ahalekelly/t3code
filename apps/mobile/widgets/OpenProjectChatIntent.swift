import AppIntents
import UIKit

struct OpenProjectChatIntent: OpenIntent {
  static var title: LocalizedStringResource = "New Chat"
  static var description = IntentDescription("Open a fresh T3 chat in a project.")

  @Parameter(title: "Project") var target: ChatProject

  init() {}

  init(project: ChatProject?) {
    if let project { target = project }
  }

  static var parameterSummary: some ParameterSummary {
    Summary("New chat in \(\.$target)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    #if T3_CONTROL_EXTENSION
    // OpenIntent must execute in the containing app, where navigation lives.
    throw NSError(domain: "NewProjectChatControl", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Open T3 before using the New Chat control."
    ])
    #else
    guard let url = URL(string: target.id),
          UIApplication.shared.delegate?.application?(UIApplication.shared, open: url, options: [:]) == true else {
      throw NSError(domain: "NewProjectChatControl", code: 2, userInfo: [
        NSLocalizedDescriptionKey: "T3 could not open the selected project."
      ])
    }
    #endif
    return .result()
  }
}
