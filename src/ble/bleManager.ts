// One BleManager for the whole app. react-native-ble-plx wraps a single native
// CBCentralManager and is explicit that you should keep ONE BleManager instance
// alive — creating a second one, or destroying and recreating in quick
// succession, leaves the native BLE stack in a broken state where scans return
// nothing. That is exactly what bit the pendant: SATE's manager was destroyed on
// the way into the pendant screen and the pendant then built its own, so its
// scan heard zero devices.
//
// So SATE and the Pendant SHARE this one manager (they never scan at the same
// time — the radio arbiter / screen flow guarantees that). It is destroyed only
// when handing the radio to the Plaud SDK (a different, non-ble-plx central
// manager that needs the radio to itself), and lazily rebuilt afterwards.

import { BleManager } from "react-native-ble-plx";

let mgr: BleManager | null = null;

/** The shared BleManager, created on first use. Throws outside a dev build. */
export function getSharedBleManager(): BleManager {
  if (!mgr) {
    try {
      mgr = new BleManager();
    } catch {
      throw new Error(
        "Bluetooth needs a development build — Expo Go cannot load react-native-ble-plx. Run: npx expo run:ios."
      );
    }
  }
  return mgr;
}

/** Whether the shared manager currently exists (without creating it). */
export function hasSharedBleManager(): boolean {
  return mgr !== null;
}

/**
 * Destroy the shared manager and free the radio. Use ONLY when handing off to a
 * non-ble-plx stack (Plaud). SATE↔Pendant handoffs must NOT destroy it — they
 * just stop scanning — or the recreate breaks the BLE stack.
 */
export function destroySharedBleManager(): void {
  mgr?.destroy();
  mgr = null;
}
