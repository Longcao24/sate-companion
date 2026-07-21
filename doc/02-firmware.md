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

## Display, LVGL & the internal-RAM budget (⚠️ hard-won, read before touching `display.cpp` or `lv_conf.h`)

The LVGL config that actually compiles is **`~/Documents/Arduino/libraries/lv_conf.h`** — it is
**NOT in this repo**, it lives in the Arduino sketchbook libraries dir (under iCloud Drive). It is
overwritten every time lvgl is reinstalled (see the iCloud-eviction fix in
[07-runbook.md](07-runbook.md)). Three settings in it are load-bearing; a fresh lvgl install
resets all three and each has bitten us:

| `lv_conf.h` setting | Must be | If wrong |
|---|---|---|
| `LV_TICK_CUSTOM` | **`1`** (millis() source) | **Silent boot brick.** The firmware calls `lv_tick_inc()` **nowhere**, so with `0` LVGL's clock is frozen at 0 → the boot spinner sticks at frame 1 and **no screen ever repaints again**, while `setup()` still finishes on wall-clock time (serial reaches `[MEM] ready`). Looks exactly like a boot hang / bad flash — it is neither. |
| `LV_MEM_CUSTOM` + alloc | **`1`**, `LV_MEM_CUSTOM_ALLOC=ps_malloc`, `LV_MEM_CUSTOM_REALLOC=ps_realloc`, include `"Arduino.h"` | LVGL's heap (default a **48 KB static internal pool**, `LV_MEM_SIZE`) sits in internal RAM and every LVGL object alloc fragments the internal heap → the register TLS handshake can't get its buffers (see below). |
| `LV_FONT_MONTSERRAT_12/14/20` | `1` | Missing glyphs / build errors. |

**Draw buffers → PSRAM too** (`display.cpp`, `Display::init`): the two double-buffered LVGL draw
buffers are allocated with `MALLOC_CAP_SPIRAM`, **not** `MALLOC_CAP_INTERNAL|MALLOC_CAP_DMA`.
`my_disp_flush()` pushes with a **blocking CPU copy** (`tft.pushColors(..., swap=true)`, no DMA), so
the buffers do **not** need to be DMA/internal-capable. Keeping them (and the whole LVGL heap) out
of internal RAM is what leaves room for TLS.

### Why the internal-RAM budget matters: register `code -1`

Device registration (`connectivity.cpp`, `PROV_REGISTER`) does an **HTTPS POST** to
`<server>/api/devices/register` via `WiFiClientSecure` (`setInsecure()`) **while BLE is still
connected to the app** and Wi-Fi is up. The mbedTLS handshake needs **two ~16 KB contiguous
buffers** (IN + OUT content, `MBEDTLS_SSL_*_CONTENT_LEN=16384`, not tunable from Arduino). If the
largest free internal block (`ESP.getMaxAllocHeap()`) can't hold **both**, the second alloc fails →
`client.connect()` returns false → `HTTPClient` returns **`-1`** → on-screen *"Server registration
failed (code -1)"*. It fails **fast** (not a timeout) and **nothing reaches the server** (no POST in
the `device-api` edge logs). The register loop logs the smoking gun each attempt:

```
[CONN] register attempt N code=-1 freeHeap=48672 maxAlloc=31732   <- maxAlloc < ~34 KB => TLS can't fit 2×16 KB
```

`maxAlloc` after freeing internal RAM (measured at `[MEM] ready`, unprovisioned, BLE advertising):

| draw buffers | LVGL heap | `maxAlloc` | register |
|---|---|---|---|
| internal DMA | internal 48 KB pool | 22.5 KB | ❌ `code -1` |
| **PSRAM** | internal 48 KB pool | 31.7 KB | ❌ `code -1` (still short of 2×16 KB) |
| **PSRAM** | **PSRAM (`ps_malloc`)** | **63.5 KB** | ✅ `code 200`, claimed |

Coexistence is already handled (`esp_coex_preference_set(ESP_COEX_PREFER_WIFI)` during provisioning,
`WiFi.setSleep(false)`); the failure was purely contiguous-heap starvation, so **do not** chase coex
or the handshake timeout for a `code -1` — check `maxAlloc` first. A one-off `reason=8` Wi-Fi
disconnect mid-provision is a normal coexistence flake (the state machine re-`begin()`s).

> Note: `LV_MEM_CUSTOM=1` must be a **clean** compile (`arduino-cli compile --clean`). A stale build
> cache can link lvgl objects compiled with the old `LV_MEM_CUSTOM=0` (static pool) against the new
> ones → LVGL frees a static-pool pointer with `free()` → `assert failed: heap_caps_free ... "free()
> target pointer is outside heap areas"` at runtime. `--clean` fixes it.

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
from hiding all later ones.

### ⚠️ Nothing deletes a recording automatically (fw ≥1.5.9)

**The device holds the only copy of a take until the user explicitly deletes it** from the Sessions
screen. All three reclaim paths were removed in 1.5.9:

| Removed | Did |
|---------|-----|
| post-upload purge (`uploadStep`) | dropped the audio the moment a session uploaded |
| `purgeSyncedAudio()` | dropped every `.synced` session's audio at boot |
| `trimSessionsToMax()` | capped the card at 5 sessions per patient |

A `.synced` marker only ever proved that a POST returned 2xx — **not** that the audio is intact and
usable on the server. That gap destroyed a recording (see [05](05-backend-supabase.md)). A 32 GB
card holds ~278 h at 16 kHz mono, so keeping everything is cheap.

The uploader deletes nothing — the only `SD_MMC.remove` left in `connectivity.cpp` drops a
`.synced` marker in `resyncAll()`. **Audio is deleted in exactly one place**:
`deleteSessionFiles()` in the `.ino`, reached only from `ACT_DELETE_SESSION` (the user tapping
Delete). If you are adding a second, stop and reconsider.

The take itself stops cleanly if the card ever does fill (`recordWavStreamToSd` watches the
remaining space and finalises what it captured) — a full card is a normal end state, not an error,
and it must never discard the minutes already recorded.

### Uploader invariants

- **`.synced` is written only when the server ACKs `final=1`** (`upFinalAcked`). Never infer success
  from having walked to the end of the segment list: a take stopped exactly on a minute boundary
  leaves a trailing 44-byte header-only segment, whose slice is `len == 0`, so the `final=1` request
  is never sent. `upLastSrc` is therefore the last segment **with data**, not the last file on disk.
- **The sweep rotates.** It takes the first *unparked* pending session, not `pendTable[0]`. One
  unsendable session used to block the entire backlog forever. Each session gets its own strike
  count; at 3 strikes it parks for 5 min, and go-online / `sync_now` clears all parks.
- **A stall keeps its resume offset** and continues from there; restarting at 0 made the server
  truncate its temp blob (pre-v12) and the session could never converge.
- **Deleting a session renumbers every later one**, so the UI takes the SD bus, waits for the
  uploader to release its file, and calls `connNotifySessionsRenumbered()` to drop the resume point
  and strike table — both are keyed by session number and would otherwise point at *different audio*.
- **`resync_all`** clears `.synced` for sessions that still have audio, forcing a full re-backup.

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
