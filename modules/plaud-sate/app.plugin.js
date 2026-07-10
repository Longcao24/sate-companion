// Config plugin: applies the Info.plist keys + entitlements the Plaud SDK needs
// so they survive `expo prebuild` (which regenerates ios/). The frameworks
// themselves are vendored via PlaudSate.podspec — this only handles native
// project config.
//
// Referenced from app.json plugins as "./modules/plaud-sate/app.plugin.js".
const { withInfoPlist, withEntitlementsPlist } = require("expo/config-plugins");

const withPlaudSate = (config) => {
  // Local-network + location are required for WiFi Fast Transfer (joining the
  // device hotspot). Strings match Plaud's official project.yml spec.
  config = withInfoPlist(config, (cfg) => {
    const plist = cfg.modResults;
    plist.NSLocalNetworkUsageDescription =
      plist.NSLocalNetworkUsageDescription ||
      "Local network access is required for Plaud WiFi fast transfer.";
    plist.NSLocationWhenInUseUsageDescription =
      plist.NSLocationWhenInUseUsageDescription ||
      "Location access is required for Plaud WiFi fast transfer to connect to the device hotspot.";
    return cfg;
  });

  // Hotspot Configuration entitlement: needed ONLY for WiFi Fast Transfer
  // (deferred). DISABLED until that's wired — the capability must first be
  // enabled for the App ID in the Apple Developer portal, or auto-signing
  // fails with "profile does not support the Hotspot capability".
  // config = withEntitlementsPlist(config, (cfg) => {
  //   cfg.modResults["com.apple.developer.networking.HotspotConfiguration"] = true;
  //   return cfg;
  // });

  return config;
};

module.exports = withPlaudSate;
