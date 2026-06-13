# SATE Companion (React Native / Expo)

Phone app for the SATE Recorder. Signs in with the **same SLP account as the
SATE web app**; recorders you set up are claimed to that account.

## Connectivity model (two modes, automatic)

```text
                 +--------------------+
   Wi-Fi OK      |    SATE  Server    |     app manages the fleet
  ───────────►   |  (sessions, fleet, | ◄───────────────────────────
  device uploads |   remote commands) |        REST + Bearer token
  by itself      +--------------------+
                        ▲
                        | phone's internet
   No Wi-Fi             |
  ───────────►   [ SATE Companion ]  ◄──── BLE ────  [ SATE Recorder ]
  device advertises "needs sync"; app auto-connects and bridges
```

- **Mode 1 - Wi-Fi (default).** The recorder is independent: it uploads
  sessions straight to the server and polls `GET /api/devices/:id/commands`
  (~15 s) for remote commands. The app only talks to the server.
- **Mode 2 - BLE bridge (fallback).** No Wi-Fi -> the recorder advertises
  `needs_sync` + pending count. While the app is open, auto-sync connects,
  pulls each WAV over BLE, uploads it with the phone's connection, and the
  recorder marks it synced only after the server confirms.
- Mode switching is automatic on the device; the SLP never chooses.

## App features (v0.1)

- Sign in with the SATE account (demo mode: any credentials work)
- Recorder fleet: online/offline, firmware, last seen, pending sessions,
  10-second auto-refresh
- Remote control over Wi-Fi: Sync now / Reload patients / Identify / Restart
- First-time setup over BLE: device scans Wi-Fi -> pick network -> password
  -> claim token binds the recorder to your account -> live progress
- Automatic BLE bridge sync with a live status banner (foreground; true
  background sync is a v0.2 item)
- Rename / remove recorders; demo mode (no hardware or backend needed)

## Run it

```bash
npm install
# BLE needs a custom dev client (Expo Go cannot load react-native-ble-plx):
npx expo run:android      # or: npx expo run:ios
```

Demo mode is ON by default - the whole flow works immediately. To test
against a server: Settings -> Demo mode OFF, then either your real backend
or the included mock:

```bash
cd mock-server && npm install && npm start   # http://<your-ip>:4000
```

## BLE protocol (mirrored by firmware)

Service `53415445-0001-4a7e-8c5e-000000000001`

| Char (suffix) | Dir | Purpose |
|---|---|---|
| `...0010` INFO | read | `{ model, fw, serial, provisioned }` |
| `...0020` CONTROL | write | JSON commands (chunk-framed) |
| `...0030` STATUS | notify | JSON events (chunk-framed) |
| `...0040` DATA | notify | raw WAV bytes (chunk-framed) |

Commands: `scan_wifi`, `provision{ssid,pass,server,claim_token}`,
`list_sessions`, `send_session{n}`, `mark_synced{n}`, `set_patients{[...]}`.

Framing: every packet is `[flag][payload]`; `0x01` partial, `0x02` final.
Advertising adds 4 manufacturer bytes: `0x5A`, flags (bit0 unprovisioned,
bit1 needs_sync), pending count, reserved.

## Server API

```text
POST  /api/auth/login              { email, password } -> { token, user }
GET   /api/devices                 -> ManagedDevice[]
POST  /api/devices/claim-token     -> { token }            (app)
POST  /api/devices/register        { serial, claim_token, fw }  (device)
GET   /api/devices/:id/commands    ?pending=N -> { commands }   (device poll
                                   doubles as heartbeat: sets online=true)
POST  /api/devices/:id/commands    { op }                  (app)
PATCH /api/devices/:id             { name }
DELETE /api/devices/:id
GET   /api/patients                -> Patient[]
POST  /api/sessions                { device_serial, patient_id,
                                     session_number, sample_rate,
                                     wav_base64 }
```

`mock-server/server.js` implements all of it, including the device-side
endpoints, so firmware can be developed against it directly.

## Firmware counterpart (next step, v0.5.0)

On the ESP32-S3: NimBLE GATT server with the table above; boot tries Wi-Fi
for ~12 s -> on success: register/heartbeat + auto-upload pending sessions +
poll commands; on failure: advertise needs_sync and serve the BLE bridge.
Streaming architecture stays: BLE transfer reads the WAV from SD in the same
static 4 KB chunks. A 30 s session (~940 KB) takes roughly 40-90 s over BLE
at MTU 247 - the app shows per-file progress for exactly this reason.
