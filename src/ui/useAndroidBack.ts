import { useEffect } from "react";
import { BackHandler, Platform } from "react-native";

/**
 * Handle Android's back button / back gesture.
 *
 * 🛑 NOTHING in this app handled it, and that is why back — and the left-edge
 * swipe, which Android delivers as the same event — QUIT THE APP instead of
 * going back. Neither app uses a navigation library: both keep the current
 * screen in a `useState` and render it directly, so React Navigation's
 * automatic back handling was never there to inherit. With no JS listener the
 * event falls through to the Activity, which finishes, and from the user's side
 * reading a report and swiping back closes SATE.
 *
 * `handler` returns **true when it consumed the event** and false to let Android
 * do its default thing — which at the root of the app SHOULD be leaving. An app
 * that can never be backed out of is its own bug.
 *
 * `Modal` registers its own handler and is called first, so a sheet's
 * `onRequestClose` still closes the sheet rather than popping a screen behind it.
 */
export function useAndroidBack(handler: () => boolean): void {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // RN 0.81: addEventListener returns the subscription; the old
    // `removeEventListener` no longer exists.
    const sub = BackHandler.addEventListener("hardwareBackPress", handler);
    return () => sub.remove();
  }, [handler]);
}
