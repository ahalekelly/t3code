import AppIntents
import SwiftUI
import WidgetKit

struct NewProjectChatConfiguration: ControlConfigurationIntent {
  static var title: LocalizedStringResource = "New Chat"
  @Parameter(title: "Project") var project: ChatProject?
}

private func projectChatControl(
  kind: String,
  title: LocalizedStringResource,
  systemImage: String,
  dictate: Bool,
  description: LocalizedStringResource
) -> some ControlWidgetConfiguration {
  AppIntentControlConfiguration(kind: kind, intent: NewProjectChatConfiguration.self) { configuration in
    ControlWidgetButton(action: OpenProjectChatIntent(project: configuration.project, dictate: dictate)) {
      Label(title, systemImage: systemImage)
    }
  }
  .displayName(title)
  .description(description)
}

struct NewProjectChatControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    projectChatControl(
      kind: NewChatControlStore.newChatKind,
      title: "New Chat",
      systemImage: "square.and.pencil",
      dictate: false,
      description: "Open a fresh T3 chat in your chosen project, or without one."
    )
  }
}

struct DictateProjectChatControl: ControlWidget {
  var body: some ControlWidgetConfiguration {
    projectChatControl(
      kind: NewChatControlStore.dictateChatKind,
      title: "Dictate Chat",
      systemImage: "mic.badge.plus",
      dictate: true,
      description: "Open a fresh T3 chat with dictation running, in your chosen project or without one."
    )
  }
}
