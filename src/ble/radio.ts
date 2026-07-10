// Radio arbiter — the single source of truth for who owns the phone's BLE radio.
//
// The app drives three PHYSICAL BLE stacks, all fighting for one radio:
//   'sate'    — react-native-ble-plx `SateLink` (`link`). Shared by the
//               background auto-sync engine AND the foreground SATE screens
//               (provision / change-Wi-Fi / recorder-settings).
//   'pendant' — SATE Pendant, its own ble-plx `BleManager` (`PendantLink`).
//   'plaud'   — Plaud proprietary SDK (its own CBCentralManager).
//
// Two central managers scanning at once starve each other (this is exactly why
// the pendant wouldn't scan while auto-sync kept SATE's manager alive).
//
// But "who may use the radio" is finer than the physical stack: auto-sync and a
// foreground SATE setup BOTH use `link`, yet must not run at the same time (a
// restart/provision needs the radio to itself). So callers acquire a LOGICAL
// owner; the arbiter tears down whichever physical stacks that owner doesn't
// need, and auto-sync backs off whenever the owner isn't itself.
//
//   owner 'autosync' → keeps SATE link, tears down pendant+plaud
//   owner 'sate-fg'  → keeps SATE link, tears down pendant+plaud, pauses autosync
//   owner 'pendant'  → tears down SATE link + plaud
//   owner 'plaud'    → tears down SATE link + pendant
//
// LOCK SAFETY (RULE #1): the 'plaud' physical teardown MUST be
// `plaud.disconnect()` only — it drops the BLE link and KEEPS the binding.
// depair()/resetBinding (the user UNBIND) is never wired here. Anything else
// risks desyncing the binding and permanently locking the device.

export type RadioStack = "sate" | "pendant" | "plaud";
export type RadioOwner = "autosync" | "sate-fg" | "pendant" | "plaud";

// Which physical stacks each logical owner needs kept alive.
const KEEP: Record<RadioOwner, RadioStack[]> = {
  autosync: ["sate"],
  "sate-fg": ["sate"],
  pendant: ["pendant"],
  plaud: ["plaud"],
};

const ALL: RadioStack[] = ["sate", "pendant", "plaud"];

const teardowns: Partial<Record<RadioStack, () => void>> = {};
let active: RadioOwner | null = null;
const subs = new Set<() => void>();

function emit() {
  subs.forEach((f) => f());
}

/** Register how to tear a physical stack down. Called once per stack at startup. */
export function registerRadio(stack: RadioStack, teardown: () => void): void {
  teardowns[stack] = teardown;
}

/**
 * Take ownership of the radio as `owner`, tearing down every physical stack this
 * owner doesn't need. Idempotent when `owner` already holds it.
 */
export function acquireRadio(owner: RadioOwner): void {
  if (active === owner) return;
  const keep = KEEP[owner];
  for (const stack of ALL) {
    if (!keep.includes(stack)) {
      try {
        teardowns[stack]?.();
      } catch {
        /* a teardown must never block the handoff */
      }
    }
  }
  active = owner;
  emit();
}

/** Release ownership if `owner` currently holds it (no-op otherwise). */
export function releaseRadio(owner: RadioOwner): void {
  if (active === owner) {
    active = null;
    emit();
  }
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
