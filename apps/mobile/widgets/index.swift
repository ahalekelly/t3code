import SwiftUI
import WidgetKit
internal import ExpoWidgets

@main
struct T3Widgets: WidgetBundle {
  var body: some Widget {
    NewProjectChatControl()
    AgentActivity()
    WidgetLiveActivity()
  }
}
