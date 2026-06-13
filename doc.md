# SATE Companion — Work Log & System Doc

This document records everything changed across the companion app, the ESP32-S3
recorder firmware, and the dev/test tooling, plus how the two halves connect.

Last updated: 2026-06-13.

---

## 1. System overview

Two pieces talk to one SATE backend (shared account with the SATE web app):

```
 ┌─────────────┐   BLE (setup / fallback)    ┌──────────────────┐
 │  iPhone app │◀───────────────────────────▶│  SATE Recorder   │
 │ (Expo / RN) │                             │   (ESP32-S3)     │
 └──────┬──────┘                             └────────┬─────────┘
        │ HTTPS                                       │ HTTPS (Wi-Fi)
        ▼                                             ▼
                 ┌─────────────────────────┐
                 │   SATE server / API     │   (mock-server in dev)
                 └─────────────────────────┘
```

Two connectivity modes on the recorder:

- **Wi-Fi (default, online):** the recorder uploads recorded sessions straight
  to the server and polls `GET /api/devices/:id/commands` (~15 s) for remote
  commands. Patient roster is pulled from the server.
- **BLE bridge (fallback / setup):** when Wi-Fi is unavailable, or during
  first-time setup, the recorder advertises the SATE GATT service so the app can
  provision Wi-Fi, bridge-sync sessions, and send commands.

The BLE GATT protocol (UUIDs, JSON ops, chunk framing) is mirrored exactly
between `src/protocol.ts` (app) and `connectivity.cpp` (firmware).

---

## 2. Environment / toolchain

- **Node:** v20.19.4 required (Expo SDK 54). Managed with nvm.
  `nvm alias default 20.19.4`; prefix one-off commands with
  `source ~/.nvm/nvm.sh && nvm use 20.19.4`.
- **App:** Expo SDK 54, React Native 0.81.5, React 19.1.0. Installs need
  `npm install --legacy-peer-deps`.
- **BLE:** `react-native-ble-plx` needs a **custom dev build** (Expo Go cannot
  load it). `expo-dev-client` is installed for this.
- **Firmware:** arduino-cli, ESP32 core, NimBLE-Arduino 2.x, ArduinoJson 7.x,
  LVGL 8.4, ES8311 codec, SD_MMC, Preferences (NVS), HTTPClient, WiFi.
  - FQBN: `esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi`
  - Serial port: `/dev/cu.usbmodem101`. Device serial: `SATE-D19EB8` (from eFuse MAC).
- **Phone:** iPhone "HLong", iOS 26.5. Bundle id `com.auspexmedix.satecompanion`.
- **Mac LAN IP (dev server host):** **dynamic — changes when the Mac joins a
  different Wi-Fi.** Get the current value with `ipconfig getifaddr en0`. It was
  `10.3.228.57`, now `192.168.0.138` (2026-06-12). When it changes you MUST
  update the app's Server URL (`http://<ip>:4000`) **and** restart Metro pinned
  to it (`REACT_NATIVE_PACKAGER_HOSTNAME=<ip> npx expo start --dev-client`), or
  both "can't open the app" (Metro unreachable) and "can't reach SATE server"
  (provision fails) appear together.

### Build / run commands

```bash
# App (Metro + iOS dev client on the phone)
source ~/.nvm/nvm.sh && nvm use 20.19.4
npx expo run:ios --device "HLong"      # build + install + launch dev client
npx expo start --dev-client            # just the bundler, once installed

# Firmware
arduino-cli compile --fqbn "<FQBN above>" SATE_Touch_Patient_Record_Play_White
arduino-cli upload -p /dev/cu.usbmodem101 --fqbn "<FQBN above>" SATE_Touch_Patient_Record_Play_White

# Dev server
cd mock-server && node server.js       # listens on :4000, token "dev-token"
```

---

## 3. App changes

### 3.1 Expo SDK 54 + Node
- Downgraded/pinned to Expo SDK 54 so Expo Go matches; updated Node to 20.19.4.
- Fixed recurring `Cannot find module 'babel-preset-expo'`: full wipe of
  `node_modules` + `package-lock.json` + `.expo`, then reinstall.

### 3.2 Device control over BLE (works while device offline)
- `src/protocol.ts`: added `export type BleCommand = "identify" | "reboot";`.
- `src/ble/SateBle.ts`: added `sendCommand(op: BleCommand)` to the `SateLink`
  interface and all implementations (`BleLink`, `MockLink`).
- `src/screens/DeviceDetailScreen.tsx`: added a `link` prop, `findNearby()`
  (scans BLE for the device by serial), and `bleCommand()` so **Identify** and
  **Restart** work even when the device is offline (previously remote-only over
  Wi-Fi). Buttons no longer disabled when offline.

