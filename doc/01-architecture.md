# 01 — Architecture

This is the end-to-end, source-of-truth map of the SATE Companion system: every
real component, transport, table, bucket, route, and the async processing state
machine. Firmware and edge-function versions drift — the numbers here were audited
against the tree on 2026-07-24 (recorder `FIRMWARE_VERSION = 1.5.32`, `device-api`
in-comment `[v18]`). When in doubt, `git log` / the `FIRMWARE_VERSION` constant /
the version comment atop `device-api/index.ts` win.

## Components

| Component | Tech | Source | Role |
|-----------|------|--------|------|
| Recorder firmware | Arduino / ESP32-S3, NimBLE, `WiFiClientSecure`, LVGL | `SATE_Recorder/SATE_Recorder.ino` + `connectivity.cpp` (**fw 1.5.32**) | Capture audio → 1-min segments on SD → chunked HTTPS upload (Wi-Fi) or expose over BLE. Runs standalone. |
| Pendant firmware | Arduino / Seeed XIAO nRF52840 Sense, BLE PCM stream | `SATE_Pendant/SATE_Pendant.ino` | Wearable mic → live 16 kHz mono S16LE PCM over BLE → phone wraps to WAV → same upload pipeline as `device_serial` `pendant-<bleId>` |
| Companion app | Expo (iOS), React Native, `react-native-ble-plx` + proprietary Plaud SDK | `src/` | Setup/claim, offline BLE bridge, remote control, Plaud + Pendant capture. Uploads via `src/api/sateApi.ts` `uploadSession()` |
| Backend — edge | Supabase (Postgres + Storage + Edge Functions / Deno) | `react_app_sate-ui_update/supabase/functions/` (`device-api` **v18**, `process-device-session`) | Auth, device API, session ingest, finalize. `verify_jwt` MUST stay false on both. |
| Backend — async worker | **Cloudflare Container** (Python, long-lived) + thin Worker | `cf-processor/` (`app/processor.py`, `app/main.py`, `src/index.ts`) → `sate-processor.longcao.workers.dev` | Drains the processing queue, HOLDS the long AI call, no serverless wall-clock |
| Status / alerting | Cloudflare Worker + D1, cron `*/5 * * * *` | `status/src/worker.js`, `status/schema.sql`, `status/wrangler.toml` | 90-day status page + **error-email alerting** (Cloudflare Email binding) |
| Service monitor | Static page (admin-gated `adminStatus`) | `monitoring/index.html` | Live pipeline/fleet dashboard off `device-api/api/admin/status` |
| Web app | Vite + React 19 + TypeScript | `react_app_sate-ui_update/src/` | SLP-facing app: manual uploads, reports, device mgmt, `/admin`. Reads Supabase directly (anon client) + calls `device-api` with the user JWT |
| AI service | external HTTP `POST /process` over an ngrok tunnel (`sate-v1-5.ngrok.io`), **held by the container** | ngrok → self-hosted CUDA | Whisper-style transcribe + word/segment timing |
| Mock server | Node/Express | `mock-server/` | Local stand-in for `device-api` during dev |

