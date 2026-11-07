const { withInfoPlist } = require("expo/config-plugins");

module.exports = function withResponseSpeech(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIBackgroundModes = [
      ...new Set([...(config.modResults.UIBackgroundModes ?? []), "audio"]),
    ];
    return config;
  });
};