### 3.3 Render crash fix (Expo Go)
- `new NativeEventEmitter() requires a non-null argument` — `BleManager` was
  constructed during render where the native module is null. Made the manager
  **lazy** with a try/catch that surfaces a clear "needs a dev build" message;
  `stopScan` uses `this.manager_?.stopDeviceScan()`.

### 3.4 iOS dev build — bundle URL (null) fix
- Symptom on the phone: *"No script URL provided… unsanitizedScriptURLString =
  (null)"*.
- Cause: `expo-dev-client` was **missing**, so the plain RN debug build defaults
  its bundle URL to `localhost` (= the phone itself) → null on device.
- Fix: `npx expo install expo-dev-client` + rebuild. The dev launcher now
  auto-discovers Metro on the LAN (`10.3.228.57:8081`) or lets you type the URL.

### 3.5 Wi-Fi list duplicate-key warning
- Symptom: `Encountered two children with the same key` for `Velocity Wi-Fi` /
  `Velocity Guest`.
- Cause: mesh / band-steering APs share an SSID; the list used SSID as the React
  key.
- Fix (`src/screens/ProvisionScreen.tsx`): `dedupeNetworks()` collapses by SSID
  keeping the strongest RSSI (sorted), and `keyExtractor` is now
  `` `${n.ssid}-${i}` `` as a safety net.

### 3.6 Provisioning safety timeout
- `src/ble/SateBle.ts` `provision()` waited indefinitely for a terminal status.
  Added a **60 s guard** so a mid-setup BLE drop can't freeze the provisioning
  screen (firmware worst case ≈ 28 s connect + retry + 8 s register).

### 3.7 Remote record + live status (full demo)
End-to-end "tap a button → recorder captures + uploads → app watches it land":
- `src/protocol.ts`: `RemoteCommand` gained `"record"`; `ManagedDevice` gained
  `state` (`idle` | `recording` | `uploading`); new `UploadedSession` type for
  `GET /api/sessions`.
- `src/api/sateApi.ts`: `listUploads(serial?)` on the interface + `HttpApi`.
  `MockApi` simulates the whole loop (`simulateRecord`: device → `recording` →
  `uploading` → a new session appears) so the demo runs **with no hardware**
  (Demo mode). `MockApi.uploadSession` now also records the bridge-synced file.
