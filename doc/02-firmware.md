# 02 — Recorder firmware

ESP32-S3 touchscreen recorder. Arduino framework, **NimBLE** (`NimBLEDevice.h`) for BLE,
`WiFiClientSecure` + `HTTPClient` for HTTPS. Source: `SATE_Recorder/` (sketch `SATE_Recorder.ino`).

Current version: **fw 1.5.32** (`FIRMWARE_VERSION` string, `SATE_Recorder.ino:119`; see
[07-runbook.md](07-runbook.md#firmware-version-history)). It talks to **device-api v18**
(`react_app_sate-ui_update/supabase/functions/device-api/index.ts`, version in the header comment).
The prebuilt flash assets on GitHub Releases may lag the source tag — bump the release per firmware.
Deep hardware reference (pin map, board + build/flash, audio pipeline, optimization playbook,
LVGL/PSRAM memory budget): root `hardware.md`.

## File map

| File | Responsibility |
|------|----------------|
| `SATE_Recorder.ino` | `setup()` / `loop()`, UI state machine, screen flows, record/play, session file model (numbering, resume, delete), NVS crash-mark, boot resume gate, remote-command hooks (`sateHook*`) |
| `connectivity.cpp` / `.h` | Core-0 net task, BLE provisioning, Wi-Fi, HTTPS chunked upload, command poll + heartbeat, device config (NVS `sate`), pending scan, verified SD reclaim (`trimAllPatients`/`trimPatientSyncedAudio`/`verifySessionStored`), ownership stamps, resync/OTA/reboot |
| `display.cpp` / `.h` | LVGL screen driver + touch; PSRAM draw buffers |
| `es8311.cpp` / `.h` / `es8311_reg.h` | ES8311 audio codec (I2S capture/playback) |
| `lv_conf.reference.h` | **Reference copy** of the load-bearing `lv_conf.h` (see below). The one that actually compiles lives in the Arduino libraries dir, NOT here |
| `sate_logo_white.h` | Logo bitmap |

## Dual-core execution model (fw 1.2.5+)

**Networking runs on a dedicated core-0 task; GUI + buttons own core 1.** Once the device is
online, `connStartNetTask()` (`connectivity.cpp:3184`) creates `sateNet` with
`xTaskCreatePinnedToCore(netTaskFn, "sateNet", 16384, nullptr, 1, …, 0)` — **core 0 (PRO_CPU),
16 KB stack, priority 1** — and `netTaskFn` runs `connLoop()` (BLE ops, Wi-Fi, command poll,
heartbeat, upload, reclaim) in a `for(;;)` with a `vTaskDelay(5 ms)` yield. A physical button or
a screen repaint never waits on an HTTP call. `loop()` on core 1 runs `runGui()` (LVGL + touch),
services the ISR-latched buttons, and consumes connectivity flags. The handoff is **flag-based**
(e.g. `connStateReq`, `connPatientsReq`, `connRecordReq`, `connStopReq`, `uploadSweepDue`,
`resyncDue`, `patientsFetchDue`) — the net task never touches LVGL. Core-0 stack floor is reported
by `connNetStackHighWater()` in the serial `DIAG` dump.

> **The net task is NOT started in `setup()`.** During provisioning `connLoop()` runs on the **main
> loop** (see `loop()`), so the register TLS handshake has the heap it needs while BLE is up. `loop()`
> calls `connStartNetTask()` only once the device goes online. This ordering is load-bearing for the
> boot-resume fallback (below) and for register `code -1` heap headroom — see `hardware.md` §8.15
> (dual-core) and §8.23 / §8.8 (register heap).

Earlier firmware (≤1.2.4) was single-core (GUI + networking interleaved on one core); the move to
core-0 networking fixed a 4–5 s button lag and stuck uploads.

## Display, LVGL & the internal-RAM budget (⚠️ hard-won, read before touching `display.cpp` or `lv_conf.h`)

The LVGL config that actually compiles is **`~/Documents/Arduino/libraries/lv_conf.h`** — it is
**NOT in this repo** (the repo carries `lv_conf.reference.h` as a copy to diff against). It lives in
the Arduino sketchbook libraries dir (under iCloud Drive) and is overwritten every time lvgl is
reinstalled (see the iCloud-eviction fix in [07-runbook.md](07-runbook.md)). Three settings in it
are load-bearing; a fresh lvgl install resets all three and each has bitten us:

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
- **command poll** every `CMD_POLL_PERIOD_MS` (**12 s**) → `pollCommands()` (`GET /api/devices/:id/commands`)
- **heartbeat** every `HEARTBEAT_PERIOD_MS` (**15 s**) → `scanPending()` (refresh cached pending count) plus
  `pushHeartbeatState()` (below)
- **patients fetch** when `patientsFetchDue`; **resync** when `resyncDue`
- **upload step**: one ~1 MB slice per pass via `uploadStep()` (cooperative; GUI keeps running)
- **idle reclaim**: `trimAllPatients()` on an idle cadence (verified SD reclaim, below)

### Heartbeat / telemetry (`pushHeartbeatState`)

The heartbeat is a `GET /api/devices/<id>/commands` carrying the device's live telemetry as query
params: `pending`, `state` (`liveState`: idle/recording/…), `fw`, `ota` (OTA phase), `bat` (%),
`recs`, `mv` (battery millivolts), `rst` (boot reset reason), `up` (uptime s),
`heapmin` (`heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL)`). The server stores this on the
`sate_devices` row and it feeds the **error-email alerting** path (`device-api` **v18**
`GET /health/alerts`, a secret-gated digest a status Worker turns into an operator email via
Cloudflare Email) — see [05-backend-supabase.md](05-backend-supabase.md). Firmware just reports; it
never emails.

## HTTP layer (`httpJson`, `sendSessionChunk`)

- `serverIsSupabase()` switches between `WiFiClientSecure` (TLS, port 443, `setInsecure()`)
  for Supabase and plain `WiFiClient` for the mock server.
- Supabase requests carry **two** auth headers: `apikey: <anon key>` (gateway requirement) and
  `Authorization: Bearer key-<serial>` (`cfgDeviceKey`, device identity).
- `httpJson` streams the response straight into a caller buffer (no `String` alloc) and uses
  `setReuse(true)` for keep-alive; both the poll and the chunk upload share the **same warm HTTPS
  client** (`s_http` / `s_httpsClient`) so a chunk POST skips the TLS handshake.
- `sendSessionChunk` POSTs one ~1 MB slice (`UPLOAD_CHUNK_BYTES = 1 MB`) to `/api/sessions/chunk`
  with `?offset=&final=&total=`. Slice timeout is 12 s; the **final** slice (server assembles the
  whole WAV, stores it, kicks the AI pipeline) gets **60 s**. A `409` on a slice means the server's
  temp blob disagrees with the resume offset — the one case where restarting from byte 0 is correct;
  every other failure keeps the offset and resumes.

### Touch-lag fix (fw 1.0.3, historical)

Symptom: screen unresponsive after Wi-Fi connect, only on Supabase. Cause: the Supabase Edge
gateway closes the keep-alive socket, so every command poll paid a full ~1–2 s **blocking TLS
handshake** that froze touch on the single core. Mitigations then: `CMD_POLL_PERIOD_MS` 3000 →
12000, `setInsecure()` once (not per request), and pumping the GUI around `pollCommands()`. The
**real fix was the core-0 net task** (above) — the GUI on core 1 no longer blocks on TLS at all, so
the manual `sateHookGuiPump()` calls around the poll are gone.

## Device config (NVS namespace `sate`, `connectivity.cpp`)

`loadConfig()` / `saveConfig()` use the `sate` NVS namespace:

| Key | Meaning |
|-----|---------|
| `ssid` / `pass` | Joined Wi-Fi network |
| `server` | Backend base URL (`…/functions/v1/device-api` for Supabase, or mock URL) |
| `dev_id` (`cfgDeviceId`) | Server device id — the identity of the **claim**, changes on every (re)claim |
| `dev_key` (`cfgDeviceKey`) | `key-<serial>` issued at registration; sent as `Authorization: Bearer` |

`provisioned = ssid && server && dev_id`. `connInit()` loads this, builds the serial, then enters
`CONN_WIFI_TRYING` if provisioned else BLE advertising. `connFactoryReset()` clears **only** the
`sate` namespace and touches **nothing on SD**, so takes recorded under a previous claim survive an
unclaim (they must never upload under the next claim's key — see ownership, below).

### All NVS namespaces

| Namespace | Written by | Contents | Survives factory reset? |
|---|---|---|---|
| `sate` | `connectivity.cpp` | Wi-Fi + server + claim id/key (config table above) | **No** (wiped by `connFactoryReset()`) |
| `sate-own` | `connectivity.cpp` (`ownerTrackId`) | `id` = last claim's device id; **diagnostics only**, logs a change of hands, never an upload gate | **Yes** (deliberate) |
| `sate-seq` | `SATE_Recorder.ino` | `hw%08lx` per-patient-dir session-number high-water (FNV-1a of the dir) + `gseq` global `take_seq` counter | Yes |
| `sate-rec` | `SATE_Recorder.ino` | Crash-resume mark: `active`, `pid`, `sess`, `cap`, `tries` | Yes |
| `sate-stats` | `SATE_Recorder.ino` | `recs` = lifetime recordings counter (Home chip) | Yes |

## Standalone is the default

The recorder records into a synthetic **"Standalone"** patient (`ensureStandalonePatient()`,
`g_standalonePatient`) unless a real patient is explicitly selected. A **server roster is NOT a
patient assignment** — recordings upload as Standalone and can be assigned to a patient later on the
web report. Standalone stays in the roster even after real patients are pushed, so the user can go
back to it without waiting.

## Sessions on SD

Session files live under `/sate/patients/<pid>/session_<n>.*`:
- `session_<n>.partNN` — **1-minute segments**; part 0 carries the 44-byte WAV header, later parts
  are raw PCM. (`sessionHasAudio()` / `scanSessionNumbers()` treat a segment or a legacy merged
  `.wav` as "has audio".)
- `session_<n>.wav` — legacy single merged file (older firmware); still read.
- `session_<n>.json` — metadata (written by `saveMetadataToSd()` after a take ends cleanly): carries
  `session_number`, `sample_rate` (16000), `take_seq`, `owner_dev`, flag markers, etc.
- `session_<n>.synced` — sync marker / **tombstone** (see reclaim).

`scanPending()` walks the card for un-synced sessions and caches the count (advertised in BLE
manufacturer data so the app sees pending without connecting). **Holes are legal** — deletes never
renumber — so every scan (`scanSessionNumbers`, `scanPatientDir`, `resyncAll`, `trimAllPatients`)
iterates the whole `1..99` number space and skips absent slots; nothing may assume contiguous `1..N`
or stop at the first gap. `PatientDirScan` returns per-slot `present` / `audio` / `mark` bitmaps plus
byte counts.

### Session numbering — monotonic, WRAP AT 99, NEVER renumbered (fw ≥1.5.20)

`SESSION_NUM_MAX = 99` (kept in sync between `SATE_Recorder.ino:317` and `connectivity.cpp:398`).
`findNextSessionIndex(dir)` allocates the next number:

1. Scan the dir for the **highest** present number; take the **max of that and the NVS high-water**
   (`sate-seq` `hw%08lx` for this dir). A deleted number **stays spent** — the high-water only ever
   climbs — so a number is never handed straight back. This is a correctness guard, not tidiness: the
   server keeps its row for a deleted take, and a remote **timed** take of the same duration produces
   the **same byte count**, so reusing `(patient, number, bytes)` immediately would make trim's verify
   ambiguous and could free the new take's only local copy against the old take's row.
2. `next = highest + 1` while `highest < 99` (empty dir starts at 1).
3. **At the wrap (`highest == 99`)**: prefer any slot holding *nothing*; else recycle the **oldest
   audio-free `.synced` tombstone** (`clearSessionTombstone()` removes its marker + json — its audio
   is already durably on the server). Return **0 only when all 99 slots hold real audio**. At the wrap
   the high-water restarts from the number just handed out, so the counter tracks the new cycle.

**A number is an identifier, not a dense index.** The old down-shift renumber machinery is **GONE** —
there is **no** `sate-del` NVS journal, no `recoverInterruptedDelete()` / `compactPatientDir()` /
`renameSessionFiles()`, and no `connNotifySessionsRenumbered()`. Renumbering under a live upload once
spliced two takes into one server WAV, a trash-tap after a renumber deleted the wrong take, and a
power-cut mid-renumber reused a slot. Deleting all of that killed the biggest critical-bug cluster.
See agent-memory `no-renumber-sessions`.

`deleteSessionFiles(dir, n)` (`SATE_Recorder.ino:1588`) removes **only** session `n`'s own files
(every segment + legacy wav + json + `.synced`) and shifts nothing. It is reached **only** from
`ACT_DELETE_SESSION` (the user tapping Delete). On delete the UI takes the SD bus
(`connSetUiSdBusy(true)`) and calls `connNotifySessionDeleted(pid, num)` on the net task, which drops
the uploader's memory of that `(patient, number)`: clears the resume offset if latched there, defers
a strike-table drop to the net task's next pass, and — **only if an upload is in flight on that exact
session** — sets `upDropReq` so `uploadStep()` closes `upFile` next pass. **Any other session's
upload is untouched.**

### `take_seq` — recording-order recency (fw ≥1.5.20)

Because numbers wrap and recycle, **a lower number can be a newer take** past the wrap. Every session
JSON therefore carries `take_seq`, a **global monotonic** counter (`nextTakeSeq()`, `sate-seq` key
`gseq`, never reset, never wraps in practice). Retention ranks audio-bearing slots by `take_seq`
(`trimRecencyKey()`), offset past `SESSION_NUM_MAX` so any stamped take outranks a legacy un-stamped
one (which falls back to its session number). This is what makes "keep the newest 5" correct after a
wrap instead of keeping stale high-numbered tombstones and freeing the genuinely newest audio.

### `owner_dev` — the ownership upload gate

`cfgDeviceId` identifies the **claim**, not the hardware; it changes on every (re)claim, including a
claim by a *different* account. Since SD survives a factory reset, takes recorded under a previous
claim sit on the card after an unclaim and **must never upload under the next claim's key** (another
clinic would durably receive this clinic's patient audio). So:

- Every take is stamped `owner_dev = cfgDeviceId` at record time (`saveMetadataToSd()`), and the
  pending sweep **skips any session whose stamp is not the current id**.
- An **unstamped** take (pre-stamp firmware, or unreadable JSON) has an **unknown** owner, which the
  device cannot distinguish from "someone else's audio on a re-claimed board" — so **unknown never
  defaults to upload**. Such takes stay on the card until the current owner deliberately runs
  `resync_all`, the one licensed adoption point (`adoptSessionOwner()` stamps them to the current
  claim). `sate-own` remembers the last claim id purely to log a change of hands.

### ⚠️ SD audio is reclaimed only after the server VERIFIES it (fw ≥1.5.13, gate at device-api v15+)

**The device holds the only copy of a take until it is *provably* on the server.** The blind reclaim
paths that once dropped audio on nothing more than a `.synced` marker (post-upload purge,
`purgeSyncedAudio()`, `trimSessionsToMax()`, `freeSessionAudio()`) are **gone**. Reclaim is now
**device-wide, idle-cadence, and verify-gated**:

- `trimAllPatients()` (`connectivity.cpp:932`) runs on an idle cadence and walks **every** patient
  dir. "Keep the newest 5" is a **device-wide** rule, not per folder: new takes only ever land in the
  **active** dir (`activePid`), so it keeps `KEEP_AUDIO_SESSIONS` (**=5**) there and reclaims **stale
  dirs fully** (keep 0). If `activePid` is not yet known it keeps everything (unknown must never mean
  keep-nothing).
- `trimPatientSyncedAudio(pid, keep, budget)` frees the audio of **synced** takes older than the
  newest `keep` (ranked by `take_seq`), **only after** `verifySessionStored()` gets a byte-exact
  `stored:true` from `GET /api/sessions/verify` (device-api **v18**; the route checks the DB row AND
  that the storage object really exists — `handleSessionVerify`). It frees only the audio + json
  (`freeSessionAudioKeepMarker()`) and **keeps the `.synced` tombstone** so the slot stays numbered
  and the pending scan is unchanged. **Unsynced takes are never touched.**
- `sessionAssembledBytes()` computes the byte count that must match the server's stored `bytes`
  exactly: a legacy `.wav` is its own file size; a segmented take is one 44-byte header (on part 0
  only) + all PCM. A byte match proves it is the SAME take, not a same-numbered later one.
- **Any doubt keeps the audio** — offline, non-2xx, parse failure, or byte mismatch all return
  `false` from `verifySessionStored()`; trim just retries next cycle.

> **SAFETY: a `.synced` marker alone is NOT proof and must never authorize a free.** A marker only
> ever meant "a POST returned 2xx" (or an app-set BLE `mark_synced`) — **not** that the audio is
> durably stored. The 413-ghost class left markers with no storage object; that gap destroyed a
> recording (see [05-backend-supabase.md](05-backend-supabase.md)). The verify gate (row +
> `objectExists`) is what makes reclaim safe. Do not bypass it.

**Verify-strike park (fw 1.5.32).** A marked take the server permanently answers `stored:false` for
(a false-2xx / BLE `mark_synced` ghost) is never freed (verify fails) and never re-uploaded (the
pending scan skips marked takes), so it re-spends the verify budget on **every** sweep — enough of
them in dirs walked before the active one starved the active dir of reclaim entirely. Mirroring the
uploader's strikes, `trimPatientSyncedAudio` now:

- Caps work per sweep: `TRIM_MAX_FREES_PER_PASS = 2`, `TRIM_MAX_VERIFIES_PER_PASS = 8` (a shared
  `s_trimVerifyBudget` reset once per `trimAllPatients()` sweep so the cap spans all dirs). A verify
  is a 2–4.5 s HTTPS round-trip that holds the SD bus, and the UI's delete handshake has a 120 s
  guard, so the sweep must never run away.
- Strikes a take **only** on a *definitive* `stored:false` (a clean, parsed 2xx that positively says
  "not stored" — `definitiveNo`); offline / non-2xx / parse failures stay free retries.
- **Parks** a take after `VERIFY_MAX_STRIKES = 3` strikes for `VERIFY_PARK_RETRY_MS = 6 h`
  (`VerifyStrike` table, `VERIFY_STRIKE_MAX = 32` entries, net-task only). A parked take **spends no
  verify budget** but **always keeps its audio** — parking skips only the verify, never frees. After
  the cooldown it is re-checked, so a take that becomes verifiable later (a `resync_all` re-upload)
  is still freed. `resync_all` / `sync_now` clear all parks (`verifyStrikeClearAll()`).

**Full deletion stays user-only.** `deleteSessionFiles()` (Delete button) is the one place all of a
take's audio disappears. The verified trim frees audio but keeps the tombstone; nothing else removes
a recording. If you are adding a second deleter, stop and reconsider.

The take itself stops cleanly if the card ever does fill (`recordWavStreamToSd` watches the remaining
space and finalises what it captured) — a full card is a normal end state, not an error, and it must
never discard the minutes already recorded.

### Recording durability across a reboot

- **Segments flush to SD every ~5 s** (`FLUSH_EVERY_BYTES = PCM_BYTES_PER_SEC * 5` in
  `recordWavStreamToSd`, `SATE_Recorder.ino:2231`), not once per minute — a brownout / watchdog reset
  loses at most the last few seconds, not the whole open minute.
- **A live take writes a crash-mark to NVS** (`recCrashMark()` → `sate-rec`: `active=1`, `pid`,
  `sess`, `cap`, `tries`) and clears it (`recCrashClear()`) when it ends cleanly. `cap` is the take's
  byte ceiling — a server-timed take (`record_seconds`, fw 1.5.19) must resume with its **original**
  cap, not the generic `PCM_MAX_BYTES` (`RECORD_MAX_SECONDS = 3700` ≈ **62-minute** ceiling), or a
  60-second remote capture would resume as an unattended 62-minute one.
- **Every take auto-resumes on boot** (`maybeResumeRecording()`, fw ≥1.5.16): a take interrupted by a
  reboot continues into the *same* session — button-started **and** server/app-started, because an
  SLP who starts a recording from the app expects a power blip not to end it. If only an empty
  header-only `part00` survived (`existingBytes == 0`), it **restarts** the take into that session
  (`startPart = 0`) rather than deleting it. It runs from local NVS + the SD segments alone: **no
  Wi-Fi, no server**. A `tries` boot-loop guard **gives up after 2 attempts** — and then
  `stampInterruptedTakeOwner()` writes minimal JSON (`owner_dev` + `take_seq`) so the stranded
  segments still upload as a normal unsynced session (the pending sweep skips owner-less audio).
- **The resume runs from `loop()`, NEVER from `setup()`** (fw ≥1.5.17). It re-enters the capture,
  which **blocks until Stop**, and `connStartNetTask()` lives in `loop()` — so resuming inside
  `setup()` meant the net task never started and the unit went dark for the whole take: no heartbeat,
  no remote `stop`, no serial, unstoppable except at the button or the ~62-min ceiling. A
  server-started take with nobody at the device just vanishes. Instead `setup()` sets
  `g_resumePending`; `loop()` resumes once `connNetTaskStarted()` **or ~8 s** elapsed. **Offline
  fallback:** if Wi-Fi hasn't associated in 8 s and a real crash-mark is present on a provisioned
  device, `loop()` **starts the net task itself** before entering the blocking capture, so the resumed
  take keeps Wi-Fi retries / BLE, the remote `stop`, the heartbeat, and the OTA health-confirm even
  when the AP is down at boot (mains outage that killed recorder + AP together). This shipped and was
  caught on the bench — don't undo it. Same rule applies to anything that blocks for a
  user-controlled duration.
- **Resume is SD-bus-safe.** Before touching the session files it claims the bus
  (`connSetUiSdBusy(true)`) and waits (up to 120 s) for the net task to release it
  (`connNetSdIdle()`), because the sweep may already be uploading this very session; if the net task
  never yields it **aborts and keeps the mark** for the next boot. If the session is already `.synced`
  it refuses to append (would strand the new audio). An unprovisioned boot with a live mark clears it
  (a factory-reset / unclaim mid-take must not fire on a later provisioned boot).
- **Every `[REC] resume …` branch logs why.** The path used to be silent, so a failed resume was
  invisible; `[REC] resume: ABORT - …` now names the reason (unprovisioned, boot-loop guard, patient
  not in roster, already synced, missing `part00`, net task never released the bus, card full).

### Remote `stop` / `reboot` latching

- **Remote `stop` (fw ≥1.5.15) is latched only while a take is ARMED** (`recTakeArmed`,
  `SATE_Recorder.ino:242`) — set **before** the take's start sequence (both the normal path and the
  resume path arm before the status screen / GUI pump), cleared the instant capture returns.
  `sateHookStop()` (called by the net task's `runRemoteCommand("stop")`) sets `connStopReq` **only**
  while `recTakeArmed`; otherwise it is dropped. Do **not** "drop stale stops" by clearing the flag at
  take start — that swallows a stop issued during the take's own start (the status screen + GUI pump),
  which is exactly when a resumed take is stopped, and left takes running unbounded (the bug fixed in
  1.5.18). `sateHookTakeActive()` exposes the flag.
- **Remote `reboot`** (`runRemoteCommand("reboot")` and the BLE handler) sets `rebootRequested` +
  `rebootAtMs` (300–800 ms in the future so the ack reaches the app), and the net task reboots when
  the delay elapses (`ESP.restart()`), on **core 0** — the only reliable way to reboot a recording
  device, because a serial DTR/RTS reset can't (USB-CDC reset is software-handled and the capture loop
  never services USB). `factory_reset` over BLE works the same way (`factoryResetRequested`).
- **Remote `record`** (`runRemoteCommand("record")`) calls `sateHookRecord()`; a `record` with
  `{record_seconds:N}` calls `sateHookRecordTimed(N)` which caps the capture at exactly N seconds of
  PCM (fw 1.5.19). `loop()` runs the capture when the UI is idle.

### Uploader invariants

- **`.synced` is written only when the server ACKs `final=1`** (`upFinalAcked`). Never infer success
  from having walked to the end of the segment list: a take stopped exactly on a minute boundary
  leaves a trailing 44-byte header-only segment, whose slice is `len == 0`, so the `final=1` request
  is never sent. `upLastSrc` is therefore the last segment **with data**, not the last file on disk.
- **The sweep rotates.** It takes the first *unparked* pending session, not `pendTable[0]`. One
  unsendable session used to block the entire backlog forever. Each session gets its own strike count
  (`UPLOAD_MAX_STRIKES = 3`); at 3 strikes it parks for `UPLOAD_PARK_RETRY_MS = 5 min`, and
  go-online / `sync_now` clears all parks (`strikeClearAll()`).
- **A stall keeps its resume offset** and continues from there; restarting at 0 made the server
  truncate its temp blob (pre-v12) and the session could never converge. A `409` is the sole signal to
  restart from 0.
- **Deletes never renumber**, so `connNotifySessionDeleted()` only has to drop this one session's
  resume point, strike, and in-flight latch (see the delete flow above) — nothing else moves.
- **`resync_all`** first **adopts** any unstamped / prior-claim take to the current owner
  (`adoptSessionOwner()`), then clears `.synced` for every session that **still has audio**, forcing a
  full re-backup; it clears the upload parks, verify parks, and resume offset.

## Optimization summary

The recorder runs in tight RAM. Key techniques (full detail in `hardware.md`):

- Stream everything — no length-proportional `malloc` (response streamed into fixed buffers; JSON
  parsed into a PSRAM arena `s_jsonPsram`).
- Big buffers `static`, off the task stack; net-task stack sized deliberately (16 KB) for the mbedTLS
  handshake.
- No Arduino `String` in hot paths.
- `delay(1)` yield in the record loop (long-session stability).
- Cooperative ~1 MB sliced upload sharing a warm keep-alive HTTPS client — stay responsive and online
  during a multi-MB transfer.
- Segment recording with zero merge — the server assembles on the final slice; less device I/O and
  risk.
- Cache the pending-session scan and the SD-usage scan (`f_getfree` is a full FAT walk; scanned at
  most every 30 s); PSRAM draw buffers + LVGL heap, internal RAM reserved for TLS.

See [07-runbook.md](07-runbook.md) for build/flash, and the BLE wire format in
[04-ble-protocol.md](04-ble-protocol.md).
