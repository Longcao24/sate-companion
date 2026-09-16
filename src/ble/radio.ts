// Radio arbiter — the single source of truth for who owns the phone's BLE radio.
//
// PHYSICAL stacks (there are only two):
//   'bleplx' — the ONE shared react-native-ble-plx BleManager (ble/bleManager.ts),
//              used by BOTH the SATE recorder (`SateLink`) and the Pendant.
//   'plaud'  — the Plaud proprietary SDK's own CBCentralManager (alive from app
//              launch).
//
// LOGICAL owners (finer than the physical stack — auto-sync and a foreground SATE
// setup both drive `bleplx`, but must not run at the same time):
//   'autosync' — background BLE bridge (default owner)
//   'sate-fg'  — provision / change-Wi-Fi / recorder-settings (needs the radio alone)
//   'pendant'  — pendant connect screen
//   'l816'     — L816 connect screen (plain ble-plx, like the pendant)
//   'plaud'    — Plaud connect/settings screen
//
// THE TWO RULES THIS ENCODES (see CLAUDE.md RULE #2):
//  1. SATE, the Pendant and the L816 all share `bleplx`. Handing off between them
//     = stopScan() ONLY.
//     Destroying and recreating the manager leaves the native iOS BLE stack broken
//     (scans return zero devices, silently). NEVER destroy on that path.
//  2. Plaud needs the radio to itself → and ONLY there do we destroy `bleplx`.
//     It's rebuilt lazily on the next SATE/Pendant use.
//
// LOCK SAFETY (RULE #1): leaving Plaud calls `disconnectPlaud` — which MUST be
// `plaud.disconnect()` (drops the BLE link, KEEPS the binding). depair()/
// resetBinding (the user UNBIND) is never wired here. Anything else risks
// desyncing the binding and permanently locking the device.

export type RadioOwner = "autosync" | "sate-fg" | "pendant" | "l816" | "plaud";

export interface RadioHooks {
  /** Stop any scan running on the shared ble-plx manager (never destroys it). */
  stopBleScan(): void;
  /** Destroy the shared ble-plx manager. ONLY used when handing off to Plaud. */
  destroyBle(): void;
  /** Drop the Plaud BLE link. MUST be disconnect() — never depair(). */
  disconnectPlaud(): void;
  /** Drop the pendant's connection/scan (does NOT destroy the shared manager). */
  disconnectPendant(): void;
  /** Drop the L816's connection/scan (does NOT destroy the shared manager). */
  disconnectL816(): void;
  /** Stop the L816's SCAN but KEEP its connection (see setL816Held). */
  stopL816Scan(): void;
}

const noop = () => {};
let hooks: RadioHooks = {
  stopBleScan: noop,
  destroyBle: noop,
  disconnectPlaud: noop,
  disconnectPendant: noop,
  disconnectL816: noop,
  stopL816Scan: noop,
};

let active: RadioOwner | null = null;
// The L816 session is holding a live connection ACROSS screens.
//
// It is the only device family that does. The L816 records on its own with the
// phone in a pocket, and the app's job is to notice and upload that take — which
// it cannot do if the link dies the moment the user navigates away, and leaving
// the L816 screen acquires 'autosync', whose release for `l816` is teardown().
// So while this is set, handing the radio to another ble-plx owner stops the
// L816's SCAN and leaves its CONNECTION up.
//
// This does not weaken RULE #2: there is still exactly ONE shared BleManager and
// it is still never destroyed on this path. A held connection and auto-sync's
// scan coexist on it — ble-plx allows that; what it does not allow is two
// managers, or two scans.
//
// 🛑 The Plaud handoff is NOT covered by this and must not be. The Plaud SDK
// needs the radio to itself and that path DESTROYS the shared manager, so a
// "held" L816 connection would be severed anyway — pretending otherwise would
// leave the session believing it still had a link. Plaud always fully releases.
let l816Held = false;
const subs = new Set<() => void>();

function emit() {
  subs.forEach((f) => f());
}

/** Wire the arbiter to the real BLE stacks. Called once at app startup. */
export function registerRadio(h: RadioHooks): void {
  hooks = h;
}

/**
 * Take ownership of the radio. Hands off the previous owner's stack according to
 * the two rules above. Idempotent when `owner` already holds it.
 *
 * Call this SYNCHRONOUSLY in the navigation handler, BEFORE rendering the screen —
 * not in an effect. A parent effect runs after the child's, so acquiring there
 * would stop the scan the new screen just started.
 */
export function acquireRadio(owner: RadioOwner): void {
  if (active === owner) return;
  const prev = active;

  // Release what the previous owner held.
  if (prev === "plaud" && owner !== "plaud") hooks.disconnectPlaud();
  if (prev === "pendant" && owner !== "pendant") hooks.disconnectPendant();
  if (prev === "l816" && owner !== "l816") {
    if (l816Held && owner !== "plaud") hooks.stopL816Scan();
    else hooks.disconnectL816();
  }

  if (owner === "plaud") {
    // Plaud SDK needs the radio to itself: this is the ONLY destroy path.
    hooks.stopBleScan();
    hooks.destroyBle();
  } else {
    // autosync / sate-fg / pendant / l816 all drive the SHARED ble-plx manager.
    // Only one scan per manager, so clear whatever was scanning — but never
    // destroy it.
    hooks.stopBleScan();
  }

  active = owner;
  emit();
}

/**
 * Declare whether the L816 session is holding a connection that must survive a
 * handoff. Called by the session itself as it connects/disconnects.
 */
export function setL816Held(held: boolean): void {
  l816Held = held;
}

/** Who owns the radio right now, or null if free. */
export function radioOwner(): RadioOwner | null {
  return active;
}

/** True when the background auto-sync engine may use the SATE radio right now. */
export function autoSyncAllowed(): boolean {
  return active === null || active === "autosync";
}

/** Subscribe to ownership changes. Returns an unsubscribe fn. */
export function subscribeRadio(cb: () => void): () => void {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
}