- `src/screens/DeviceDetailScreen.tsx`: now polls the server every 4 s for a
  **live** view of this recorder + its uploads. Added a **Record a session
  now** button (online-only; goes out as the `record` remote command), a status
  pill that flips to **RECORDING / UPLOADING**, and a **Recent recordings**
  card listing the last 5 uploads (patient, session #, duration, "uploaded …").
  Wrapped in a `ScrollView` (six cards now).

---

## 4. Firmware changes (`SATE_Touch_Patient_Record_Play_White/`)

New files: `connectivity.h`, `connectivity.cpp` (NimBLE GATT server + Wi-Fi
client). Main sketch heavily reworked. **Firmware version: 0.6.0.**

### 4.1 Real connectivity (`connectivity.cpp`, ~800 lines)
- Full NimBLE GATT server implementing the SATE service:
  - Service `53415445-0001-4a7e-8c5e-000000000001`
  - Characteristics: `CHAR_INFO` (read), `CHAR_CONTROL` (write), `CHAR_STATUS`
    (notify), `CHAR_DATA` (notify).
  - Chunk framing: `FRAME_PARTIAL 0x01`, `FRAME_FINAL 0x02`, 180-byte chunks.
  - Advertising manufacturer data `[0x5A magic, flags, pending, 0]`
    (flags: unprovisioned 0x01, needs-sync 0x02).
- BLE ops handled: `scan_wifi`, `provision`, `list_sessions`, `send_session`,
  `mark_synced`, `set_patients`, `identify`, `reboot`.
- Wi-Fi mode: HTTP session upload to `POST /api/sessions` (base64 WAV in PSRAM
  buffers), heartbeat/command poll to `GET /api/devices/:id/commands?pending=N`,
  auto patient fetch when online.
- Config persisted in NVS (`ssid`, `pass`, `server`, `dev_id`, `dev_key`);
  `provisioned` is derived from those being present.
- Serial built from `ESP.getEfuseMac()` (not `WiFi.macAddress()`, which returns
  zeros before STA starts) → `SATE-D19EB8`.

### 4.2 Async Wi-Fi scan (fixed "device did not respond on time")
- A synchronous `WiFi.scanNetworks()` stalls many seconds under BLE
  coexistence, blocking notifications past the app's 20 s timeout.
- Now **non-blocking**: `scan_wifi` starts `WiFi.scanNetworks(true)`; `connLoop()`
  collects the result via `WiFi.scanComplete()` and notifies when ready.
  BLE never blocks. Confirmed working — real networks returned to the app.

### 4.3 Robust Wi-Fi provisioning (so the board reliably joins the user's Wi-Fi)
In `handleBleOp("provision")` and `handleProvisionTick()`:
- **Cancel any in-flight async scan** before `WiFi.begin()` (a leftover scan
  holds the radio and makes connect flaky under BLE coexistence).
- Clean STA bring-up: `WiFi.persistent(false)`, `setAutoReconnect(true)`,
  `disconnect(false)` to clear half-open state, then `begin()`.
- **One automatic retry** of `begin()` after 11 s if the first is swallowed.
- Longer windows: connect timeout 20 s → **28 s**, reboot-reconnect 12 s → 18 s.
- **Fast wrong-name detection:** `WL_NO_SSID_AVAIL` fails in ~2 s with "Network
  not found" instead of waiting the full timeout.
- Terminal status always emitted (`registered` or `error`) so the app resolves.

Provisioning state machine:
`PROV_WIFI` (connect) → `PROV_REGISTER` (`POST /api/devices/register`,
unauthenticated route, returns `device_id`/`device_key`) → save config → stay on
BLE until the app disconnects, then `enterWifiOnline()` takes over.

### 4.4 No dummy data — real patient roster only
- Removed the 3 firmware seed patients (Maya / Ethan / Sophia). Roster starts
  **empty**; patients arrive only from the app (`set_patients`) or the server
  (`/sate/patients.json` via fetch). Verified live: `provisioned=0`, 0 patients.
- Removed the simulated SATE-AI analysis entirely (`DemoAnalysis`, `djb2`,
  `makeDemoAnalysis`, the fake WPM/mispron/filler/grammar metrics).

### 4.5 Real sync (was fully simulated)
- `runSyncDemo()` (fake upload progress + fake AI) → **`runSync()`** which drives
  the real connectivity upload: triggers the sweep, pumps `connLoop()`, and a
  session is only marked synced after the **server accepts it**. Progress bar
  tracks the real pending count. Offline → tells the user to use Wi-Fi/the app.
- Results screen rewritten to show **real facts** (patient, sessions uploaded,
  audio duration, "saved to your account", remaining pending) — no invented
  metrics, no "demo" chip.

### 4.6 Memory optimization
- Patient roster cap **12 → 6** (only patients under test are kept).
- Dropped the `DemoAnalysis` struct and helpers.
- Net **−936 bytes** global RAM. Build now 49 % flash / 28 % RAM.
- Recordings already stream straight to SD — never buffered whole in RAM.

### 4.7 On-device onboarding / connection screen
- New `ONBOARDING` state acts as a **gate**: until the recorder is claimed to an
  account **and** has a patient roster (`deviceReady()`), the user sees **only**
  the onboarding screen — no Home, no Record.
- Modern layout: title, device serial, live status icon + live status line, and a
  4-step checklist with done / active / todo states:
  1. Bluetooth ready → 2. App connected → 3. Wi-Fi connected → 4. Account + patients.
- Auto-unlocks to Home the moment setup completes (driven by connectivity hooks
  `sateHookConnChanged` / `sateHookPatientsUpdated` consumed in `loop()`).
- A separate live **Connection** screen (tap the header Bluetooth/Wi-Fi icon)
  shows mode, serial, IP, pending count, setup state.

### 4.8 Remote record command (`record`) — **firmware 0.7.0**
- `connectivity.cpp`: the Wi-Fi command poll now handles `record` →
  `sateHookRecord()`. New `connSetLiveState("recording"|"idle")` is reported to
  the server in the heartbeat (`&state=…`) and, when online, forces an immediate
  heartbeat so the app sees the change without waiting the 15 s cycle.
- Sketch: new `connRecordReq` flag (set by the hook) is consumed in `loop()`
  only when the UI is idle on **Home** and `deviceReady()`. It records via
  `runRecordSavePlaySession(review=false, …)` — a new shorter
  `REMOTE_RECORD_SECONDS` (8 s) capture that **skips the review playback**
  (nobody is holding the unit) and auto-uploads through the normal
  `connNotifyNewSession()` sweep. `recordWavStreamToSd` / the record flow are
  now parameterized by capture size; the on-device 30 s tap path is unchanged.
- Builds at **50 % flash / 28 % RAM**.

---

## 5. Dev server (`mock-server/`)

- `server.js`: real persistence (`data.json` survives restarts) and real file
  handling — uploaded sessions are written to `uploads/` as **playable WAV** +
  `.json` metadata. Listens on `:4000`, token `dev-token`.
- Auth allows the app account token (`Bearer dev-token`) and device keys
  (`Bearer key-dev-…`); `/api/devices/register` is intentionally unauthenticated
  (guarded by the one-time claim token).
- Endpoints: `POST /api/auth/login`, `GET/POST/PATCH/DELETE /api/devices…`,
  `POST /api/devices/claim-token`, `POST /api/devices/register`,
  `GET/POST /api/devices/:id/commands`, `GET/PUT /api/patients`,
  `POST/GET /api/sessions`.
- Heartbeat `GET /api/devices/:id/commands` now also reads `&state=` and stores
  it on the device (surfaced as `ManagedDevice.state`); the offline sweep resets
  it to `idle`. `GET /api/sessions?device=<serial>` filters to one recorder and
  returns newest-first. A queued `record` op rides the existing command queue.
- `PUT /api/patients` sets the clinic's real roster (the recorder picks it up on
  reconnect / `reload_patients`).
