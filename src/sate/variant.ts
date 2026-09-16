import Constants from "expo-constants";

/**
 * True in the **SATE** build, false in SATE Companion.
 *
 * Set by `app.config.js` when `SATE_VARIANT=sate`, which also gives that build
 * its own applicationId — so the two apps install side by side and this flag is
 * a build constant, never something that flips while the app is running.
 *
 * It exists so one codebase can serve both without the shipping app changing
 * behaviour: everything guarded by this is invisible to SATE Companion.
 */
export const IS_SATE_APP: boolean =
  (Constants.expoConfig?.extra as Record<string, unknown> | undefined)?.sateVariant === true;

// Logged once at startup. `Constants.expoConfig` is read from the config embedded
// by `expo prebuild`, NOT from the JS bundle — so a build where the bundle has
// the flag but prebuild did not can render the wrong app with nothing to show
// for it. One line here turns that from a mystery into a fact.
console.log(
  `[variant] IS_SATE_APP=${IS_SATE_APP} expoConfig=${
    Constants.expoConfig ? "present" : "NULL"
  } extra=${JSON.stringify(Constants.expoConfig?.extra ?? null)}`
);
