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
      // Its own version line: this variant moves independently of Companion.
      version: '0.1.0',
      android: {
        ...cfg.android,
        package: 'com.auspexmedix.sate',
        versionCode: 1,
      },
      ios: {
        ...cfg.ios,
        bundleIdentifier: 'agency.sate.app',
      },
      extra: { ...(cfg.extra || {}), sateVariant: true },
    },
  };
};