- `e2e-test.js`: 22 protocol tests, all passing; writes real WAVs to `uploads/`.

> Note: `data.json` may still hold 3 demo patients from earlier testing. To use a
> real roster, overwrite it:
> ```bash
> curl -X PUT http://localhost:4000/api/patients \
>   -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" \
>   -d '[{"patient_id":"PT-2001","name":"Real Patient","age":"8y","session_type":"Articulation","clinician":"Dr. You"}]'
> ```

---

## 6. End-to-end setup flow

1. Start the dev server: `cd mock-server && node server.js` (must be reachable
   from **both** the phone and the recorder).
2. App: demo mode **OFF**, Server URL = `http://10.3.228.57:4000` (Mac LAN IP —
   not `localhost`, because the **board** also calls this URL over Wi-Fi to
   register).
3. App → Set up a recorder → BLE finds `SATE-D19EB8` → pick Wi-Fi (e.g. Velocity
   Wi-Fi) → enter password → Continue.
4. App fetches a claim token from the server, then sends `provision` over BLE.
5. Board joins Wi-Fi → gets IP → `POST /api/devices/register` → saves config →
   onboarding screen flips to Home; patients sync; recordings upload as real
   WAVs into `mock-server/uploads/`.

### Watch the board during setup
```bash
arduino-cli monitor -p /dev/cu.usbmodem101 -c baudrate=115200
```

---

## 7. Known gotchas / troubleshooting

- **"Network request failed" on setup** = the **app→server** request failed
  (usually the mock server isn't running, or Server URL is `localhost`/wrong IP).
  This happens *before* any Wi-Fi is tested — start the server, set the LAN IP,
  retry. (This was the cause of the "right password but still error" report.)
- **Board can't register** even though it joined Wi-Fi = the Mac/server isn't
  reachable from the board's network. Put the Mac on the same LAN/subnet the
  board joins.
- **`device did not respond on time`** during Wi-Fi scan = fixed by the async
  scan (4.2). Reflash if seen on old firmware.
- **iOS "No script URL"** = needs `expo-dev-client` + rebuild (3.4); ensure Metro
  is up and the phone is on the same Wi-Fi as the Mac.
- **iOS launch "invalid code signature / profile not trusted"** = on the phone,
  Settings → General → VPN & Device Management → trust the Apple Development
  certificate.
- **Serial port `[Errno 6] Device not configured`** = the USB CDC dropped (board
  reset or two readers on the port). Reopen the port; close other monitors first.

---

## 8. Key files

| File | Purpose |
|---|---|
| `src/protocol.ts` | BLE service/characteristic UUIDs, ops, types (mirror of firmware) |
| `src/ble/SateBle.ts` | `SateLink` interface, `BleLink`, `MockLink`, provision/sync/commands |
| `src/screens/ProvisionScreen.tsx` | Setup wizard: scan → Wi-Fi → creds → provision |
| `src/screens/DeviceDetailScreen.tsx` | Device control incl. offline BLE Identify/Restart |
| `src/sync/AutoSync.ts` | Background auto-sync |
| `SATE_…/connectivity.h` / `.cpp` | Firmware Wi-Fi + BLE GATT, provisioning, upload |
| `SATE_…/SATE_…​.ino` | Main sketch: UI, screens, onboarding gate, record/sync |
| `mock-server/server.js` | Dev SATE API with real persistence + WAV files |
| `mock-server/e2e-test.js` | 22 protocol tests |
