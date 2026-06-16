# 01 — Architecture

## Components

| Component | Tech | Source | Role |
|-----------|------|--------|------|
| Recorder firmware | Arduino / ESP32-S3, NimBLE, WiFiClientSecure | `SATE_Touch_Patient_Record_Play_White/` | Capture audio → SD → upload (Wi-Fi) or expose over BLE |
| Companion app | Expo SDK 54, React Native, `react-native-ble-plx` | `src/` | Setup, claim, offline bridge, remote control |
| Backend | Supabase (Postgres + Storage + Edge Functions / Deno) | `react_app_sate-ui_update/supabase/functions/` | Auth, device API, AI orchestration, persistence |
| Web app | Vite + React 19 + TypeScript | `react_app_sate-ui_update/src/` | The SLP-facing SATE app (manual uploads, results) |
| AI service | external HTTP (`/process`) over an ngrok tunnel | `https://sate-v1-5.ngrok.io/process` | Transcribe + segment audio |
| Mock server | Node/Express | `mock-server/` | Local stand-in for the backend during dev |

## The recorder's two connectivity modes

The recorder is designed to work **independently** of the phone:

- **Online (Wi-Fi):** uploads sessions straight to the backend over HTTPS and polls for
  remote commands. The app is not required.
- **Offline (no Wi-Fi):** advertises BLE "needs sync"; the app auto-connects and **bridges**
  pending sessions to the backend over the phone's connection.

BLE is also used **once** for first-time setup (Wi-Fi provisioning + claiming the device to
the signed-in SLP). See [04-ble-protocol.md](04-ble-protocol.md).

## Four end-to-end flows

### A. Provisioning / claim (BLE, one time)

```
App (signed-in SLP)                Recorder                    Supabase
  │ POST /devices/claim-token  ───────────────────────────────►  mint sate_claim_tokens row
  │   ◄── { token }                                              │
  │ BLE write {op:provision, ssid,pass,server,claim_token}  ──►  │
  │                              WiFi.begin(ssid,pass)           │
  │   ◄── ev:state connecting                                    │
  │   ◄── ev:state wifi_ok                                       │
  │                              POST /api/devices/register ──►  validate claim_token,
  │                                {serial, claim_token, fw}     insert sate_devices,
  │                                   ◄── { device_key }         bind to SLP, mark token used
  │   ◄── ev:state registered (device_id)                       │
```

The device stores `device_key` (`key-dev-<serial>`) as `cfgDeviceKey` and the `server` URL as
`cfgServer`, then operates on its own. Details: [02-firmware.md](02-firmware.md),
[03-companion-app.md](03-companion-app.md#provisioning).

### B. Online upload (Wi-Fi, no phone)

```
Recorder ── record → WAV on SD
  │  POST /api/sessions/chunk?...&offset&final   (apikey + Bearer key-dev-…)   ~1 MB slices
  ▼
device-api (edge fn)  → stitch slices → patch WAV header → device-sessions bucket
  │                     insert sate_device_sessions → triggerProcessor(session_id)
  ▼
process-device-session (edge fn)  → resolve patient → POST AI /process → countErrors +
                                     calculateSpeechAnalysis → copy WAV to recordings bucket →
                                     INSERT recordings → mark session processed
```

Sliced upload keeps the device responsive and online; a dropped slice is retried at its own
offset (idempotent). See [05-backend-supabase.md](05-backend-supabase.md) and
[06-ai-pipeline.md](06-ai-pipeline.md).

### C. Offline bridge (BLE)

```
Recorder advertises  ADV flags: needs_sync, pending=N
  │ App auto-connects, {op:list_sessions} ── ◄ ev:sessions [{n,patient_id,bytes}]
  │ for each pending: {op:send_session,n} ── ◄ ev:file + raw WAV bytes on CHAR_DATA ── ◄ ev:file_done
  │ App uploads WAV to backend (same recordings path as a manual upload)
  │ {op:mark_synced,n} ── ◄ ev:ok
```

### D. Remote command (Wi-Fi)

```
App  POST /api/devices/:id/commands {op, patient?}  → sate_device_commands
Recorder poll  GET /api/devices/:id/commands?pending&state  (every ~12 s)
  → runs: sync_now | reload_patients | reboot | record
  (record: device captures + uploads, tagging the app-provided active patient)
```

## Where state lives

| State | Home |
|-------|------|
| Audio (raw WAV, pending) | Recorder SD card; mirrored to `device-sessions` bucket on upload |
| Final clinical result | `recordings` table + `recordings` storage bucket |
| Device identity / ownership | `sate_devices` (serial, device_key, slp_id) |
| Claim tokens | `sate_claim_tokens` (minted by app, consumed at register) |
| Remote command queue | `sate_device_commands` |
| Device→clinical patient links | `sate_device_patients`, `patients.device_patient_id` |
| SLP session (app) | AsyncStorage `sate-companion-settings-v3` (token, refresh, expiry, user) |
| Device config (recorder) | SD config file: `cfgServer`, `cfgDeviceKey`, `cfgDeviceId`, Wi-Fi creds |

## Trust / auth model

- **App → backend:** real Supabase user JWT (same account as the web app). device-api validates
  it for SLP-scoped routes.
- **Device → backend:** `Bearer key-dev-<serial>` device key (issued at registration) for
  device routes; plus the public `apikey` (anon key) the Supabase Edge gateway requires.
- **Edge fn → edge fn / DB:** service-role key (or `PROCESSOR_SECRET`) server-side only.
- The **anon key is public by design** — the web app ships it in its JS bundle; the firmware
  embeds the same constant.
