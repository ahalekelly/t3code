import UIKit

/// Keeps the app running while work that must not be cut short finishes in the
/// background. iOS ends a task itself when it runs out of time, so ending one
/// twice is expected and ignored.
@MainActor
enum BackgroundTasks {
  private static var active = Set<UIBackgroundTaskIdentifier>()

  static func begin(_ name: String) -> Int {
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: name) { end(task.rawValue) }
    active.insert(task)
    return task.rawValue
  }

  static func end(_ rawValue: Int) {
    let task = UIBackgroundTaskIdentifier(rawValue: rawValue)
    guard active.remove(task) != nil else { return }
    UIApplication.shared.endBackgroundTask(task)
  }
}
