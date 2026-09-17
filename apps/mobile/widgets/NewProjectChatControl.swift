import AppIntents
import SwiftUI
import WidgetKit

struct NewProjectChatConfiguration: ControlConfigurationIntent {
  static var title: LocalizedStringResource = "New Chat"
  @Parameter(title: "Project") var project: ChatProject?
}

struct NewProjectChatControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: NewChatControlStore.kind, intent: NewProjectChatConfiguration.self) { configuration in
      ControlWidgetButton(action: OpenProjectChatIntent(project: configuration.project)) {
        Label("New Chat", systemImage: "square.and.pencil")
      }
    }
    .displayName("New Chat")
    .description("Open a fresh chat in your chosen T3 project.")
  }
}
