# 02 — Recorder firmware

ESP32-S3 touchscreen recorder. Arduino framework, NimBLE for BLE, `WiFiClientSecure` +
`HTTPClient` for HTTPS. Source: `SATE_Touch_Patient_Record_Play_White/`.

Current version: **fw 1.0.3** (see [07-runbook.md](07-runbook.md#firmware-version-history)).
Deep hardware reference (pin map, audio pipeline, optimization playbook): root `hardware.md`.

## File map

| File | Responsibility |
|------|----------------|
| `SATE_Touch_Patient_Record_Play_White.ino` | `setup()` / `loop()`, UI state machine, screen flows, record/play, hook handlers |
| `connectivity.cpp` / `.h` | BLE provisioning, Wi-Fi, HTTPS upload, command polling, device config, SD session scan |
| `display.cpp` / `.h` | LVGL screen driver + touch |
| `es8311.cpp` / `.h` / `es8311_reg.h` | ES8311 audio codec (I2S capture/playback) |
| `sate_logo_white.h` | Logo bitmap |

## Single-core execution model

`loop()` runs sequentially on one core:

```c
void loop() {
  runGui();                 // LVGL + touch
  serviceFactoryResetButton();
  if (currentState != ERROR_STATE) {
    connLoop();             // BLE ops, Wi-Fi state, command poll, upload step
    // consume connectivity flags (connStateReq, connPatientsReq, connRecordReq, …)
    screen.routine();       // immediate repaint after any network/SD work
  }
  // pending UI action …
}
```

There is **no separate network task** — GUI and networking interleave on the same core. The
handoff from networking to GUI is **flag-based**: `connLoop()` sets flags (`connStateReq`,
`connPatientsReq`, `connActivePatientReq`, `connRecordReq`), and `loop()` consumes them on the
GUI side. This matters for the lag fix below and for the possible future move of networking to
core 0.

## Connectivity state machine (`connLoop`)

```
CONN_WIFI_TRYING ──connected──► CONN_WIFI_ONLINE
       │ timeout                       │ Wi-Fi lost
       ▼                               ▼
   CONN_BLE_ADV ◄──────────────► CONN_BLE_CONNECTED
   (advertise)   app connects     (BLE session)

PROV_* substates run during provisioning (handleProvisionTick) and short-circuit the above.
```

`CONN_WIFI_ONLINE` per pass:
- **command poll** every `CMD_POLL_PERIOD_MS` (12 s) → `pollCommands()`
- **heartbeat** every `HEARTBEAT_PERIOD_MS` → `scanPending()` (refresh cached pending count)
- **patients fetch** when `patientsFetchDue`
- **upload step**: one ~1 MB slice per pass via `uploadStep()` (cooperative; GUI keeps running)

## HTTP layer (`httpJson`, `sendSessionChunk`)

- `serverIsSupabase()` switches between `WiFiClientSecure` (TLS, port 443, `setInsecure()`)
  for Supabase and plain `WiFiClient` for the mock server.
- Supabase requests carry **two** auth headers: `apikey: <anon key>` (gateway requirement) and
  `Authorization: Bearer <cfgDeviceKey>` (device identity).
- `httpJson` streams the response straight into a caller buffer (no `String` alloc) and uses
  `setReuse(true)` for keep-alive.
- `sendSessionChunk` POSTs one ~1 MB slice (`?offset=&final=`), pumping the GUI between socket
  writes so the screen stays smooth during upload.

### Touch-lag fix (fw 1.0.3)

Symptom: screen unresponsive after Wi-Fi connect, only on Supabase. Cause: the Supabase Edge
gateway closes the keep-alive socket, so every command poll paid a full ~1–2 s **blocking TLS
handshake** that froze touch on the single core. The mock server (plain HTTP) was cheap, so the
lag was Supabase-only. Mitigation:

- `CMD_POLL_PERIOD_MS` 3000 → **12000** (fewer handshakes; commands still land within ~12 s).
- `setInsecure()` called **once**, not per request (re-calling churned the TLS client and
  defeated any reuse the gateway did grant).
- `sateHookGuiPump()` **before and after** `pollCommands()` so the screen repaints right around
  the freeze.

Proper fix if still rough: move `connLoop()` networking to a **core-0 FreeRTOS task** (GUI stays
on core 1, never blocks). The flag-based handoff already exists; it needs an SD mutex and to drop
the manual `sateHookGuiPump()` calls (the GUI task would run on its own).

## Device config (persisted on SD)

| Field | Meaning |
|-------|---------|
| `cfgServer` | Backend base URL (`…/functions/v1/device-api` for Supabase, or mock URL) |
| `cfgDeviceKey` | `key-dev-<serial>` issued at registration; sent as `Authorization: Bearer` |
| `cfgDeviceId` | Server device id |
| Wi-Fi SSID/pass | Joined network |
| `provisioned` | Whether setup is complete (drives BLE-adv vs Wi-Fi-try on boot) |

`connInit()` loads this, builds the serial, then enters `CONN_WIFI_TRYING` if provisioned else
BLE mode.

## Sessions on SD

`scanPending()` walks the SD card for un-synced sessions and caches the count (advertised in BLE
manufacturer data so the app sees pending without connecting). A session is "done" only when its
wav + parts + `.synced` marker state agree — the fix in fw 0.9.3 stopped a purged-audio session
from hiding all later ones. Synced audio is purged on boot (self-cleaning SD).

## Optimization summary

The recorder runs in tight RAM. Key techniques (full detail in `hardware.md`):

- Stream everything — no length-proportional `malloc` (response streamed into fixed buffers).
- Big buffers `static`, off the task stack; loop-task stack sized deliberately.
- No Arduino `String` in hot paths.
- `delay(1)` yield in the record loop (long-session stability, not watchdog subscription).
- Cooperative ~1 MB sliced upload — stay responsive and online during a multi-MB transfer.
- Segment recording with zero merge — less I/O and risk.
- Cache the pending-session scan; double-buffered DMA draw buffers; PSRAM/internal RAM split.

See [07-runbook.md](07-runbook.md) for build/flash, and the BLE wire format in
[04-ble-protocol.md](04-ble-protocol.md).
