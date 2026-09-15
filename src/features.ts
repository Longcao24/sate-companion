import { Platform } from "react-native";

// Which device families this build supports.
//
// The Android build is RECORDER-ONLY, and not by accident:
//
//   * Plaud ships an arm64 iOS-only SDK (modules/plaud-sate declares
//     `"platforms": ["apple"]`), so on Android there is no native module to talk
//     to — makePlaudLink() already falls back to a mock. A mock device that can
//     be added, listed and never synced is worse than no entry point at all.
//   * The pendant is pure ble-plx and WOULD run on Android, but it is not part
//     of the Android product: shipping an entry point for hardware the build is
//     not tested against invites a bug report that costs more than the feature.
//
// Gate the ENTRY POINTS on these, never the imports: PlaudLink/PendantLink are
// safe to import everywhere (neither touches a native module at module scope),
// and keeping the imports unconditional is what keeps `tsc` honest about them.
export const PLAUD_ENABLED = Platform.OS === "ios";
export const PENDANT_ENABLED = Platform.OS === "ios";