> `finalize-session` (the light "insert `recordings` + mark done" edge fn the
> container calls via `FINALIZE_URL`) is **deployed only** — it is not checked into
> this tree. `process-device-session/index.ts` in the repo is the OLD synchronous
> processor; see [the no-op warning](#the-process-device-session-no-op-trap).

## The recorder's two connectivity modes

The recorder is designed to work **independently** of the phone:

- **Online (Wi-Fi):** chunked-HTTPS uploads straight to `device-api` and polls
  `GET /api/devices/:id/commands` (~every 12 s, `CMD_POLL_PERIOD_MS`) for remote
  commands. This poll doubles as the heartbeat — it updates `last_seen` and reports
  `fw`, `state`, `pending`, `ota`. The app is not required.
- **Offline (no Wi-Fi):** advertises a BLE "needs sync" flag; the app auto-connects
  and **bridges** pending sessions to the backend over the phone's connection.

BLE is also used **once** for first-time setup (Wi-Fi provisioning + claiming the
device to the signed-in SLP). See [04-ble-protocol.md](04-ble-protocol.md).

Connectivity runs on a **core-0 FreeRTOS task** (`connStartNetTask()` /
`connLoop()`); the GUI + buttons run on core 1. Before the device is online (and
during provisioning), `connLoop()` is driven from the main `loop()` on core 1 to
keep the heap contiguous for the register TLS handshake; once online it hands off to
core 0 so HTTP never blocks the UI. Offline devices are flipped to
`online:false, state:'idle'` server-side after a **45 s** `last_seen` cutoff
(`listDevices`, `adminStatus`, `healthAlerts`).

## Recorder is Standalone by default — a roster is NOT patient assignment

`ensureStandalonePatient()` seeds a single synthetic **"Standalone"** patient when
the roster is empty; takes upload with `patient_id = "Standalone"`. A `set_patients`
(BLE) / `reload_patients` (remote) roster push, or a `record` command carrying a
`patient` payload, can select a real patient — but the roster is a convenience list,
not an assignment: standalone recording is the normal path, and a patient can be
assigned later on the web report. Do not force patient assignment at capture.

## End-to-end flows

### A. Provisioning / claim (BLE, one time)

```
App (signed-in SLP)                Recorder                         Supabase
  │ POST /api/devices/claim-token  ───────────────────────────►  createClaimToken:
  │                                                               insert sate_claim_tokens
  │   ◄── { token: "claim-xxxxxxxx" }                            (token, user_id, user_name)
  │ BLE {op:provision, ssid,pass,server,claim_token} ──►         │
  │                              WiFi.begin(ssid,pass)            │
  │   ◄── ev:state connecting / wifi_ok                          │
  │                              POST /api/devices/register ──►  handleDeviceRegister:
  │                                {serial, claim_token, fw}      validate token(used=false),
  │                                                               upsert sate_devices
  │                                   ◄── { device_id, device_key, slp, slp_id }
  │   ◄── ev:state registered                                    mark token used
```

- `device_id = "dev-" + serial.toLowerCase()`; `device_key = "key-" + device_id`
  (i.e. `key-dev-<serial-lowercase>`). The device stores the key as `cfgDeviceKey`
  and the `server` URL as `cfgServer`, then operates on its own.
- Registration is an **upsert on `id`** — re-registering the same serial is
  idempotent. `claim_token` is mandatory (`register` refuses without one).
- Details: [02-firmware.md](02-firmware.md),
  [03-companion-app.md](03-companion-app.md#provisioning),
  [04-ble-protocol.md](04-ble-protocol.md).

### B. Online upload (Wi-Fi, no phone) — the chunked path

```
Recorder ── record → 1-minute WAV segments (part00…partNN) on SD
  │  POST /api/sessions/chunk?patient_id&session_number&offset&total[&final=1][&flags]
  │        (apikey + Bearer key-dev-…, body = ~1 MB raw slice)          per slice
  ▼
device-api handleSessionUpload (/sessions/chunk):
   each slice → device-sessions bucket at _tmp/<patient>/s<n>/<offset>.part  (O(1), upsert)
   on final=1 → list parts, verify GAP-FREE contiguity from sizes, assemble ONCE,
                patchWavHeader(), storeSessionRecord() → device-sessions/<user>/<serial>/<id>.wav
                INSERT sate_device_sessions (status defaults to 'queued')
                triggerProcessor() → fire-and-forget process-device-session (NO-OP in prod)
  ▼   (AI is ASYNC — never in an edge fn; the 150 s edge wall-clock kills a long take)
Cloudflare Container (cf-processor/app/processor.py) poll loop:
   requeue_stale_sessions() → claim_next_session() [SKIP LOCKED] → status='processing'
   download WAV → HOLD ngrok POST /process (1 h read ceiling) →
   has speech? copy WAV to recordings bucket → finalize-session edge
             (resolve patient, countErrors + calculateSpeechAnalysis, INSERT recordings, status='done')
   no speech? finalize-session {no_text:true} → status='done', no recording
```

Key correctness properties (all in `device-api/index.ts`):

- **Sliced upload keeps the device responsive.** Each slice is its own `.part`
  object (v12); the whole file is materialised exactly once, on the final slice.
  The old design rewrote one temp blob per slice (quadratic, ~1.5 GB moved for a
  30-min take) and could never drain a backlog.
- **Part dir is patient-scoped** (`_tmp/<patient>/s<n>/`): session numbers restart
  per patient, so an un-scoped `s1` would splice two patients' audio.
- **`offset === 0` wipes the part dir** first (abandoned prior attempt).
- **Contiguity is verified from listed sizes** before a byte is downloaded; a gap or
  a `total=` mismatch → `409`, device restarts the session from 0 rather than store
  a corrupt WAV. Parts fetched in batches of 8 (`DL_CONCURRENCY`) into one
  pre-allocated buffer (avoids holding the take twice = OOM on 62-min takes).
- **Lost-ACK idempotency:** a final that actually succeeded but timed out is retried;
  the "already stored?" probe matches `(user, serial, session_number, bytes)` AND
  confirms `objectExists` — a row alone is not proof (the 413 ghost class). A genuine
  match returns `{idempotent:true}`; a ghost row is deleted and re-stored. Same probe
  lives in `storeSessionRecord` for the whole-file `POST /sessions` path.
- **`storeSessionRecord` THROWS on upload failure** — never logs-and-continues. A
  swallowed 413 (a full take vs Storage's global file-size limit) once returned 2xx,
  the recorder marked it synced, and a 62-min recording was lost.

Raw single-shot uploads also exist: `POST /api/sessions/raw` (device-key, body =
whole WAV) and user-authed `POST /api/sessions` (`{wav_base64, …}`) — the app uses
the latter for **Plaud** (no `sate_devices` row / device key) and **BLE-bridged /
Pendant** sessions.

See [05-backend-supabase.md](05-backend-supabase.md) and
[06-ai-pipeline.md](06-ai-pipeline.md).

### C. Offline bridge (BLE)

```
Recorder advertises  ADV flags: ADV_FLAG_NEEDS_SYNC (pending>0), ADV_FLAG_UNPROVISIONED
  │ App auto-connects, BLE {op:list_sessions} ── ◄ pending table [{n,patient_id,bytes}]
  │ for each pending: {op:send_session,n} ── ◄ ev:file + raw WAV bytes on CHAR_DATA ── ◄ ev:file_done
  │ App POST /api/sessions {device_serial, patient_id, session_number, wav_base64}  (USER JWT)
  │ BLE {op:mark_synced,n} ── ◄ ev:ok
```

The bridged upload takes the **user-authed** `POST /sessions` path (the phone's
account), so a BLE-bridged SATE session is stored under the SLP's `user.id` exactly
like a manual web upload. `mark_synced` sets the `.synced` tombstone on the device.

### D. Remote command (Wi-Fi)

```
App / web  POST /api/devices/:id/commands {op, patient?, seconds?}  → sate_device_commands
Recorder poll  GET /api/devices/:id/commands  (~12 s, Bearer key-dev-…)
  → heartbeat updates sate_devices(last_seen, online, state, fw, ota, pending_sessions)
  → returns unconsumed ops (marked consumed), active_patient, record_seconds, ota{url,version}
```

Remote command set the firmware handles (`connectivity.cpp` dispatch): `sync_now`,
`resync_all`, `reload_patients`, `record`, `stop`, `wifi_change`, `reboot`, `ota`.
(The BLE control channel additionally handles `scan_wifi`, `provision`,
`change_wifi`, `cancel_wifi`, `list_sessions`, `send_session`, `mark_synced`,
`set_patients`, `factory_reset`.)

- **`record` may carry `{seconds:N}`** (v17): the firmware stops the take ITSELF at
  exactly N seconds of PCM (sample-exact) instead of racing a `stop` through the
  poll channel (+3–12 s slop). `seconds` and `patient` both ride the jsonb `patient`
  column.
- **`ota`** stashes `{url, version}` in the same jsonb col; the firmware downloads
  the `.bin` and flashes. OTA on a device with an upload backlog fails `err-get-1`
  (fragmented heap) — `reboot` first, wait, then `ota` (see
  [07-runbook.md](07-runbook.md)).

## The async processing state machine

State lives on `sate_device_sessions.status`, added by the
`async_processor_state_machine` migration (applied via the Supabase MCP; not a repo
file), with `processing_started_at`, `attempts`, `process_error`.

```
        (INSERT, column default)
  ──────────────► queued ─────────────────────────────┐
                    │ claim_next_session() [SKIP LOCKED, atomic]
                    ▼
                processing ──► success ──► done
                    │            (finalize-session sets it)
                    │ transient (network / 5xx / 408 / 429), attempts<MAX ──► requeue_session() ─► queued
                    │ permanent (4xx / "no segments") ─────────────────────► fail_session() ────► error
                    │ worker died / stalled >45 min ─► requeue_stale_sessions() ─► queued (attempts++)
                    │                                   …until attempts ≥ MAX_ATTEMPTS ─────────► error
                    ▼
   user "Retry" (POST /api/sessions/:id/retry, error-only) → status=queued, attempts=0, process_error=null
```

Who triggers what:

- **New session → `queued`** automatically (the `status` column defaults to
  `queued`). `device-api` also fire-and-forgets `process-device-session`, but that
  is a no-op — the container is the sole processor.
- **`pg_cron`** pings the Worker `POST /tick` (Bearer `TICK_SECRET`) every minute to
  keep the container warm. The Worker itself does NO processing; a single `fetch`
  boots the container if asleep (`sleepAfter = '20m'`).
- **The container's own loop** (`app/processor.py::loop`, `POLL_INTERVAL=10 s`) is
  the real driver: watchdog → claim → process → done/requeue/fail.

Container constants (`processor.py`, overridable via env in `src/index.ts`):

| Const | Value | Meaning |
|-------|-------|---------|
| `AI_READ_TIMEOUT_S` | **3600 (1 h)** | ceiling on ONE AI read. Was unbounded — a dead-but-connected AI wedged the single worker forever; 1 h covers the longest take (~62 min) yet guarantees the worker returns. |
| `STUCK_MINUTES` | **45** | watchdog requeues a `processing` job older than this (matches `device-api` `STUCK_MS` and `adminStatus`). |
| `MAX_ATTEMPTS` | **3** | after this many, a stalled/transient job → `error`. |
| `POLL_INTERVAL` | 10 s | idle poll cadence; also the transient backoff base (`min(60, POLL*attempt)`). |
| download read timeout | (30 s connect, 900 s read) | large WAVs, but never a wedged worker. |

RPCs the container calls (Postgres functions, service-role): `claim_next_session`
(atomic `SKIP LOCKED`), `requeue_stale_sessions(p_stuck_minutes, p_max_attempts)`,
`requeue_session(p_id)`, `fail_session(p_id, p_msg)`. **Failure NEVER deletes device
audio** — the device is the only copy until server-verify (see reclaim below).

### The `process-device-session` no-op trap

Prod deploys `process-device-session` as a **200 no-op** (`device-api` still
fire-and-forgets to it, but it must not process, or it races the container and
**duplicates recordings**). ⚠️ The copy **checked into this repo is NOT the no-op** —
it still downloads the WAV, awaits the AI, and inserts `recordings` (it filters on
`processed=false` while the container claims on `status`, so both would process the
same session). Do not deploy the repo file as-is; make it a real early-return before
GA. See CLAUDE.md and [05-backend-supabase.md](05-backend-supabase.md).

### Never move the AI call into a serverless fetch

Any serverless request — Supabase edge (~150 s hard wall-clock, not configurable) OR
a plain CF Worker (~100 s 524 origin timeout) — kills a long synchronous
transcription **before the try/catch**, so `process_error` is never written and the
session hangs in `processing` forever (a 32-min take once showed 70 min stuck: edge
kill → cron retry → kill …). The long call MUST live in the long-running container.
`finalize-session` and `device-api` MUST stay `verify_jwt:false`.

## Recorder SD reclaim — server-verify-gated (fw ≥1.5.13, hardened through 1.5.32)

The device is the only copy of a take until it is **provably** on the server, so the
recorder frees SD audio only after a byte-exact server confirmation. Lives in
`connectivity.cpp`.

- **Verify before free.** `trimPatientSyncedAudio()` reclaims the AUDIO of synced
  takes older than the newest `KEEP_AUDIO_SESSIONS` (**=5**) per patient dir — but
  only after `verifySessionStored()` gets a clean 2xx `{stored:true}` from
  `GET /api/sessions/verify` (device-key auth, read-only; v15). That endpoint answers
  `true` ONLY when the `sate_device_sessions` row exists AND its storage object
  really exists (`objectExists`). It reclaims audio and keeps a `.synced` tombstone
  (the slot stays numbered); full deletion stays user-only (`deleteSession` / Delete
  button).
- **Byte-exact identity.** `sessionAssembledBytes()` mirrors the server's stored
  `bytes` exactly (part0 keeps its 44-byte header, later parts strip theirs), so a
  match proves it is the SAME take — not a same-numbered but different recording
  (numbers are reused after a delete).
- **Any doubt keeps the audio.** Offline, non-2xx, parse failure, `stored:false`, or
  a byte mismatch → keep; the next sweep retries. Do NOT free on a `.synced` marker
  alone — a marker only means "a POST returned 2xx" or an app-set BLE `mark_synced`,
  NOT "durably stored" (the 413-ghost class left markers with no object).
- **Verify-strike / park (fw ≥1.5.32).** A take the server keeps answering
  `stored:false` for (a false-2xx / `mark_synced` ghost) is a permanent verify
  candidate; each such definitive `stored:false` is a strike. After
  `VERIFY_MAX_STRIKES` (**=3**) the take is **parked** for a 6 h cooldown
  (`VERIFY_PARK_RETRY_MS`) and spends no verify budget until then, so it can't starve
  reclaim of a genuinely reclaimable dir. Per-pass caps bound the SD-bus hold:
  `TRIM_MAX_FREES_PER_PASS=2`, `TRIM_MAX_VERIFIES_PER_PASS=8`. `resync_all` /
  `sync_now` clears parks.
- **Recency by `take_seq`, not session number.** Numbers wrap at 99 and recycle
  tombstones, so past the wrap the newest takes carry the LOWEST numbers. Ranking by
  number freed the newest audio; `trimRecencyKey()` ranks by `take_seq`, a global
  monotonic counter stamped into each session JSON that never wraps.

## Sessions are NEVER renumbered — monotonic, wrap at 99, holes legal (fw ≥1.5.20)

Session numbers live in `1..SESSION_NUM_MAX` (**=99**) and are allocated
**monotonically** (highest existing + 1, NVS high-water keeps it monotonic across
deletes); past 99 the allocator **wraps to the lowest free number**. A `deleteSession`
removes ONLY that session's own files and shifts nothing — a patient dir holds an
arbitrary subset of `1..99`, and holes are normal. Every SD walk lists the dir once
into a `PatientDirScan` map and skips holes; nothing may assume contiguous `1..N`.

The old renumber machinery is **gone** (no `sate-del` NVS journal, no
`recoverInterruptedDelete` / `compactPatientDir` / `renameSessionFiles`). This
deliberately killed the biggest critical-bug cluster (renumber-under-a-live-upload
splicing two takes, trash-tap-after-renumber deleting the wrong take,
power-cut-mid-renumber slot reuse). See agent-memory `no-renumber-sessions`.

> Note: a stale comment inside `device-api` `/sessions/chunk` still says "sessions
> are renumbered when the SLP deletes one." That is obsolete at the firmware level;
> the `offset===0` part-dir wipe it justifies is still correct (a reused number CAN
> hold different audio), but no renumber happens anymore.

## Ownership gate — audio never uploads under the wrong claim

`cfgDeviceId` is the server-assigned identity of the **claim**, not the hardware; it
changes on every (re)claim, including by a different account. A factory reset clears
only NVS, leaving prior-owner takes on the SD card. So every take is stamped with
`owner_dev = cfgDeviceId` at record time (`saveMetadataToSd`), and the pending sweep
(`sessionOwnedByCurrent`) uploads ONLY takes whose stamp is the current id.

- An **unstamped** take (pre-stamp firmware / unreadable JSON) is UNKNOWN-owner and
  is NEVER auto-uploaded and NEVER deleted — a depot re-flash + new-account claim
  looks identical to a genuine first claim. Recovery is the explicit `resync_all`
  (`adoptSessionOwner`), the one licensed adoption point, which re-stamps to the
  current claim and re-uploads.
- A **crash-interrupted** take (segments but no JSON) is stamped with a minimal
  `owner_dev`/`take_seq` JSON by `stampInterruptedTakeOwner()` on give-up, so it
  uploads as a normal unsynced session instead of being stranded invisibly. This is
  licensed by the NVS crash mark, which proves capture under the CURRENT claim.

## Auto-resume + latched remote stop

- **Resume runs from `loop()`, never `setup()` (fw ≥1.5.17).** `setup()` only sets
  `g_resumePending`; `loop()` calls `maybeResumeRecording()` once the net task is up
  (or ~8 s in if offline). The resume re-enters capture, which BLOCKS until Stop —
  and `connStartNetTask()` lives in `loop()`. Resuming inside `setup()` meant the net
  task never started: no heartbeat, no remote `stop`, unstoppable except at the
  button or the ~62-min ceiling. If Wi-Fi hasn't associated in ~8 s, the offline
  fallback STARTS the net task itself (provisioned + real crash-mark only) before the
  blocking capture, so a resumed take keeps Wi-Fi retries / BLE / remote `stop` /
  heartbeat / OTA health-confirm even when the AP is down at boot.
- **Every take is crash-resumable** (button-started AND server/app-started, fw
  ≥1.5.16) because segments flush to SD every ~5 s. An empty `part00` on boot
  RESTARTS the take rather than dropping it. A `tries` boot-loop guard gives up after
  2 attempts (still stamping the owner so segments upload via sync).
- **Remote `stop` is latched only while a take is ARMED** (`recTakeArmed`, set before
  the take's start sequence, cleared the instant capture returns). Do NOT clear the
  flag at take start — that swallows a stop issued during the take's own start (which
  is exactly when a resumed take is stopped) and left takes running unbounded (the
  1.5.18 fix). A blocking, user-controlled duration must obey this same rule.

## Error-email alerting path

Any system-level problem emails the operator
(**`caothohoanglong2404@gmail.com`**, `ALERT_TO`), driven by the **status Worker**
(`status/src/worker.js`) on its `*/5 * * * *` cron:

```
Cloudflare cron (5 min) → runChecks() probe TARGETS (device-api, Supabase API,
   Storage, AI /process; 10 s timeout each) → record up/degraded/down in D1
                         ↓
   evaluateAndAlert():
     (a) any probed service DOWN → problem
     (b) fetch device-api GET /api/health/alerts?key=HEALTH_ALERT_KEY  ([v18], secret-gated)
         → digest: recent_errors, stuck_list (processing >45 min), error_count,
           offline_devices, plus a stable `signature`
     build signature; compare to D1 alert_state:
       new / changed problem set                          → sendAlertEmail (env.EMAIL binding)
       still-broken, ACTIVE cond only (svc DOWN / stuck)  → re-remind ≤ every 24 h ALERT_REPEAT_MS
         (a settled `error` is mailed ONCE, never re-reminded — it cannot auto-clear)
       problems==0 after a prior alert                    → sendRecoveredEmail ("all clear")
       first cron tick at 08:00 America/New_York          → daily infrastructure report (alert_state id=2)
```

- `device-api` `healthAlerts()` is **read-only**, gated on `HEALTH_ALERT_KEY` (no
  user JWT). It flips 45 s-stale devices offline, then returns the digest + a
  `signature` so the worker only mails on a CHANGE (a lingering error doesn't mail
  every 5 minutes; ongoing problems re-notify every 6 h).
- The email transport is the **Cloudflare Email binding** (`env.EMAIL.send`), from
  `EMAIL_FROM` / `EMAIL_FROM_NAME`. A missing binding logs instead of throwing.
- The 90-day status page renders from the same D1 history at the Worker's root path.
- `monitoring/index.html` is a separate live dashboard reading the admin-gated
  `device-api/api/admin/status` (`adminStatus`: per-status pipeline counts, stuck
  list, recent errors, fleet + `fw_breakdown`, recordings total).

## The web app reading Supabase

The web app (`react_app_sate-ui_update/src/`) reads Supabase through **two** paths:

1. **Direct anon client** (`src/lib/supabase.ts`, `createClient(url, anonKey)`) for
   clinical data, authenticated as the signed-in user (RLS-scoped):
   - `recordings` table — reports, dashboard, standalone list
     (`services/reportService.ts`, `services/DataService/recordingStorage.ts`,
     `components/Layout/Dashboard/hooks/useDashboardData.ts`).
   - `recordings` Storage bucket — audio playback via `createSignedUrl`
     (`recordingStorage.ts`).
2. **`device-api` edge function** (`src/services/device/deviceApiService.ts`, base
   `${SUPABASE_URL}/functions/v1/device-api`) with the user JWT, for device
   management and uploaded-session views: `/devices`, `/devices/claim-token`,
   `/devices/:id/commands`, `/sessions` (list), `/sessions/:id` (delete),
   `/sessions/:id/retry`, `/sessions/:id/audio`, `/firmware`, and the `/admin/*`
   family (gated by `sate_admins`).

`flags` (ms offsets, from the SATE flag button or a Plaud tap) flow device → session
row `flags` → `recordings.flags` → seek-bar ticks on the web report — one shared
pipeline.

## Where state lives

| State | Home |
|-------|------|
| Audio, in flight (chunk parts) | `device-sessions` bucket `<deviceId>/_tmp/<patient>/s<n>/<offset>.part` (binned on final stitch) |
| Audio, uploaded (raw WAV) | `device-sessions` bucket `<user>/<serial>/<sessionId>.wav`; SD copy kept until server-verify |
| Uploaded-session record + status | `sate_device_sessions` (`status`, `attempts`, `processing_started_at`, `process_error`, `bytes`, `storage_path`, `flags`, `recording_id`) |
| Final clinical result | `recordings` table + `recordings` Storage bucket |
| Firmware images | `firmware` bucket (public, `sate_<version>.bin`) + `sate_firmware` rows |
| Device identity / ownership | `sate_devices` (`id`, `serial`, `user_id`/`slp_id`, `fw`, `online`, `last_seen`, `state`, `pending_sessions`, `ota_state`) |
| Claim tokens | `sate_claim_tokens` (minted by app, consumed once at register) |
| Remote command queue | `sate_device_commands` (`op`, jsonb `patient`, `consumed`) |
| Device→clinical patient links | `sate_device_patients`, `patients.device_patient_id` |
| Admin allowlist | `sate_admins` (by lowercased email) |
| Alert dedup + status history | Worker D1: `alert_state`, `checks` |
| SLP session (app) | AsyncStorage `sate-companion-settings-v3` (token, refresh, expiry, user) |
| Device config (recorder) | NVS/SD: `cfgServer`, `cfgDeviceKey`, `cfgDeviceId`, Wi-Fi creds; `owner_dev`/`take_seq` in each session JSON; `sate-rec`/`sate-seq`/`sate-own` NVS namespaces |

## Trust / auth model

- **App/web → backend (SLP-scoped routes):** real Supabase **user JWT** (same account
  as the web app). `device-api` calls `supabase.auth.getUser(token)` and scopes every
  query by `user.id`; admin routes additionally check `sate_admins` by email.
- **Device → backend:** `Authorization: Bearer key-dev-<serial-lowercase>` device key
  (issued at register) for device routes (`register`, heartbeat, chunk/raw/`/sessions`
  upload, `/sessions/verify`, `/patients`), PLUS the public `apikey` (anon key) the
  Supabase Edge gateway requires.
- **Container / edge → edge / DB:** `SUPABASE_SERVICE_ROLE_KEY` (or `PROCESSOR_SECRET`
  / `TICK_SECRET` / `HEALTH_ALERT_KEY`), server-side only.
- **Anon key is public by design** — shipped in the web JS bundle and embedded in the
  firmware.
- **`device-api` and `mint-plaud-token` MUST deploy `--no-verify-jwt`** (they validate
  the token/device-key themselves). The MCP/CLI default `verify_jwt:true` breaks
  recorder registration ("Setup link expired") and Plaud token minting.

### Known auth gaps (deprioritized behind features; fix before GA)

- `POST /firmware` (`publishFirmware`) is routed ABOVE the `/admin` gate, so any
  authenticated user can push fleet-wide OTA. It now validates the image (semver +
  `0xE9` magic + 4 MB cap) but still lacks an `isAdmin()` gate.
- There is **no DB unique constraint** backstopping the `sate_device_sessions`
  idempotency probe — dedup relies entirely on the app-level `(user, serial,
  session_number, bytes)` + `objectExists` check.
