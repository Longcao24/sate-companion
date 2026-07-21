# SATE Companion — project instructions

## ⚠️ RULE #1 — Plaud device-lock safety (READ BEFORE ANY CHANGE)

**A Plaud device can be PERMANENTLY LOCKED if its binding is mishandled.** Unlike a
SATE recorder (recoverable), a mis-bound / desynced Plaud is bricked for that account.
So **every** new feature, refactor, or "small" edit that touches Plaud — connect,
identity, Keychain, BLE lifecycle, teardown, account/login, provisioning, multi-device,
sync, settings — MUST preserve these invariants. When in doubt, stop and re-read
`doc/08-plaud.md` + `plaud-integration.md` before writing code.

Five invariants (verified airtight; do NOT break any):

1. **Stable, account-derived identity — never random/per-install.**
   `plaudUserId(uid) = "sate_<uid>"` is the SAME string used by (a) the
   `mint-plaud-token` edge fn as the Plaud `user_id`, and (b) `connect(deviceId, ...)`
   as the deviceToken. It is restored on login → survives reinstall. Never pass a raw
   uid, a random value, or a per-device token to `connect()`.

2. **Bind guard before connect.** If `bindingOwner(sn)` is set and ≠ this account,
   REFUSE to connect (don't re-bind under a new identity). Reconnect to your own
   binding; never re-bind.

3. **Binding lives in the iOS Keychain** (`plaud.bind.<sn>`), `AfterFirstUnlock`, so it
   outlives uninstall (AsyncStorage does NOT). Reinstall → reconnect, never re-bind.

4. **No auto-depair, ever.** `depair(clear:true)` is exposed ONLY via the user-initiated
   `resetBinding` (the UNBIND button). Unmount/teardown/logout must only `disconnect()`
   (drops the BLE link, keeps the binding) — never depair.

5. **ACK-before-forget on unbind.** Order is law: send depair → device ACKs
   (`bleDepair`, status 0) → ONLY THEN delete the local Keychain record. Native refuses
   depair while disconnected, fails fast on a mid-command BLE drop, and times out (20s)
   instead of hanging; `resetBinding` keeps the Keychain record on ANY failure.
   Forgetting locally before the device ACKs desyncs the binding and freezes the device.

Residual (not a code bug, out of our control): Plaud hasn't officially confirmed that a
re-bind with the same `user_id` is a guaranteed no-op, and iOS can't guarantee Keychain
survives every uninstall path. Our stable identity makes a re-bind idempotent either way —
but if you add a "switch account" flow, WiFi transfer, or anything that could change the
identity or the binding lifecycle, treat it as high-risk and confirm with the user.

Where the logic lives: `src/plaud/PlaudLink.ts` (identity, bindings, resetBinding),
`src/screens/PlaudConnectScreen.tsx` (connect guard), `src/screens/PlaudSettingsScreen.tsx`
(UNBIND), `modules/plaud-sate/ios/PlaudSateModule.swift` (native connect/depair + ACK).

## ⚠️ RULE #2 — ONE shared BleManager (SATE + Pendant)

Three BLE stacks fight for one radio: **SATE** (`SateLink`, react-native-ble-plx),
**Pendant** (also ble-plx), **Plaud** (proprietary SDK, its own `CBCentralManager`,
created at app launch).

**SATE and Pendant SHARE a single `BleManager`** — `src/ble/bleManager.ts`
(`getSharedBleManager()`). This is not a style choice:

- Two ble-plx `BleManager` instances, **or destroying one and immediately creating
  another**, leaves the native iOS BLE stack broken — scans return **zero devices**
  with no error. This is exactly what stopped the pendant being found for days
  (the SATE→Pendant handoff used to `link.teardown()` → destroy → pendant built its
  own manager → empty scan).
- **SATE ↔ Pendant handoff: `stopScan()` only. NEVER destroy.**
- **Plaud handoff: DO destroy** (`link.teardown()` → `destroySharedBleManager()`) —
  the Plaud SDK needs the radio to itself. Rebuilt lazily afterwards. This is a
  radio handoff only; it never touches Plaud's binding (see RULE #1).
- Auto-sync (`useAutoSync`) owns SATE's manager in the background. It **must be
  paused** on any screen that needs the radio: `provision`, `changeWifi`,
  `recorderSettings`, `plaud`, `pendant` (see `syncEnabled` in `App.tsx`). Leaving
  it on rebuilds/rescans the shared manager under the screen and starves it.
- Only one scan per manager: a screen taking over should `stopDeviceScan()` first.

**`src/ble/radio.ts` is the arbiter and the ONLY place that hands the radio over.**
Logical owners (`autosync` | `sate-fg` | `pendant` | `plaud`) sit over the two
physical stacks; it encodes both rules above, including the lock-safe Plaud release
(`disconnect()`, never `depair()`). Rules for touching it:

- A screen that scans/connects MUST own the radio. `acquireRadio(...)` is called
  **synchronously in the navigation handler in `App.tsx`** (`goHome` / `openPlaud` /
  `openPendant` / `openSateFg`) — NEVER in an effect: a parent effect runs after the
  child's, so it would stop the scan the screen just started.
- Auto-sync gates itself via `autoSyncAllowed()`. There is **no screen-name
  allowlist** any more — don't reintroduce one; give the screen an owner instead.
- **One scan per manager.** Auto-sync is the only background scanner and publishes
  the `nearby` set; a screen must not run its own presence scan alongside it. A
  foreground SATE scan (e.g. sync-over-BLE in `RecorderDetailScreen`) must borrow the
  radio with `acquireRadio('sate-fg')` and hand it back with `acquireRadio('autosync')`.

## Build / verify

- **Mobile (Expo, iOS-only for Plaud — arm64 device SDK, no simulator):** the user builds
  via Xcode. Compile-check the native module without a device/signing:
  `xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos \
   -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`
- **Typecheck:** mobile `npx tsc --noEmit` (repo root — it also pulls in
  `react_app_sate-ui_update/`, whose `@/…` path-alias errors are noise; filter them
  out); web `npx tsc --noEmit` in `react_app_sate-ui_update/`.
- **ALWAYS `npm run build` in `react_app_sate-ui_update/` before pushing the web
  subtree.** The web build is `tsc -b && vite build` with `noUnusedLocals`, so a
  merely-unused variable (TS6133) fails the build — typecheck alone won't catch what
  Vercel will. This has broken the deploy before.
- **Web deploy is a git subtree** to a separate repo:
  `git subtree push --prefix=react_app_sate-ui_update webapp <branch>`
  (`webapp` remote = `Longcao24/SATE_hardwave`, which Vercel builds).
- Proprietary Plaud frameworks are git-ignored (`modules/plaud-sate/ios/Frameworks/`) —
  never commit them. Deploy `mint-plaud-token` with `--no-verify-jwt`.

## Project knowledge & gotchas (from accumulated notes)

Durable lessons — check the ones relevant to what you're touching. Version numbers drift;
`git log` is the source of truth for current firmware/edge-fn versions.

**Backend / Supabase edge functions**
- **`device-api` and `mint-plaud-token` MUST deploy with `verify_jwt:false`** (they validate
  the token themselves). Redeploying with the MCP default `verify_jwt:true` breaks recorder
  registration ("Setup link expired") and Plaud token minting. Always pass
  `--no-verify-jwt` / `verify_jwt:false`.
- `device-api` is versioned in-comment; bump it when you change routes. Plaud upload uses a
  USER-authed `POST /sessions` (Plaud has no `sate_devices` row / device key).
- **Admin page** `/admin` manages ALL devices + firmware system-wide, gated by the
  `sate_admins` table (by email). Don't expose admin routes without that gate.

**⚠️ Device AI processing is ASYNC — never call the AI from an edge function**
- **The bug:** the old `process-device-session` edge ran `fetch(AI_PROCESS_URL)` (ngrok, self-hosted
  CUDA) and *awaited* the whole transcription. Supabase edge has a hard ~150s wall-clock limit
  (NOT configurable, NOT a timeout we set) — on a long take it **kills the worker mid-fetch, before
  the `try/catch`**, so `process_error` is never written and the session hangs in `processing`
  forever. A 32-min take showed 70 min stuck (edge kill → cron retry → kill …) before a retry
  happened to land. The AI is not slow; the edge just can't hold the call.
- **The fix (in prod):** processing is a state machine on `sate_device_sessions.status`
  (`queued → processing → done | error`, cols `processing_started_at` / `attempts` / added by the
  `async_processor_state_machine` migration). New sessions auto-`queued` (column default). A
  **Cloudflare Container** (`cf-processor/`, Python, `sate-processor.longcao.workers.dev`) is a
  long-lived process with NO wall-clock: it `claim_next_session()` (atomic, SKIP LOCKED) → downloads
  the WAV → HOLDS the ngrok `/process` call → copies audio to the recordings bucket → calls the
  `finalize-session` edge (analysis + insert `recordings` + set done; the light half, fits the edge
  limit). `pg_cron` pings the Worker `/tick` every minute to keep the container warm; the container's
  own loop drains the queue.
- **`process-device-session` is now a 200 no-op** — `device-api` still fire-and-forgets to it, but it
  must NOT process, or it races the container and duplicates recordings. Don't revive it.
- **Retry:** watchdog (`requeue_stale_sessions`) auto-requeues stalled `processing` jobs up to
  `MAX_ATTEMPTS` then → `error`; transient failures (network/`5xx`/`408`/`429`) requeue with backoff
  (`requeue_session`); permanent (`4xx`, no segments) → `error` immediately; the user Retry button
  (`POST /sessions/:id/retry`, device-api ≥v14) re-queues an `error` session.
- **Never move the AI call back into an edge/Worker fetch.** Any serverless request (Supabase edge OR
  a plain CF Worker — the ~100s 524 origin timeout) will kill a long synchronous transcription. The
  long call MUST live in a real long-running process (the container). `finalize-session` and
  `device-api` MUST stay `verify_jwt:false`. See `doc/05-backend-supabase.md`.

**⚠️ Recorder audio is never auto-deleted (fw ≥1.5.9)**
- The device holds the ONLY copy of a take until the user deletes it by hand. The three old reclaim
  paths (post-upload purge, boot-time `purgeSyncedAudio`, 5-session `trimSessionsToMax`) are GONE.
  The uploader deletes NOTHING; the only `SD_MMC.remove` in `connectivity.cpp` drops a `.synced`
  marker in `resyncAll()`. Audio is removed in exactly one place, `deleteSessionFiles()` in the
  `.ino`, reached only from the user tapping Delete. Don't add a second one.
- A `.synced` marker only means "a POST returned 2xx", NOT "the audio is safe on the server". It is
  written only when the server ACKs `final=1` (`upFinalAcked`). Never infer it from anything else.
- **Storage's project-wide file size limit overrides the bucket's** and defaults to 50 MB. A
  full-length take is ~118 MB. It's set to 500 MB now; if big sessions land as rows with
  `process_error: "download failed: Object not found"`, check that first. A swallowed 413 plus a
  `.synced` written on a false 2xx destroyed a 62-minute recording once — `storeSessionRecord` now
  throws on upload failure. See `doc/05-backend-supabase.md`.
- **OTA on a device with a backlog fails `err-get-1`** (fragmented heap ⇒ the 2nd TLS handshake
  can't get its ~40 KB). Queue `reboot`, wait for it to come back, THEN queue `ota` — the first poll
  after boot flashes with a clean heap. Recipe in `doc/07-runbook.md`.

**Firmware / hardware (ESP32-S3, `SATE_Recorder/`)** — recorder sketch is
`SATE_Recorder/SATE_Recorder.ino` (folder name matches the `.ino`, so `arduino-cli` builds it
directly, no temp-copy). Pendant firmware is `SATE_Pendant/` (see the pendant section).
- 🛑🛑 **#1 BOOT-HANG TRAP — screen bright but frozen at the boot spinner is NOT a bad flash and NOT
  the code. It is `lv_conf.h` `LV_TICK_CUSTOM 0`.** The firmware never calls `lv_tick_inc()`, so if
  `LV_TICK_CUSTOM` isn't `1` (millis()) LVGL's clock is frozen → spinner sticks at frame 1, nothing
  ever repaints, yet `setup()` finishes (serial shows `[MEM] ready`). **Reinstalling lvgl resets
  this to 0.** Before wasting hours on flash params: check `~/Documents/Arduino/libraries/lv_conf.h`
  → `#define LV_TICK_CUSTOM 1` (+ montserrat 12/14/20).
- 🛑 **FLASH CONFIG (verified fw 1.5.12):** `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi`.
  Board = **16MB flash + 8MB octal (opi) PSRAM**. **`PartitionScheme=default_8MB` is mandatory — it
  has TWO app slots (`ota_0`+`ota_1`) so OTA works. NEVER `huge_app`** (it's literally "3MB **No
  OTA**", a single slot — flashing it silently kills OTA; the device records/registers but can't
  self-update). `PSRAM=opi` mandatory. Manual `esptool` merged-bin flashing needs flash mode
  **DIO** (qio = dead black screen); `arduino-cli upload` sets the mode itself. LVGL draw buffers +
  heap live in **PSRAM** (`lv_conf.h` `LV_MEM_CUSTOM 1`/`ps_malloc`, and `display.cpp`
  `MALLOC_CAP_SPIRAM`) so the register TLS handshake has contiguous internal RAM — don't move them
  back to internal DMA RAM (that caused "Server registration failed code -1"). See `hardware.md` §3.
- **GPIO34 cannot be used for battery ADC on the S3** — it bootloops the board. Battery
  sensing was disabled; a real ADC1 pin or a fuel-gauge IC is required.
- **Two-button pinout**: record = GPIO2, flag = GPIO14 (interrupt-latched). Flag markers
  flow device → sessions → recordings → web report seek-bar ticks. Don't reassign lightly.
- **Connectivity runs on a core-0 task**, GUI + buttons on core 1 (fixed button lag + stuck
  uploads). Keep network work off the UI core.
- **OTA**: firmware pulls a `.bin` from Supabase Storage via the command channel; the web
  "Publish firmware" card uploads a release. Bump `FIRMWARE_VERSION` per release so the
  device reports it and the update banner works.
- **Building + publishing a firmware release (the exact recipe):**
  1. Bump `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`, then compile
     (`arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder`).
     The folder name matches the `.ino`, so it builds in place — no temp-copy. **Partition MUST be
     `default_8MB` (dual OTA), never `huge_app`** (see the FLASH CONFIG trap above). Flash the fleet
     with `arduino-cli upload -p <port> --fqbn "…" SATE_Recorder` (handles flash mode). Manual
     `esptool` merged-bin flashing (for a stuck board) needs `--flash_mode dio --flash_freq 80m
     --flash_size 16MB` at `0x0`.
     ⚠️ **`lv_conf.h` — `LV_TICK_CUSTOM` MUST be `1` (SILENT BRICK if 0).** The firmware calls
     `lv_tick_inc()` NOWHERE; it relies entirely on `LV_TICK_CUSTOM=millis()`. With it `0`, LVGL's
     clock is stuck at 0 → the boot spinner freezes at frame 1 and NO screen ever repaints after,
     while `setup()` still completes on wall-clock (serial reaches `[MEM] ready`). Looks exactly like
     a boot hang / bad flash — it is neither. **Reinstalling lvgl (the iCloud fix below) resets
     `lv_conf.h` and drops `LV_TICK_CUSTOM` back to 0** (it re-enables fonts but not the tick) — so
     after ANY `lib install lvgl`, re-check `~/Documents/Arduino/libraries/lv_conf.h`: line ~88
     `#define LV_TICK_CUSTOM 1` AND montserrat 12/14/20 enabled.
     ⚠️ **Reading serial to debug boot:** `Serial` output only appears when built with
     `CDCOnBoot=cdc,USBMode=hwcdc`; the board is `/dev/cu.usbmodem101` (USB-Serial-JTAG). Plain
     `cat` won't reset it and racing esptool for the port fails — use a pyserial script that opens
     the port, pulses `RTS`(EN)/`DTR`(GPIO0) to reset-to-run, then reads.
     ⚠️ **Compile gotcha:** `~/Documents/Arduino/libraries` is under **iCloud Drive** — lvgl gets
     evicted to 0-block placeholders and `cc1plus` then blocks forever in `read()` on the lvgl
     preprocess (looks like a hang; it is iCloud on-demand download stalling). Fix: `arduino-cli lib
     uninstall lvgl && arduino-cli lib install lvgl@8.4.0` to re-materialise it, then **re-fix
     `lv_conf.h`** (LV_TICK_CUSTOM 1 + montserrat 12/14/20 — see the tick warning above). Long-term:
     turn off "Optimize Mac Storage" / move the Arduino sketchbook out of iCloud. Also `arduino-cli
     config delete board_manager.additional_urls` if `init` hangs on the board-index fetch.
  2. The **OTA image is the APP bin** (`SATE_Recorder.ino.bin`, ~1.7 MB) — NOT `.ino.merged.bin`
     (the full 8MB image, first USB flash only).
  3. **Publish** = upload that `.bin` to the public `firmware` Storage bucket at path
     `sate_<version>.bin` (`upsert`, `application/octet-stream`) + insert a `sate_firmware` row
     `{version, url, notes}` where `url` is the bucket's public URL
     (`<SUPABASE_URL>/storage/v1/object/public/firmware/sate_<version>.bin`). `getLatestFirmware`
     orders by `created_at`, so the newest row wins; re-publishing a version overwrites its `.bin`.
     Two ways to do it:
     - **Web card** (`/admin` → "Publish firmware"): easiest for a human — uses the admin's browser
       session, no keys. But it needs a browser + admin login, so an agent can't drive it.
     - **Direct upload + row insert (easiest programmatic path — this is what to use):** two calls,
       no temp function, no browser.
       1. `curl -X POST "$SUPABASE_URL/storage/v1/object/firmware/sate_<v>.bin" -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/octet-stream" -H "x-upsert: true" --data-binary @<bin>`
       2. `insert into sate_firmware (version, url, notes) values ('<v>', '$SUPABASE_URL/storage/v1/object/public/firmware/sate_<v>.bin', '<notes>');` — run it with the **Supabase MCP** `execute_sql`.
       Then verify: the public URL returns 200 and its SHA-256 matches the local `.bin`.
       `$KEY` = the Supabase **`sb_secret_…`** key (a new-style secret key works on Storage; the repo's
       `SERVICE_KEY` is a custom `svc-…` app key and is NOT it, and the MCP only exposes the anon key —
       so the secret has to be supplied). Project ref `zlgdpivcbmaodgokkdvz`. **Do NOT** deploy a
       throwaway edge function to do this — the two calls above are simpler. Treat a pasted `sb_secret`
       as compromised and tell the user to rotate it afterward.
  4. Queueing OTA to a device with a backlog fails `err-get-1` — `reboot` first, wait, then `ota`
     (see the runbook note above).
- **Wi-Fi change without factory reset**: BOOT-hold re-provisions Wi-Fi and KEEPS the
  account; a full reset is only for when the server removed the device (heartbeat
  `unclaimed:true`). Don't wipe the account binding for a Wi-Fi change.

**SATE Pendant (XIAO nRF52840 wearable)**
- Firmware is in the repo at `SATE_Pendant/` (`SATE_Pendant.ino` + `HARDWARE.md` +
  `INTEGRATION.md` + `flash_xiao.sh`). Build/flash from repo root: `./SATE_Pendant/flash_xiao.sh
  SATE_Pendant` — it compiles with the **Seeed** core and aborts on the `0x26000` SoftDevice trap
  (see below + `doc/09-pendant.md`). Needs the Seeed nRF52 board package installed.
- Streams raw PCM (16 kHz mono S16LE, 244 B/notify) over standard BLE → app wraps it
  in a WAV → same `uploadSession` pipeline, `device_serial` `pendant-<bleId>`.
  Pure ble-plx: **no native rebuild, no binding/lock concern** (unlike Plaud).
- **Advertising**: the audio service UUID `19b10000-…` is in the ADV packet, but the
  NAME (`SATE Pendant`) is only in the SCAN RESPONSE → iOS surfaces it as
  `localName`, not `name`, and `name` may be a STALE cached GAP name from an earlier
  firmware. So: **scan with NO service filter**, and match on `name` OR `localName`
  OR the advertised audio service. Verify what the device really broadcasts by
  scanning from the Mac (`bleak`) before blaming the app.
- 🛑 **Flash with the SEEED core, NOT the Adafruit Feather core.** FQBN
  `Seeeduino:nrf52:xiaonRF52840SensePlus`. The Adafruit `feather52840sense` links the app
  at `0x26000` → overwrites the last page of the S140 7.3.0 SoftDevice → BLE stack
  corrupted: **app runs but NEVER advertises, no CDC port** (hardfaults in
  `Bluefruit.begin()`). Correct core links at `0x27000` (the UF2 conversion prints it —
  `0x26000` = STOP). Recover a corrupted (or factory-fresh) board by DFU-restoring Seeed's
  SoftDevice+bootloader (`adafruit-nrfutil dfu serial … Seeed_…_s140_7.3.0.zip`), then
  reflash. `flash_xiao.sh` now uses the Seeed core + aborts on `0x26000`. Full recipe:
  `doc/09-pendant.md` + `~/Desktop/necklace-insole/firmware/HARDWARE.md`.
- **Mic is very quiet.** The app peak-normalizes + applies a loudness drive with a
  tanh soft-clip (`applyGain` in `PendantLink.ts`; tune `LOUDNESS`/`MAX_GAIN`). The
  firmware has its own `MIC_GAIN`/`DIGITAL_GAIN` — don't stack both to the point of
  clipping.
- **Stop must gate accumulation.** BLE notifications keep arriving after `CMD_STOP`;
  without the `capturing` flag they tack extra seconds onto the take (duration crept
  to 0:01/0:02 after Stop).
- Paired pendants persist in AsyncStorage (`PendantStore.ts`) — a known pendant
  reconnects straight by BLE id, no rescan. **Nap mode**: a notification gap while
  connected is NORMAL (the pendant sleeps in silence), not a disconnect.
- Recordings upload as **Standalone** by default — assigning a patient is optional
  and can be done later on the web report. Don't force patient assignment at capture.

**Dev environment**
- **The dev Mac's LAN IP is dynamic** — a stale IP breaks both app launch and provisioning.
  Check `ipconfig getifaddr en0` first when things "suddenly" can't reach the Mac.

**Features**
- **Mobile-link QR login** (2nd login method): web mints a one-time code/QR, the phone
  consumes it for a real session (`mobile-link` edge fn + `mobile_link_codes` table). Needs
  a native rebuild (expo-camera) + web redeploy (qrcode.react) to change.
- **Flag markers** are one pipeline shared by SATE hardware (physical flag button) and Plaud
  (device tap): ms offsets → `flags` column → `recordings.flags` → seek-bar ticks on the web
  report. Reuse it; don't fork a parallel path.

## Docs

`doc/` is the numbered project handbook (`08-plaud.md` = Plaud). `plaud-integration.md`
(repo root) is the Plaud deep dive. Keep docs current when behavior changes. Deeper /
cross-session context lives in the agent memory at
`~/.claude/projects/-Users-hoanglong-Documents-sate-companion/memory/`.
