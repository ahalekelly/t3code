import Foundation
import WidgetKit

struct NewChatControlProject: Codable {
  let id: String
  let title: String
  let workspaceRoot: String
}

struct NewChatControlEnvironment: Codable {
  let environmentId: String
  let label: String
  var projects: [NewChatControlProject]?
}

enum NewChatControlStore {
  static let kind = "NewProjectChatControl"
  private static let key = "T3NewChatProjects"

  private static func defaults() throws -> UserDefaults {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String,
          let defaults = UserDefaults(suiteName: group) else {
      throw NSError(domain: kind, code: 1, userInfo: [
        NSLocalizedDescriptionKey: "The new-chat control requires the T3 shared App Group."
      ])
    }
    return defaults
  }

  static func read() throws -> [NewChatControlEnvironment] {
    guard let data = try defaults().data(forKey: key) else { return [] }
    return try JSONDecoder().decode([NewChatControlEnvironment].self, from: data)
  }

  static func sync(_ json: String) throws {
    var environments = try JSONDecoder().decode([NewChatControlEnvironment].self, from: Data(json.utf8))
    let previous = try read()
    // An unloaded environment retains its cached projects. An empty loaded
    // project list or a removed environment must clear the control choices.
    for index in environments.indices where environments[index].projects == nil {
      environments[index].projects = previous.first {
        $0.environmentId == environments[index].environmentId
      }?.projects
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let data = try encoder.encode(environments)
    let storage = try defaults()
    guard storage.data(forKey: key) != data else { return }
    storage.set(data, forKey: key)
    ControlCenter.shared.reloadControls(ofKind: kind)
  }
}
