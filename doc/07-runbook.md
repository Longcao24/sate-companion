# 07 — Runbook

Build, flash, deploy, go-live, and troubleshooting for the SATE recorder system.

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

## Firmware (ESP32-S3)

### ⚠️ Real board specs (verified on hardware via esptool — the old docs were wrong)

The S3 module is **16 MB flash + 8 MB octal PSRAM**, flash mode **DIO**:

- `FlashSize=16M` (NOT 8M — an 8M-header bootloader on a 16 MB board can hang at the first frame)
- `PSRAM=opi` (8 MB embedded PSRAM = octal)
- Flash mode **DIO** — flashing **QIO boots to a dead black screen** (bootloader can't read flash)
- `esptool` confirms: `Chip: ESP32-S3 … Embedded PSRAM 8MB (AP_3v3) … Detected flash size: 16MB`

**Production FQBN** (no debug CDC → USB enumerates as JTAG only, port stays a stable
`/dev/cu.usbmodem101`):

```
esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=huge_app
```

### `arduino-cli` sketch-name rule

`arduino-cli` requires the sketch **folder name to match the `.ino`**. The repo folder
`Hardware_w_Screen/` (or `SATE_Touch_Patient_Record_Play_White/`) — if the folder holding the
`.ino` isn't named `SATE_Touch_Patient_Record_Play_White`, copy the `.ino`/`.cpp`/`.h` into a temp
dir of that name and build there. Always compile `--clean` after a `lv_conf.h` change (stale lvgl
cache → runtime `heap_caps_free` assert; see [02-firmware.md](02-firmware.md#display-lvgl--the-internal-ram-budget)).

```bash
DIR=SATE_Touch_Patient_Record_Play_White
arduino-cli compile --clean \
  --fqbn "esp32:esp32:esp32s3:PSRAM=opi,FlashSize=16M,PartitionScheme=huge_app" \
  --output-dir "$DIR/build" "$DIR"
```

### Flashing over USB (full, lock-safe)

The reliable path is a **full erase + write the merged bin at 0x0** (overwrites bootloader +
partitions + app; fixes a partial/bad prior flash). Use the esptool bundled with the core:

```bash
ET=~/Library/Arduino15/packages/esp32/tools/esptool_py/*/esptool
P=/dev/cu.usbmodem101
"$ET" --chip esp32s3 --port $P --baud 921600 erase_flash        # ⚠️ ALSO WIPES NVS (see below)
"$ET" --chip esp32s3 --port $P --baud 921600 --before default_reset --after hard_reset \
  write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 "$DIR/build/SATE_Touch_Patient_Record_Play_White.ino.merged.bin"
```

- **⚠️ `erase_flash` wipes NVS** — the device's Wi-Fi creds + account claim live there. After a full
  erase the device is factory-blank (`provisioned=0`, boot log shows `nvs_open failed: NOT_FOUND`)
  and **must be re-provisioned through the app** (BLE setup). If you only want to update code without
  un-claiming, skip `erase_flash` and just `write_flash` the merged bin.
- **Port flips `101` ⇄ `2101`.** With a debug build (`CDCOnBoot=cdc`) the app CDC and the
  USB-Serial-JTAG are separate interfaces and macOS renumbers them across resets/crashes; only the
  JTAG port (`101`, or whichever `esptool … flash_id` connects to) can be flashed. If it's gone,
  **unplug USB ~3 s and replug** (no buttons) to bring it back; or force ROM download mode
  (hold BOOT, tap RESET, release BOOT). The **production FQBN above avoids the flip** (no extra CDC
  interface).

### Reading the boot/register serial log

`Serial` output only appears when built with `CDCOnBoot=cdc,USBMode=hwcdc`. Plain `cat` won't reset
the board and, on the USB-Serial-JTAG, only flushes once the host asserts **DTR**. Use a tiny
pyserial reader that opens the port and pulses reset-to-run (RTS→EN low/high with DTR high = run,
no bootloader):

```python
import serial, time, sys
s = serial.Serial("/dev/cu.usbmodem101", 115200, timeout=0.2)
s.setDTR(False); s.setRTS(True); time.sleep(0.2); s.setRTS(False)   # reset-to-run; assert DTR for HWCDC
t0 = time.time()
while time.time() - t0 < 15:
    c = s.read(512)
    if c: sys.stdout.buffer.write(c); sys.stdout.flush()
```

Key lines: `[MEM] boot/ready … largest=<maxAlloc>` (internal-heap watermark) and
`[CONN] register attempt N code=<c> freeHeap=… maxAlloc=…`. A register `code=-1` with a small
`maxAlloc` is the TLS-heap starvation described in
[02-firmware.md](02-firmware.md#why-the-internal-ram-budget-matters-register-code--1).

### Two symptoms that look like a bad flash but are NOT

| Symptom | Cause | Fix |
|---|---|---|
| Screen bright, **frozen at boot spinner**, never advances | `lv_conf.h` `LV_TICK_CUSTOM 0` (reset by an lvgl reinstall) | set `LV_TICK_CUSTOM 1`, recompile |
| **"Server registration failed (code -1)"** on setup, no POST in edge logs | mbedTLS handshake can't get 2×16 KB contiguous internal RAM | LVGL heap + draw buffers → PSRAM (already in tree); check `maxAlloc` ≥ ~34 KB |

- If the port is **busy**, a serial monitor / `cat` is holding it: `lsof /dev/cu.usbmodem101`
  then `kill <pid>`. **Do not `cat` the serial port mid-record** — DTR/RTS resets the board.
- `[MEM] min` in the serial log is the free-internal-heap watermark — watch it on long sessions
  and TLS handshakes.

### Firmware version history

| Version | Change |
|---------|--------|
| 0.9.1 | Rollback-safe baseline (tag `fw-0.9.1-working`, `03cfead`) |
| 0.9.3 | Fix `scanPending()` hiding sessions after a purged-audio one (`224fbbf`) |
| 1.0.0 | Direct device → Supabase upload + AI → `recordings` |
| 1.0.2 | Supabase apikey header, TLS for HTTPS, chunk-path fix, register logging |
| 1.0.3 | **Touch-lag fix**: poll 3 s→12 s, `setInsecure()` once, GUI pump around poll ([02](02-firmware.md#touch-lag-fix-fw-103)) |
| 1.5.9 | **Offline-backlog fix + no auto-delete** (see below) |
| 1.5.10 | Adds the `resync_all` command |

### Publishing an OTA release

Publishing only marks a build as "latest" (a row in `sate_firmware` + the `.bin` in the public
`firmware` bucket). **It does not flash anything** — a recorder only updates when an `ota` command
is queued for that specific device. So publishing is safe; flashing is per-device and deliberate.

```bash
# 1. build, 2. upload the bin, 3. verify it byte-for-byte, 4. insert the release row
npx supabase storage cp ota_build/sate-fw-<v>.bin ss:///firmware/sate_<v>.bin \
  --linked --experimental --content-type application/octet-stream
curl -s https://<ref>.supabase.co/storage/v1/object/public/firmware/sate_<v>.bin -o /tmp/check.bin
cmp ota_build/sate-fw-<v>.bin /tmp/check.bin   # must match before you insert the row
```

The file must be named `sate_<version>.bin` (what `publishFirmware` writes and what the web card's
version regex expects).

### ⚠️ OTA fails with `err-get-1` on a device with a backlog — reboot it first

A recorder that has been grinding through uploads for a while **cannot start an OTA**:

```
ota_state = "err-get-1"     # http.GET() → -1 = HTTPC_ERROR_CONNECTION_REFUSED
```

The web banner says *"Update didn't start"*, which is misleading — the device received the command
and tried. `runOtaUpdate()` opens a **second** `WiFiClientSecure` while the command poller's client
still holds a keep-alive session, and the mbedtls handshake needs a ~40 KB contiguous block. On a
heap fragmented by hours of 1 MB chunk uploads that allocation fails. A freshly-booted device with
the same URL works — which is why a spare board OTAs fine and the stuck one doesn't.

**Diagnosis tell:** the heartbeat reporting `err-get-1` reaches the server over the *same host* that
just failed. Same host, same second, one client up and one down ⇒ resources, not network.

**Fix — queue the reboot and the OTA separately:**

```sql
insert into sate_device_commands (device_id, op) values ('dev-sate-xxxx', 'reboot');
-- wait for it to reboot (ota_state resets to 'idle', last_seen goes fresh), THEN:
insert into sate_device_commands (device_id, op, patient) values ('dev-sate-xxxx', 'ota',
  '{"url":"https://<ref>.supabase.co/storage/v1/object/public/firmware/sate_<v>.bin","version":"<v>"}'::jsonb);
```

`pollCommands()` runs **before** the upload block in `connLoop`'s `CONN_WIFI_ONLINE` pass and
`runOtaUpdate()` is called synchronously inside it, so the first poll after boot flashes with a
clean heap before the uploader ever starts. Do **not** queue both at once — they'd arrive in the
same poll. Verified working twice on `SATE-D0FDD4`.

### Re-uploading everything (`resync_all`, fw ≥1.5.10)

Drops the `.synced` marker of every session **whose audio is still on the card**, so the whole
backlog re-uploads. Use it to recover sessions the server acknowledged but never actually stored.

```sql
insert into sate_device_commands (device_id, op) values ('dev-sate-xxxx', 'resync_all');
```

Sessions whose audio an older firmware already purged keep their marker on purpose: that marker is
the only thing holding their slot, and `scanPendingLocked()` stops at the first slot with no wav,
no parts and no marker — clearing it would hide every later session.

Re-uploading a session the server already has is safe: `/sessions/chunk` answers the final slice
from the existing row (after confirming its object really exists), so it costs bandwidth only.

## Backend (Supabase edge functions)

Deployed via MCP / Supabase tooling (deploy ≠ git push):

- `device-api` — device + app REST surface.
- `process-device-session` — AI/recordings bridge.

Function secrets to keep set: `AI_PROCESS_URL` (if the ngrok URL rotates), `PROCESSOR_SECRET`.

## Go-live checklist (hardware in the loop)

1. **AI tunnel up:** `https://sate-v1-5.ngrok.io/process` reachable (or `AI_PROCESS_URL` points
   at a live host). Manual web upload working == AI working.
2. **Edge functions deployed:** `device-api` + `process-device-session` live on
   `zlgdpivcbmaodgokkdvz`.
3. **Flash** the current firmware to the recorder.
4. **App:** sign in as the SLP, then onboard the device (BLE): scan → Wi-Fi creds → Send. The
   device registers and auto-claims to the account.
5. **Record** on the device → it auto-uploads → after processing it appears in `recordings` and
   in the web app, auto-assigned to the patient.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| App can't see the device in onboarding | Scan started before BLE `PoweredOn` (fixed via `onStateChange` gating). Confirm the device advertises (`SATE-XXXXXX`, service UUID). |
| "Server registration failed" / 401 at register | Expired Supabase session with no refresh → empty claim token. Sign out + back in (populates refresh token), retry. Register route accepts `/register` and `/devices/register`. |
| Touch lags after Wi-Fi connect | Blocking TLS handshake on the GUI core every poll. fw 1.0.3 mitigates; proper fix = networking on core 0. |
| Device uploaded but no `recordings` row | `process-device-session` failed/timed out (`process_error` set). Re-invoke it in sweep mode; check the AI tunnel is up. |
| Web app shows no device recordings | See the live debugging notes for the current investigation; check `sate_device_sessions.processed`, `recording_id`, and that `recordings.patient_id` resolved. |
| App launch / provisioning broken after network change | Stale Mac LAN IP. `ipconfig getifaddr en0`, update the dev host. |
| Wi-Fi scan returns 0 APs | BLE/Wi-Fi coexistence; firmware retries the scan once under `ESP_COEX_PREFER_BALANCE`. |

## Constraints

- **Do not `git push` without explicit instruction.** Supabase edge-function deploys are allowed
  (deploy ≠ push).
