import AppIntents
import Foundation

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
    try NewChatControlStore.read().flatMap { environment in
      (environment.projects ?? []).map { project in
        var url = URLComponents()
        // The intent passes this link directly to the containing app's navigation.
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
