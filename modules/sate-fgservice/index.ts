import { requireOptionalNativeModule } from "expo-modules-core";

// Keeps the app's process alive while a recorder is connected over Bluetooth.
//
// Android stops scheduling a backgrounded app's work, so every timer in the app
// dies the moment the user leaves the screen — including the L816's 3-second
// state poll, which is the only thing that notices a take started on the
// device's own button. A foreground service (with its mandatory ongoing
// notification) keeps the process running normally so that poll, the transfer
// and the upload all continue with the app closed.
//
// Android-only by nature: iOS has no equivalent. There, a backgrounded app keeps
// its BLE connection but its JS timers are suspended, so this module returns
// `false` from every call and the caller degrades to foreground-only.

interface SateFgServiceNative {
  hasNotificationPermission(): boolean;
  areNotificationsEnabled(): boolean;
  /** Start or update the ongoing notification. `progress` -1 = no bar. */
  start(title: string, text: string, progress: number): boolean;
  stop(): boolean;
  notifyOnce(id: number, title: string, text: string): boolean;
}

const native = requireOptionalNativeModule<SateFgServiceNative>("SateFgService");

/** True when this build can hold a connection in the background at all. */
export function isBackgroundLinkSupported(): boolean {
  return !!native;
}

/** Android 13+ must have been granted POST_NOTIFICATIONS first. */
export function hasNotificationPermission(): boolean {
  try {
    return native?.hasNotificationPermission() ?? false;
  } catch {
    return false;
  }
}

/** False when the user has turned the app's notifications off in system settings. */
export function areNotificationsEnabled(): boolean {
  try {
    return native?.areNotificationsEnabled() ?? false;
  } catch {
    return false;
  }
}

/**
 * Start the service, or update its text in place. Idempotent — call it on every
 * status change and the one notification simply re-renders.
 *
 * `progress` is 0..100 for a transfer (a real byte count) and omitted for
 * anything that cannot be measured. Never pass a made-up number: a bar that
 * moves on a guess turns "I don't know how long this takes" into a promise.
 */
export function startBackgroundLink(
  title: string,
  text: string,
  progress?: number
): boolean {
  try {
    return native?.start(title, text, progress ?? -1) ?? false;
  } catch {
    return false;
  }
}

export function stopBackgroundLink(): boolean {
  try {
    return native?.stop() ?? false;
  } catch {
    return false;
  }
}

/**
 * A dismissible one-off notice — "your recording is in SATE". This is the only
 * way the user finds out a take arrived without opening the app, so it is worth
 * the interruption; the ongoing service notification is deliberately silent.
 */
export function notifyOnce(id: number, title: string, text: string): boolean {
  try {
    return native?.notifyOnce(id, title, text) ?? false;
  } catch {
    return false;
  }
}
