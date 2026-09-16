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
        // 🛑 The permission strings are Companion's, and on iOS the user reads
        // them in a system dialog over an app called SATE. "SATE Companion uses
        // Bluetooth to set up your SATE Recorder" shown by SATE, which sets up
        // nothing, is both confusing and the kind of mismatch App Review picks
        // up. They are rewritten here for what THIS app does.
        infoPlist: {
          // Built from Companion's, MINUS the two entries that exist only for
          // talking to hardware and a dev server on the LAN:
          //   * NSLocalNetworkUsageDescription — SATE talks to Supabase over
          //     HTTPS and nothing on the local network.
          //   * NSAppTransportSecurity with NSAllowsArbitraryLoads — a blanket
          //     opt-out of App Transport Security that App Review asks you to
          //     justify, kept for the local mock server. This app has no reason
          //     to make a plaintext request at all.
          ...Object.fromEntries(
            Object.entries(cfg.ios?.infoPlist || {}).filter(
              ([k]) =>
                k !== 'NSLocalNetworkUsageDescription' && k !== 'NSAppTransportSecurity'
            )
          ),
          NSCameraUsageDescription:
            'SATE uses the camera to scan the sign-in code shown in the SATE web app.',
          // ble-plx is linked even though this app does not pair hardware on iOS
          // (the L816 decoder is Android-only), and a linked CoreBluetooth with
          // no purpose string crashes the moment anything touches it. Keep the
          // key, tell the truth about it.
          NSBluetoothAlwaysUsageDescription:
            'SATE does not connect to recorders on iPhone. Recorders are paired in the ' +
            'SATE Companion app on Android.',
          // Expo's iOS template turns arbitrary loads ON by default. Filtering
          // the inherited key is not enough — it has to be switched off
          // explicitly. SATE reaches exactly one host, Supabase, over HTTPS.
          NSAppTransportSecurity: { NSAllowsArbitraryLoads: false },
        },
      },
      // Plugins the SATE app has no use for, dropped rather than shipped inert:
      //   * plaud-sate injects Local Network + Location purpose strings for Plaud
      //     WiFi transfer, and this app never offers a Plaud.
      //   * expo-audio adds a MICROPHONE string by default; SATE only PLAYS
      //     audio — it records nothing at all.
      // An app that asks for permissions it cannot use is one a reviewer rejects
      // and a clinician distrusts.
      plugins: (cfg.plugins || [])
        .filter((pl) => {
          const name = Array.isArray(pl) ? pl[0] : pl;
          return name !== './modules/plaud-sate/app.plugin.js';
        })
        .map((pl) => {
          const name = Array.isArray(pl) ? pl[0] : pl;
          if (name === 'expo-audio') return ['expo-audio', { microphonePermission: false }];
          if (name === 'react-native-ble-plx') {
            return [
              'react-native-ble-plx',
              {
                isBackgroundEnabled: false,
                bluetoothAlwaysPermission:
                  'SATE does not connect to recorders on iPhone. Recorders are paired in ' +
                  'the SATE Companion app on Android.',
              },
            ];
          }
          if (name === 'expo-camera') {
            return [
              'expo-camera',
              {
                cameraPermission:
                  'SATE uses the camera to scan the sign-in code shown in the SATE web app.',
              },
            ];
          }
          return pl;
        }),
      extra: { ...(cfg.extra || {}), sateVariant: true },
    },
  };
};
