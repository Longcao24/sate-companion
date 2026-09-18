import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How much room the SYSTEM NAVIGATION takes at the bottom of the screen.
 *
 * 🛑 This build is edge-to-edge (`edgeToEdgeEnabled=true`, forced by Android 15
 * for SDK 35 targets), so the nav bar is painted OVER the app. A screen whose
 * last element is a button must add this to its bottom padding or the button is
 * underneath it: the "Unpair this SATE L816" control was completely unreachable
 * on a three-button phone, and unpairing is exactly what you need when a
 * recorder is lost, broken or being handed on.
 *
 * `extra` is the design's own bottom padding — the gap you would have wanted on
 * a phone with no nav bar at all. A gesture pill reports ~24dp here and three
 * buttons ~48dp, so the same call is right on both.
 */
export function useBottomInset(extra = 0): number {
  return useSafeAreaInsets().bottom + extra;
}
