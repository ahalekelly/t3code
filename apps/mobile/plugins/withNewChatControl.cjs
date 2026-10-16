"use strict";

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET = "ExpoWidgetsTarget";
const SHARED = ["ChatProject.swift", "OpenProjectChatIntent.swift", "NewChatControlStore.swift"];

// Register before expo-widgets so its extension exists before these mods run.
// OpenIntent requires the intent and its entities in both the app and extension.
module.exports = function withNewChatControl(config) {
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const ios = cfg.modRequest.platformProjectRoot;
      for (const name of [...SHARED, "index.swift", "NewProjectChatControl.swift"]) {
        const source =
          name === "NewChatControlStore.swift"
            ? path.join(root, "modules/t3-native-controls/ios", name)
            : path.join(root, "widgets", name);
        fs.copyFileSync(source, path.join(ios, TARGET, name));
      }
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.findTargetKey(TARGET);
    const group = project.findPBXGroupKey({ name: TARGET });
    const appName = cfg.modRequest.projectName;
    const appTarget = project.findTargetKey(appName);
    if (!target || !group || !appTarget)
      throw new Error("The New Chat control requires app and widget extension targets.");
    for (const name of [...SHARED, "NewProjectChatControl.swift"]) {
      const file = project.addSourceFile(name, { target }, group);
      if (SHARED.includes(name)) {
        // One file reference, with a separate compile entry for each target.
        const appFile = { ...file, uuid: project.generateUuid(), target: appTarget };
        project.addToPbxBuildFileSection(appFile);
        project.addToPbxSourcesBuildPhase(appFile);
      }
    }
    const targetConfig = project.pbxNativeTargetSection()[target].buildConfigurationList;
    const configs = project.pbxXCConfigurationList()[targetConfig].buildConfigurations;
    for (const { value } of configs) {
      const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
      settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = '"$(inherited) T3_CONTROL_EXTENSION"';
    }
    return cfg;
  });
};
