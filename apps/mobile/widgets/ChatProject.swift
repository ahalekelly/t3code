import AppIntents
import Foundation

struct ChatProject: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Project"
  static var defaultQuery = ChatProjectQuery()

  // The id is the link the intent hands to the containing app's navigation.
  let id: String
  let title: String
  let subtitle: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)", subtitle: "\(subtitle)")
  }

  static let noProject = ChatProject(
    id: "t3code://new?scratch=1",
    title: "No project",
    subtitle: "In your most recently used environment"
  )

  static func all() throws -> [ChatProject] {
    let projects = try NewChatControlStore.read().flatMap { environment in
      (environment.projects ?? []).map { project in
        var url = URLComponents()
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
          subtitle: "\(environment.label) · \(project.workspaceRoot)"
        )
      }
    }
    return [noProject] + projects.sorted { ($0.title, $0.subtitle) < ($1.title, $1.subtitle) }
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
      "\($0.title) \($0.subtitle)".localizedCaseInsensitiveContains(string)
    }
  }
}
