# 07 — Runbook

Build, flash, deploy, go-live, and troubleshooting for the SATE recorder system.

> **Current versions (verify against source before trusting):** recorder firmware
> `FIRMWARE_VERSION = "1.5.32"` (`SATE_Recorder/SATE_Recorder.ino:119`); `device-api`
> edge fn `[v18]` (in-comment version, `react_app_sate-ui_update/supabase/functions/device-api/index.ts:1`).
> Version numbers drift — `git log` and the two files above are the source of truth.

The one-command tool for almost everything here is the **`sate` CLI** (`hwtest/sate`, a
zero-install launcher for the `hwtest` Python package). See [The `sate` CLI](#the-sate-cli).

---

## Companion app (Expo / RN)

```bash
# Metro + iOS dev client (BLE needs a dev build, not Expo Go)
EXPO_NO_TELEMETRY=1 npx expo start --dev-client --host lan --port 8081

# Build + install on a connected iPhone (native rebuild)
npx expo run:ios
```

- JS changes hot-reload over Metro (no rebuild). Native/module changes need `expo run:ios`.
- Metro serves the JS bundle at `http://<mac-lan-ip>:8081`. The Mac LAN IP is **dynamic** —
  check `ipconfig getifaddr en0` if launch/provisioning breaks.
- Signing: team `2NZUAZ4TMM`, bundle `com.auspexmedix.satecompanion`. (A free Apple-ID cert was
  revoked previously; regenerate in Xcode if a fresh standalone install fails.)
- Compile-check the native module without a device/signing:
  `xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`
- **iOS-only** (the Plaud SDK is arm64 device-only — no simulator). Proprietary Plaud
  frameworks (`modules/plaud-sate/ios/Frameworks/`) are git-ignored — never commit them.

---

## Firmware (ESP32-S3 recorder)

### ⚠️ Real board specs (verified on hardware via esptool — the old docs were wrong)

The S3 module is **16 MB flash + 8 MB octal PSRAM**, flash mode **DIO**:

- `FlashSize=16M` (NOT 8M — an 8M-header bootloader on a 16 MB board can hang at the first frame)
- `PSRAM=opi` (8 MB embedded PSRAM = octal)
- Flash mode **DIO** — flashing **QIO boots to a dead black screen** (bootloader can't read flash).
  `arduino-cli upload` sets the mode itself; only a manual merged-bin `esptool` flash needs `dio` spelled out.
- `esptool` confirms: `Chip: ESP32-S3 … Embedded PSRAM 8MB (AP_3v3) … Detected flash size: 16MB`

**Production FQBN** (`RECORDER_FQBN` in `hwtest/hwtest/cli.py:34` — no debug CDC, so USB
enumerates as JTAG only and the port stays a stable `/dev/cu.usbmodem101`):

```
esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi
```

⚠️ **`PartitionScheme=default_8MB` is MANDATORY — dual OTA slots (`ota_0`+`ota_1`), so OTA works.
NEVER `huge_app`** — it is literally "3MB **No OTA**", a single app slot; flashing it silently
kills OTA (the device records/registers but can never self-update). `PSRAM=opi` is also mandatory.

**Debug build** — append `,CDCOnBoot=cdc,USBMode=hwcdc` to expose the CDC serial log
(`[MEM] ready`, `[CONN] uploaded …`, `[REC] resume …`). Production builds emit **no serial**.
The hwtest harness (`sate ci` / `sate test`) needs the debug build to read the log; `sate flash
recorder --debug` and `sate ci` add these flags automatically.

### 🛑 The two silent bricks — check these BEFORE blaming a flash

| Symptom | Cause | Fix |
|---|---|---|
| Screen bright, **frozen at boot spinner**, never advances; `setup()` still reaches `[MEM] ready` on serial | `lv_conf.h` `LV_TICK_CUSTOM 0`. The firmware calls `lv_tick_inc()` NOWHERE and relies entirely on `LV_TICK_CUSTOM=millis()`; with it `0`, LVGL's clock is frozen at frame 1 and nothing ever repaints | `~/Documents/Arduino/libraries/lv_conf.h` → line ~88 `#define LV_TICK_CUSTOM 1` **AND** montserrat 12/14/20 enabled; recompile. **Reinstalling lvgl resets this back to 0** — re-check after any `lib install lvgl`. |
| **"Server registration failed (code -1)"** at setup, no POST in edge logs | mbedTLS handshake can't get ~2×16 KB contiguous internal RAM | LVGL draw buffers + heap → PSRAM (already in tree: `display.cpp` `MALLOC_CAP_SPIRAM`, `lv_conf.h` `LV_MEM_CUSTOM 1`/`ps_malloc`). Check `[CONN] register attempt … maxAlloc=` ≥ ~34 KB. |
| Boot log never reaches `[MEM] ready` | SD / audio / services hang in `setup()` | run `sate doctor --device` — it resets the board and diagnoses SD (`SD_MMC.begin failed`), codec (`ES8311 init failed`), PSRAM (`psram free = 0`), boot-loops, and crashes. |

### iCloud lvgl compile stall

`~/Documents/Arduino/libraries` sits under **iCloud Drive**. lvgl gets evicted to 0-block
placeholders and `cc1plus` then blocks forever in `read()` on the lvgl preprocess — looks like a
hang, it is iCloud on-demand download stalling. Fix:

```bash
arduino-cli lib uninstall lvgl && arduino-cli lib install lvgl@8.4.0   # re-materialise
# THEN re-fix lv_conf.h: LV_TICK_CUSTOM 1 + montserrat 12/14/20 (the reinstall drops both)
```

Long-term: disable "Optimize Mac Storage" or move the sketchbook out of iCloud. If `arduino-cli
init` hangs fetching the board index, `arduino-cli config delete board_manager.additional_urls`.

### Build the recorder

The sketch is `SATE_Recorder/SATE_Recorder.ino` — the folder name matches the `.ino`, so
`arduino-cli` builds it in place (no temp-copy). Compile `--clean` after any `lv_conf.h` change
(stale lvgl cache → runtime `heap_caps_free` assert; see
[02-firmware.md](02-firmware.md#display-lvgl--the-internal-ram-budget)).

```bash
# easiest — the CLI adds the debug flags and picks the port:
sate flash recorder --debug            # compile + upload (debug/CDC build)
sate flash recorder                    # production build (no serial)
sate flash recorder --compile-only     # compile, don't upload

# raw arduino-cli (production build):
arduino-cli compile \
  --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" \
  SATE_Recorder
arduino-cli upload -p /dev/cu.usbmodem101 \
  --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" \
  SATE_Recorder
```

### Flashing over USB (full, lock-safe — for a stuck / half-flashed board)

The reliable path is a **full erase + write the merged bin at 0x0** (overwrites bootloader +
partitions + app). Use the esptool bundled with the core:

```bash
ET=~/Library/Arduino15/packages/esp32/tools/esptool_py/*/esptool
P=/dev/cu.usbmodem101
"$ET" --chip esp32s3 --port $P --baud 921600 erase_flash        # ⚠️ ALSO WIPES NVS (see below)
"$ET" --chip esp32s3 --port $P --baud 921600 --before default_reset --after hard_reset \
  write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 "SATE_Recorder/build/SATE_Recorder.ino.merged.bin"
```

- **⚠️ `erase_flash` wipes NVS** — Wi-Fi creds + the account claim live there. After a full erase
  the device is factory-blank (`provisioned=0`, boot log `nvs_open failed: NOT_FOUND`) and **must
  be re-provisioned through the app** (BLE setup) or `sate provision --claim-token …`. To update
  code WITHOUT un-claiming, skip `erase_flash` and just `write_flash` the merged bin.
- **`SATE_Recorder.ino.merged.bin`** is the full 8 MB image — USB / first-flash only.
  The **OTA image is the APP bin** `SATE_Recorder.ino.bin` (~1.7 MB) — see
  [Publishing an OTA release](#publishing-an-ota-release).
- **A serial DTR/RTS reset CANNOT reboot a device that is RECORDING** on the debug build: `Serial`
  is USB-CDC, its reset is software-handled, and the capture loop never services USB. Use the
  remote `reboot` command. Flashing is unaffected — esptool resets through the USB-Serial-JTAG
  hardware, which works even when the firmware is wedged.
- **Port flips `101` ⇄ `2101`** on the debug build (`CDCOnBoot=cdc` adds a second USB interface
  macOS renumbers across resets). Only the JTAG port (`101`) can be flashed. If it's gone,
  **unplug USB ~3 s and replug** (no buttons), or force ROM download mode (hold BOOT, tap RESET,
  release BOOT). The **production FQBN avoids the flip** (no extra CDC interface).

### Reading the boot/register serial log

`Serial` output only appears on a `CDCOnBoot=cdc,USBMode=hwcdc` build. Plain `cat` won't reset the
board and only flushes once the host asserts **DTR**. Easiest: `sate monitor --reset` (mirrors the
live state) or `sate doctor --device`. Manual pyserial reader:

```python
import serial, time, sys
s = serial.Serial("/dev/cu.usbmodem101", 115200, timeout=0.2)
s.setDTR(False); s.setRTS(True); time.sleep(0.2); s.setRTS(False)   # reset-to-run; DTR high = HWCDC
t0 = time.time()
while time.time() - t0 < 15:
    c = s.read(512)
    if c: sys.stdout.buffer.write(c); sys.stdout.flush()
```

Key lines: `[MEM] boot/ready … int free= … largest= … min= … psram free=` (heap watermarks) and
`[CONN] register attempt N code=<c> … maxAlloc=…`. A register `code=-1` with a small `maxAlloc`
is TLS-heap starvation ([02-firmware.md](02-firmware.md#why-the-internal-ram-budget-matters-register-code--1)).
If the port is **busy**, a monitor/`cat` is holding it: `lsof /dev/cu.usbmodem101` then `kill <pid>`.

### Firmware version history

`FIRMWARE_VERSION` is a single source-only string; prebuilt flash assets are still tagged
`fw-1.5.12` on the GitHub Release (`merged.bin` for flash-only + `sate-arduino-libs.zip`). Intermediate
version numbers with no row (1.5.21–1.5.23, 1.5.26) were internal bumps folded into the next release.

| Version | Change |
|---------|--------|
| 1.5.9  | Offline-backlog fix + no auto-delete |
| 1.5.10 | Adds the `resync_all` command |
| 1.5.12 | Bounded reclaim `trimPatientSyncedAudio` (keep newest 5 synced sessions per patient dir) |
| 1.5.13 | **Server-verified trim** (`GET /api/sessions/verify` before freeing SD audio) + reboot auto-resume of a local take |
| 1.5.14 | On-demand **screen mirror** over serial (`SCREENDUMP`) — debug/CDC builds only, refuses while recording |
| 1.5.15 | **Remote `stop` command** — before it, a server-started take could only end at the device or the ~62-min ceiling |
| 1.5.16 | **Every** take is crash-resumable (not just button takes); an app-started recording survives a reboot. `[REC] resume …` diagnostics |
| 1.5.17 | **Resume runs from `loop()`, not `setup()`** — resuming inside `setup()` meant `connStartNetTask()` never ran and the unit went dark (no heartbeat, no remote stop) for the whole take |
| 1.5.18 | A remote **`stop` issued while a take is starting is no longer swallowed** (`recTakeArmed`); before this a resumed take ran unbounded |
| 1.5.19 | **Exact-duration remote take** — `record` may carry `{seconds:N}`; the firmware caps the take sample-exact and self-stops (device-api **v16/v17**: `/sessions/upload-progress` + `record_seconds`) |
| 1.5.20 | **Sessions are NEVER renumbered.** Numbers monotonic, **wrap at 99**, holes legal; delete removes only its own files; the old renumber machinery (`sate-del` journal, `recoverInterruptedDelete`/`compactPatientDir`/`renameSessionFiles`) is GONE; a delete drops only that session's own in-flight upload (`upDropReq`). Plus the 55-fix audit |
| 1.5.24 | **Reclaim actually runs** — idle sweep `trimAllPatients()` every 5 min, **device-wide keep-newest-5**, no number reuse |
| 1.5.25 | **Standalone is the default target** — a server roster is NOT a patient assignment |
| 1.5.27 | Fixes the four defects the third reclaim/numbering audit found |
| 1.5.28 | SD handshake covers every net-task path; standalone slot guaranteed; live state for button takes |
| 1.5.29 | Sessions list shows only takes with audio still on the card, not synced tombstones |
| 1.5.30 | **Offline crash-resume starts the net task before blocking**, so a resumed take stays stoppable even if Wi-Fi is down at boot |
| 1.5.31 | Block cross-account audio upload (`owner_dev`); rank keep-newest-5 by monotonic `take_seq` |
| 1.5.32 | **Current.** Reclaim no longer starved by unverifiable takes (verify **strike/park**); crash-give-up stamps `owner_dev` so segments still upload. device-api → **v18** (error-email digest) |

---

## SD audio reclaim — how it works (fw ≥1.5.24, verify-gated)

The device is the only copy of a take until it is **provably** on the server, so reclaim is
gated on a server round-trip, never on the local `.synced` marker alone. Lives in
`SATE_Recorder/connectivity.cpp`.

- **Keep-newest-5 is DEVICE-WIDE** (`KEEP_AUDIO_SESSIONS = 5`). `trimAllPatients()` keeps the
  newest 5 audio-bearing takes in the **active** patient dir and fully reclaims every **stale**
  dir (keep 0) — all verify-gated. "Newest" ranks by `take_seq`, a global monotonic counter
  stamped into each session JSON (session *numbers* wrap at 99, so ranking by number was wrong).
- **Verify gate:** `verifySessionStored()` must get a byte-exact `stored:true` from
  `GET /api/sessions/verify` (device-key auth, read-only, device-api ≥v15) before
  `freeSessionAudioKeepMarker()` frees anything. `sessionAssembledBytes()` mirrors the server's
  stored `bytes` exactly (part0 keeps its 44-byte header, later parts stripped). Any doubt —
  offline, non-2xx, parse fail, byte mismatch — **keeps the audio**; trim retries next cycle. It
  frees only the audio and keeps a `.synced` **tombstone** so the slot number stays occupied.
- **Idle cadence:** the sweep runs only when there's nothing to upload, every
  `TRIM_SWEEP_PERIOD_MS = 5 min` (before 1.5.24 reclaim ran *only after an upload*, so once the
  backlog drained the card filled forever while Home said "all synced").
- **Strike / park (1.5.32):** a take the server keeps answering `stored:false` for (a false-2xx or
  BLE `mark_synced` ghost with no object) is never freed and never re-uploaded, so it re-spent the
  verify budget on every sweep and starved reclaim of the active dir. After `VERIFY_MAX_STRIKES = 3`
  *definitive* `stored:false` answers it is **parked** for `VERIFY_PARK_RETRY_MS = 6 h` — it spends
  no budget until its cooldown re-checks it. Only a clean 2xx `stored:false` strikes; offline /
  non-2xx / parse failures stay free retries. Per-pass caps: `TRIM_MAX_FREES_PER_PASS = 2`,
  `TRIM_MAX_VERIFIES_PER_PASS = 8` (a verify is a 2–4.5 s HTTPS round-trip; caps stop a sweep
  holding the SD bus and starving the UI's 120 s delete guard).
- **`owner_dev` gate (1.5.31/1.5.32):** each take's JSON is stamped with the claiming device id.
  A take stamped by another account is never uploaded under this one; a crash-give-up still stamps
  `owner_dev` so its segments upload. `resync_all` is the only path that **adopts** unstamped /
  prior-claim audio to the current claim (`adoptSessionOwner()`) — a deliberate act of whoever
  physically holds the device.

Full deletion stays user-only (`deleteSessionFiles()`, the Delete button). Never free audio on a
`.synced` marker alone — a marker only means "a POST returned 2xx" (or an app BLE `mark_synced`),
NOT "durably stored". See agent-memory `no-renumber-sessions` and [05-backend-supabase.md](05-backend-supabase.md).

---

## The `sate` CLI

`hwtest/sate` is a zero-install launcher (`python3 -m hwtest.cli`); `pip install -e hwtest` puts
`sate` on PATH. Config is `hwtest/config.toml` (`[account]` email/password, `[server]`
base_url/device_serial/device_id/device_key, `[record]`). `PROTECTED_SERIALS = ("SATE-D19EB8",)`
— the real in-use unit; `ci`/`e2e` **refuse** to run against it.

| Command | What it does |
|---------|--------------|
| `sate ci` | **The standard firmware gate.** Reads `FIRMWARE_VERSION`, compiles + flashes the debug build, verifies the serial line is *alive* (not just enumerated — the USB-CDC wedge), signs in, runs the standard hands-off suite, writes `hwtest/ci-reports/fw-<version>_<stamp>.json`, exits non-zero on any FAIL/ERROR. `--no-flash` gates whatever is already on the board. |
| `sate test` | Hardware-in-the-loop scenarios (recorder). `--sim` self-tests the harness with no board; `--only k1,k2`; `-l` lists scenarios; `-t pendant` runs the BLE pendant suite. |
| `sate e2e` | **Deep test:** drives one take remotely and follows it recorder → device-api (chunked upload) → Storage+DB row → `queued` → cf-processor claims → AI `/process` → `finalize-session` → `done`. Byte-verifies the object and checks the audio length vs the requested `--take`. Needs only the account + the device on Wi-Fi (no cable). |
| `sate infra` | **Connection test:** one probe per tier in audio order — Supabase Auth → DB (REST) → device-api → **`/sessions/verify` (the v15 route once missing from the deploy)** → Storage → Cloudflare processor Worker → pipeline state (queued/processing/error) → the bench device's heartbeat. Turns "the pipeline is stuck" into "THIS tier is down". |
| `sate pipeline` | Live animated map of the audio pipeline (desktop window, `pipeline_view.py`). |
| `sate flash <recorder\|pendant>` | Build + flash. `--debug` (recorder CDC serial), `--compile-only`, `--upload-only`, `--version 1.5.12` (flash a published older build to repro a field bug), `--image <bin>`. Pendant → `flash_xiao.sh` (Seeed core). |
| `sate firmware` | List every image `sate flash --version` can put on a board (local cache + GitHub release assets). |
| `sate devices` | List serial ports (`--ble` also BLE-scans for the pendant). |
| `sate doctor` | Check the toolchain/environment; `--device` resets the attached board and diagnoses real hardware faults (SD, codec, PSRAM, boot-loop, crash, register failure). |
| `sate provision --wifi "SSID:PW" [--claim-token … --server …]` | Push Wi-Fi over BLE — register/claim with a token, or change-wifi (keeps the account). |
| `sate monitor [--reset]` | Mirror the recorder's live state from its serial log. |
| `sate screenshot -o screen.png` | Capture the recorder's screen (debug build, `SCREENDUMP`). |
| `sate debug` / `sate gui` / `sate dashboard` | Native Debugger app (screen mirror + remote control + `sate flash --version`) / native test window / browser dashboard. |
| `sate version` | Show CLI + firmware source versions. |

### The scenarios (`hwtest/hwtest/scenarios.py`)

`sate test` runs all nine; `sate ci` runs `CI_SCENARIOS` (`cli.py:107`) — **the seven hands-off
ones** (no one at the bench, remote record/stop/reboot):

| Key | Asserts | Bug it guards |
|-----|---------|---------------|
| `boot_health` | Boots to `[MEM] ready`, no crash/hang | LV_TICK_CUSTOM=0 boot-hang; heap/PSRAM regressions |
| `reboot_resume` | A take interrupted by a reboot auto-resumes into the same session | didn't auto-continue after reboot (60 s flush window / empty part00 delete) |
| `byte_match` | Uploaded bytes on the server == bytes the device sent | silent audio mismatch/truncation SD↔upload↔server |
| `verified_trim` | SD audio freed ONLY after the server confirms it | uploader auto-deleting the only copy on a `.synced` marker alone |
| `unsynced_kept` | A take the server has NOT confirmed is never freed, at any age | reclaim deleting the only copy of a not-durably-stored take |
| `reclaim_idle` | Synced audio beyond the newest 5 IS reclaimed while the device sits idle | reclaim only ran after an upload → card filled forever while Home said "all synced" |
| `standalone_default` | A server roster is NOT an assignment — recordings stay Standalone | recorder silently filed standalone reports under the first patient in the roster |

Two more need someone at the device (NOT in `ci`): `delete_journal` (a reboot-interrupted delete
damages no OTHER session — numbers are stable since 1.5.20) and `delete_during_upload` (a delete
doesn't splice two takes; `upDropReq` aborts only the deleted one).

**Regression rule:** any new feature/fix re-runs `sate ci` before it lands (firmware, harness, or
backend); add `sate e2e` when the change touches the backend. The 1.5.16→1.5.18 chain is why —
each fix exposed the next latent bug, and only the full suite after every change caught them.

---

## Publishing an OTA release

> **`sate ci` is the mandatory gate — every firmware version MUST pass it (report in
> `hwtest/ci-reports/`) before release.** Never publish a version without a passing report.
> A compiler can't catch reboot-mid-record / verified-trim / crash-safe-delete regressions.

Publishing only marks a build "latest" (a `sate_firmware` row + the `.bin` in the public `firmware`
bucket). **It does not flash anything** — a recorder updates only when an `ota` command is queued
for that specific device. So publishing is safe; flashing is per-device and deliberate.

**The exact recipe:**

1. Bump `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`, compile (production FQBN,
   `PartitionScheme=default_8MB`), pass `sate ci`.
2. The OTA image is the **APP bin** `SATE_Recorder/build/SATE_Recorder.ino.bin` (~1.7 MB) — **NOT**
   `.ino.merged.bin` (the full 8 MB image, USB-flash only).
3. **Publish** = upload that `.bin` to the public `firmware` Storage bucket at path
   `sate_<version>.bin` (`upsert`, `application/octet-stream`) + insert a `sate_firmware` row
   `{version, url, notes}` where `url` is the bucket's public URL. `getLatestFirmware` orders by
   `created_at` so the newest row wins; re-publishing a version overwrites its `.bin` (no unique
   constraint on `version`). The file MUST be named `sate_<version>.bin` — `publishFirmware`'s
   regex requires plain semver `^\d+\.\d+\.\d+$`.

   Two ways:

   - **Web card** (`/admin` → "Publish firmware"): easiest for a human — uses the admin's browser
     session, no keys. It validates the image (semver + `0xE9` magic + size cap). But it needs a
     browser + admin login, so an agent can't drive it.
     ⚠️ **Known gap (audit 2026-07-22):** `POST /firmware` is routed ABOVE the `/admin` gate — any
     authenticated user can push fleet-wide OTA. It validates the image but still needs an
     `isAdmin()` gate (device-api `index.ts` + the cloudflare port). Fix before GA.
   - **Direct upload + row insert (the programmatic path — use this):**
     ```bash
     # 1) upload the app bin (KEY = the Supabase sb_secret_… key; the repo SERVICE_KEY svc-… is NOT it)
     curl -X POST "$SUPABASE_URL/storage/v1/object/firmware/sate_<v>.bin" \
       -H "Authorization: Bearer $KEY" -H "apikey: $KEY" \
       -H "Content-Type: application/octet-stream" -H "x-upsert: true" \
       --data-binary @SATE_Recorder/build/SATE_Recorder.ino.bin
     # 2) verify the public URL is 200 and its SHA-256 matches the local bin, THEN:
     #    insert into sate_firmware (version, url, notes) values
     #      ('<v>', '$SUPABASE_URL/storage/v1/object/public/firmware/sate_<v>.bin', '<notes>');
     #    — run via the Supabase MCP execute_sql. Project ref: zlgdpivcbmaodgokkdvz
     ```
     Do NOT deploy a throwaway edge function for this. Treat a pasted `sb_secret` as compromised
     and tell the user to rotate it afterward.
4. Queueing OTA to a backlogged device fails `err-get-1` — **reboot first** (next section).

### ⚠️ OTA fails `err-get-1` on a backlogged device — reboot it first

`runOtaUpdate()` (`connectivity.cpp:2496`) opens a **second** `WiFiClientSecure` whose mbedTLS
handshake needs a ~40 KB contiguous block. On a heap fragmented by hours of 1 MB chunk uploads that
allocation fails (`http.GET() → -1 = HTTPC_ERROR_CONNECTION_REFUSED`). A freshly-booted device with
the same URL works — which is why a spare board OTAs fine and the stuck one doesn't. The web banner
says *"Update didn't start"*, which is misleading — the device received the command and tried.

The code now proactively frees the poller's TLS before the OTA (`s_http.end()`/`s_httpsClient.stop()`,
then a dedicated `otaTls`), and **defers** OTA while a take is armed (`otaDeferred`, re-run from
`connLoop` when the take ends). But a fragmented heap can still fail, so the recipe stands: **queue
the reboot and the OTA separately.**

```sql
insert into sate_device_commands (device_id, op) values ('dev-sate-xxxx', 'reboot');
-- wait for it to come back (ota_state resets to 'idle', last_seen goes fresh), THEN:
insert into sate_device_commands (device_id, op, patient) values ('dev-sate-xxxx', 'ota',
  '{"url":"https://<ref>.supabase.co/storage/v1/object/public/firmware/sate_<v>.bin","version":"<v>"}'::jsonb);
```

(Or, user-facing: `POST /api/devices/:id/commands {op:"reboot"}` then `{op:"ota", patient:{url,version}}`.)
`pollCommands()` runs **before** the upload block in `connLoop`, and `runOtaUpdate()` runs
synchronously inside it, so the first poll after boot flashes with a clean heap before the uploader
starts. Do **not** queue both at once — they'd arrive in the same poll. Verified twice on `SATE-D0FDD4`.
Diagnosis tell: the heartbeat reporting `err-get-1` reaches the server over the *same host* that
just failed ⇒ resources, not network.

### Re-uploading everything (`resync_all`, fw ≥1.5.10)

Drops the `.synced` marker of every session **whose audio is still on the card** (and adopts
unstamped / prior-claim takes to the current owner), so the whole backlog re-uploads. Recovers
sessions the server acknowledged but never actually stored.

```sql
insert into sate_device_commands (device_id, op) values ('dev-sate-xxxx', 'resync_all');
```

Sessions whose audio was already reclaimed keep their tombstone marker on purpose (it holds the
slot number). Re-uploading a session the server already has is safe: `/sessions/chunk` answers the
final slice from the existing row (after confirming its object really exists), so it costs bandwidth only.

### Timed remote take (device-api ≥v17, fw ≥1.5.19)

```sql
insert into sate_device_commands (device_id, op, patient) values ('dev-sate-xxxx', 'record', '{"seconds":8}'::jsonb);
```

The firmware records **exactly** `seconds` of PCM and self-stops (sample-exact cap, no stop race).
`seconds` rides in the jsonb `patient` col; a payload with no `patient_id` never sets an active
patient. `sate e2e` uses this so its duration assertion is meaningful.

---

## Pendant firmware (XIAO nRF52840)

Repo `SATE_Pendant/` (`SATE_Pendant.ino` + `HARDWARE.md` + `INTEGRATION.md` + `flash_xiao.sh`).
Build/flash from repo root:

```bash
sate flash pendant                       # → flash_xiao.sh SATE_Pendant
./SATE_Pendant/flash_xiao.sh SATE_Pendant
```

🛑 **Flash with the SEEED core, NOT the Adafruit Feather core.** FQBN
`Seeeduino:nrf52:xiaonRF52840SensePlus` (`PENDANT_FQBN`, `cli.py:35`). The Adafruit
`feather52840sense` links the app at `0x26000` → overwrites the last page of the S140 7.3.0
SoftDevice → the BLE stack is corrupted: the app runs but **NEVER advertises, no CDC port**.
`flash_xiao.sh` uses the Seeed core and **aborts on the `0x26000` trap** (correct core links at
`0x27000`). Recover a corrupted/factory-fresh board by DFU-restoring Seeed's SoftDevice+bootloader
(`adafruit-nrfutil dfu serial … Seeed_…_s140_7.3.0.zip`), then reflash. Full recipe:
[09-pendant.md](09-pendant.md) + `SATE_Pendant/HARDWARE.md`. Streams raw PCM (16 kHz mono S16LE,
244 B/notify) over standard BLE → the app wraps it in a WAV → same upload pipeline,
`device_serial = pendant-<bleId>`. Pure ble-plx: no native rebuild, no binding/lock concern.

---

## Backend deploys (Supabase edge functions)

Deployed via the Supabase CLI / MCP (deploy ≠ git push). **Every one below validates its own token,
so all MUST deploy `verify_jwt:false` / `--no-verify-jwt`** — the MCP default `verify_jwt:true`
breaks recorder registration ("Setup link expired") and Plaud token minting.

```bash
supabase functions deploy device-api        --no-verify-jwt --use-api
supabase functions deploy finalize-session  --no-verify-jwt --use-api
supabase functions deploy mint-plaud-token   --no-verify-jwt
```

- `device-api` (`react_app_sate-ui_update/supabase/functions/device-api/index.ts`) — the device +
  app REST surface, versioned in-comment (**v18**); bump it when you change routes. Device upload
  uses device-key auth (`Bearer key-…`); Plaud uses a USER-authed `POST /sessions`.
- `finalize-session` — the **light half** of processing (analysis + INSERT `recordings` +
  `status=done`), called by the Cloudflare container. Fits the ~150 s edge limit.
- `process-device-session` — **must be a 200 no-op in prod** (device-api still fire-and-forgets to
  it, but it must NOT process or it races the container and duplicates recordings).
  ⚠️ **Audit 2026-07-22:** the copy **checked into the repo is NOT the no-op** — it still downloads
  the WAV, awaits the AI, and inserts `recordings`. Prod is deployed as the no-op; do **NOT** deploy
  the repo file as-is. Make it a real early-return before GA.
- **Never move the long AI call into an edge fn / plain Worker fetch.** Any serverless request
  (Supabase edge ~150 s, or a CF Worker ~100 s 524) kills a long synchronous transcription. The AI
  call lives ONLY in the long-running container. Keep `AI_PROCESS_URL` + `PROCESSOR_SECRET` set.
- Deploy `mint-plaud-token` with `--no-verify-jwt` (see [08-plaud.md](08-plaud.md)).

### The AI processor (Cloudflare Container, `cf-processor/`)

Processing is a state machine on `sate_device_sessions.status` (`queued → processing → done|error`).
New sessions auto-`queued` (column default). A **Cloudflare Container** (Python,
`sate-processor.longcao.workers.dev`) is a long-lived process with NO wall-clock: it
`claim_next_session()` (atomic, SKIP LOCKED) → downloads the WAV → **holds** the ngrok `/process`
call → copies audio to the recordings bucket → calls `finalize-session`.

Deploy: `cd cf-processor && wrangler deploy`. Knobs (`cf-processor/app/processor.py`):

- `AI_READ_TIMEOUT_S = 3600` — **1-hour** read ceiling on the AI `/process` call (large takes).
- `STUCK_MINUTES = 45` — the in-loop watchdog `requeue_stale_sessions()` reclaims a `processing`
  job a dead worker left stranded after 45 min. `pg_cron` pings the Worker `/tick` every minute to
  keep the container warm; the container's own loop drains the queue.
- `MAX_ATTEMPTS = 3` — after 3 attempts a stalled job → `error`. Transient failures
  (network/5xx/408/429) `requeue_session()` with backoff; permanent (4xx / no segments) → `error`.
  The user Retry button (`POST /sessions/:id/retry`, device-api ≥v14) re-queues an `error` session.

Full detail: [06-ai-pipeline.md](06-ai-pipeline.md) + [05-backend-supabase.md](05-backend-supabase.md).

### Web app deploy (git subtree → separate repo)

The web app (`react_app_sate-ui_update/`) deploys to a **separate repo** that Vercel builds:

```bash
# ALWAYS build first — the build is `tsc -b && vite build` with noUnusedLocals, so a merely-unused
# variable (TS6133) FAILS the build; typecheck alone won't catch what Vercel will (has broken deploys).
cd react_app_sate-ui_update && npm run build
cd .. && git subtree push --prefix=react_app_sate-ui_update webapp <branch>   # webapp = Longcao24/SATE_hardwave
```

---

## Status + error-email alerting ops

Two operator surfaces. Both are Cloudflare-hosted.

### Status worker (`status/`, `sate-status`)

A status.claude-style page with 90-day uptime, plus **error-email alerting**. `wrangler deploy`
in `status/`. A cron (`*/5 * * * *`) probes each **external** service in `TARGETS`
(device-api, Supabase API, Storage, AI `/process` — a CF Worker CANNOT probe same-account
CF resources, error 1042) and records to D1 (`sate-status`). On top of the up/down probes it emails
the operator on any NEW problem and again when it clears (`evaluateAndAlert`):

- **(a) a probed service DOWN**, and
- **(b) the pipeline error digest** — it fetches device-api `GET /api/health/alerts?key=…`
  (secret-gated by `HEALTH_ALERT_KEY`, device-api **v18**, read-only) and turns each
  `recent_errors` / `stuck_list` entry into a problem.

Alerts fire only on a **change** in the problem set (a signature of sorted keys — a lingering error
does not mail every 5 min), with a re-remind every `ALERT_REPEAT_MS = 6 h`; an all-clear email
when the set empties. Alert recipient: **`caothohoanglong2404@gmail.com`** (`ALERT_TO`). State
(last signature + last-sent) lives in D1 `alert_state`.

Deploy/secrets:
```bash
cd status && wrangler deploy
wrangler secret put HEALTH_ALERT_KEY      # must match device-api's HEALTH_ALERT_KEY env
wrangler secret put SUPA_ANON             # Supabase anon apikey (device-api needs an apikey header)
wrangler secret put CHECK_KEY             # optional — gates the on-demand /check probe
```
`vars`: `EMAIL_FROM = noreply@mail.long-cao.dev`, `EMAIL_FROM_NAME = SATE Alerts`. Uses the
Cloudflare **Email Sending** binding `EMAIL` — the `mail.long-cao.dev` sender domain must already be
onboarded (Dashboard → Compute → Email Service); an un-onboarded sender fails at `send()`, not
deploy. Force a probe/test: `GET /check?key=<CHECK_KEY>`. Schema: `status/schema.sql`.

### Service monitor (`monitoring/`)

A single-page admin dashboard (`monitoring/index.html`) polling device-api `GET /admin/status`
(admin-gated, service-role + `sate_admins`). Auto-refreshes every 15 s. Paste the device-api base
URL, the Supabase anon key, and an **admin JWT** into ⚙ Settings (stored in `localStorage` only —
no secrets in the file). Run `python3 -m http.server 8080 -d monitoring`, or deploy to CF Pages
**gated with Cloudflare Access** (it's an admin tool). `STATIC_VERSIONS` at the top holds build-time
app/web versions (bump per release); recorder fw is live from `sate_devices.fw`.

---

## Go-live checklist (hardware in the loop)

1. **AI tunnel up:** `AI_PROCESS_URL` (e.g. `https://sate-v1-5.ngrok.io/process`) reachable. A
   manual web upload processing == the AI is working. `sate infra` probes it (and everything else).
2. **Backend deployed:** `device-api` + `finalize-session` (both `verify_jwt:false`) on
   `zlgdpivcbmaodgokkdvz`; `process-device-session` the no-op; the **cf-processor container**
   deployed and warm (pg_cron `/tick`). Confirm with `sate infra`.
3. **Flash** the current firmware (`sate flash recorder`), and confirm it passed `sate ci`.
4. **App:** sign in as the SLP, onboard the device over BLE (scan → Wi-Fi creds → Send); it
   registers and auto-claims. (Or `sate provision --wifi … --claim-token … --server …`.)
5. **Record** on the device (button, or a remote `record`/`record {seconds}` command). It
   auto-uploads over HTTPS → the row appears `queued` → the container processes → after
   `finalize-session` it appears in `recordings` and the web app. **Standalone by default** — a
   patient can be assigned later on the web report.
6. Optional full proof: `sate e2e` follows one take recorder → Supabase → Cloudflare → AI → done and
   byte-verifies Storage.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Screen bright but frozen at boot spinner | `lv_conf.h` `LV_TICK_CUSTOM 0` (reset by an lvgl reinstall). Set to `1` + montserrat 12/14/20. Not a bad flash. |
| "Server registration failed (code -1)" at setup | mbedTLS handshake starved of contiguous internal RAM. LVGL buffers/heap in PSRAM (`display.cpp` SPIRAM, `lv_conf` `LV_MEM_CUSTOM 1`); `[CONN] register attempt … maxAlloc=` ≥ ~34 KB. |
| "Server registration failed" / 401 at register | Expired Supabase session, empty claim token. Sign out + back in (populates refresh token), retry. Register accepts `/register` and `/devices/register`. |
| `cc1plus` hangs forever compiling | iCloud evicted lvgl. `lib uninstall lvgl && lib install lvgl@8.4.0`, then re-fix `lv_conf.h`. |
| OTA fails `err-get-1` | Fragmented heap on a backlogged device. Queue `reboot`, wait for it to come back, THEN `ota`. |
| App can't see the device in onboarding | Scan started before BLE `PoweredOn`. Confirm it advertises `SATE-XXXXXX` + service UUID. |
| Device uploaded but no `recordings` row | Check `sate_device_sessions.status` + `process_error`. The **cf-processor container** processes — ensure it's warm (pg_cron `/tick`) and the ngrok tunnel is up. User Retry re-queues an `error`. Do NOT re-invoke `process-device-session` (no-op). `sate infra` localizes the down tier. |
| Card fills up despite "all synced" | Pre-1.5.24 reclaim only ran after an upload; check fw ≥1.5.24. Or a `stored:false` ghost is parked — `resync_all` re-uploads so it verifies for real. |
| Big session lands as a row with `process_error: "download failed: Object not found"` | Storage project-wide file-size limit (default 50 MB) < a ~118 MB take. It's 500 MB now — check that first. |
| Device can't reach the Mac after a network change | Stale Mac LAN IP. `ipconfig getifaddr en0`, update the dev host. |
| No alert emails despite an outage | `mail.long-cao.dev` sender not onboarded (fails at `send()`), or `HEALTH_ALERT_KEY`/`SUPA_ANON` unset on the status worker. `GET /check?key=…` to force a probe. |
| Serial port enumerated but SILENT (`sate ci` aborts) | The USB-CDC wedge — unplug the cable, replug, re-run. The device usually still works over Wi-Fi; only the log view is dead. |

## Constraints

- **Do not `git push` without explicit instruction.** Edge-function deploys are allowed
  (deploy ≠ push). The web subtree push is a deploy but goes to a separate repo — still only on request.
- Never flash `PartitionScheme=huge_app` (kills OTA). Never commit the Plaud frameworks.
- `ci`/`e2e` must never touch a `PROTECTED_SERIALS` unit (`SATE-D19EB8`).
</content>
