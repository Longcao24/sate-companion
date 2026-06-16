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

FQBN: `esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi`
Port: `/dev/cu.usbmodem101`

```bash
cd SATE_Touch_Patient_Record_Play_White

arduino-cli compile --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi" .

arduino-cli upload -p /dev/cu.usbmodem101 \
  --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi" .
```

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
