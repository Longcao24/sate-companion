// Expo config with a SECOND app variant.
//
// `SATE_VARIANT=sate npx expo prebuild -p android` builds **SATE** — a separate
// app with its own applicationId, so it installs ALONGSIDE SATE Companion and
// cannot replace or disturb it. With the variable unset this returns the base
// config byte-for-byte, so the shipping app is unaffected by this file existing.
//
// Why a separate applicationId rather than a flag inside one app: the running
// build is what people are testing L816 on. A flag would mean reinstalling over
// it to try a new UI, which is exactly what "don't touch the current app" rules
// out. Two ids means both are on the phone at once and either can be deleted.

const base = require('./app.json');

module.exports = () => {
  const cfg = JSON.parse(JSON.stringify(base)).expo;
  if (process.env.SATE_VARIANT !== 'sate') return { expo: cfg };

  return {
    expo: {
      ...cfg,
      name: 'SATE',
      slug: 'sate',
      // 🛑 The version and versionCode are INHERITED from app.json, deliberately.
      // They used to be pinned here as '0.1.0' / 1 with the comment "this variant
      // moves independently" — but nothing ever moved them, so every SATE build
      // ever made reported 0.1.0 and versionCode 1. A build you cannot identify
      // is a build you cannot debug a report against, and a versionCode that
      // never increases is one Android will not treat as an update.
      // The two apps are built from ONE tree at ONE commit, so one version line
      // is the truth about both. Bump app.json.
      android: {
        ...cfg.android,
        package: 'com.auspexmedix.sate',
      },
      ios: {
        ...cfg.ios,
        bundleIdentifier: 'agency.sate.app',
      },
      extra: { ...(cfg.extra || {}), sateVariant: true },
    },
  };
};
