# SATE Recorder — Hardware Reference

On-device firmware for the SATE clinical speech recorder. This documents the
board, pin map, build/flash, the audio + storage + connectivity pipeline, and —
the part most worth reading — **how the firmware is optimized for memory, RAM,
and the two CPU cores** so long recordings run smooth and never reboot.

Firmware lives in `SATE_Recorder/` (sketch `SATE_Recorder.ino` — folder matches the
`.ino`, so `arduino-cli` builds it in place). Current source version: **fw 1.5.33**
(`FIRMWARE_VERSION`; dual-core, two external buttons, screen). No GitHub release has been cut for it
yet, so the prebuilt flash assets are still tagged `fw-1.5.12`. Rollback tag: `fw-0.9.1-working`.

**Looking for the device↔server contract** (how a recorder is claimed, what it sends, every
endpoint and header)? That is [§7](#7-connectivity--the-device--server-contract) — the pairing,
API-call, upload, verify, and OTA reference, written so you can reproduce a recorder's traffic
with `curl`. The **read/monitoring half** — the operator-facing endpoints for watching that
traffic — is [§7.13](#713-readmonitoring-api--watching-the-traffic-live).

> **Watch it live:** <https://status-sate.long-cao.dev/pipeline> — the animated pipeline map
> in the browser, signed in with your SATE account. No CLI install; monitoring only.

The **pendant** firmware (XIAO nRF52840, a separate wearable) lives in `SATE_Pendant/`
with its own `HARDWARE.md` + `flash_xiao.sh` — see that folder and `doc/09-pendant.md`.
(The old `1_core/` single-core fallback and duplicate sketch copies were removed;
`git log` has them if ever needed.)

> ### ⭐ Versioning rule (always)
> **Bump `FIRMWARE_VERSION` on EVERY change you flash — including a fix to the
> version you just shipped.** Never reuse a version number for different binaries.
> A bug fix on top of `1.2.5` is `1.2.6`, not "still 1.2.5": the dashboard reports
> the running version, OTA compares it, and "which build is on the board?" must
> have one answer. Bump in `SATE_Recorder.ino`
> (`FIRMWARE_VERSION`) and update the "Current good version" line above in the
> same change.

---

## 1. Board + chips

| Part | Detail |
|------|--------|
| Board | Freenove ESP32-S3 Display **FNK0104AB**, 2.8" |
| MCU | ESP32-S3, dual-core Xtensa LX7 @ 240 MHz |
| Flash | **16 MB** (mode **DIO** — qio = dead black screen on manual esptool flashing) |
| PSRAM | 8 MB **OPI** (octal) PSRAM |
| Screen | 2.8" **240×320 ILI9341** TFT (via TFT_eSPI) |
| Touch | **FT6336U** capacitive, I2C |
| Audio codec | **ES8311** (I2S): onboard analog mic in + speaker amp out |
| Storage | microSD over **SD_MMC 4-bit** bus |
| Power | USB-C (USB CDC serial on boot) |

Everything is on one board, zero external wiring for the demo.

---

## 2. Pin map

All pins are defined at the top of `SATE_Recorder.ino`.

### SD card — SD_MMC 4-bit
| Signal | GPIO |
|--------|------|
| CLK | 38 |
| CMD | 40 |
| D0 | 39 |
| D1 | 41 |
| D2 | 48 |
| D3 | 47 |

`SD_MMC.setPins(CLK, CMD, D0, D1, D2, D3)` then `SD_MMC.begin()`. 4-bit bus =
4× the bandwidth of 1-bit SPI; matters for streaming WAV at 32 KB/s.

### Audio — ES8311 over I2S
| Signal | GPIO |
|--------|------|
| MCLK | 4 |
| BCLK | 5 |
| DIN (codec→MCU, mic) | 6 |
| DOUT (MCU→codec, speaker) | 8 |
| WS / LRCK | 7 |

MCLK = sample_rate × 256 = 16000 × 256 = **4.096 MHz**.

### I2C — shared bus (touch + ES8311 control)
| Signal | GPIO |
|--------|------|
| SCL | 15 |
| SDA | 16 |
| Speed | 400 kHz |

One `Wire.begin(SDA, SCL, 400000)` shared by FT6336U touch and the ES8311
register interface. Begun once, before display init.

### Misc
| Signal | GPIO | Note |
|--------|------|------|
| BOOT button | 0 | active LOW, `INPUT_PULLUP`; hold 5 s = factory reset |
| RECORD button | 2 | external, active LOW, `INPUT_PULLUP` to GND (GPIO2 since fw 1.2.14; was 3) |
| FLAG button | 14 | external, active LOW, `INPUT_PULLUP` to GND (fw 1.2.0+) |
| **LCD backlight** | **45** | active HIGH; driven by **LEDC PWM** for auto-dim (fw 1.4.0, §8.25). Defined in the TFT_eSPI `FNK0104AB` setup, not the `.ino`. |
| **Battery sense** | **9** | ADC1, behind the board's on-board **0.5 divider** (read ×2). `batteryPercent()` → Home chip + heartbeat telemetry (§8.27). *Not* GPIO34 — that's a classic-ESP32 pin, wrong on the S3. |
| **IO3 — ground rail** | **3** | **Not a signal.** Driven a hard **LOW for the whole life of the firmware** (fw 1.5.33) so a button/LED common wired to IO3 always has a return path. See the note below. |

**IO3 as a ground rail (fw 1.5.33).** `GND_OUT_PIN 3` is set `OUTPUT`/`LOW` in
`setup()` — *before* the buttons, since a button common on IO3 has no return until
the pin is driven — and is latched low **through deep sleep** as well
(`rtc_gpio_set_direction` + `rtc_gpio_hold_en` in `enterBatterySleep()`, released
with `rtc_gpio_hold_dis` at the top of `setup()`). Without that hold the pin floats
while asleep and the **RECORD wake button would be dead**, because its ext0 wake
needs to pull GPIO2 down *through IO3*.
- ⚠️ **It is a GPIO, not the ground plane** — keep the sink under ~**20 mA**. A
  pull-up button is ~100 µA; an LED needs its own resistor. Never hang the
  speaker/backlight return on it.
- IO3 *is* an S3 strapping pin (JTAG_SEL) but strapping is sampled only at reset
  and nothing external drives it high, so driving it low afterwards is safe.
- IO3 is free because RECORD moved to GPIO2 in fw 1.2.14.

**Demo buttons (fw 1.2.0+):** two external push buttons in `SATE_Recorder/`.
- **RECORD (GPIO2):** on Home a press starts a take, press again stops it; from
  any other screen a press jumps back to Home. (BOOT/GPIO0 is factory-reset only.)
- **FLAG (GPIO14):** while recording, each press marks the current moment as an
  important event (a live `Flags: N` counter shows on the record overlay). The
  offsets ride the upload to the web report, shown as amber ticks on the seek bar.

GPIO2 is **not** an S3 strapping pin (those are 0/3/45/46), so it's the cleanest
free choice for RECORD - no boot-strap concern at all.

> **Instant response (fw 1.2.5+):** both buttons are **interrupt-latched** and all
> network work runs on a **second core**, so a press registers immediately even
> mid-upload/poll. This replaced an old 4–5 s delay where presses landed during a
> blocking HTTP call. See §8.15 (dual-core) and §8.16 (button ISR).

**UI history — read together with §8.24 (the current 1.5.0 Home).**
- **fw 1.2.4:** fully hardware-driven — recording started/stopped by the physical
  RECORD button; Home had **no on-screen record dial**; the record overlay had no
  on-screen Stop (press RECORD to stop). Playback kept an on-screen Stop.
- **fw 1.5.0 (current):** Home is standalone-focused — a **big tappable red record
  dot** (`ACT_RECORD`, same code path as the physical RECORD button, so tap *or*
  press works) + "Ready to Record" + one **Sessions** button. No patient rows, no
  "Next" button, "Standalone" never shown. ⚠️ **On-device playback is REMOVED**
  (units have no speaker): Sessions rows are **info + delete only** (§8.26). So
  "Playback keeps an on-screen Stop" no longer applies on shipping units.

⚠️ **Do NOT attach serial (`cat`/monitor) while recording** — opening the CDC
port toggles DTR/RTS and resets the board mid-take. Watch the on-screen UI
instead (see §3 for the same caveat on the record-and-upload path).

---

## 3. Build + flash

Toolchain: `arduino-cli` 1.5.x, ESP32 core 3.3.x.

**FQBN (exact, verified fw 1.5.12):**
```
esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi
```

Key options and why:
- `PSRAM=opi` — the board has OPI (octal) PSRAM; QSPI setting won't init it. **Mandatory.**
- `FlashSize=16M` — the module is 16 MB (esptool: *Detected flash size: 16MB*). Flash
  mode is **DIO** (a manual esptool qio write boots to a dead black screen; `arduino-cli
  upload` sets the mode for you).
- ⚠️ `PartitionScheme=default_8MB` — **"8M with spiffs (3MB APP/1.5MB SPIFFS)", which has
  TWO app slots (`ota_0` + `ota_1`).** OTA is a shipped feature and **requires dual app
  slots** — do **NOT** use `huge_app` ("3MB **No OTA**"): it gives one slot and **silently
  breaks OTA** (the device records/registers but can't flash a spare slot to self-update).
  The 1.5.12 sketch is ~1.72 MB = 51% of the 3 MB slot, fits with room for the spare. (The
  8MB partition table sits in the lower half of the 16MB flash; the upper half is unused —
  the base `esp32s3` FQBN has no stock 16MB dual-OTA scheme, and `default_8MB` is the
  proven OTA-safe choice.)

**Compile + flash** — the sketch folder `SATE_Recorder/` matches its `.ino`
(`SATE_Recorder.ino`), so `arduino-cli` builds it in place (no temp copy):
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
arduino-cli upload  -p /dev/cu.usbmodemNNNN --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
```

> **First USB upload after a stuck board:** if `esptool` reports *"Failed to
> connect … No serial data received"*, the running app owns the native USB-CDC and
> won't auto-reset. Put the board in **download mode** manually: hold **BOOT**, tap
> **RESET/EN**, release **BOOT**, then re-run upload. Subsequent updates can go OTA.

> ⚠️ **Never `--erase` a provisioned unit.** A full-chip erase wipes NVS = the stored
> Wi-Fi creds + SATE account/device-key, dropping the device back to first-time setup.
> A normal flash keeps NVS, so an updated build comes back already claimed. Only erase
> on a **first-ever** flash or a deliberate factory reset.

> ⚠️ **Post-flash the board may sit idle** (no serial, no heartbeat) instead of booting
> the new app — the S3's post-esptool reset doesn't always start the app. If a
> just-flashed build never checks in, **tap RESET / power-cycle** once.

A good flash ends with `Hard resetting via RTS pin...` + `New upload port`.

**Footprint (fw 0.9.4):** flash 1.63 MB = **51%** of 3 MB; static RAM 99 KB =
**30%** of 320 KB, leaving ~228 KB for local/heap.

⚠️ **Do NOT `cat`/open the serial port while a recording is running.** Opening
the CDC port toggles DTR/RTS and **resets the board** mid-record. Use the app /
on-screen UI to watch; only attach serial when idle or for boot logs.

---

## 4. Firmware file map

| File | Role |
|------|------|
| `SATE_Recorder.ino` | main: UI (LVGL), record/play, SD, setup/loop |
| `display.cpp` / `.h` | ILI9341 + LVGL init, DMA draw buffers |
| `es8311.cpp` / `.h` / `_reg.h` | ES8311 codec driver |
| `connectivity.cpp` / `.h` | Wi-Fi upload + command poll, BLE provisioning, sync logic |
| `sate_logo_white.h` | boot logo bitmap |

---

## 5. Audio pipeline

| Spec | Value |
|------|-------|
| Sample rate | 16 kHz |
| Bit depth | 16-bit |
| Channels | mono |
| Bitrate | 32 KB/s ≈ **1.9 MB/min** |
| Record ceiling | `RECORD_MAX_SECONDS = 3700` (~62 min safety cap) |
| Stop | runs until the user taps **Stop** (or hits the ceiling) |

**Recording is segmented**, not one giant file:
- Each minute is written as `session_NNNN.partKK.wav` (`SEGMENT_SECONDS = 60`).
- part00 keeps a full WAV header; later parts are raw PCM (header stripped on
  upload). **No on-device merge** — the parts upload directly and the server
  stitches them + patches the RIFF/`data` sizes. Half the SD I/O, no "Saving…"
  stall, and a crash mid-session only loses the current minute.

Capture/playback both stream through one **static 4 KB** buffer
(`audioChunk[AUDIO_CHUNK_BYTES]`) — see optimization #1.

---

## 6. Storage layout (SD)

```
/sate/patients.json                                 roster
/sate/patients/<patient_id>/session_XXXX.part00.wav segment 0 (has WAV header)
/sate/patients/<patient_id>/session_XXXX.partNN.wav segment N (raw PCM)
/sate/patients/<patient_id>/session_XXXX.json       metadata
/sate/patients/<patient_id>/session_XXXX.synced     "on server" marker
```

Exact names (`sessionPath()` / `sessionPartFile()` in `connectivity.cpp`):
`session_%04lu.part%02d.wav`, `session_%04lu.json`, `session_%04lu.synced`.
`<patient_id>` is a directory name — in practice **`Standalone`**, the default
bucket the recorder records into (patient assignment is optional and normally done
later on the web report, so `/sate/patients/Standalone/` is the dir you will actually
see on a field card).

Session "exists" if it has any part file, a legacy merged `.wav`, **or** a
`.synced` marker — that is what keeps a reclaimed slot numbered so a reboot can
never overwrite a take.

### Session `.json` — every field, and who reads it

Written by `writeSessionMetadata()` (`SATE_Recorder.ino`) when the take ends, and
again in the crash-give-up path (`.ino` ~L3560, a minimal JSON carrying at least
`owner_dev`). The uploader reads it back on every sweep.

| Field | Type | Meaning / who consumes it |
|---|---|---|
| `firmware_version` | string | build that recorded the take |
| `patient_id` | string | SD dir + the `patient_id` query param on upload (`Standalone` by default) |
| `patient_name` / `age` / `session_type` / `clinician` | string | roster copy, JSON-escaped |
| `session_number` | 1…99 | the slot; **wraps**, so it is NOT a global ordering key |
| `take_seq` | uint32, monotonic | lifetime take counter (NVS `sate-seq`). The **recency rank** used by retention — it never wraps, so it survives the 99 wrap. A crash-resumed take re-stamps a fresh value (still newest). Missing (legacy) → falls back to the session number |
| `owner_dev` | string | the `device_id` of the claim that recorded it. **The uploader skips any session whose stamp ≠ the current `device_id`** — a factory-reset unit claimed by another account can never upload the previous account's audio under the new key |
| `audio_path` | string | part00 path |
| `audio_pcm_bytes` / `duration_seconds` | uint32 | PCM payload and length |
| `sample_rate` / `bit_depth` / `channels` | 16000 / 16 / 1 | uploaded as `&sample_rate=` |
| `created_ms_since_boot` | uint32 | the device has no RTC — server `created_at` is the real timestamp |
| `peak_abs` | uint32 | peak \|sample\| of the capture. Near-zero on a full-length take = dead/muted mic; rides the upload as `&peak=` so the dashboard can flag it **before** the audio is trimmed |
| `flags_ms` | number[] | FLAG-button offsets (ms). Uploaded as `&flags=12000,45000` → `recordings.flags` → amber ticks on the web report's seek bar |

### Session numbering — allocate, never renumber

- Numbers live in **1…`SESSION_NUM_MAX` (99)** and are allocated **monotonically**:
  highest existing + 1, and past 99 the counter wraps to the **lowest free** slot.
  A per-dir NVS high-water (`hw%08x`) keeps allocation monotonic across deletes; it
  only resets at the wrap.
- **Holes are legal, and deletes never renumber.** `deleteSession()` removes only that
  session's own files and shifts nothing. The old renumber machinery (NVS `sate-del`
  journal, `recoverInterruptedDelete()`, `compactPatientDir()`, `renameSessionFiles()`)
  is **gone** — it caused the worst bug class in the project (renumber under a live
  upload splicing two takes together, a trash tap after a renumber deleting the wrong
  take, a power cut mid-renumber reusing a slot). Every scan iterates the directory;
  **never write code that assumes contiguous `1..N`.**
- A delete during an upload defers and drops **only** the uploader if it is latched on
  that exact `(patient, number)` (`upDropReq` / `connNotifySessionDeleted()`); any other
  session's upload is untouched.

### Lifecycle of one take on the card

```
record ──► session_NNNN.part00.wav (+ .json)      audio + metadata on SD
   │        part01, part02 …                      flushed every ~5 s, new part each 60 s
   ▼
upload ──► .synced written                        TOMBSTONE: slot stays numbered
   │                                              (audio still on the card)
   ▼
reclaim ─► audio parts deleted, .json + .synced kept
           ONLY after GET /api/sessions/verify answers stored:true (§7.7)
           and only for takes older than the newest KEEP_AUDIO_SESSIONS = 5
```

Full deletion stays **user-only** (the Delete button → `deleteSessionFiles()`). Any doubt
during reclaim — offline, non-2xx, parse failure, byte mismatch — **keeps** the audio and
retries on the next sweep (5 min; a take the server keeps answering `stored:false` for is
parked for 6 h so it can't starve the sweep). See §8.10.

---

## 7. Connectivity — the device ↔ server contract

Everything a recorder does with the outside world. Written so you can reproduce it with
`curl`: exact paths, headers, query params, response bodies, timeouts, and what the
firmware does with each failure. Implementation: `SATE_Recorder/connectivity.cpp`;
server side: `react_app_sate-ui_update/supabase/functions/device-api/index.ts` (**v18**).

### 7.1 Identity — four names for one recorder

| Name | Example | Where it comes from | Lifetime |
|---|---|---|---|
| **serial** | `SATE-D19EB8` | `buildSerial()` — bytes 3/4/5 of the **eFuse factory MAC**, readable before the radio is up | burned in, never changes |
| **device_id** | `dev-sate-d19eb8` | server, on register: `'dev-' + serial.toLowerCase()` | changes identity on every (re)claim |
| **device_key** | `key-dev-sate-d19eb8` | server, on register: `'key-' + device_id` | the recorder's only credential |
| **owner_dev** | `dev-sate-d19eb8` | the `device_id` stamped into each session JSON at record time | per take |

⚠️ **The device key is derivable from the serial**, which is printed on the unit and
broadcast in BLE advertising. Treat `key-…` as an identifier, not a secret, until the
scheme is replaced — see `doc/05-backend-supabase.md` and the audit notes.

Config lives in **NVS namespace `sate`** (`Preferences`): `ssid`, `pass`, `server`,
`dev_id`, `dev_key`. A second namespace `sate-own` holds the previous `device_id` so the
firmware can detect the unit changed hands. `connFactoryReset()` clears `sate` and reboots.
**A full-chip `--erase` wipes NVS = same as a factory reset** — see §3.

### 7.2 The two transports

| Mode (`ConnMode`) | When | What it does |
|---|---|---|
| `CONN_WIFI_ONLINE` | creds valid + associated | upload sessions, poll commands, heartbeat, verify, OTA |
| `CONN_WIFI_TRYING` | associating | retries every `WIFI_RETRY_PERIOD_MS` = 90 s |
| `CONN_BLE_ADV` | no Wi-Fi, or Change-Wi-Fi mode | advertises the SATE service so the app can provision / bridge-sync |
| `CONN_BLE_CONNECTED` | app connected | provisioning + BLE session bridge |
| `CONN_OFF` | SD failed / not started | — |

`connLoop()` is the whole net body and runs on a **core-0 task** (`connStartNetTask()`) so
TLS never stalls the GUI/buttons — **except during provisioning**, which deliberately runs
on the main loop so the register TLS handshake gets a clean heap (§8.23).

### 7.3 How a path becomes a URL

`cfgServer` is the stored base, including any path prefix:

```
https://<project>.supabase.co/functions/v1/device-api     ← production
http://192.168.0.138:4000                                 ← mock-server (mock-server/)
```

`httpJson()` concatenates `cfgServer + path`, so `/api/devices/x/commands` becomes
`…/functions/v1/device-api/api/devices/x/commands`. The edge function strips a leading
`/api`, and **accepts both `/api/*` and `/*`**.

Headers the firmware sends on every authenticated call:

| Header | Value | Note |
|---|---|---|
| `Authorization` | `Bearer key-dev-<serial-lower>` | omitted on register (no key yet) |
| `apikey` | the Supabase **anon** key | only when the host is `*.supabase.co` |
| `Content-Type` | `application/json`, or `audio/wav` for chunks | |

TLS is `setInsecure()` (no CA bundle on-device). Sockets are pooled
(`setReuse(true)`) — one warm HTTPS connection carries the poll *and* the chunk uploads,
because a fresh handshake under Wi-Fi+BLE coexistence can stall for seconds.

`curl` equivalent of any device call:

```bash
BASE="https://<project>.supabase.co/functions/v1/device-api"
KEY="key-dev-sate-d19eb8"        # device key
ANON="<supabase anon key>"
curl -s "$BASE/api/devices/dev-sate-d19eb8/commands?pending=0&state=idle&fw=1.5.32" \
  -H "Authorization: Bearer $KEY" -H "apikey: $ANON"
```

### 7.4 Connecting a device to the system (the claim flow)

Three parties: the **web/mobile app** (user JWT), the **recorder** (BLE, then Wi-Fi), and
**device-api**. A recorder is useless until it holds a `device_id` + `device_key`.

```
 App (user JWT)                Recorder                    device-api
      │                            │                            │
 1.   ├─ POST /devices/claim-token ─────────────────────────────►│  row in sate_claim_tokens
      │◄──────────────── { token: "claim-1a2b3c4d" } ────────────┤  single use
      │                            │                            │
 2.   ├─ BLE write CHAR_CONTROL ──►│  {"op":"provision",         │
      │   (ssid, pass, server,     │   "ssid","pass",            │
      │    claim_token)            │   "server","claim_token"}   │
      │                            │                            │
 3.   │◄─ notify CHAR_STATUS ──────┤  {"ev":"state","state":"connecting"}
      │                            ├─ WiFi.begin(ssid, pass)     │
      │                            │  ≤28 s, re-begin every 8 s  │
      │                            │                            │
 4.   │                            ├─ POST /api/devices/register ►│  claim_token → user_id
      │                            │◄─ {device_id, device_key} ──┤  upsert sate_devices
      │                            │  saveConfig() → NVS         │  token marked used
 5.   │◄─ notify CHAR_STATUS ──────┤  {"ev":"state","state":"registered","device_id":…}
      │                            │                            │
 6.   │      (app disconnects)     ├─ CONN_WIFI_ONLINE ─────────►│  heartbeat every 12 s
```

**Step 1 — mint a claim token** (user JWT, from the app/web):

```http
POST /functions/v1/device-api/devices/claim-token
Authorization: Bearer <user JWT>
→ 200 { "token": "claim-1a2b3c4d" }
```

Stored in `sate_claim_tokens` with the caller's `user_id` + display name. **Single use** —
register flips `used=true`, and a second attempt gets `401 Invalid or used claim token`
(the recorder surfaces this as *"Setup link expired — sign out and back in, then retry"*).

**Step 2 — push credentials over BLE** (see §7.10 for the GATT map). The app writes the
`provision` op; the firmware saves nothing yet, sets `esp_coex_preference_set(ESP_COEX_PREFER_WIFI)`
(BLE stays connected so the app can watch, and under the default BALANCE coex a *correct*
password can fail the 4-way handshake), disables modem sleep, and associates.

**Step 3 — Wi-Fi window.** `WIFI_PROV_TIMEOUT_MS` = 28 s total, re-`begin()` every
`WIFI_PROV_RETRY_MS` = 8 s (~3 tries). On timeout it reports a *reason-coded* hint:
`0` → "no response from router — is it 2.4 GHz?", auth-ish reasons → "wrong password",
otherwise "weak signal or out of range". **The ESP32-S3 has no 5 GHz radio** — a 5 GHz-only
SSID is the single most common setup failure.

**Step 4 — register** (the only unauthenticated device route):

```http
POST /functions/v1/device-api/api/devices/register
Content-Type: application/json
apikey: <anon key>
{ "serial": "SATE-D19EB8", "claim_token": "claim-1a2b3c4d", "fw": "1.5.32" }

→ 200 { "device_id": "dev-sate-d19eb8",
        "device_key": "key-dev-sate-d19eb8",
        "slp": "Jane Doe", "slp_id": "<user uuid>" }
```

Server-side it upserts `sate_devices` (`id`, `user_id`, `name`=serial, `serial`, `fw`,
`online:true`, `ip` from `x-forwarded-for`, `last_seen`, `pending_sessions:0`,
`state:'idle'`, `slp`, `slp_id`) keyed on `id`, so re-registering the same physical unit
updates rather than duplicates.

Firmware behavior worth knowing:
- connect timeout **6 s**, read **8 s**, TLS handshake timeout **5 s**;
  **5 attempts** with a 600 ms backoff.
- **A parseable 2xx is not success.** If `device_id`/`device_key` are empty the firmware
  treats it as failure — persisting blanks once made the device report "registered" while
  every later call hit `/api/devices//…` unauthenticated, and the next boot silently
  dropped back to setup with the day's takes unsynced.
- **4xx = fail fast** (bad/used token; retrying can't help). 5xx/timeout = retry.
- On success: `saveConfig()` writes NVS, `ownerTrackId()` records the claim, and the device
  stays in BLE until the app disconnects, then goes online.

**Re-pairing / handing a unit over — two paths, and only two:**

1. **Server-driven (normal).** The SLP removes the recorder in the web app → the
   `sate_devices` row disappears → the next heartbeat returns `{ "unclaimed": true }` → the
   firmware calls `connFactoryReset()` (wipes Wi-Fi + account, reboots into first-time
   setup). The device needs no user at the bench.
2. **Hold BOOT for 5 s** (`serviceFactoryResetButton()`, `.ino`) — the deliberate full wipe,
   claimed or not, with a red countdown banner; releasing early cancels.

Changing Wi-Fi **without** losing the account is a separate, app-driven flow (§7.9) — not a
button. `--erase` on a USB flash is a third, accidental path to the same place: it wipes NVS.

### 7.5 Heartbeat + command poll — one endpoint does both

```http
GET /api/devices/<device_id>/commands?pending=2&state=recording&fw=1.5.32&ota=&bat=87
    &recs=412&mv=3980&rst=1&up=53211&heapmin=41232
Authorization: Bearer key-dev-sate-d19eb8
apikey: <anon key>
```

| Param | Meaning |
|---|---|
| `pending` | unsynced sessions across all patient dirs → `sate_devices.pending_sessions` |
| `state` | `idle` \| `recording` \| `uploading` → `sate_devices.state` (a state change forces an immediate heartbeat) |
| `fw` | running `FIRMWARE_VERSION` → drives the update banner |
| `ota` | OTA phase: `dl`, `deferred-rec`, `err-begin`, `err-get-<code>`, … → `sate_devices.ota_state` |
| `bat` | battery % (255 = unknown) |
| `recs` | lifetime recording count |
| `mv` | raw cell mV (−1 unknown) — for admin-side battery calibration |
| `rst` | `esp_reset_reason()` of the last boot |
| `up` | uptime in seconds |
| `heapmin` | minimum free **internal** heap since boot — the early warning for TLS/OTA failures |

Response:

```json
{ "commands": ["record"],
  "active_patient": { "patient_id": "...", "name": "...", "age": "",
                      "session_type": "", "clinician": "" },
  "record_seconds": 300,
  "ota": { "url": "https://…/firmware/sate_1.5.32.bin", "version": "1.5.32" } }
```

- ⚠️ **Delivery is at-most-once.** The handler marks *every* unconsumed command
  `consumed=true` as it reads them, before the device has acted. A reply lost in flight
  loses those commands — re-issue from the app rather than expecting a retry. (The OTA path
  compensates by latching the payload when it defers.)
- `unclaimed:true` (device row gone) → factory reset, described above.
- `active_patient` is staged **before** the command list runs, so a queued `record` tags the
  take to that patient.
- `record_seconds` (device-api ≥ v17, fw ≥ 1.5.19) makes the device stop the take **itself**
  at exactly N seconds of PCM — sample-exact, instead of racing a `stop` through the poll
  channel (+3–12 s of slop).

| Command | Effect on the recorder |
|---|---|
| `record` / `record`+`seconds` | `sateHookRecord()` / `sateHookRecordTimed(n)` — capture runs on the UI core |
| `stop` | ends the take; **latched only while a take is armed** (`recTakeArmed`) so a stop issued during the take's own start sequence is not swallowed |
| `sync_now` | re-arm the upload sweep |
| `resync_all` | drop every `.synced` marker and re-upload what the card still holds (deferred into the SD bracket) |
| `reload_patients` | re-fetch `/api/patients` and rewrite `patients.json` |
| `wifi_change` | drop to BLE Change-Wi-Fi mode without unclaiming |
| `reboot` | reboot in ~300 ms |
| `ota` | flash the `.bin` in the sibling `ota` payload (§7.9) |

The server flips a device to `online:false` when `last_seen` is older than **45 s**
(`listDevices`), so the 12 s poll gives ~3 misses of slack.

### 7.6 Uploading a take — chunked, resumable, idempotent

The uploader is **cooperative**: one ~1 MiB slice per pass, then back to `connLoop()` so
polling and the GUI keep running. Slices stream straight from the SD file (`File` is a
`Stream`) — memory stays flat regardless of take length.

```http
POST <prefix>/api/sessions/chunk
     ?device_serial=SATE-D19EB8&patient_id=Standalone&session_number=7
     &sample_rate=16000&peak=18422&flags=12000,45000
     &offset=<bytes so far>&final=<0|1>&total=<full byte length>
Authorization: Bearer key-dev-sate-d19eb8
apikey: <anon key>
Content-Type: audio/wav
<~1 MiB of the WAV>

→ 200 { "ok": true, "received": 1048576, "offset": 0 }      (non-final)
→ 200 { "id": "s-1a2b3c4d" }                                 (final, stored)
→ 200 { "id": "s-…", "idempotent": true }                    (final, already stored)
→ 409 offset gap / size mismatch / missing part
```

**Server side** (`handleSessionUpload`): each slice lands as its **own object** at
`<device_id>/_tmp/<patient_id>/s<n>/<offset padded to 12>.part` in the `device-sessions`
bucket (upsert, so re-sending a slice is free). On `final=1` it lists the parts, checks
they form a **gap-free** stream and that the total matches `&total=`, downloads them 8 at a
time straight into one pre-allocated buffer, patches the RIFF/`data` sizes, stores
`<user_id>/<serial>/s-<id>.wav`, inserts `sate_device_sessions`, deletes the parts, and
fires the processor. Then the async AI pipeline takes over (`queued → processing → done`).

Why each rule exists — do not "simplify" these away:

| Rule | Reason |
|---|---|
| Parts are separate objects | the old one-blob version re-uploaded the whole temp file per slice: quadratic, and late slices blew the 12 s timeout → a backlog that could never drain |
| `offset=0` clears the part dir | leftover higher-offset parts from an abandoned attempt would otherwise be stitched onto the new upload |
| Part dir scoped by `patient_id` | session numbers restart per patient; a shared dir could stitch a WAV out of **two patients' audio** |
| Final probes for an existing row **and** the object | a lost ACK must be a no-op, not a 9-minute re-upload; a row alone is not proof (the 413 bug left ghost rows, which are deleted and re-stored) |
| `&total=` (fw ≥ 1.5.9) | without it a mis-mapped resume could assemble a short or padded WAV and still return 2xx |
| Upload failure **throws** | it used to log and insert the row anyway → device marked the take synced and freed its only copy while the server held a row pointing at nothing |

**Timeouts and retries (firmware):** connect 6 s; **12 s** per ordinary slice, **60 s** on
the final (the server assembles the whole session there). Any failure keeps the offset and
retries the same slice — **except HTTP 409**, the one case where the device restarts the
session from byte 0. A session that keeps failing is parked for `UPLOAD_PARK_RETRY_MS`
(5 min) so it can't starve the others; going online or `sync_now` clears all parks.

**Legacy endpoints, still live** — useful for testing, not used by current firmware:
`POST /api/sessions/raw` (whole WAV as the body, metadata in the query) and
`POST /api/sessions` (JSON with `wav_base64`). Both funnel into the same
`storeSessionRecord()` with the same idempotency probe.

### 7.7 Verify before the audio is freed

The device is the **only** copy of a take until it is provably on the server.

```http
GET /api/sessions/verify?patient_id=Standalone&session_number=7&bytes=113246444
Authorization: Bearer key-dev-sate-d19eb8
→ 200 { "stored": true }
```

`device_serial` is deliberately **omitted** so the server defaults it to this device's own
serial — the same identity the take was uploaded under. The server answers `stored:true`
only when the row exists **and** its storage object really exists; it never mutates
anything. `sessionAssembledBytes()` computes `bytes` exactly as the server stored it
(part00 keeps its 44-byte header, later parts contribute PCM only).

Firmware treats the answers asymmetrically: only a clean 2xx carrying `stored:false` is a
*definitive no*. Offline, non-2xx, or an unparseable body → **keep the audio**. See §8.10.

### 7.8 Patient roster

```http
GET /api/patients
Authorization: Bearer key-dev-sate-d19eb8
```

Device-key auth: the function resolves the device's owner and returns *that user's*
roster (`listPatients`), written to `/sate/patients.json`. In practice the recorder records
standalone and this is mostly cosmetic — patients are assigned later on the web report.

### 7.9 OTA, and Change-Wi-Fi

**OTA.** An `ota` command carries `{ url, version }` in the sibling payload. `runOtaUpdate()`
skips if `version` equals the running build; **defers** (latching the payload, phase
`deferred-rec`) if a take is armed — flashing stalls both cores' cache and the success path
reboots, which would cut a live patient recording. It then closes the pooled TLS socket
(the poller's ~40 KB mbedTLS arena is exactly why a busy heap gives `err-get-1`), downloads
with its own client (redirects followed, insecure TLS, 20 s read), writes the spare app
slot, and reboots. The new image boots **PENDING_VERIFY** and is committed only after it
proves healthy, so a bad *or* wedged build rolls back on the next power cycle.

⚠️ **On a device with an upload backlog, queue `reboot` first, wait for it to come back,
then `ota`** — the first poll after boot flashes with a clean heap. Details in §8.28 and
`doc/07-runbook.md`.

**Change-Wi-Fi** — app-driven only: the `change_wifi` BLE op (the recorder is already in BLE
range) or the `wifi_change` remote command (drops an online recorder to BLE so the phone can
push new creds). It re-associates and persists new creds **without** re-registering — the
account, server, and device key are kept. Requires `provisioned` (else `"device not set up
yet"`); auto-cancels after `WIFI_CHANGE_TIMEOUT_MS` = 3 min; `cancel_wifi` leaves
immediately. **The BOOT button is not part of this flow** — holding it is a full factory
reset (§7.4).

### 7.10 BLE — the provisioning + bridge channel

Advertised manufacturer data is `[0x5A, flags, pending, 0]`, service UUID in the ADV packet.
Full protocol (framing, JSON ops, chunked session bridge) mirrors `src/protocol.ts` in the
companion app — see **`doc/04-ble-protocol.md`**.

| Characteristic | UUID | Props |
|---|---|---|
| Service | `53415445-0001-4a7e-8c5e-000000000001` | — |
| `CHAR_INFO` | `…-000000000010` | READ → `{"model":"SATE Recorder","fw":…,"serial":…,"provisioned":bool}` |
| `CHAR_CONTROL` | `…-000000000020` | WRITE — JSON ops, `[flag][payload]` framed (`FRAME_PARTIAL`/`FRAME_FINAL`), reassembled into `CTRL_BUF_MAX` |
| `CHAR_STATUS` | `…-000000000030` | NOTIFY — `{"ev":…}` events |
| `CHAR_DATA` | `…-000000000040` | NOTIFY — session audio bridge, 4 KB blocks, same framing |

MTU is set to 247 and notifications are framed in `BLE_CHUNK` = 180-byte packets
(`notifyFramed()`, which **fails the whole message** rather than let a dropped packet look
like a fully-sent WAV).

Ops on `CHAR_CONTROL`: `scan_wifi`, `provision`, `change_wifi`, `cancel_wifi`,
`list_sessions`, `send_session`, `mark_synced`, `set_patients`, `reboot`, `factory_reset`.

⚠️ `list_sessions` / `send_session` refuse with *"recorder busy — try again"* while the UI
core owns the SD card (recording / saving / deleting) — a list taken mid-take would report
the in-progress session as pending and the bridge would stream a partial file and tombstone
a take that is still recording.

### 7.11 Timing constants (all in `connectivity.cpp`)

| Constant | Value | What it paces |
|---|---|---|
| `CMD_POLL_PERIOD_MS` | 12 s | command poll / heartbeat |
| `HEARTBEAT_PERIOD_MS` | 15 s | pending-session rescan cadence |
| `WIFI_BOOT_TIMEOUT_MS` | 18 s | associate at boot before falling back to BLE |
| `WIFI_PROV_TIMEOUT_MS` / `_RETRY_MS` | 28 s / 8 s | provisioning window / re-`begin()` |
| `WIFI_RETRY_PERIOD_MS` | 90 s | reconnect attempts once offline |
| `WIFI_SCAN_ATTEMPT_MS` | 11 s | one `scan_wifi` attempt (≤2) |
| `WIFI_CHANGE_TIMEOUT_MS` | 3 min | auto-exit Change-Wi-Fi |
| `ADV_REFRESH_PERIOD_MS` | 30 s | refresh BLE advertising payload |
| `TRIM_SWEEP_PERIOD_MS` | 5 min | verify-gated audio reclaim sweep |
| `UPLOAD_PARK_RETRY_MS` | 5 min | retry a repeatedly-failing session |
| `VERIFY_PARK_RETRY_MS` | 6 h | retry a take the server says it does not hold |
| `UPLOAD_CHUNK_BYTES` | 1 MiB | slice size |
| HTTP timeouts | 2 s connect / 2.5 s read (JSON), 6 s / 12 s (slice), 6 s / 60 s (final), 6 s / 8 s (register), 8 s / 20 s (OTA) | |

### 7.12 When it goes wrong — symptom → cause

| Symptom | Cause / fix |
|---|---|
| *"Setup link expired"* on register | claim token already used or from another account — mint a fresh one |
| *"Server registration failed (code N)"* | 5 attempts exhausted. `code=-1` historically = no contiguous internal RAM for the TLS handshake (§8.8/§8.23); `code=0` = never reached the server |
| Wi-Fi "wrong password" that is right | 5 GHz-only SSID, or the BLE-coexistence handshake failure the `ESP_COEX_PREFER_WIFI` window fixes |
| Registers, then every call 401s | empty `device_id`/`device_key` persisted — fixed in fw ≥1.5.x, which refuses a credential-less 2xx |
| Device drops to first-time setup on its own | the account removed it → heartbeat `{unclaimed:true}` → factory reset. Expected |
| Uploads "in progress" forever | pre-v12 quadratic chunk path, or repeated 12 s timeouts. Check `heapmin` and `sate infra` |
| Session row exists, audio 404s | ghost row (Storage rejected the object — check the **project-wide** file size limit, not just the bucket's). Verify now deletes and re-stores these |
| OTA `err-get-1` | fragmented heap → `reboot` first, then `ota` |
| Device online but no commands land | commands are marked consumed on read — a lost reply drops them; re-issue |

**Auto-sync is hands-off.** On a new recording (or on going online at boot) the device flags
an upload sweep; `connLoop()` uploads each pending session one ~1 MiB slice at a time, writes
`.synced`, and later reclaims the audio once verify says it is durably stored. Validated
end-to-end at scale (a 64 MB / ~33-min session auto-uploads cleanly; the device stays online
throughout).

### 7.13 Read/monitoring API — watching the traffic live

Everything above is what the **recorder** calls with its `device_key`. This section is the
other half of the contract: the **operator-facing read API** used to watch that traffic —
what the live pipeline map, the Debugger and `sate pipeline` all run on.

**→ Live map: <https://status-sate.long-cao.dev/pipeline>** — sign in with your SATE account.
Nothing to install; it is the `sate pipeline` view rebuilt in the browser (§ below).

Different auth from the device path — these take a **user JWT**, not a device key:

| Header | Value |
|---|---|
| `Authorization` | `Bearer <supabase user JWT>` (from `/auth/v1/token?grant_type=password`) |
| `apikey` | the Supabase **anon** key (public client key, ships in the firmware and both apps) |

| Endpoint | Returns | Used for |
|---|---|---|
| `GET {device-api}/api/devices` | the account's claimed devices: `serial`, `fw`, `online`, `state`, `battery_pct`, `battery_mv`, `pending_sessions`, `ota_state`, `last_seen` | recorder tier dot, device header, device picker |
| `GET {device-api}/api/sessions/upload-progress?device_serial=…` | `{uploading, uploads:[{patient_id, session_number, parts, bytes}]}` | **the only** server-side truth for a take mid-upload — the session row does not exist yet, so this sums the `_tmp` part objects (device-api ≥ v16) |
| `GET {SUPABASE}/rest/v1/sate_device_sessions?select=…&device_serial=eq.…` | session rows: `session_number`, `patient_id`, `bytes`, `status`, `processing_started_at`, `process_error`, `attempts` | the session table + queue/processing state |

⚠️ **Field names are `battery_pct` / `battery_mv`**, not `battery` / `cell_mv`. Guessing them
yields a header that silently renders `—` forever — the values are simply absent, not zero.

All three upstreams (Supabase auth, REST, device-api) send `access-control-allow-origin: *`,
so a browser can call them directly with the viewer's own JWT. That is what lets the live map
be **static HTML with no server-side credential**: RLS scopes every read to whoever signed in.

:::warning[Do not put a service key or an account password behind a monitoring page]
The first cut of the live map gated itself with a URL key and logged the Worker in with a
stored `SATE_EMAIL`/`SATE_PASSWORD`. That put the account that can publish **fleet-wide OTA**
into a Worker secret, and made the link itself the credential — anyone with the URL saw that
one account's patient data. Both are gone. Authenticate the **viewer**, and let RLS decide.
:::

**Two honesty rules the map follows** — worth keeping in anything else that reads this API:

- **A failed fetch is not a red light.** Offline/DNS/CORS means *we could not ask*, which is
  reported as grey "no data". Only an explicit bad HTTP status is "down". A false red on a
  monitoring page is worse than an admitted gap.
- **Idle never fakes green.** A stage lights up only when a row or an in-flight upload proves
  it. The cf-processor and AI dots are *inferred from the queue* (a job past the 45-min
  watchdog turns them red) because a Cloudflare Worker cannot probe its own account — that
  returns **error 1042** — and the map says so on the page rather than implying a real probe.

---

## 8. ⭐ Memory / RAM / core optimization playbook

This is the core of keeping the device smooth on long sessions. Each technique,
why it matters, and where it lives.

### 8.1 Stream everything — no length-proportional mallocs
Recording and playback move audio through **one static 4 KB buffer**
(`audioChunk`, `.ino`). Working memory is **constant** whether the session is
10 s or 60 min. A 64 MB recording uses the same RAM as a 1 MB one. Never buffer
a whole file in RAM (the old base64-the-whole-WAV path needed ~12.7 MB and
failed — deleted).

### 8.2 Keep big buffers static, off the task stack
Hot buffers are file-scope `static`, not stack locals:
`audioChunk[4096]`, connectivity's `ioChunk[4096]` / `upBuf[4096]`, the 32 KB
merge buffer, plus `static` HTTP response buffers ("keeps 1–2 KB off the
loop-task stack"). The loop task runs LVGL + Wi-Fi + JSON on **one** stack;
large locals would blow it.

### 8.3 Size the loop-task stack deliberately
```c
SET_LOOP_TASK_STACK_SIZE(16 * 1024);   // default 8 KB overflows
```
The default 8 KB overflows on the Wi-Fi-online path (HTTPClient fetch + JSON
parse of the roster) and crashes with a corrupted backtrace right after
"Connecting to Wi-Fi". 16 KB gives headroom.

### 8.4 No Arduino `String` in hot paths
Fixed `char[]` buffers + `snprintf` everywhere. Avoids heap fragmentation from
thousands of transient `String` allocs during recording/upload/UI refresh.

### 8.5 `delay(1)` yield in the record loop — the long-session stability fix
The record loop is a tight `read I2S → write SD` loop. Without yielding it
**starves the idle task on that core**, and after ~3 min the board reboots.
The fix is one line every ~120 ms tick:
```c
delay(1);   // yields to idle/RTOS so long records don't trip the watchdog
```
This was misdiagnosed as a watchdog-subscription bug — the loop task isn't on
the TWDT; `esp_task_wdt_reset()` just spammed "task not found". The real cure is
the yield. (Removed the dead `esp_task_wdt_reset` calls.)

### 8.6 Cooperative, sliced upload — stay responsive + online
`connLoop()` sends **one ~1 MB slice per pass** (`UPLOAD_CHUNK_BYTES = 1 MB`),
then returns to `loop()`. The GUI keeps painting and command-polling continues,
so a 64 MB upload doesn't freeze the screen or drop the device offline. HTTP
**keep-alive** (`s_http`, `setReuse`) avoids a TCP handshake per slice.

### 8.7 Segment recording, zero merge — less I/O, less risk
1-min segments stream straight to SD and upload directly (§5). No giant
contiguous file, no merge pass (merge was ~30 s for 6.4 MB and overflowed the
loop stack via deep `lv_timer_handler` re-entry — eliminated).

### 8.8 Double-buffered LVGL draw buffers — in PSRAM (fw 1.5.x), NOT internal RAM ⚠️
`display.cpp` allocates **two** LVGL draw buffers of `240 × 24` pixels from **PSRAM**
(`MALLOC_CAP_SPIRAM`), with a single-buffer fallback. They used to be DMA-capable
**internal** RAM — that was wrong: `my_disp_flush()` pushes with a **blocking CPU copy**
(`tft.pushColors(..., swap=true)`, no DMA), so the buffers never needed to be DMA/internal.
Keeping them (and the whole LVGL heap, see below) OUT of internal RAM is what leaves the
~40 KB contiguous internal block the **Supabase register TLS handshake** needs while BLE +
Wi-Fi are up — internal draw buffers starved it and provisioning failed *"Server
registration failed (code -1)"* (mbedTLS couldn't get its two ~16 KB buffers). This was the
fw 1.5.12 register fix; a `code -1` at register = check internal `maxAlloc` first, not coex.

> **`lv_conf.h` (external — `~/Documents/Arduino/libraries/lv_conf.h`, NOT in the repo, reset
> by any lvgl reinstall) carries two load-bearing settings:**
> - `LV_TICK_CUSTOM 1` — the firmware calls `lv_tick_inc()` **nowhere**; with `0`, LVGL's
>   clock freezes at 0 and the **boot spinner sticks at frame 1, nothing ever repaints**
>   (yet `setup()` finishes — looks like a boot hang, is not). Silent brick.
> - `LV_MEM_CUSTOM 1` + `LV_MEM_CUSTOM_ALLOC=ps_malloc`/`ps_realloc` — puts LVGL's whole heap
>   (else a 48 KB static **internal** pool) in PSRAM, freeing internal RAM for TLS. Needs a
>   `--clean` compile (stale lvgl cache → runtime `heap_caps_free ... "outside heap areas"`).
>
> **A known-good copy is committed at `SATE_Recorder/lv_conf.reference.h`.** After installing or
> reinstalling lvgl (8.4.0), copy it over the library's config:
> `cp SATE_Recorder/lv_conf.reference.h ~/Documents/Arduino/libraries/lv_conf.h`.

### 8.9 Cache the pending-session scan
`scanPending()` walks the whole `/sate/patients` tree (slow, ~15 s hitch on a
full card). It's cached behind a `pendDirty` flag — only re-walked when a
recording is saved, a session syncs, or the roster changes. Everything else
reads the cached count instantly.
> Bug history: `scanPending` once `break`-ed at the first audio-purged session,
> hiding all later ones — they never uploaded and Home falsely read
> "all synced". Fix (fw 0.9.3): check the `.synced` marker before deciding a
> slot is empty; stop only when wav+parts+marker are all absent.

### 8.10 SD audio retention — reclaimed only when SERVER-VERIFIED (fw 1.5.13+) ⚠️
The old blind reclaim paths (boot-time `purgeSyncedAudio()`, post-upload purge, the 5-session
`trimSessionsToMax`) are **gone**. fw 1.5.12 re-added a *bounded* reclaim, and fw 1.5.13 made it
**server-verified**: `trimPatientSyncedAudio` keeps the newest `KEEP_AUDIO_SESSIONS` (=5) per patient
and frees the audio of older synced takes **only after** `verifySessionStored()` gets a **byte-exact
`stored:true`** from `GET /api/sessions/verify` (device-api ≥v15 — checks the DB row AND that the
storage object exists; `sessionAssembledBytes()` is the byte count that must match). It keeps the
`.synced` tombstone marker (numbering stays contiguous) and, on ANY doubt — offline, non-2xx, parse
fail, byte mismatch — **keeps the audio** and retries next cycle. **A `.synced` marker alone is NOT
proof** (it only means "a POST returned 2xx") and must never authorize a free. Full deletion stays
user-only: `deleteSessionFiles()` (the sole `SD_MMC.remove` for audio, the Delete button).

Reboot durability (fw 1.5.13, extended 1.5.16-1.5.18): segments **flush to SD every ~5 s**
(`FLUSH_EVERY_BYTES`, not once per minute); **every** take interrupted by a reboot **auto-resumes**
into the same session on boot — button-started *and* server/app-started since fw 1.5.16
(`maybeResumeRecording()`; an empty header-only `part00` is restarted, not deleted; a `tries`
boot-loop guard gives up after two attempts). Resume needs nothing but local NVS and the SD
segments: no Wi-Fi, no server. And `deleteSession()`'s multi-rename renumber is **journaled to NVS**
(`"sate-del"`) and re-driven on boot (`recoverInterruptedDelete()` → `compactPatientDir()`) so a
reboot mid-shift heals into contiguous `1..N` instead of hiding later takes.

**The resume itself runs from `loop()`, never from `setup()` (fw 1.5.17).** Resuming re-enters the
capture, which blocks until Stop. `connStartNetTask()` lives in `loop()`, so a resume that blocks
`setup()` takes the unit off the air entirely — no heartbeat, no remote `stop`, no serial — and a
server-started take, with nobody at the device, goes dark until the ~62-minute ceiling. `setup()`
only sets a pending flag; `loop()` performs the resume once the net task is up (or ~8 s in, if the
unit is offline), so a resumed take stays controllable for its whole length. Do not move it back.

**A remote `stop` is latched only while a take is *armed* (fw 1.5.18).** `recTakeArmed` is set
before the take's start sequence and cleared when capture returns, so a stop can neither go stale
(and kill the *next* take) nor be dropped mid-start. Clearing a "stale" stop at take start instead
was the earlier design, and it swallowed the stop that a resumed take is ended with — leaving takes
running for minutes with nothing able to stop them.

### 8.11 Touch sets a flag; heavy work runs in `loop()`
Touch callbacks only set `pendingAction`; record/upload/screen-rebuild run from
`loop()`. LVGL is never re-entered from an event handler (re-entrancy =
stack/heap corruption). Same rule lets long blocking work call
`sateHookGuiPump()` to service one GUI tick at a safe depth.

### 8.12 PSRAM vs internal RAM split
8 MB OPI PSRAM holds big/cold allocations **plus the LVGL draw buffers and LVGL heap**
(moved there in fw 1.5.x, §8.8) so internal RAM stays free for the register TLS handshake
and Wi-Fi. Only the audio chunk and the small hot buffers stay in internal SRAM. `[MEM]`
telemetry tracks both: internal `free`/`largest`/`min` and `psram free`. Watch internal
`largest` (`maxAlloc`) — it must stay above ~34 KB during provisioning or register `code -1`.

### 8.13 Small audio slices = responsive UI (fw 1.2.3+)
The record/playback loops move audio in **1 KB slices (~32 ms)**, not one 4 KB
block (~128 ms), and call `lv_timer_handler()` **every slice (~30 Hz)**. A 4 KB
block meant the GUI/touch were serviced only ~8x/sec, so the on-screen Stop
button missed quick taps and the ring stuttered. The I2S DMA ring absorbs the
few-ms per-slice GUI/SD overhead, so audio timing is unaffected. Ring/elapsed
text still refreshes only a few times a second (cheap to skip).

### 8.14 Never full-rebuild Home on a connectivity ping (fw 1.2.4+)
A connectivity state change (`connStateReq`) used to call `showHomeScreen()`,
which does `lv_obj_clean()` + ~20 widget re-creations + a full repaint. Firing
that on every ping caused periodic jank. Now it calls only `updateConnBadge()`
(the small conn icon); the live status line + counts refresh on their own 250 ms
cadence, and a real roster change still rebuilds Home via `connPatientsReq`.

### 8.15 ⭐ Dual-core split: network off the UI core (fw 1.2.5+)
**The big lag fix.** Cause of the old 4–5 s button delay: `loop()` read the
RECORD button only at the top, then called `connLoop()`, which **blocks** on
HTTP/TLS — `pollCommands()` every 12 s (~1–2 s TLS handshake against Supabase),
`scanPending()` every 15 s, uploads. A press landing during that blocked stretch
wasn't seen until the socket returned. The ESP32-S3 has **two cores**, so the fix
is a clean split:

- **Core 1 (Arduino `loop`)** — GUI (LVGL) + physical buttons + record/playback.
  Never blocks on the network anymore.
- **Core 0 (`sateNet` task, `connStartNetTask()`)** — *all* of `connLoop()`:
  HTTP poll, heartbeat, uploads, BLE provisioning. Pinned to core 0 where the
  Wi-Fi/BT stacks already live. 16 KB stack (mbedTLS handshake is stack-heavy).

Rules that make it safe:
- **LVGL only on core 1.** `sateHookGuiPump()` is now a **no-op**, and the upload
  hooks (`sateHookUploadBegin/Progress/End`) only set `volatile` flags —
  `renderUploadOverlay()` on core 1 draws the overlay. The net task must never
  call an `lv_*` function.
- **SD is shared but safe:** FATFS is built with `FF_FS_REENTRANT 1`, so it
  serializes cross-task access internally — no SD mutex needed for correctness.
  `scanPending()` is still wrapped in `pendMux` because both cores write the
  shared `pendTable`/`pendCount`.
- **One HTTP client, one owner.** `s_http` belongs to the net task. `connSetLiveState()`
  (called from core 1) no longer calls `pollCommands()` directly — it sets
  `forcePollDue`, consumed by the net task. The manual Sync screen no longer calls
  `connLoop()`; it just animates while the net task drives uploads.

### 8.16 Interrupt-latched buttons (fw 1.2.5+)
Polling a button only works while the loop is free — but the capture loop blocks
on I2S/SD and (pre-split) `connLoop` blocked on HTTP, so a press was seen late or
missed (level-edge desync). Now a **FALLING-edge ISR** (`isrRecBtn`/`isrFlagBtn`,
`IRAM_ATTR`) latches the press the instant it happens, regardless of what either
core is doing. The ISR does *only* `g_recHit = true;` — **no `millis()`** (its
64-bit divide can live in flash, unsafe from an IRAM ISR if the cache is
disabled). Debounce (40 ms) happens in `btnPressed()` in task context. Result:
RECORD start/stop and FLAG marks register immediately, even mid-upload.

### 8.17 Stop ack + no accidental re-record (fw 1.2.6+)
Stopping a take is detected fast, but the silent ~100–300 ms of save + Home
rebuild after it made users tap RECORD again — and that 2nd press (still latched)
started an unwanted new recording. Three guards:
- **Instant ack:** when stop is detected in the capture loop, the overlay shows a
  save icon + the pill flips to **SAVE** that same frame, so the press visibly
  took.
- **Latch drain:** `g_recHit` is cleared at end-of-take, dropping any press queued
  during save.
- **Settle window:** `g_recSettleUntil = millis() + 700` — RECORD presses in the
  first 700 ms after a take are ignored in `loop()`, so a double-tap can't restart
  recording. A deliberate press after that starts a new take normally.

### 8.18 "Saving..." spinner overlay (fw 1.2.7+)
On stop, `showSavingOverlay()` puts a full-screen `lv_spinner` + `LV_SYMBOL_SAVE
"Saving..."` over the screen while the metadata is written, then `hideSavingOverlay()`
+ Home. `pumpGuiMs(80)` paints it before the (fast) SD write, then it hides
immediately - no artificial hold (the 650/300 ms cosmetic pad was dropped in 1.2.13
for the snappiest stop). The spinner is just a brief blink during the real save;
double-tap is blocked by the §8.17 settle window, not by holding this overlay.

### 8.19 ⭐ Speed: cache f_getfree + pause net SD during a take (fw 1.2.8+)
**The dual-core split (§8.15) made the SD bus contended**, and two slow calls sat
on the hot path. After this, begin/stop/sync are fast again:
- **`SD_MMC.usedBytes()` is `f_getfree`** — a full FAT free-cluster scan, many ms.
  It ran on **every record-begin** (`sdFreeBytes`) *and* **every `showHomeScreen`**
  (`sdUsedPercent`, runs after each stop). Now usage is **cached** (`g_sdTotal` /
  `g_sdUsedCache`): scanned at boot, refreshed at most every 30 s on the Home idle
  tick, and adjusted by `+pcmBytes` after a take. The hot paths read the cache with
  **zero SD access**.
- **`connSetUiSdBusy(true/false)`** brackets record/save and playback. While set,
  the net task (core 0) skips *all* its SD work (uploads, `scanPending`,
  `fetchPatients`) so it doesn't fight the capture/playback on the shared SD bus +
  FATFS lock. HTTP polling keeps running; uploads resume the instant the take ends.
- **`connPendingTotal()` returns the cached count** (no SD walk). It's polled every
  ~250 ms by the GUI core; walking there fought the net task's upload reads. The
  net task refreshes `pendCount` on its heartbeat / sweep / per synced session.

Rule of thumb: **never call `SD_MMC.usedBytes()`/`totalBytes()` or walk the card on
a path that runs per-frame or on a button press** — cache it, refresh off the hot
path, and keep the two cores off the SD bus at the same time.

### 8.20 Pending sessions always drain — re-arm the sweep (fw 1.2.9+)
Bug: **"stuck at uploading"** — sessions sat unsynced for minutes. `uploadSweepDue`
(the upload trigger) was only set on go-online, `sync_now`, or a new recording, and
the sweep aborts if one `beginUpload` returns false. So once it stopped, the backlog
waited for the next take even though the 15 s heartbeat *knew* `pending>0`. Verified
in the device-api logs: long runs of `pending=2/1` heartbeats with **no
`/sessions/chunk` POSTs** in between. Fix: the heartbeat now **re-arms the sweep**
whenever online + `pendCount>0` + not currently uploading, so anything pending
drains on its own at heartbeat cadence (and a transiently-bad session retries every
15 s instead of stalling the queue). New recordings still upload immediately via
`connNotifyNewSession()`.

### 8.21 Buttons: no release-bounce double-count (fw 1.2.10+)
Cheap buttons bounce on RELEASE, firing a spurious FALLING edge the ISR latched as
a 2nd press - the FLAG counter was going +2 per tap (one on press, one on release).
`btnPressed()` now accepts a latched press only when the pin is **held LOW right
now** AND the button was **stably released** (HIGH >=50 ms, tracked via
`g_*LastLow`/`g_*Armed`) since the last accept. One count per real press; release
bounce can't re-trigger. Hardens RECORD start/stop the same way.

### Core model (fw 1.2.5+)
**Two tasks, one per core.** Core 1 = Arduino `loop` (LVGL + buttons +
record/playback). Core 0 = `sateNet` (connectivity/HTTP/BLE). I2S DMA + LCD flush
run on hardware/DMA. Discipline: **never touch LVGL from the net task**; keep all
HTTP on the net task (don't reintroduce a blocking network call on core 1); SD is
fine from either core (FATFS-reentrant), but new shared scalars/tables need a
mutex like `pendMux`. `static` scratch buffers are still safe **only because each
buffer has a single owning task** (e.g. `s_http`'s buffers = net task only).

---

## 9. Reading `[MEM]` telemetry

Serial prints heap at boot/record/play/sync:
```
[MEM] boot       int free=233668  largest=180212  min=228272  psram free=8386096
[MEM] ready      int free=138632  largest= 98292  min=137244  psram free=8350368
```
- `int free` — free internal SRAM right now.
- `largest` — biggest contiguous internal block (fragmentation indicator).
- `min` — lowest internal free ever seen (worst-case watermark; the number to
  watch on long sessions).
- `psram free` — free PSRAM.

Healthy: `min` stays well above ~40 KB and is **flat** across a long record
(constant-memory streaming working). A steadily falling `min` = a leak.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reboot after ~3 min recording | record loop starves idle task | `delay(1)` yield (§8.5) — fixed |
| Record aborts mid-session | serial `cat` toggled DTR/RTS = board reset | don't attach serial mid-record |
| App can't reach device / upload fails | Mac/server LAN IP changed | `ipconfig getifaddr en0`, re-check server IP |
| "auto-records after flash" | stale queued `record` commands on server | clear the server command queue |
| Home "all synced" but a session stuck "queued" | old `scanPending` early-break | fw 0.9.3+ — fixed |
| Crash right after "Connecting to Wi-Fi" | loop-task stack overflow | `SET_LOOP_TASK_STACK_SIZE(16K)` (§8.3) — fixed |
| Screen pans sideways | scrollable LVGL screen + overrun child | scroll disabled globally (fw 0.9.4) — fixed |
| **"Registration Rejected" / "Setup link expired"** (Wi-Fi joins, register fails) | `device-api` redeployed with `verify_jwt:true` → gateway 401s the device's unauthenticated register **before** the function runs | redeploy `device-api` with **`verify_jwt:false`**; verify via `list_edge_functions` (see the ⚠️ note after §11) |
| Setup fails but registration debug/logs are empty | request dies at the Supabase **gateway**, not in the function (same as above) | check `verify_jwt` first — empty function logs = gateway-level rejection |
| Just-flashed build never heartbeats | S3 didn't boot the app after esptool reset | tap **RESET** / power-cycle (§3) |
| Device dropped to first-time setup after a flash | flashed with `--erase` (wiped NVS) | don't erase a provisioned unit (§3) |
| OTA never reaches the device | board flashed with `huge_app` (single app slot) | reflash once over USB with `default_8MB` (§3), then OTA works |

---

## 11. Toward a real product (partially built)

**Already in fw 1.5.0:** 1S-LiPo **battery sensing** (GPIO9 ADC ÷2 divider → live
Home %-chip + admin telemetry, §8.27), **backlight auto-dim** to save power (§8.25),
USB-C charge-detect. Estimated runtime on a 3000 mAh cell: ~14–16 h screen-on idle,
~26–31 h dimmed idle, ~11–13 h continuous record+upload — the ESP32 + Wi-Fi radio
(no modem-sleep yet) is the floor once the backlight is dimmed.

**Still to do:** proper PMU / fuel-gauge IC (the GPIO9 divider is coarse; GPIO34
bootloops the S3 — see §2 note); Wi-Fi modem-sleep / light-sleep to cut idle draw;
dedicated MEMS/electret mic
near a front grille for better clinical SNR; TLS uploads; device ID + clinician
PIN; handheld wipeable enclosure.

### 8.22 Wi-Fi join reliability under BLE coexistence (fw 1.2.15+)
Symptom: a **correct** SSID/password sometimes fails to connect and the app shows
**"weak signal / out of range"**. Cause: provisioning joins Wi-Fi while the **BLE
link stays open** (app watching progress), so both share the one 2.4 GHz radio;
under coexistence a valid join can miss beacons / fail the 4-way handshake, time
out at 28 s, and fall through to the generic out-of-range message (it's not really
range). Fixes: `WiFi.setSleep(false)` during the connect (and once online) so the
STA doesn't modem-sleep through beacons mid-handshake; and **re-issue `WiFi.begin()`
every 8 s** across the window (~3 tries) instead of a single re-begin at 11 s.
`esp_coex_preference_set(ESP_COEX_PREFER_WIFI)` during the connect window stays.
If it still fails: the AP must be **2.4 GHz** (ESP32 has no 5 GHz), and a clear
`WL_NO_SSID_AVAIL` still fast-fails as "Network not found".

### 8.23 ⭐ Provisioning runs single-core — register needs the heap (fw 1.2.22+)
**The dual-core split (§8.15) broke device registration.** Symptom: Wi-Fi joins fine,
but "Saving to the recorder" fails with `Server registration failed`; the diagnostic
build showed `code -1, ssl -32512, mem ~31732`. `ssl -32512` = `MBEDTLS_ERR_SSL_ALLOC_FAILED`
— the register TLS handshake **couldn't allocate memory**. The `/api/devices/register`
POST is a fresh Supabase HTTPS handshake done **while the app's BLE link is still
open**; mbedTLS needs **two ~16 KB buffers**, but with NimBLE holding RAM the largest
free block was only ~31 KB → the 2nd alloc fails and the POST never reaches the
server (confirmed: no `/register` in the Supabase device-api logs).

The old single-core **SATE_Up** never hit this: with no 16 KB net-task stack eating
the heap, registration had room with BLE up. So the fix makes provisioning behave
the same:

- **The net task is NOT started at boot** (`connStartNetTask` deferred). During
  provisioning `connLoop()` runs on the **main loop** (core 1), so the register
  handshake has heap to spare while BLE stays connected. No BLE teardown, no reboot.
- `enterWifiOnline()` sets `g_wantNetTask`; `loop()` then calls `connStartNetTask()`
  **once** (`connNetTaskStarted()` gates it) and hands `connLoop()` to core 0 — so the
  dual-core upload speed + instant buttons are back **after** setup.
- Register itself reverted to the SATE_Up flow: notify `registered` over the live
  BLE link, a few retries, 4xx fails fast as "Setup link expired".

Rule: **a fresh TLS handshake needs ~32 KB of contiguous heap. Don't do one while
NimBLE is active unless you've confirmed the largest free block is big enough** — or
do it on the main loop before the net task exists, like provisioning does. The blocking
register on the loop task is fine: Arduino's loopTask isn't on the task-WDT by default
(matches SATE_Up), and TLS socket reads yield.

> A dead-end worth remembering: trying to free RAM by `bleStop()` (NimBLE deinit)
> mid-provisioning **crash-reboots** the board — deinit while a client is connected is
> unsafe. The single-core-during-setup approach above avoids needing to free BLE at all.

### 8.24 SLP-focused UI + auto-trim 5 sessions (fw 1.3.0–1.3.3)
Tuned for low-vision SLPs and standalone use:
- **Bigger fonts** (patient name + session rows `montserrat_20`); Home reduced to a
  big **"Ready to Record"** + a **tappable red record dot** (fires the same
  `ACT_RECORD` path as the physical RECORD button — tap OR button both record) +
  one full-width **Sessions** button. Removed the patient Age/Session/SLP rows, the
  "Next patient" button, and the "Standalone" placeholder name (never shown).
- **Auto-trim:** after every save the device keeps only the **5 newest** sessions
  per patient (`trimSessionsToMax`, `MAX_SESSIONS_ON_DEVICE = 5`) — older files are
  deleted so the SD stays light and the Sessions list stays fast. The lifetime
  count is tracked separately (see §8.27), so trimming doesn't lose the total.
  **⚠️ Trim only deletes `.synced` sessions and yields the GUI between deletes —
  see §8.29; the naive 1.5.0 version could freeze the "Saving..." screen.**

### 8.25 ⭐ Screen auto-dim — battery saver (fw 1.4.0)
The LCD **backlight is on GPIO45** (active HIGH; defined in the TFT_eSPI
`FNK0104AB` setup). At boot `backlightInit()` takes the pin over with **LEDC PWM**
so brightness is adjustable. After **5 min idle** (`SCREEN_DIM_MS`, tracked via
`lv_disp_get_inactive_time()`) the backlight drops to ~4% (`BL_DIM`); **any touch
or button press wakes it** to full (`wakeScreen()` also called at record start so
the screen stays lit through a take). Dimming the backlight is the **only** real
power saver on an LCD — an on-screen black overlay would not cut backlight current.
> The radio is the next ceiling: the firmware runs a continuous loop with **no
> Wi-Fi modem-sleep / light-sleep**, so even dimmed the ESP32+Wi-Fi floor is
> ~90–110 mA. Rough runtime on a 3000 mAh 1S LiPo: ~14–16 h screen-on idle,
> ~26–31 h dimmed idle, ~11–13 h recording+uploading. Modem-sleep
> (`WiFi.setSleep(true)`) is the cheap next win and does **not** drop the Wi-Fi
> association (no reconnect).

### 8.26 No on-device playback on speakerless units (fw 1.4.0)
The shipping units have **no speaker**, so on-device playback was removed: the
Sessions screen is **info + delete only** (rows are plain panels, not play
buttons; tapping does nothing). Recordings auto-upload to SATE and are reviewed in
the web/app report. The `playSessionAudio` / I2S-out path still compiles (some
board revisions have the ES8311 speaker amp) but is no longer reachable from the
UI. **If a unit does have a speaker, re-enable the row's `ACT_PLAY_SESSION`
action.** (The §1 table still lists the codec's speaker-amp output for boards that
populate it.)

### 8.27 Device telemetry to the admin dashboard (fw 1.5.0, mV added 1.5.4)
Every heartbeat now also sends **battery %**, a **lifetime recording count**, and
(fw 1.5.4) the **raw cell mV**: `...&bat=<0-100|255>&recs=<n>&mv=<mV|-1>`
(`connSetTelemetry()`, refreshed every ~10 s). The count is **NVS-persisted**
(`Preferences "sate-stats"`, key `recs`) so it survives reboots **and** the §8.24
auto-trim — you can't derive it from files on the card. 255 = battery unknown,
`mv=-1` = sensing unavailable. Server side: `device-api` (v18) writes
`sate_devices.battery_pct` / `total_recordings` / `battery_mv`; the `/admin` page
shows all three columns so a super-admin sees every recorder's charge, raw cell
voltage, and total without logging into the owner's account. **`bat=255` must map
to `null`** in the edge fn, not `255` (same for `mv<=0`).
> The **Cell mV** column is what to read for **battery-% calibration** (§8.31): pair
> the shown mV against a multimeter on the cell at a few charge levels, then adjust
> the divider scale in `readBatteryMv()` and the `batteryPercent()` LUT.

### 8.28 OTA is live — keep the dual-slot partition (fw 1.1.6+)
The device pulls firmware updates over the air: the heartbeat returns
`ota:{url,version}` when an `ota` command is queued (admin **Publish firmware**
card uploads the `.bin` to Supabase Storage + `sate_firmware`); `runOtaUpdate()`
downloads it, flashes the **spare** app slot, and reboots into it. **This only works because the
build uses a dual-app-slot partition (`default_8MB`, see §3).**
> ⚠️ **Known gap (audit 2026-07-22): there is NO device-side OTA rollback.** `verifyOta` is not
> overridden, so the new slot is marked valid on first boot with no post-boot self-test — a bad
> image that still boots enough to mark itself valid can **brick** the device. Needs a post-boot
> self-test before GA; until then, treat every OTA as one-way and stage it on a spare board first. A unit flashed with a
single-slot scheme (`huge_app`) cannot receive OTA and needs one more USB flash
onto the dual-slot layout first. Bump `FIRMWARE_VERSION` every release (§ top) —
OTA compares it to decide whether to flash.

> ⚠️ **`ota_state: err-space` = the image is bigger than the device's spare OTA
> slot** (`Update.begin()` failed). This bit us going to 1.5.0: units still on an
> **older/smaller** partition (the 4 MB `default` scheme has ~1.3 MB app slots, and
> `huge_app` has no spare slot at all) took the small 1.1.x images fine, but the
> **1.74 MB** 1.5.0 image no longer fits. There is **no OTA fix** — the target
> partition is decided at USB-flash time. Any device provisioned before we
> standardized on `default_8MB` (3.3 MB slots) needs **one more USB flash with
> `default_8MB`**; after that it OTAs every future build. The web shows a generic
> "didn't begin — check the image is published" message, but the image is fine —
> read `ota_state` on the device row: `err-space` = partition too small,
> `err-get<code>`/`err-write` = download/stream problem, `updating` = in progress.

### 8.29 ⭐ Fix: "stuck at Saving" — safe auto-trim + uploader SD handshake (fw 1.5.1)
1.5.0's §8.24 auto-trim ran on the **save path** with three faults that stacked
into a freeze on the **"Saving..."** overlay (touch + buttons dead, sometimes
indefinitely):
1. **No GUI yield** in the save block — the core was blocked through the metadata
   write + NVS bump + trim, so the spinner froze for the full duration.
2. **Trim deleted the raw oldest session** regardless of upload state, and
   **renamed every remaining session's files** to renumber. On a device that
   recorded offline, the oldest was often **unsynced / still uploading** → it wiped
   an un-uploaded recording (**data loss**) and did heavy SD metadata work in the
   hot path.
3. **The uploader kept its source file open across passes** and `connSetUiSdBusy()`
   only flipped a flag — it never closed that handle. Trim's delete/rename then hit
   the open file → FATFS returned **`FR_LOCKED`**, ops failed silently, and a single
   SD call could block for seconds while the net task held the FATFS lock during a
   slow TLS-backed read. Net effect: **stuck at Saving**.

Fixes (fw 1.5.1):
- **`trimSessionsToMax` only deletes `.synced` sessions** (`sessionSynced()` checks
  the sync marker) — never an unsynced/uploading recording; it stops as soon as the
  oldest isn't synced, and trims it on a later save once it uploads. No data loss.
- **`lv_timer_handler()` between deletes** keeps the screen alive during trim.
- **Uploader releases the SD on the net task:** when `uiSdBusy` goes true, the
  connectivity state machine closes `upFile` and drops `upActive` (in
  `connectivity.cpp`, the `else` on the `if (!uiSdBusy)` branch — done on **core 0**
  to avoid a cross-core `File` race). The sweep re-begins the session from the
  server's known offset once the UI releases the bus, same as an upload stall.

### 8.30 Charging indicator — layered detection, no charge-status pin (fw 1.5.33)
**Behaviour: USB-C plugged in ⇒ charging ⇒ the Home battery chip animates** (a bolt
plus the battery glyph sweeping EMPTY→FULL on a ~1.3 s loop, in green, with the live
% beside it). Once the charger has terminated the sweep **stops on a full glyph at
100%** — an animation that never ends reads as stuck.

**Why this is inference and not a pin read.** The charge circuit is **on-board** (the
USB-C feeds both the S3's native USB and the charger) and exposes **no CHRG/STAT
line** to a GPIO. Two hardware facts bound what firmware can do:
- `usb_serial_jtag_is_connected()` (`HWCDC::isPlugged()`) counts **SOF packets**, so
  it only sees a real USB **host**. IDF's own docs: *"Having the USB port connected
  to a power bank will never be considered as connected."* **True is trustworthy,
  false is not.**
- The ESP32-S3 has **no VBUS-sense register** — with the internal PHY, the OTG
  `vbus_valid` is tied high, so it can't be read either.

**The layers** (`batteryService()` in `SATE_Recorder.ino`, one ADC sample per 3 s,
32 reads averaged):

| # | Signal | Effect |
|---|--------|--------|
| a | USB **host** attached — or **lost** after being attached (1-sample debounce) | plugged / unplugged, certain. The only **bidirectional** signal here. |
| b | sensed node ≥ **4250 mV** | plugged (no 1S cell rests there) |
| c | **step** ≥ **25 mV** between consecutive raw samples | the fast path: plugging in moves the ~120 mA load off the cell *and* pushes ~1 A through its internal resistance, so the node jumps **60–90 mV** within one sample. Unplug mid-charge is the same in reverse. |
| d | **4-minute trend**, ±**8 mV** on the smoothed value | catches a **boot/OTA reboot that happened while already on the charger** (no step to see). CC charge climbs ~3 mV/min ≈ 12 mV/window; an idle pack drains ~0.5 mV/min — the two never overlap. |

Anything none of the layers can see **holds the previous state** — the chip never
flickers.

> **Two design rules that are load-bearing, both found by simulation, not the bench:**
> 1. **Slow tests run on the smoothed (EMA) value, only the step test on the raw
>    read.** The slow tests compare against single-digit mV thresholds — the same
>    size as the ADC's own noise — so run raw they misfire constantly.
> 2. **The trend and the charge-terminated test are windowed *slopes* (compare the
>    two ends of a fixed window, decide once, reopen), never "has it moved since the
>    reference".** A threshold retested every sample against a fixed reference is
>    eventually crossed by noise alone, and the *sign* of that crossing is a coin
>    flip; the ratchet variant has the mirror bug — noise keeps restarting the clock
>    so the window never completes and the state is never reached.

**Known limit (accepted).** Unplugging a **full** pack from a **dumb charger** is
nearly invisible — the charger already stopped pushing current, so there is no step —
and takes a trend window or two (**~4–8 min**) to notice. Off a USB **host**, layer
(a) catches it immediately.

> **⭐ Upgrade to true detection (one wire):** a TP4056/TP4057-class **CHRG (STAT)**
> pad is open-drain, **LOW while charging**, floating when done. Solder CHRG → a
> spare GPIO, enable the internal pull-up, read `LOW` = charging, and every caveat
> above disappears. IP5306/power-bank ICs report status over **I²C** instead.

**History:** 1.5.0/1.5.1 used `if (Serial)` (true whenever USB was enumerated for
power → "charging" when it wasn't). 1.5.2 replaced it with a ±15 mV-per-5 s trend,
which mis-called the state often enough that **1.5.6 hid the animation entirely**
(`SHOW_CHARGE_EFFECT 0`). 1.5.33 is the rewrite above and turns it back on.

### 8.31 ⭐ Battery protection: low-voltage cutoff + charging heat (fw 1.5.3)
Two separate problems on a 1S LiPo (**3000 mAh** cell as shipped).

> **Capacity-independent protection:** the guard thresholds below are **per-cell
> VOLTAGE** (mV), not capacity, so moving between a 1000 mAh and a 3000 mAh cell
> needs **no code change** — only the runtime is ~3× longer on 3000 mAh (§8.25/§11).
> The battery **%** is voltage-based too (no coulomb counting), so it's correct on
> any capacity.

**Battery-% calibration (fw 1.5.8).** The raw read under-reads ~1.4% (divider
tolerance + ESP32 ADC): a full cell measured **~4142 mV raw**, so `readBatteryMv()`
applies a 1-point **gain `4200/4142 ≈ 1.014`**. Refine with a second low-end point
(multimeter vs the /admin **Cell mV** column) and adjust `BAT_CAL_GAIN` (or the
`batteryPercentFromMv()` LUT) if the low range drifts.

**⚠️ Why the battery never reached 100% — and the fix (fw 1.5.33).** The old curve
put 100% at **4200 mV**, the charger's CV setpoint, which the *sensed node* never
actually shows in service. Three effects stack:
1. a TP4056-class charger **terminates** when the taper current falls to ~1/10 of
   `Iset`; the cell then **relaxes to ~4.15–4.18 V** while still plugged in,
2. the device's own **~120 mA draw sags** the node another ~10 mV below the resting
   voltage the LUT was written against,
3. the divider + S3 ADC under-read is corrected by a **1-point gain tuned on one
   unit**, so any other board lands a few mV low.

So a genuinely, completely full pack read ~4150 mV and displayed **95% forever**.
Two changes make 100% reachable and honest:
- the LUT now tops out at **`BAT_FULL_LUT_MV` = 4150 mV = 100%** (top of the curve
  respaced: 4150/4120/4090/4050/4000…),
- a **charge-terminated latch**: on USB power, above `BAT_FULL_MV` (4120 mV), if the
  smoothed reading climbs **< 6 mV across a 4-minute window** the charger has
  finished → report a real **100%**, held until the pack actually starts draining
  (< `BAT_FULL_CLEAR_MV`, 4050 mV) so the chip doesn't fall back to 96% the instant
  the cell relaxes off 4.20 V.

Two related quality fixes in the same version: `readBatteryMv()` averages **32**
reads (was 8) since the charge detector's whole error budget is ADC noise, and the
displayed % is smoothed (EMA ~12 s) then **ratcheted one-way** — counts up only
while charging, down only while discharging — so it never jitters 89/90/89.
`connSetTelemetry()` now reports the **same smoothed sample** the % came from, so
the admin **Cell mV** column and the % beside it are always a consistent pair.

**A) Over-discharge (firmware — fixed in 1.5.3).** A LiPo dragged below ~3.0 V is
permanently damaged. The board has no low-voltage cutoff wired to the ESP, so the
firmware now guards the cell in software:
- `serviceBatteryGuard()` (every loop) — when the cell reads **< `BAT_CRIT_MV`
  (3350 mV)** for **~24 s sustained** (3 samples @ 8 s, so a WiFi/record sag can't
  false-trip) **and it isn't charging**, it warns then `esp_deep_sleep_start()`.
  Deep sleep is **~10 µA vs the ~100 mA** running floor, so the discharge
  effectively **stops** — the cell can't sink further.
- Wakes on a **RECORD-button press** (GPIO2, ext0, RTC pull-up held) or a **5 min
  timer**. `batteryBootGuard()` in `setup()` re-checks on every wake and only boots
  normally once the cell has recovered (been charged) — it even re-samples for a
  rising trend so a unit genuinely on the charger boots instead of re-sleeping.
- Thresholds are **at-the-cell mV under load** (deliberately low; load sags the
  reading). `BAT_SENSE_ENABLED` must be on (GPIO9 ADC) or the guard no-ops.
> Firmware only protects the cell while the device is **on**. For a true cutoff
> that works even when off, use a **protected charge board** — a TP4056 **with the
> DW01 + FS8205 protection** (the 6-pad `B+ B- OUT+ OUT-` version), which cuts the
> cell off at ~2.4 V in hardware.

**B) Charging runs warm — chip heat, NOT the cell (hardware).** The TP4056 is a
**linear** charger: it burns `(Vin − Vcell) × Icharge` as heat in that tiny SOP-8.
On a **3000 mAh** cell the stock **1 A = 0.33C**, which is **gentle on the cell**
(the cell stays cool — expected/safe). Only the **chip** runs warm (~1.3 W), because
that dissipation depends on Vin/current, not capacity. So a hot chip + cool cell =
normal; the chip also self-limits with thermal regulation (~120 °C). Firmware cannot
set the charge current — it's the **`Rprog` resistor** (SMD marked **`122` = 1.2 kΩ**):

| Rprog | Marking | Charge current | 3000 mAh C-rate | Full-charge time |
|-------|---------|----------------|-----------------|------------------|
| 1.2 kΩ (stock) | `122` | ~1000 mA | 0.33C (fine) | ~3.5 h, chip warm |
| **2.4 kΩ** | `242` | **~500 mA** | 0.17C (gentle) | ~7 h, chip cooler |
| 4.0 kΩ | `402` | ~300 mA | 0.1C | ~11 h, coolest |

On 3000 mAh the stock 1 A is **fine for the cell** — only lower `Rprog` (→ `242`) if
the **chip** running warm bothers you (cuts its heat ~half, at ~2× charge time).
Don't **record while charging** (stacks load + heat) and give the board airflow.

---

## 12. Shipping an update to the fleet (publish → OTA)

The whole "cut a new firmware and push it to every device" flow is scripted in
**`scripts/publish_firmware.sh`** — the CLI equivalent of the web Admin
**"Publish firmware"** card. It:
1. Bumps `FIRMWARE_VERSION` (auto patch-bump, or pass an explicit version),
2. Compiles `SATE_Recorder/` with the **OTA partition** (`default_8MB`),
3. Admin-logs-in to Supabase → JWT,
4. `POST`s the `.bin` to `device-api /firmware?version=…&notes=…` → uploads to the
   `firmware` Storage bucket + inserts a `sate_firmware` row,
5. every **online** device on an OTA-capable partition pulls it on its next
   heartbeat (§8.28) — no USB.

```bash
./scripts/publish_firmware.sh                 # auto-bump patch (1.5.0 -> 1.5.1)
./scripts/publish_firmware.sh 1.6.0 "notes"   # explicit version + release notes
```

Setup once: `cp scripts/.publish.env.example scripts/.publish.env` and fill in an
**admin** account (must be in `sate_admins`). `scripts/.publish.env` is **gitignored**
— never commit real creds. Requires `arduino-cli`, `curl`, `jq`.

Guard rails baked in: refuses to reuse a version; forces `PartitionScheme=default_8MB`
(so a publish can never ship an OTA-broken partition); creds stay out of git.

> ⚠️ **First-ever flash of a NEW device is still USB** (bootstrap — a device with no
> OTA-capable firmware can't receive OTA). Flash it once with `default_8MB` (§3), then
> it lives on OTA. And see §8.28: a device already on `huge_app` / a too-small slot
> needs one USB reflash before the first OTA works.

---

## ⚠️ Edge function `verify_jwt` MUST stay `false` for `device-api`

**Symptom:** recorder setup fails at the very end — screen shows **"Registration
Rejected"**, the app shows **"Setup link expired — sign out and back in"**. WiFi
connects fine; the failure is the register step. The app can still mint a claim
token (it has a user JWT), so the token exists + stays `used=false`.

**Root cause:** the `device-api` Edge Function was redeployed with
**`verify_jwt: true`**. The recorder's `POST /api/devices/register` is
*unauthenticated* (it carries only the `apikey` anon header + a claim token in the
body — the device has no Supabase user JWT yet). With `verify_jwt: true` the
**Supabase gateway rejects the call with 401 *before* the function runs**, so:
- the device sees a 4xx → firmware's "Registration Rejected" path,
- the function never executes → **no server-side log / no DB write** (this is the
  tell: a 4xx the function can't account for = gateway-level rejection).

`device-api` does its **own** auth inside the function (device keys `Bearer key-`,
claim tokens, and `supabase.auth.getUser` for user routes), so the gateway check
must be OFF. Same applies to the other unauthenticated functions: `mobile-link`,
`process-device-session`, `process-mobile-uploads`, `stripe-webhook` — all
`verify_jwt: false`.

**The trap:** the MCP `deploy_edge_function` tool **defaults `verify_jwt` to
`true`**. If you redeploy `device-api` and don't pass `verify_jwt: false`
explicitly, you silently break ALL device endpoints (register, heartbeat, session
upload) even though the app keeps working (the app sends a real user JWT).

**Rule:** every `device-api` deploy MUST set **`verify_jwt: false`**. After any
redeploy, verify with `list_edge_functions` that `device-api.verify_jwt === false`.

> Diagnostic that nailed it: device on USB showed "Registration Rejected" (a real
> 4xx) while the server's register-debug table stayed empty across attempts → the
> request was dying at the gateway, not in our code. Firmware anon key + server URL
> were both correct, which ruled everything else out.
