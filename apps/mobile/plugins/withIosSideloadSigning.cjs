const fs = require("node:fs");
const path = require("node:path");
const plist = require("@expo/plist");
const { withDangerousMod, withEntitlementsPlist, withInfoPlist } = require("expo/config-plugins");

// Register before SDK plugins so these mods run after their generated values.
module.exports = function withIosSideloadSigning(config, { sideStoreTeam }) {
  config = withEntitlementsPlist(config, (cfg) => {
    delete cfg.modResults["aps-environment"];
    delete cfg.modResults["com.apple.developer.applesignin"];
    if (!sideStoreTeam) delete cfg.modResults["com.apple.security.application-groups"];
    return cfg;
  });
  if (!sideStoreTeam) return config;

  // SideStore appends the signing team to entitlement groups, but leaves Expo’s
  // custom Info.plist key untouched. Both processes must use the signed group.
  const signedGroup = `group.${config.ios.bundleIdentifier}.${sideStoreTeam}`;
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.ExpoWidgetsAppGroupIdentifier = signedGroup;
    return cfg;
  });
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, "ExpoWidgetsTarget/Info.plist");
      const info = plist.default.parse(fs.readFileSync(file, "utf8"));
      info.ExpoWidgetsAppGroupIdentifier = signedGroup;
      fs.writeFileSync(file, plist.default.build(info));
      return cfg;
    },
  ]);
};
