"use strict";

const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const TARGET = "ExpoWidgetsTarget";
const SOURCES = ["NewProjectChat.swift", "NewChatWidgetStore.swift"];

// T3 owns the bundle entry point to include native AppEntity configuration
// alongside Expo's widgets and Live Activities. Register before expo-widgets
// so these mods run after it creates the extension and its generated sources.
module.exports = function withNativeWidgets(config) {
  config = withDangerousMod(config, [
    "ios",
    (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const target = path.join(cfg.modRequest.platformProjectRoot, TARGET);
      for (const name of ["index.swift", "NewProjectChat.swift"]) {
        fs.copyFileSync(path.join(root, "widgets", name), path.join(target, name));
      }
      fs.copyFileSync(
        path.join(root, "modules/t3-native-controls/ios/NewChatWidgetStore.swift"),
        path.join(target, "NewChatWidgetStore.swift"),
      );
      return cfg;
    },
  ]);
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = project.findTargetKey(TARGET);
    const group = project.findPBXGroupKey({ name: TARGET });
    if (!target || !group)
      throw new Error("Native widgets require the ExpoWidgetsTarget target and group.");
    for (const name of SOURCES) {
      project.addSourceFile(name, { target }, group);
    }
    return cfg;
  });
};
