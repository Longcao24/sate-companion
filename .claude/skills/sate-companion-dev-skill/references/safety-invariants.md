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

## 5. A blocking take must never run before the network task starts

`maybeResumeRecording()` re-enters the capture, which **blocks until Stop**. It is called
from `loop()` (behind a pending flag set in `setup()`), and gated on the net task being up
or ~8 s elapsed. Do **not** move it back into `setup()`: `connStartNetTask()` lives in
`loop()`, so a resume that blocks `setup()` takes the whole unit off the air — no heartbeat,
no remote `stop`, no serial — and a server-started take, where nobody is at the device, just
goes dark until the ~62-minute ceiling. This shipped and was caught on the bench (fw 1.5.17).

The same rule applies to anything else that blocks for a user-controlled duration: it belongs
in `loop()`, after connectivity, never in `setup()`.

Related: a remote `stop` is latched only while a take is **armed** (`recTakeArmed`, set before
the take's start sequence, cleared when capture returns). Do not "clear stale stops" at take
start instead — that swallows a stop issued during the take's own start, which left resumed
takes running unbounded (fw 1.5.18).

## 6. A destructive path proves its case AT the deletion site — and "unknown" means keep

Reclaim frees the device's only copy of a recording, so the proof obligation lives where
the delete happens, not in the caller: `trimPatientSyncedAudio()` frees a take's audio only
after `verifySessionStored()` gets a byte-exact `stored:true` from the server. During the
2026-07-23 audit rounds the retention logic was wrong more than once — wrong floor, wrong
"live directory", once reclaiming every directory — and **no recording was ever lost**,
because the gate held every time. Keep it that way:

- Never free audio on a `.synced` marker alone; the marker only means "a POST returned 2xx".
- Any doubt — offline, non-2xx, parse fail, byte mismatch — KEEPS the audio.
- **A fail-safe default must be "keep everything", never "keep nothing".** One cut treated an
  unknown live directory as keep-0 and reclaimed the whole card. Write the safe direction
  explicitly; do not let it fall out of a zero-initialised variable.
- A byte count is not an identity. `(patient, session_number, bytes)` can match a *different*
  take once numbers are reused and durations are exact — a per-take id is the real fix
  (still open; see `references/auditing-firmware.md` §6).

## 7. Sessions are never renumbered — numbers are monotonic and wrap at 99

A delete removes only its own session's files and leaves a hole; numbers come from a
per-directory NVS high-water (`"sate-seq"`) so a deleted number is not recycled, and at the
99 wrap the allocator recycles the oldest **audio-free** tombstone (its recording is already
on the server). Do not reintroduce renumbering, and do not add code that assumes contiguous
`1..N` — that machinery was the single largest source of critical bugs in the audit
(splicing two takes into one server WAV, deleting the wrong recording, power-cut slot reuse).
See the memory note `no-renumber-sessions`.

## 8. Firmware flash traps that silently brick

- **`PartitionScheme=default_8MB`** (dual OTA slots). `huge_app` silently disables OTA.
- **`lv_conf.h` `LV_TICK_CUSTOM=1`.** If `0`, the boot spinner freezes at frame 1 while
  `setup()` still finishes — looks like a bad flash, isn't. Reinstalling lvgl resets it to `0`.
- **Pendant: Seeed core only** (`Seeeduino:nrf52:xiaonRF52840SensePlus`). The Adafruit Feather
  core links at `0x26000`, overwrites the S140 SoftDevice → BLE never advertises, no CDC port.
