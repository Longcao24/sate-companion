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
