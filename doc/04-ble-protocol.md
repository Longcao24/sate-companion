# 04 — BLE protocol

Two independent BLE stacks live in this app, both on plain `react-native-ble-plx` (no proprietary
SDK, unlike Plaud):

1. **SATE Recorder** (ESP32-S3, NimBLE) — Wi-Fi provisioning, a JSON command channel, and an
   offline "bridge sync" that pulls stored WAV sessions to the phone when the recorder has no Wi-Fi.
2. **SATE Pendant** (XIAO nRF52840, Adafruit Bluefruit / Nordic S140) — a live raw-PCM audio stream.

Both share ONE `BleManager` (see [The single shared BleManager](#the-single-shared-blemanager)).

Canonical wire definitions:

| Side | Recorder | Pendant |
|------|----------|---------|
| Firmware | `SATE_Recorder/connectivity.cpp` (fw **1.5.32**, `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`) | `SATE_Pendant/SATE_Pendant.ino` (fw **1.0.0**) |
| App | `src/protocol.ts` (constants) + `src/ble/SateBle.ts` (`BleLink`) | `src/pendant/PendantLink.ts` (`NativePendantLink`) |

The recorder constants in `src/protocol.ts` are mirrored **byte-for-byte** by `connectivity.cpp`
lines 27–42; if you change one, change both.

---

# Part A — SATE Recorder

## Connectivity model (why BLE exists at all)

- The recorder works **independently**: with Wi-Fi it uploads sessions straight to the SATE server
  (resumable `POST /api/sessions/chunk`) and polls `GET /api/devices/:id/commands` every ~3 s for
  remote commands.
- With **no Wi-Fi** it advertises BLE "needs sync"; the app auto-connects and **bridges** the
  stored WAV sessions to the server over the phone's connection.
- BLE is also used **once** for first-time setup (Wi-Fi provisioning + claiming the device to the
  signed-in SLP account), and later for **change-Wi-Fi** and direct control (`reboot` /
  `factory_reset`) of an off-Wi-Fi unit.

The recorder default is **Standalone**: a session's `patient_id` is a local label, and pushing a
patient roster (`set_patients`) is NOT a patient assignment — assignment happens later on the web
report. Do not force it at capture time.

## Service + characteristics

Service UUID `53415445-0001-4a7e-8c5e-000000000001` — the ASCII bytes `SATE\0\x01…`
(`SATE_SERVICE`, `connectivity.cpp:27`). All four characteristics live under this one service.

| Const | UUID | NimBLE property | App use |
|-------|------|-----------------|---------|
| `CHAR_INFO` | `…0010` | `READ` | One-shot identity JSON (see below), read on connect |
| `CHAR_CONTROL` | `…0020` | `WRITE` (with response) | JSON commands app → device, chunk-framed |
| `CHAR_STATUS` | `…0030` | `NOTIFY` | JSON events device → app, chunk-framed |
| `CHAR_DATA` | `…0040` | `NOTIFY` | Raw WAV bytes of a pulled session, chunk-framed |

`CHAR_INFO` read payload (`InfoCB::onRead`, `connectivity.cpp:1029`):

```json
{"model":"SATE Recorder","fw":"1.5.32","serial":"<serialStr>","provisioned":true|false}
```

`provisioned` is `true` when the NVS config holds a non-empty SSID, server, **and** device id
(`connectivity.cpp:327`).

**MTU:** firmware calls `NimBLEDevice::setMTU(247)` (`bleStart`, `connectivity.cpp:1052`); the app
connects with `{ requestMTU: 247 }` (`BleLink.connect`). BLE name for `NimBLEDevice::init` is the
device serial.

## Advertising vs scan-response (the recorder's name quirk)

`bleUpdateAdvertising()` (`connectivity.cpp:1082`) splits the two advertising payloads:

- **ADV packet** carries `flags 0x06` (LE General Discoverable, BR/EDR unsupported), the
  **service UUID**, and 6 bytes of **manufacturer data**.
- **SCAN RESPONSE** carries only the **name** (`scanResp.setName(serialStr)` → the device serial).

Because the service UUID is in the ADV packet, the app can scan **with** a service filter
(`startDeviceScan([SATE_SERVICE], …)`, `BleLink.beginScan`) and still discover the recorder without
a connection; it then falls back to `dev.name || "SATE Recorder"`. (Contrast the pendant, whose
service UUID and name land differently — see Part B.)

### Manufacturer data (6 bytes)

```
byte:  0     1     2      3       4                 5
       0xFF  0xFF  0x5A   flags   pending(0..255)   0x00
       └─ company id ─┘   magic   flags   pending  rsvd
```

Built at `connectivity.cpp:1092` as `md[6] = {0xFF,0xFF, ADV_MAGIC, flags, pending, 0x00}`:

- `0xFFFF` is the BLE "test/unassigned" company id (2 bytes, little-endian on the wire).
- `ADV_MAGIC = 0x5A`.
- `flags`: `ADV_FLAG_UNPROVISIONED (0x01)` when not yet set up; `ADV_FLAG_NEEDS_SYNC (0x02)` when
  provisioned **and** it has pending sessions (`connPendingTotal() > 0`).
- `pending` = pending-session count, capped at 255.

**App parse** (`BleLink.beginScan`, `SateBle.ts:168`): it decodes `dev.manufacturerData` and scans
for `ADV_MAGIC` **at offsets 0 and 2**, then reads flags at `+1` and pending at `+2`. The dual
offset is because platforms differ on whether the 2-byte company id is included in the buffer the
app sees; checking both offsets makes the parse company-id-transparent. So the app can show
"needs setup" / "needs sync" / a pending count **without connecting**.

> ⚠️ **Correction vs the old doc:** the manufacturer data is **6 bytes** (`FF FF 5A flags pending
> 00`), not 4 — the old doc's `[0] magic [1] flags [2] pending [3] reserved` was missing the
> leading 2-byte `0xFFFF` company id, which is exactly why the parser has to check offset 2.

## Chunk framing

Any payload (JSON or binary) larger than one packet is split into `[flag][payload]` packets:

```
flag 0x01 = FRAME_PARTIAL (more follow)
flag 0x02 = FRAME_FINAL   (last packet of this message)
```

Constants `FRAME_PARTIAL`/`FRAME_FINAL` (`protocol.ts:47`, `connectivity.cpp:33`). Payload MTU is
**180 bytes** (`BLE_CHUNK`, `connectivity.cpp:42`; `frameChunks(…, mtuPayload = 180)`,
`SateBle.ts:107`). Both `CHAR_STATUS` and `CHAR_DATA` use the same flag byte.

- **App → device reassembly** (`CtrlCB::onWrite`, `connectivity.cpp:1003`): partials accumulate into
  `ctrlAsm` (max `CTRL_BUF_MAX = 6144` bytes); on `FRAME_FINAL` the message is copied into `opBuf`
  under `opMux` for `connLoop()` to consume on the loop task. An unknown flag resets the assembler.
- **Device → app reassembly** (`FrameAssembler`, `SateBle.ts:86`): pushes each packet's body, and on
  `FRAME_FINAL` returns the concatenated message; an unknown flag resets.
- **Device → app framing** (`notifyFramed`, `connectivity.cpp:1112`): sends each 180-byte slice with
  `ch->notify()`, retrying up to **50 times × 5 ms (~250 ms)** if the TX queue is full, with a 2 ms
  pacing delay between packets. It returns **false** if the client is gone or a packet can't be
  sent — so a dropped packet is never treated as delivered (this is what stops a truncated WAV from
  looking fully sent).

## Control ops (app → device, `CHAR_CONTROL`)

Dispatched by `handleBleOp()` (`connectivity.cpp:2220`). Ops that touch the SD card first check the
`uiSdBusy` gate and reply `err … "recorder busy - try again"` if the UI core owns the card (recording
/ saving / playback / delete) — a bridge sync must never walk the card mid-take.

| Op | Args | Effect | Firmware |
|----|------|--------|----------|
| `scan_wifi` | — | Async **passive** Wi-Fi scan (300 ms/ch, coex→`PREFER_WIFI`, modem-sleep off); result arrives later as `ev:scan`. Not used in BLE-only onboarding. | `2226` |
| `provision` | `ssid, pass, server, claim_token` | First-time setup: join Wi-Fi, then `POST /api/devices/register`, persist creds+key, claim to the account. Streams `ev:state`. | `2254` |
| `change_wifi` | `ssid, pass` | Move an **already-claimed** unit to a new network. Joins Wi-Fi, persists new creds against the **existing** account/device key — **no re-register**. Requires `provisioned`, else `err`. Ends `ev:state wifi_saved`. | `2293` |
| `cancel_wifi` | — | App backed out of change-Wi-Fi: leave change-mode immediately (don't wait for timeout). Acks `ev:ok`. | `2324` |
| `list_sessions` | — | `scanPending()` then `ev:sessions` with **pending only** (unsynced) sessions. | `2332` |
| `send_session` | `n` (1-based index into the last `list_sessions`) | Reply `ev:file`, stream the WAV on `CHAR_DATA`, end `ev:file_done` (or `err`). | `2352` |
| `mark_synced` | `patient_id`+`session` (preferred) or legacy `n` | Write the `.synced` tombstone. Acks `ev:ok`. | `2360` |
| `set_patients` | `patients[]` | Overwrite `/sate/patients.json`. Acks `ev:ok`. | `2392` |
| `reboot` | — | Ack `ev:ok`, then reboot ~800 ms later. | `2410` |
| `factory_reset` | — | Ack `ev:ok`, then wipe Wi-Fi + account and reboot to first-time setup ~800 ms later. Used to unlink an off-Wi-Fi unit the server can't reach. | `2414` |

App wrappers live in `BleLink` (`SateBle.ts`): `scanWifi`, `provision`, `changeWifi`,
`listSessions`, `pullSession`, `markSynced`, `setPatients`, and `sendCommand(op)` for the direct
`BleCommand = "reboot" | "factory_reset" | "cancel_wifi"` set (`protocol.ts:208`).

> ⚠️ **`mark_synced` resolves by identity, not by index.** Newer apps pass `{patient_id, session}`;
> the legacy `{n}` is still accepted but re-validated against the card (`connectivity.cpp:2366`).
> A device-side delete can invalidate a stale index, and a marker written on the wrong slot silently
> drops a real recording from the pending set forever. The firmware also refuses with `"session gone"`
> if the audio is no longer local (`sessionHasAudioLocal`).

> ⚠️ **`identify` is gone.** The old doc listed an `identify` op ("beep + flash"); it is not
> implemented in `handleBleOp()`. `protocol.ts` still mentions it in a comment but there is no wire
> handler and no `BleLink` method. (The pendant has a `find-me` LED command — see Part B.)

## Status events (device → app, `CHAR_STATUS`)

| Event | Fields | Emitted by |
|-------|--------|-----------|
| `scan` | `networks: [{ssid, rssi, sec}]` | Wi-Fi scan collector in `connLoop()` |
| `state` | `state`, `ip?`, `device_id?`, `msg?` | Provisioning / change-Wi-Fi progress |
| `sessions` | `items: [{n, patient_id, bytes}]` (pending only; `n` = 1-based index) | `list_sessions` |
| `file` | `n, bytes, meta` — then raw bytes stream on `CHAR_DATA` | `sendSessionOverBle` |
| `file_done` | `n` — **only** sent when `sent == total` bytes were notified | `sendSessionOverBle` |
| `ok` | `op` | `statusOk()` |
| `err` | `op`, `msg` | `statusErr()` |

`ProvisionState` (`protocol.ts:74`): `connecting → wifi_ok → registering → registered`
for `provision`; `connecting → wifi_ok → wifi_saved` for `change_wifi`; either can end in `error`
with a human-readable `msg`.

> ⚠️ **New state `wifi_saved`** (change-Wi-Fi terminal state) did not exist in the old doc.

## Flows

### Provision (first-time setup)

```
App ── write {op:provision, ssid, pass, server, claim_token}
Device ── notify ev:state connecting
       ── (WiFi.begin; retries every ~8 s; 28 s window)
       ── notify ev:state wifi_ok {ip}
       ── notify ev:state registering
       ── POST {server}/api/devices/register  {serial, claim_token, fw}
       ──   2xx w/ {device_id, device_key} → persist NVS → notify ev:state registered {device_id}
       ──   4xx  → notify ev:state error "Setup link expired…"  (fail fast, no retry)
       ──   other → up to 5 attempts, then ev:state error "Couldn't reach SATE…"
```

Firmware timing constants: `WIFI_PROV_TIMEOUT_MS = 28000` (Wi-Fi connect window),
`WIFI_PROV_RETRY_MS = 8000` (re-issue `WiFi.begin` every ~8 s → ~3 tries in the window). The
register POST runs on the **main loop**, not the net task (the net task isn't started until the
device goes online), so the heap has room for the TLS handshake while BLE stays connected. A 2xx
that parses but carries **no** `device_id`/`device_key` is treated as failure (an error envelope or
gateway-rewritten body), never persisted (`connectivity.cpp:2164`).

**Coexistence:** during the connect the firmware sets `esp_coex_preference_set(PREFER_WIFI)`,
disables modem sleep, and uses full TX power so a valid password isn't failed by the 4-way handshake
losing airtime to the live BLE link; it restores `PREFER_BALANCE` on exit.

**App guard** (`BleLink.provision`, `SateBle.ts:290`): a **60 s** timeout (worst case ≈ 28 s Wi-Fi +
register attempts) resolves `{state:"error"}` so a mid-provision BLE drop can't wedge the UI forever.
`changeWifi` uses a tighter **45 s** guard (no register step).

On success the device stays in BLE (`provState = PROV_IDLE`) until the app disconnects, then goes
online. Registration credentials are stored in NVS as `cfgSsid/cfgPass/cfgServer/cfgDeviceId/cfgDeviceKey`.

### Change Wi-Fi (keep the account)

```
App ── write {op:change_wifi, ssid, pass}   (device must be provisioned)
Device ── notify ev:state connecting → wifi_ok {ip} → wifi_saved
       (persists new ssid/pass against the SAME server + device_key; no register)
```

An SLP uses this instead of a factory reset when the clinic Wi-Fi changes. A recorder that is
**online** can be pushed into this mode remotely via the `wifi_change` command
(`runRemoteCommand`, `connectivity.cpp:2451`) — it drops to BLE and advertises so the phone can push
new creds; the account is untouched. If the app disconnects mid-wait or sends `cancel_wifi`, the
recorder leaves change-mode and resumes normal operation (`SrvCB::onDisconnect` clears
`wifiChangeMode`).

### Pull a session (offline bridge sync)

```
App ── write {op:list_sessions}   ── ◄ ev:sessions [{n, patient_id, bytes}]
App ── write {op:send_session, n} ── ◄ ev:file {n, bytes, meta}
                                   ── ◄ raw WAV bytes (180-B framed) on CHAR_DATA …
                                   ── ◄ ev:file_done {n}      (only if sent == bytes)
App ── upload WAV to backend (same recordings path as a manual upload)
App ── write {op:mark_synced, patient_id, session} ── ◄ ev:ok
```

**Firmware side** (`sendSessionOverBle`, `connectivity.cpp:~1930`): the take may be a single legacy
`.wav` or the newer **segment files** (`part00`, `part01`, …). For segments it sends one assembled
44-byte WAV header sized for all the PCM, then each part's PCM with its own per-part header stripped,
so the byte count matches `sessionAssembledBytes()` exactly (part0 keeps its header; later parts are
PCM-only, seeking past byte 44). `meta` is the raw session JSON. It counts every notified byte in
`sent`; if the UI core claims the card mid-stream (`uiSdBusy`) or a notify fails, it aborts **without**
`file_done`, and the app discards the partial.

**App side** (`pullSession`, `SateBle.ts:382`): accumulates `CHAR_DATA` chunks, reporting progress
against the `bytes` from `ev:file`. It waits for `ev:file` (header) and `ev:file_done` (120 s
timeout), then **reconciles the byte count** — `assembled.length !== total` throws so the caller
retries. This is critical: BLE notifications are unacknowledged, so a dropped data notify would
otherwise silently truncate the only copy of a take, and a short WAV would be uploaded and
`markSynced`'d as complete. Both sides guard this: the firmware only claims `file_done` at
`sent == total`, and the app only accepts a transfer of exactly `total` bytes.

`mark_synced` writes a `.synced` **tombstone** (the slot stays numbered; sessions are never
renumbered). The audio itself is only freed later, server-verify-gated — see
[Interaction with SD reclaim](#interaction-with-sd-reclaim).

## Server registration & the bridge upload target

- **Register** (`provision`): `POST {server}/api/devices/register` with `{serial, claim_token, fw}`,
  unauthenticated (no device key yet), `apikey` header added when the server is Supabase. Handled by
  device-api (**[v18]**, `react_app_sate-ui_update/supabase/functions/device-api/index.ts`), which
  accepts both `/api/devices/register` and `/register`.
- **Bridge upload** (`send_session` → phone → server): the phone uploads the pulled WAV through the
  **same** path as a manual upload (`api.uploadSession` → device-api `POST /sessions`), not directly
  from the recorder. Wi-Fi-online recorders instead upload themselves via resumable
  `POST /api/sessions/chunk`.

## Interaction with SD reclaim

`mark_synced` (or a Wi-Fi self-upload) writes only the `.synced` marker. **Audio is never freed on a
marker alone.** `trimPatientSyncedAudio()` reclaims audio of synced takes older than the newest
`KEEP_AUDIO_SESSIONS (=5)` device-wide, and only after `verifySessionStored()` gets a byte-exact
`stored:true` from `GET /api/sessions/verify` (device-api ≥ v15 — checks the DB row **and** that the
storage object exists). Any doubt (offline, non-2xx, parse fail, byte mismatch) keeps the audio.
Sessions are **never renumbered**: numbers are allocated monotonically and wrap at 99, and holes are
legal. See [05-backend-supabase.md](05-backend-supabase.md) and the agent-memory `no-renumber-sessions`.

## Threading model (recorder)

NimBLE callbacks (`CtrlCB::onWrite`, `SrvCB::on(Dis)Connect`, `InfoCB::onRead`) run on the BLE host
task and do the **bare minimum** — copy bytes into `ctrlAsm`/`opBuf`, flip `bleClientConnected`. The
actual op is executed by `connLoop()` on the main loop task. During provisioning `connLoop()` runs on
the loop (the core-0 net task is not started until the device goes online), which is why the register
TLS handshake has contiguous internal RAM while BLE is connected.

---

# Part B — SATE Pendant

The pendant (Sona/Nuna, XIAO nRF52840 Sense) is plain `react-native-ble-plx` GATT — **no proprietary
SDK, no binding/lock concern** (unlike Plaud). It streams live raw PCM; the app wraps it in a WAV and
pushes it through the **same** `api.uploadSession` pipeline, `device_serial = pendant-<bleId>`.
Recordings upload as **Standalone** by default; patient assignment is optional and can be done later.

## Service + characteristics

Base UUID family `19B10000-E8F2-537E-4F6C-D104768A1214` (`SATE_Pendant.ino:88`,
`PendantLink.ts:22`). Lowercased in the app to match ble-plx's normalized UUIDs.

| Const | UUID | Property | Payload |
|-------|------|----------|---------|
| `AUDIO_SERVICE` | `19b10000-…` | service | container |
| `AUDIO_CHAR` | `19b10001-…` | `NOTIFY`, fixed len 244 | raw PCM: **244 bytes = 122 × int16 LE** samples |
| `CONTROL_CHAR` | `19b10002-…` | `WRITE`, fixed len 1 | 1-byte command |
| Battery Service | `0000180f-…` | standard | — |
| Battery Char | `00002a19-…` | `NOTIFY`/read | 1 byte: bit7 = charging, low 7 bits = percent |

The firmware also exposes **Nordic BLE DFU** (`BLEDfu bledfu` — OTA firmware over BLE) and the
standard **Battery Service** (`BLEBas batSvc`). DFU is added first so its attribute handle stays fixed
across firmware versions (`SATE_Pendant.ino:267`).

### PCM format (exact)

- 16-bit **signed** PCM, **little-endian**, **mono**, **16 kHz** (`SAMPLE_RATE`).
- Each notify = `PKT_SAMPLES = 122` samples = **244 bytes** (chosen as the max notify at MTU 247).
- Byte rate = 32 000 B/s; the app computes duration as `capturedBytes / (16000 × 2) × 1000` ms.
- The app wraps the accumulated PCM in a 44-byte canonical WAV header (`pcmToWavBase64`,
  `PendantLink.ts:127`): `RIFF`/`WAVE`, fmt = PCM(1), 1 channel, 16 kHz, byte-rate 32000, block-align
  2, 16 bits/sample.

### Control commands (`CONTROL_CHAR`, 1 byte)

| Byte | Const | Effect (`onCtrlWrite`, `SATE_Pendant.ino:198`) |
|------|-------|-----------------------------------------------|
| `0x01` | `CMD_START` | Begin streaming: `micStart()` (drops ~140 ms of mic-settle), `recording = true` |
| `0x00` | `CMD_STOP` | Stop streaming: `PDM.end()`, `recording = false` |
| `0x02` | `CMD_FIND_ME` | Flash LEDs ~5 s to locate the pendant (`findMeUntil = millis()+5000`) |

## Advertising vs scan-response (the pendant's name quirk)

`setup()` (`SATE_Pendant.ino:295`):

- **ADV packet**: flags (LE-only general discoverable), TX power, and the **audio service UUID**
  (`Bluefruit.Advertising.addService(audioSvc)`).
- **SCAN RESPONSE**: the **name** only (`Bluefruit.ScanResponse.addName()` → `"SATE Pendant"`, set via
  `Bluefruit.setName`).
- Advertising interval: fast 20 ms for the first 30 s, then slow 152.5 ms
  (`setInterval(32, 244)`), `restartOnDisconnect(true)`.

Because the name is in the scan response, iOS surfaces it as **`localName`**, not `name` — and
`dev.name` may be a **stale cached GAP name** from an earlier firmware (e.g. `"Nuna-Necklace"`).

**App scan strategy** (`NativePendantLink.startScan`, `PendantLink.ts:187`), and this is load-bearing:

- Scan with **NO service filter** (`startDeviceScan(null, {allowDuplicates:true}, …)`). iOS can
  deliver the service UUID and the name in **separate** callbacks; a service filter would hide a
  name-only sighting and vice versa.
- A device **matches** if `dev.name` OR `dev.localName` matches `/sate|pendant|nuna/i`, **OR** it
  advertises `AUDIO_SERVICE` (the ground-truth fallback).
- `allowDuplicates:true` so a name-only or service-only advert still eventually matches.
- Every peripheral heard is reported via `onSeen` (diagnostics / manual pick) and logged once.

> When debugging "pendant not found", scan from the Mac (`bleak`) first to see what it really
> broadcasts, before blaming the app.

## Connection & streaming

`onConnect` (`SATE_Pendant.ino:214`) requests **2 M PHY** (doubles raw BLE rate), **MTU 247**, and a
**30 ms** connection interval (`requestConnectionParameter(24)`, 24 × 1.25 ms). At 16 kHz × 16-bit =
256 kbps this is tight, so the firmware also uses `configPrphBandwidth(BANDWIDTH_MAX)` (big notify
queue) and runs the SoC on the DC/DC regulator (`sd_power_dcdc_mode_set`) — needed because the hard
radio current bursts sag a low battery's rail on the default LDO and drop packets.

**Firmware pipeline** (`SATE_Pendant.ino`):
- PDM ISR (`onPDMdata`) reads samples, applies a **DC-block high-pass** (`HPF_R = 0.976`, ~60 Hz),
  then makeup gain `DIGITAL_GAIN = 6.0` with a **tanh soft-clip**, into an 8192-sample ring buffer.
  Overrun drops the newest sample (keeps the queued stream contiguous — one clean gap, not
  mid-buffer corruption).
- `loop()` drains the ring in 122-sample packets and `audioChr.notify(…, 244)`; on a full BLE queue
  it breaks and retries next loop (`ringTail` not advanced → nothing lost).
- **Nap mode:** after `SLEEP_AFTER_MS = 30 s` below `LOUD_MEANABS`, PDM + notifies stop (radio
  idles). It wakes on sound ≥ `WAKE_MEANABS` sampled during a short listen window every
  `NAP_CHECK_MS = 2 s`. **A notification gap while connected is NORMAL** (silence), not a disconnect.

**App pipeline** (`PendantLink.ts`):
- `start()` resets buffers, sets `capturing = true`, writes `CMD_START`.
- Audio notifications accumulate into `chunks` **only while `capturing`** — packets that arrive
  during the `CMD_STOP` round-trip are dropped (the `capturing` gate is why; without it the take
  duration crept to 0:01/0:02 after Stop).
- `stop()` sets `capturing = false` **before** writing `CMD_STOP`.
- `takeWav()` concatenates the PCM, applies **peak-normalize + loudness drive** (`applyGain`:
  `TARGET_PEAK = 0.97·full-scale`, `MAX_GAIN = 40`, `LOUDNESS = 2.6`, tanh soft-clip — the raw mic is
  very quiet), and returns the WAV. Firmware `MIC_GAIN`/`DIGITAL_GAIN` and app gain stack, so don't
  push both to clipping.
- Paired pendants persist in `AsyncStorage` (`src/pendant/PendantStore.ts`) → a known pendant
  reconnects straight by BLE id, no rescan.

Battery: firmware publishes `readBatteryPct() & 0x7F | (usbPlugged ? 0x80 : 0)` on the standard
Battery Service every 60 s (and on plug/unplug). The app masks bit7 as the charging flag
(`PendantLink.ts:294`).

---

# The single shared BleManager

**SATE and the Pendant SHARE one `BleManager`** — `getSharedBleManager()` in
`src/ble/bleManager.ts`. This is a hard rule, not style:

- `react-native-ble-plx` wraps a single native `CBCentralManager` and requires you keep **one**
  instance alive. A **second** instance — or **destroying and immediately recreating** one — leaves
  the native iOS BLE stack broken: scans return **zero devices, silently**. This is exactly what
  stopped the pendant being found for days (the SATE→Pendant handoff used to destroy SATE's manager,
  then the pendant built its own → empty scan).
- **SATE ↔ Pendant handoff: `stopScan()` only. NEVER destroy.** Only one scan per manager, so a
  screen taking over first calls `stopDeviceScan()`. Both `BleLink.teardown()` and
  `NativePendantLink.teardown()` drop only their own connection/subscriptions and do **not** destroy
  the shared manager (except `BleLink.teardown`, which destroys it **only** on the Plaud handoff).
- **Plaud handoff: DO destroy** (`destroySharedBleManager()`) — the proprietary Plaud SDK has its own
  `CBCentralManager` and needs the radio to itself; the shared manager is rebuilt lazily afterward.

The arbiter that enforces this is `src/ble/radio.ts` — the single source of truth for who owns the
radio. Logical owners `autosync | sate-fg | pendant | plaud` sit over the two physical stacks
(`bleplx`, `plaud`). `acquireRadio(owner)` is called **synchronously in the navigation handler** in
`App.tsx` (never in an effect — a parent effect runs after the child's and would stop the scan the
new screen just started). `plaud` is the only path that calls `destroyBle()`; every other handoff is
`stopBleScan()` only. Auto-sync (background BLE bridge) gates itself with `autoSyncAllowed()` and must
be paused on any screen that needs the radio. Leaving Plaud must call `plaud.disconnect()` (drop the
BLE link, keep the binding) — **never** `depair()`. See CLAUDE.md RULE #1/#2 and
[08-plaud.md](08-plaud.md).

---

# Cross-references

- Firmware capture / resume / remote-command internals: [02-firmware.md](02-firmware.md)
- Companion-app screens & radio wiring: [03-companion-app.md](03-companion-app.md)
- device-api routes, `/sessions/verify`, chunked upload: [05-backend-supabase.md](05-backend-supabase.md)
- Pendant hardware / flashing (Seeed core, `0x26000` SoftDevice trap): [09-pendant.md](09-pendant.md)
- Operational recipes (OTA order, Wi-Fi change): [07-runbook.md](07-runbook.md)
