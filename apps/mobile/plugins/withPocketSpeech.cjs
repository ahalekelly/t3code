const { withInfoPlist } = require("expo/config-plugins");

module.exports = function withPocketSpeech(config) {
  return withInfoPlist(config, (config) => {
    config.modResults.UIBackgroundModes = [
      ...new Set([...(config.modResults.UIBackgroundModes ?? []), "audio"]),
    ];
    return config;
  });
};
