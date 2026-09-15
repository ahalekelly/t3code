import Foundation
import WidgetKit

struct NewChatWidgetProject: Codable {
  let id: String
  let title: String
  let workspaceRoot: String
}

struct NewChatWidgetEnvironment: Codable {
  let environmentId: String
  let label: String
  var projects: [NewChatWidgetProject]?
}

enum NewChatWidgetStore {
  static let kind = "NewProjectChat"
  private static let key = "T3NewChatProjects"

  private static func defaults() throws -> UserDefaults {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "ExpoWidgetsAppGroupIdentifier") as? String,
          let defaults = UserDefaults(suiteName: group) else {
      throw NSError(domain: kind, code: 1, userInfo: [
        NSLocalizedDescriptionKey: "The new-chat widget requires the T3 widget App Group."
      ])
    }
    return defaults
  }

  static func read() throws -> [NewChatWidgetEnvironment] {
    guard let data = try defaults().data(forKey: key) else { return [] }
    return try JSONDecoder().decode([NewChatWidgetEnvironment].self, from: data)
  }

  static func sync(_ json: String) throws {
    var environments = try JSONDecoder().decode([NewChatWidgetEnvironment].self, from: Data(json.utf8))
    let previous = try read()
    // An unloaded environment retains its cached projects. An empty loaded
    // project list or a removed environment must clear the widget choices.
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
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
  }
}
