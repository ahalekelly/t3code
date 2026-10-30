import AppIntents
import SwiftUI
import WidgetKit

struct NewProjectChatConfiguration: ControlConfigurationIntent {
  static var title: LocalizedStringResource = "New Chat"
  @Parameter(title: "Project") var project: ChatProject?
  @Parameter(title: "Start dictation", default: false) var dictate: Bool
}

struct NewProjectChatControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: NewChatControlStore.kind, intent: NewProjectChatConfiguration.self) { configuration in
      ControlWidgetButton(action: OpenProjectChatIntent(project: configuration.project, dictate: configuration.dictate)) {
        Label("New Chat", systemImage: configuration.dictate ? "mic.badge.plus" : "square.and.pencil")
      }
    }
    .displayName("New Chat")
    .description("Open a fresh T3 chat in your chosen project, or without one.")
  }
}
