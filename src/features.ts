import { Platform } from "react-native";
import { isAscAvailable } from "../modules/sate-asc";

// Which device families this build supports.
//
// Each family is gated by where its hardware can actually work, and the two
// gates point in OPPOSITE directions — Plaud and the pendant are iOS, the L816
// is Android. Nothing here is a preference; each line is a platform that cannot
// run the other's code.
//
// The Android build is otherwise RECORDER-ONLY, and not by accident:
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

// The L816 is the mirror image of Plaud: its audio is ASC-VI, and the only
// decoder in existence is the vendor's ARM ELF pair, which loads on Android and
// nowhere else — not iOS, not the x86 cf-processor container (see
// modules/sate-asc/README.md). BLE, the screen and the upload path are all
// portable; the codec is the wall.
//
// `isAscAvailable()` is checked too, not just the platform: the binaries are
// proprietary and git-ignored, so a clone that has not copied them in builds and
// runs fine — it just must not offer hardware whose recordings it could download
// and then never convert or upload.
export const L816_ENABLED = Platform.OS === "android" && isAscAvailable();
