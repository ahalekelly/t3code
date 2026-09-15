import AppIntents
import SwiftUI
import WidgetKit

struct ChatProject: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
  static var defaultQuery = ChatProjectQuery()

  let id: String
  let title: String
  let environment: String
  let workspaceRoot: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(environment) · \(workspaceRoot)")
  }

  static func all() throws -> [ChatProject] {
    try NewChatWidgetStore.read().flatMap { environment in
      (environment.projects ?? []).map { project in
        var url = URLComponents()
        // WidgetKit delivers the URL to the containing app, including dev builds.
        url.scheme = "t3code"
        url.host = "new"
        url.path = "/draft"
        url.queryItems = [
          URLQueryItem(name: "environmentId", value: environment.environmentId),
          URLQueryItem(name: "projectId", value: project.id)
        ]
        url.percentEncodedQuery = url.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let deepLink = url.url else {
          preconditionFailure("Could not encode the project chat link.")
        }
        return ChatProject(
          id: deepLink.absoluteString,
          title: project.title,
          environment: environment.label,
          workspaceRoot: project.workspaceRoot
        )
      }
    }.sorted { ($0.title, $0.environment, $0.workspaceRoot) < ($1.title, $1.environment, $1.workspaceRoot) }
  }
}

struct ChatProjectQuery: EntityStringQuery {
  func entities(for identifiers: [String]) async throws -> [ChatProject] {
    try ChatProject.all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [ChatProject] {
    try ChatProject.all()
  }

  func entities(matching string: String) async throws -> [ChatProject] {
    try ChatProject.all().filter {
      "\($0.title) \($0.environment) \($0.workspaceRoot)".localizedCaseInsensitiveContains(string)
    }
  }
}

struct NewProjectChatIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "New Chat"
  static var description = IntentDescription("Open a fresh T3 chat in a project.")

  @Parameter(title: "Project") var project: ChatProject?
}

struct NewProjectChatEntry: TimelineEntry {
  let date: Date
  let project: ChatProject?
  let message: String
}

struct NewProjectChatProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> NewProjectChatEntry {
    NewProjectChatEntry(date: .now, project: nil, message: "Choose a project")
  }

  func snapshot(for configuration: NewProjectChatIntent, in context: Context) async -> NewProjectChatEntry {
    entry(for: configuration)
  }

  func timeline(for configuration: NewProjectChatIntent, in context: Context) async -> Timeline<NewProjectChatEntry> {
    Timeline(entries: [entry(for: configuration)], policy: .never)
  }

  private func entry(for configuration: NewProjectChatIntent) -> NewProjectChatEntry {
    guard let selected = configuration.project else {
      return NewProjectChatEntry(date: .now, project: nil, message: "Edit Widget to choose a project")
    }
    do {
      let project = try ChatProject.all().first { $0.id == selected.id }
      return NewProjectChatEntry(date: .now, project: project, message: "Project unavailable — open T3")
    } catch {
      return NewProjectChatEntry(date: .now, project: nil, message: "Could not load projects — open T3")
    }
  }
}

struct NewProjectChatView: View {
  @Environment(\.widgetFamily) private var family
  let entry: NewProjectChatEntry

  var body: some View {
    Group {
      if family == .accessoryCircular {
        Image(systemName: "square.and.pencil")
          .font(.title2)
          .widgetLabel { Text(entry.project?.title ?? "Choose project") }
      } else {
        VStack(alignment: .leading, spacing: 5) {
          Label("New Chat", systemImage: "square.and.pencil")
            .font(family == .systemSmall ? .headline : .caption)
          if family == .systemSmall { Spacer(minLength: 4) }
          Text(entry.project?.title ?? entry.message)
            .font(.headline)
            .lineLimit(2)
          if let project = entry.project {
            Text(project.environment)
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
      }
    }
    .containerBackground(.background, for: .widget)
    .widgetURL(entry.project.flatMap { URL(string: $0.id) })
    .accessibilityLabel(entry.project.map { "New chat in \($0.title), \($0.environment)" } ?? entry.message)
  }
}

struct NewProjectChat: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: NewChatWidgetStore.kind, intent: NewProjectChatIntent.self, provider: NewProjectChatProvider()) {
      NewProjectChatView(entry: $0)
    }
    .configurationDisplayName("New Chat")
    .description("Open a fresh chat in your chosen T3 project.")
    .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular])
  }
}
