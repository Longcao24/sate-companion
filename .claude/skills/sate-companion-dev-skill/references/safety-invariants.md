# Safety invariants (production guardrails)

These are the failures that are **unrecoverable or lose patient data**. Violating any of them
is a production incident. Full, line-precise detail lives in `CLAUDE.md` (RULE #1, RULE #2)
and `doc/08-plaud.md` / `doc/09-pendant.md`; this is the operational summary.

## 1. Plaud device-lock — a mis-bound Plaud is PERMANENTLY bricked

Unlike a SATE recorder (recoverable), a mis-bound/desynced Plaud is bricked for that account.
Any edit touching Plaud connect / identity / Keychain / BLE lifecycle / account / sync must
preserve all five invariants:

1. **Stable, account-derived identity** — `plaudUserId(uid) = "sate_<uid>"`, the SAME string
   used as the Plaud `user_id` and the `connect()` deviceToken. Never random, per-install, or
   a raw uid. It is restored on login so it survives reinstall.
2. **Bind guard before connect** — if `bindingOwner(sn)` is set and ≠ this account, REFUSE to
   connect. Reconnect to your own binding; never re-bind.
3. **Binding lives in the iOS Keychain** (`plaud.bind.<sn>`, `AfterFirstUnlock`) so it outlives
   uninstall. Reinstall → reconnect, never re-bind.
4. **No auto-depair, ever** — `depair(clear:true)` is exposed ONLY via the user-initiated UNBIND
   (`resetBinding`). Teardown/logout must only `disconnect()`.
5. **ACK-before-forget on unbind** — send depair → device ACKs → ONLY THEN delete the local
   Keychain record. Forgetting locally first desyncs the binding and freezes the device.

Where: `src/plaud/PlaudLink.ts`, `PlaudConnectScreen.tsx`, `PlaudSettingsScreen.tsx`,
`modules/plaud-sate/ios/PlaudSateModule.swift`.

## 2. One shared BleManager (SATE + Pendant)

Two ble-plx `BleManager` instances — or destroying one and creating another — leaves the iOS
BLE stack broken: scans return **zero devices**, no error. This stopped the pendant being found
for days.

- SATE + Pendant **share** `getSharedBleManager()` (`src/ble/bleManager.ts`).
- **SATE ↔ Pendant handoff: `stopScan()` only, NEVER destroy.**
- **Plaud handoff: DO destroy** (`destroySharedBleManager()`) — the Plaud SDK needs the radio
  to itself; rebuilt lazily after. This is a radio handoff only; it never touches Plaud's binding.
- `src/ble/radio.ts` is the ONLY arbiter. `acquireRadio(...)` is called **synchronously in the
  `App.tsx` nav handler**, never in an effect (a parent effect runs after the child's and would
  stop the scan the screen just started).
- Auto-sync (`useAutoSync`) owns SATE's manager in the background and must be paused on any
  screen that needs the radio.

## 3. Never run the long AI call from a serverless function

Supabase edge has a hard ~150 s wall-clock limit (kills the worker mid-fetch, before the
try/catch → session hangs in `processing` forever). A plain CF Worker has the ~100 s 524 origin
timeout. The long transcription MUST live in the **`cf-processor` container** (no wall-clock).
`device-api` and `finalize-session` stay `verify_jwt:false`. `process-device-session` must be a
200 **no-op** in prod — the repo copy still processes, so do NOT deploy it as-is.

## 4. SD reclaim is server-verified — never lose the only copy of a take

The device is the only copy of a recording until it is PROVABLY on the server.
`trimPatientSyncedAudio()` frees audio only after `verifySessionStored()` gets a byte-exact
`stored:true` from `GET /api/sessions/verify` (checks the DB row AND that the storage object
exists). Any doubt — offline, non-2xx, byte mismatch — KEEPS the audio. Never free audio on the
`.synced` marker alone. Full deletion stays user-only.

## 5. Firmware flash traps that silently brick

- **`PartitionScheme=default_8MB`** (dual OTA slots). `huge_app` silently disables OTA.
- **`lv_conf.h` `LV_TICK_CUSTOM=1`.** If `0`, the boot spinner freezes at frame 1 while
  `setup()` still finishes — looks like a bad flash, isn't. Reinstalling lvgl resets it to `0`.
- **Pendant: Seeed core only** (`Seeeduino:nrf52:xiaonRF52840SensePlus`). The Adafruit Feather
  core links at `0x26000`, overwrites the S140 SoftDevice → BLE never advertises, no CDC port.
