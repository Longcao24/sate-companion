# SATE Companion — project instructions

## ⚠️ RULE #1 — Plaud device-lock safety (READ BEFORE ANY CHANGE)

**A Plaud device can be PERMANENTLY LOCKED if its binding is mishandled.** Unlike a
SATE recorder (recoverable), a mis-bound / desynced Plaud is bricked for that account.
So **every** new feature, refactor, or "small" edit that touches Plaud — connect,
identity, Keychain, BLE lifecycle, teardown, account/login, provisioning, multi-device,
sync, settings — MUST preserve these invariants. When in doubt, stop and re-read
`doc/08-plaud.md` + `plaud-integration.md` before writing code.

Five invariants (verified airtight; do NOT break any):

1. **Stable, account-derived identity — never random/per-install.**
   `plaudUserId(uid) = "sate_<uid>"` is the SAME string used by (a) the
   `mint-plaud-token` edge fn as the Plaud `user_id`, and (b) `connect(deviceId, ...)`
   as the deviceToken. It is restored on login → survives reinstall. Never pass a raw
   uid, a random value, or a per-device token to `connect()`.

2. **Bind guard before connect.** If `bindingOwner(sn)` is set and ≠ this account,
   REFUSE to connect (don't re-bind under a new identity). Reconnect to your own
   binding; never re-bind.

3. **Binding lives in the iOS Keychain** (`plaud.bind.<sn>`), `AfterFirstUnlock`, so it
   outlives uninstall (AsyncStorage does NOT). Reinstall → reconnect, never re-bind.

4. **No auto-depair, ever.** `depair(clear:true)` is exposed ONLY via the user-initiated
   `resetBinding` (the UNBIND button). Unmount/teardown/logout must only `disconnect()`
   (drops the BLE link, keeps the binding) — never depair.

5. **ACK-before-forget on unbind.** Order is law: send depair → device ACKs
   (`bleDepair`, status 0) → ONLY THEN delete the local Keychain record. Native refuses
   depair while disconnected, fails fast on a mid-command BLE drop, and times out (20s)
   instead of hanging; `resetBinding` keeps the Keychain record on ANY failure.
   Forgetting locally before the device ACKs desyncs the binding and freezes the device.

Residual (not a code bug, out of our control): Plaud hasn't officially confirmed that a
re-bind with the same `user_id` is a guaranteed no-op, and iOS can't guarantee Keychain
survives every uninstall path. Our stable identity makes a re-bind idempotent either way —
but if you add a "switch account" flow, WiFi transfer, or anything that could change the
identity or the binding lifecycle, treat it as high-risk and confirm with the user.

Where the logic lives: `src/plaud/PlaudLink.ts` (identity, bindings, resetBinding),
`src/screens/PlaudConnectScreen.tsx` (connect guard), `src/screens/PlaudSettingsScreen.tsx`
(UNBIND), `modules/plaud-sate/ios/PlaudSateModule.swift` (native connect/depair + ACK).

## ⚠️ RULE #2 — ONE shared BleManager (SATE + Pendant + L816)

Two BLE stacks fight for one radio: **ble-plx** — used by **SATE** (`SateLink`), the
**Pendant** and the **L816** — and **Plaud** (proprietary SDK, its own
`CBCentralManager`, created at app launch).

**SATE, the Pendant and the L816 SHARE a single `BleManager`** — `src/ble/bleManager.ts`
(`getSharedBleManager()`). This is not a style choice:

- Two ble-plx `BleManager` instances, **or destroying one and immediately creating
  another**, leaves the native iOS BLE stack broken — scans return **zero devices**
  with no error. This is exactly what stopped the pendant being found for days
  (the SATE→Pendant handoff used to `link.teardown()` → destroy → pendant built its
  own manager → empty scan).
- **SATE ↔ Pendant ↔ L816 handoff: `stopScan()` only. NEVER destroy.**
- **Plaud handoff: DO destroy** (`link.teardown()` → `destroySharedBleManager()`) —
  the Plaud SDK needs the radio to itself. Rebuilt lazily afterwards. This is a
  radio handoff only; it never touches Plaud's binding (see RULE #1).
- Auto-sync (`useAutoSync`) owns SATE's manager in the background. It **must be
  paused** on any screen that needs the radio: `provision`, `changeWifi`,
  `recorderSettings`, `plaud`, `pendant`, `l816` (it gates itself via
  `autoSyncAllowed()`; the screen just takes the radio). Leaving
  it on rebuilds/rescans the shared manager under the screen and starves it.
- Only one scan per manager: a screen taking over should `stopDeviceScan()` first.

**`src/ble/radio.ts` is the arbiter and the ONLY place that hands the radio over.**
Logical owners (`autosync` | `sate-fg` | `pendant` | `l816` | `plaud`) sit over the two
physical stacks; it encodes both rules above, including the lock-safe Plaud release
(`disconnect()`, never `depair()`). Rules for touching it:

- A screen that scans/connects MUST own the radio. `acquireRadio(...)` is called
  **synchronously in the navigation handler in `App.tsx`** (`goHome` / `openPlaud` /
  `openPendant` / `openL816` / `openSateFg`) — NEVER in an effect: a parent effect runs after the
  child's, so it would stop the scan the screen just started.
- Auto-sync gates itself via `autoSyncAllowed()`. There is **no screen-name
  allowlist** any more — don't reintroduce one; give the screen an owner instead.
- **One scan per manager.** Auto-sync is the only background scanner and publishes
  the `nearby` set; a screen must not run its own presence scan alongside it. A
  foreground SATE scan (e.g. sync-over-BLE in `RecorderDetailScreen`) must borrow the
  radio with `acquireRadio('sate-fg')` and hand it back with `acquireRadio('autosync')`.

## Build / verify

- **Mobile (Expo, iOS-only for Plaud — arm64 device SDK, no simulator):** the user builds
  via Xcode. Compile-check the native module without a device/signing:
  `xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos \
   -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`
- **Typecheck:** mobile `npx tsc --noEmit` (repo root — it also pulls in
  `react_app_sate-ui_update/`, whose `@/…` path-alias errors are noise; filter them
  out); web `npx tsc --noEmit` in `react_app_sate-ui_update/`.
- **ALWAYS `npm run build` in `react_app_sate-ui_update/` before pushing the web
  subtree.** The web build is `tsc -b && vite build` with `noUnusedLocals`, so a
  merely-unused variable (TS6133) fails the build — typecheck alone won't catch what
  Vercel will. This has broken the deploy before.
- **Web deploy is a git subtree** to a separate repo:
  `git subtree push --prefix=react_app_sate-ui_update webapp <branch>`
  (`webapp` remote = `Longcao24/SATE_hardwave`, which Vercel builds).
- **The CLI + Debugger ship as a git subtree too:**
  `git subtree push --prefix=hwtest sate-cli main` (`sate-cli` remote = `Longcao24/SATE-CLI`) —
  the standalone repo a coworker clones to get `sate` / the Debugger without the monorepo.
  `hwtest/` here is the source of truth: edit here and push, never commit into `SATE-CLI`
  (that needs a `git subtree pull --prefix=hwtest sate-cli main` or the next push conflicts).
  `config.toml` (account password + device key), `.venv/`, `ci-reports/`, and the built
  `SATE Debugger.app` are git-ignored — keep them out of the subtree.
- Proprietary Plaud frameworks are git-ignored (`modules/plaud-sate/ios/Frameworks/`) —
  never commit them. Deploy `mint-plaud-token` with `--no-verify-jwt`.
- **`sate ci` is the standard firmware gate — every recorder firmware version MUST pass it
  before release.** It builds + flashes the debug build, runs the hands-off suite
  (`boot_health`, `reboot_resume`, `byte_match`, `verified_trim`) against a real board with
  remote record/stop/reboot, writes `hwtest/ci-reports/fw-<version>_<stamp>.json`, and exits
  non-zero on failure. Never release a version without a passing report.
- **Regression rule: any new feature or fix re-runs `sate ci` (the standard suite) BEFORE it
  lands** — firmware, harness, or backend alike; add `sate e2e` when the change touches the
  backend. The 1.5.16→1.5.18 chain is why: each fix exposed the next latent bug, and only
  re-running the full suite after every change caught them. `sate infra` probes every tier
  (auth, DB, device-api + the v15 verify route, Storage, CF worker, AI-queue state, device
  heartbeat) when something looks down; `sate pipeline` is the live animated pipeline map.
- **Hardware-in-the-loop tests** live in `hwtest/` (Python). A compiler can't catch the
  worst bugs — reboot mid-record, dropped-BLE truncation, delete-during-upload splicing,
  verified trim, crash-safe delete, OTA — so before a firmware release run the harness on
  a real recorder: `cd hwtest && python3 run.py --config config.toml` (CLI),
  `sate gui` (native window), `sate dashboard` (browser), or `sate debug` (desktop Debugger:
  screen mirror + remote control + flash an older published build via `sate flash --version`). It resets the board
  over serial, drives record/reboot/delete, and asserts on the firmware's own log
  (`[MEM] ready`, `[CONN] resume … session …`, `[CONN] uploaded … (N bytes)`,
  `[REC] healed interrupted delete`) **plus** the bytes the server stored (`GET /sessions/verify`).
  `python3 run.py --sim` self-tests the harness with no board. See `hwtest/README.md`.

## Project knowledge & gotchas (from accumulated notes)

Durable lessons — check the ones relevant to what you're touching. Version numbers drift;
`git log` is the source of truth for current firmware/edge-fn versions.

**Backend / Supabase edge functions**
- **`supabase functions deploy` may fail locally with `failed to open eszip: ENOENT`.** The
  bundler fetches every dep, then dies writing its output. It is the CLI, not your code — an
  unmodified file fails identically, and `TMPDIR` makes no difference. Use **`--use-api`**,
  which bundles server-side: `supabase functions deploy device-api --no-verify-jwt --use-api
  --project-ref zlgdpivcbmaodgokkdvz`.

- **`device-api` and `mint-plaud-token` MUST deploy with `verify_jwt:false`** (they validate
  the token themselves). Redeploying with the MCP default `verify_jwt:true` breaks recorder
  registration ("Setup link expired") and Plaud token minting. Always pass
  `--no-verify-jwt` / `verify_jwt:false`.
- `device-api` is versioned in-comment; bump it when you change routes. Plaud upload uses a
  USER-authed `POST /sessions` (Plaud has no `sate_devices` row / device key).
- **Admin page** `/admin` manages ALL devices + firmware system-wide, gated by the
  `sate_admins` table (by email). Don't expose admin routes without that gate.
  ✅ **Fixed 2026-09-07 (device-api v22):** `POST /firmware` now calls `isAdmin()` and returns 403
  to a non-admin — verified empirically with a throwaway non-admin account (403; it previously
  reached input validation). ⚠️ The **cloudflare port** (`cloudflare/src/functions/deviceApi.ts`)
  still has the ungated route — fix it there too before that lane ships.
- **A recording has ONE name, and `src/services/recordingName.ts` is where it is decided.**
  `recordingLabel(name)` (from a stored recording's name) and `sessionLabel(serial, n)` (from an
  uploaded session, which has no file name) both produce `R-S13` / `P-3:17 PM` / `PL-3:17 PM`;
  a name that does not match the generated pattern is a human's and is returned untouched. Used by
  the sidebar, the report header, the dashboard cards, the Devices session rows, the delete/move
  dialogs, the rename prefill, and a meeting note's meta line. **Do not re-derive it locally** —
  the same take used to be `device_SATE-443EAC_s13.wav` in the report, `R-S13` in the sidebar,
  `Session 13` on Devices and `SATE-443EAC · session 1` in a note, and four names for one thing
  means you cannot tell whether two screens are showing you the same recording. The raw file name
  stays reachable in the `title` tooltip.
- **`recordings.recording_name` is AUTO-FILLED with the file name — it is not evidence a human
  named the take.** Only a value that DIFFERS from `file_name` is. `recordingLabel` sidesteps the
  comparison — no person types `device_SATE-443EAC_s13.wav`, so matching the pattern IS the proof
  it was generated — but anything else asking "did the user name this?" must compare the two.
- **The number after `_s` in a device file name is NOT always a session number.** The recorder
  numbers takes 1..99 (`device_SATE-443EAC_s13.wav`); the pendant and Plaud paths put a UNIX
  TIMESTAMP there (`device_plaud-…_s1783709768.wav`). Anything rendering it must branch, or it
  prints thirteen digits of noise.
- **`GET /api/sessions` was capped at 20 (fixed in v19; default 200, `?limit=` up to 1000).**
  The cap silently hid a recorder's history — one account had **176** sessions and could see 20.
  The Devices page is the only place a session exists once its audio has been reclaimed from the
  card, so a take falling off that list looks like it was never made. Still bounded: it is one
  JSON response.
- **Deleting a session DELETES THE DERIVED RECORDING TOO (device-api ≥v22).** `deleteSession()` used
  to remove only the session row + its `device-sessions` object, leaving the `recordings` row and its
  copy of the audio behind — the take still showed in the web app and was still downloadable, so
  "delete" did not delete the clinical data. It now also removes the linked `recordings` row and its
  object (and `recording_versions` cascades). Both delete and retry write to **`sate_session_audit`**
  (append-only, RLS read-own, and deliberately NO foreign key to `sate_device_sessions` so the record
  OUTLIVES the row it describes). `retrySession()` records the previous error/attempts there before
  clearing them — without that, retrying erased the only evidence of what failed.
- **A transcript save is a compare-and-swap, not an UPDATE (2026-09-07).** `recordings` gained a
  `version` counter; `save_transcript(recording_id, expected_version, …)` keeps the previous transcript
  in **`recording_versions`** and raises `PT409` (→ HTTP 409) if the row has moved on. Two clinicians
  editing one transcript used to mean the second save silently overwrote the first, with no server-side
  history to recover from. The web app's `updateRecording()` calls the RPC and passes the version it
  last loaded. A trigger keeps history (and `updated_at`, which nothing maintained before) even for a
  direct table write, so an older deployed client degrades to "no conflict detection", never to
  "no history".
- **An AUDIBLE take that the AI returns with no words is RETRIED, not stored as `no_text`
  (`cf-processor`, 2026-09-07).** Byte-identical speech audio was measured coming back empty on ~1
  upload in 3. A silent `no_text` is indistinguishable to the clinician from a recording that captured
  nothing, and it cannot be retried (the Retry button only accepts `error`). `process()` now computes
  `_audio_rms(wav)`; if the audio is above `SILENT_RMS_MAX` (env, default **20**) and attempts remain,
  it raises `Transient` instead of finalizing. **Tune that threshold against real audio, not intuition
  — this mic is very quiet: a 7.6 s take that transcribes fine reads only ~76 RMS, so the first guess
  of 300 never fired.** Genuinely silent audio still finalizes `no_text` on attempt 1.
- **The recordings-bucket key is derived from the SESSION id, never wall-clock (`cf-processor`).** It
  used to embed `time.time()`, so every retry of a failing job wrote a NEW object and left one orphaned
  copy of the clinical audio per attempt. The upload is upsert, so a stable key means a retry overwrites
  its own previous copy.
- **`GET /api/sessions/verify`** (device-api ≥v15, device-key auth, read-only) — the recorder asks
  "is session N with exactly B bytes durably stored?" before freeing SD audio. Answers `stored:true`
  only when the row exists AND `objectExists`. Never make it mutate. `storeSessionRecord` also probes
  by (user, serial, patient, session_number, bytes) + `objectExists` to dedup a re-uploaded take (a
  lost BLE `markSynced` ACK). There is NO DB unique constraint backstop yet — add one.

**⚠️ A LONG TAKE MUST NOT BE BASE64'd INTO ONE JSON BODY (`device-api`, 2026-09-16)**
- The phone uploads hardware with no device key (L816/L815, pendant, Plaud) through
  `POST /api/sessions`, which carried the whole WAV as base64 in the body. Three innocent
  lines — `await req.json()`, destructure, `Uint8Array.from(atob(...))` — hold **FOUR copies
  at once**: the raw request text, the parsed object's copy of the base64 string, the binary
  string `atob` returns, and the byte array. For ten minutes of 16 kHz mono (~19 MB PCM,
  ~26 MB base64) that is upwards of 100 MB, and the function is killed part-way through with
  **HTTP 546 `WORKER_RESOURCE_LIMIT` — "Function failed due to not having enough compute
  resources"**. 🛑 **That message names compute, so it reads as an AI/model problem and sends
  you to Workers AI. It is neither — it is this function running out of MEMORY**, and the
  phrase is worth recognising on sight.
- **Fixed by STREAMING the body (`readSessionBody`)**: metadata is collected as text (tiny)
  and the base64 value is decoded four characters at a time straight into ONE pre-sized
  buffer, so peak memory is the audio once. Measured against the live function afterwards:
  1 / 5 / 10 / 20 / 40 / **62 min (119 MB WAV, 159 MB body) all 200**, in 9 s at 62 min;
  90 min (230 MB body) is a **502 at the gateway**, above the edge function entirely. The
  recorder's own ceiling is ~62 min, so this covers every take the hardware can make.
- **THE PHONE USES DIRECT-TO-STORAGE FOR ANYTHING OVER 4 MB** (`uploadSession`). Short takes
  keep the single POST — one round trip instead of three, and nothing left behind if the phone
  dies mid-upload. The register call happens only AFTER the object is really in Storage, which
  is what stops a failed upload leaving a row pointing at nothing.
- **`POST /api/sessions/upload-url` + `POST /api/sessions/register` (v27) are the ONLY routes
  with no size ceiling.** Every byte-carrying route puts the audio through the function, so
  every one of them has a limit that no amount of tuning moves — the streaming fix gets ~62 min
  through and 90 min is a 502 at the GATEWAY, before the function is reached. So the bytes stop
  coming through at all: the client asks for a signed upload URL, PUTs the WAV straight into
  Storage, then registers it; the function only ever sees metadata. 🛑 `storage_path` is
  confined to the caller's own `<user id>/` prefix (a caller naming any path could otherwise
  register another account's audio as their own session), and the byte count is read from
  **Storage**, never from the client. Verified live: 90 min / 172.8 MB — the exact size that
  was a 502 — uploads and registers; out-of-prefix paths get 403; an unuploaded path gets 409
  rather than a ghost row.
- ⚠️ **The BUCKET's own `file_size_limit` is what binds, not the project's** — the opposite of
  what this file used to say. Measured 2026-09-16: the project was already at 500 MB while
  uploads died at exactly 200 MiB (`413 EntityTooLarge`), which was `device-sessions`'
  own limit. Both are now **5 GB** (~43 h of 16 kHz mono; a bound rather than "off", so a bug
  cannot write a 50 GB object). Read them with the Management API
  `GET /v1/projects/<ref>/config/storage` and the Storage API `GET /storage/v1/bucket/<name>`
  — checking only one of the two is how the wrong one gets blamed. Verified after raising:
  **8 h / 922 MB uploads and registers**.
- **`POST /api/sessions/chunk` now accepts a USER JWT too (v26)**, not only a device key.
  Same handler, same part objects, same contiguity and idempotency checks; parts are rooted
  at `u_<user id>` and NEVER at a caller-supplied serial (that would let one account write
  parts under another's prefix). The phone should prefer it for large takes — the firmware
  has used it for 118 MB sessions all along — but the streaming fix above is what rescues the
  builds already installed.
- **A failed upload is self-healing and must stay that way.** Nothing is ever deleted from an
  L816, `markUploaded` runs ONLY after `uploadSession` resolves, and the sweep diffs the
  device's file list against what has been marked — so a take that failed to upload is still
  on the device, still unmarked, and goes up by itself on the next connect. That is why a
  server-side fix reaches recordings that already failed, with no app update.

**⚠️ THE WATCHDOG MUST OUTLAST THE LONGEST LEGITIMATE JOB (2026-09-16)**
- `STUCK_MINUTES` was **45** while `AI_READ_TIMEOUT_S` is **3600 (60 min)** — the watchdog cutoff
  was shorter than one legitimate AI read. ⚠️ **Latent, not live**: `loop()` is strictly sequential
  (`requeue_stale()` → `claim_next()` → `process()`) and there is one worker, so a worker cannot
  requeue its own in-flight job; no recording is known to have been reclaimed mid-transcription.
  Raised to **90** anyway so the invariant holds BY CONSTRUCTION rather than by an accident of
  single-threading — `doc/06` explicitly contemplates adding concurrency, at which point 45 is a
  live bug that costs an hour of GPU per occurrence. Lifting the upload ceiling is what made
  45–60-min takes reachable at all: raising a limit in one tier moves load into tiers nobody sized
  for it. **The trade**: a genuinely dead job now waits 90 min to be reclaimed instead of 45.
- 🛑 **THREE copies of that number exist and they must agree**: `cf-processor/wrangler.toml`
  `STUCK_MINUTES`, and TWO `STUCK_MS` constants in `device-api` — `adminStatus` (the admin
  page) and `healthAlerts` (the operator's EMAIL alerts). If either device-api copy is the
  smaller, you get paged about jobs that are simply still running, and an alert that cries wolf
  is one nobody reads when it is real.
- **`MAX_AUDIO_SEC` (default 4 h) refuses a take the AI cannot finish**, raised as `Permanent`
  so it fails once with a clear message instead of three times at an hour each. The audio is
  not lost — it is in Storage, and for a handheld still on the device. There is a MIN guard
  (`MIN_AUDIO_SEC`) and there was no MAX until uploads could carry one.

**⚠️ Device AI processing is ASYNC — never call the AI from an edge function**
- **The bug:** the old `process-device-session` edge ran `fetch(AI_PROCESS_URL)` (ngrok, self-hosted
  CUDA) and *awaited* the whole transcription. Supabase edge has a hard ~150s wall-clock limit
  (NOT configurable, NOT a timeout we set) — on a long take it **kills the worker mid-fetch, before
  the `try/catch`**, so `process_error` is never written and the session hangs in `processing`
  forever. A 32-min take showed 70 min stuck (edge kill → cron retry → kill …) before a retry
  happened to land. The AI is not slow; the edge just can't hold the call.
- **The fix (in prod):** processing is a state machine on `sate_device_sessions.status`
  (`queued → processing → done | error`, cols `processing_started_at` / `attempts` / added by the
  `async_processor_state_machine` migration). New sessions auto-`queued` (column default). A
  **Cloudflare Container** (`cf-processor/`, Python, `sate-processor.longcao.workers.dev`) is a
  long-lived process with NO wall-clock: it `claim_next_session()` (atomic, SKIP LOCKED) → downloads
  the WAV → HOLDS the ngrok `/process` call → copies audio to the recordings bucket → calls the
  `finalize-session` edge (analysis + insert `recordings` + set done; the light half, fits the edge
  limit). `pg_cron` pings the Worker `/tick` every minute to keep the container warm; the container's
  own loop drains the queue.
- **`process-device-session` must be a 200 no-op** — `device-api` still fire-and-forgets to it, but it
  must NOT process, or it races the container and duplicates recordings. Don't revive it.
  ✅ **Fixed 2026-09-07:** the repo copy was still the old processing version (a deploy of it would
  have raced the container into duplicate recordings). It has been replaced with the deployed 27-line
  no-op, so repo and prod now match — confirmed by downloading the deployed source.
- **Retry:** watchdog (`requeue_stale_sessions`) auto-requeues stalled `processing` jobs up to
  `MAX_ATTEMPTS` then → `error`; transient failures (network/`5xx`/`408`/`429`) requeue with backoff
  (`requeue_session`); permanent (`4xx`, no segments) → `error` immediately; the user Retry button
  (`POST /sessions/:id/retry`, device-api ≥v14) re-queues an `error` session.
- **Empty/too-short takes are finalized `no_text` BEFORE the AI call (`cf-processor/app/processor.py`,
  2026-07-26).** The AI service returns HTTP `500` on a near-empty WAV (a ~32 ms / ~1 KB accidental
  tap), and a `5xx` is transient → it retry-looped into a stuck `error` (hit real: session 35).
  `process()` now computes `_wav_seconds(wav)` and, if `< MIN_AUDIO_SEC` (env, default `0.4`), calls
  `finalize({no_text:true})` and returns without hitting the AI. Don't "fix" a stuck empty take by
  retrying — it's handled up front. NB a new container image doesn't instantly swap the running
  singleton (an in-flight claim is killed → orphaned in `processing` until the 45-min watchdog); to
  re-run one now, owner-PATCH its row to `queued` via PostgREST (the retry route only accepts `error`).
- **Error alerting + daily report (`status/src/worker.js`, Cloudflare `sate-status`).** The 5-min cron
  probes each tier and emails the operator via the Cloudflare Email binding, using the device-api
  `GET /api/health/alerts` digest. A settled `error` session is mailed ONCE (it can't auto-clear);
  only ACTIVE conditions (service DOWN, job stuck in `processing`) re-remind, ≤ every 24h. A full daily
  infrastructure report is emailed at 08:00 America/New_York; `GET /check?daily=1` force-sends it.
  A `TARGETS` entry may carry **`minIntervalSec`** to rate-limit its network probe below the 5-min
  cron — used for the **ngrok** hosts to conserve ngrok quota; the AI `/process` target is `24*3600`
  (once/day, ~1 hit/day vs ~288 — so a NEW AI outage can go unseen for up to 24h). When throttled,
  `runChecks()` carries the last status/code forward
  (re-inserts it, no fetch) so the 90-day history stays continuous; a carried `down` still alerts.
- **Never move the AI call back into an edge/Worker fetch.** Any serverless request (Supabase edge OR
  a plain CF Worker — the ~100s 524 origin timeout) will kill a long synchronous transcription. The
  long call MUST live in a real long-running process (the container). `finalize-session` and
  `device-api` MUST stay `verify_jwt:false`. See `doc/05-backend-supabase.md`.

**⚠️ Recorder SD reclaim is SERVER-VERIFIED, never on the `.synced` marker alone (fw ≥1.5.13)**
- The device is the only copy of a take until it is PROVABLY on the server. `trimPatientSyncedAudio()`
  in `connectivity.cpp` reclaims the audio of synced takes older than the newest `KEEP_AUDIO_SESSIONS`
  (=5) — but ONLY after `verifySessionStored()` gets a byte-exact `stored:true` from
  `GET /api/sessions/verify` (device-api ≥v15: checks the row AND that the storage object really
  exists). It keeps a `.synced` tombstone (slot stays numbered) and frees only the audio. Any doubt —
  offline, non-2xx, parse fail, byte mismatch — KEEPS the audio; trim just retries next cycle.
  `sessionAssembledBytes()` mirrors the server's stored `bytes` exactly (part0 keeps its 44-byte
  header, later parts stripped). Full deletion stays user-only (`deleteSessionFiles()`, Delete button).
- **Do NOT free audio on a `.synced` marker alone.** A marker only means "a POST returned 2xx" (or an
  app-set BLE `mark_synced`), NOT "the audio is durably stored" — the 413-ghost class left markers with
  no object. The verify gate (row + `objectExists`) is what makes reclaim safe; don't bypass it.
- **Sessions are NEVER renumbered (fw ≥1.5.20).** Numbers are allocated **monotonically and wrap at 99**
  (to the lowest free `1..99`); a hole is legal. `deleteSession()` removes ONLY that session's own files
  and shifts nothing. The old renumber machinery is GONE — no `sate-del` NVS journal, no
  `recoverInterruptedDelete()`/`compactPatientDir()`/`renameSessionFiles()`. This deliberately killed the
  biggest critical cluster (renumber-under-a-live-upload splicing two takes, trash-tap-after-renumber
  deleting the wrong take, power-cut-mid-renumber slot reuse). A delete defers-and-drops only the uploader
  if it is latched on that exact session (`upDropReq`); any other session's upload is untouched. Every scan
  iterates the directory — do NOT reintroduce code that assumes contiguous `1..N` or renumbers. See
  agent-memory `no-renumber-sessions`.
- **Auto-resume after reboot** (`maybeResumeRecording()`): **every** take - button-started AND
  server/app-started (fw >=1.5.16) - resumes into the same session, because segments flush to SD every
  ~5 s (not once per minute) and an empty `part00` on boot RESTARTS the take instead of deleting it.
  It needs only local NVS + the SD segments: no Wi-Fi, no server. A `tries` boot-loop guard gives up
  after two attempts.
- **The resume runs from `loop()`, NEVER from `setup()` (fw >=1.5.17).** It re-enters the capture,
  which BLOCKS until Stop, and `connStartNetTask()` lives in `loop()` - so resuming inside `setup()`
  meant the net task never started and the unit went off the air for the whole take: no heartbeat, no
  remote `stop`, no serial, unstoppable except at the button or the ~62-min ceiling. A server-started
  take, with nobody at the device, just goes dark. `setup()` sets a pending flag; `loop()` resumes once
  the net task is up — and if Wi-Fi hasn't associated in ~8 s, the offline fallback STARTS the net
  task itself (provisioned + real crash-mark only) before entering the blocking capture, so the
  resumed take keeps Wi-Fi retries/BLE, the remote `stop`, the heartbeat, and the OTA health-confirm
  even when the AP is down at boot. This shipped and was caught on the bench - don't undo it.
  The same rule applies to anything else that blocks for a user-controlled duration.
- **Remote `stop` (fw >=1.5.15) is latched only while a take is ARMED** (`recTakeArmed`, set before the
  take's start sequence, cleared when capture returns). Do NOT "drop stale stops" by clearing the flag
  at take start - that swallows a stop issued during the take's own start (status screen + GUI pump),
  which is exactly when a resumed take is stopped, and left takes running unbounded (fixed 1.5.18).
- **A serial DTR/RTS reset cannot reboot a RECORDING device** on the debug build: `Serial` is USB-CDC,
  its reset is software-handled, and the capture loop never services USB. Use the remote `reboot`
  command (core-0 net task). Flashing is unaffected - esptool resets through the USB-Serial-JTAG
  hardware, which works even when the firmware is wedged.
- **Storage's project-wide file size limit overrides the bucket's** and defaults to 50 MB. A
  full-length take is ~118 MB. It's set to 500 MB now; if big sessions land as rows with
  `process_error: "download failed: Object not found"`, check that first. A swallowed 413 plus a
  `.synced` written on a false 2xx destroyed a 62-minute recording once — `storeSessionRecord` now
  throws on upload failure. See `doc/05-backend-supabase.md`.
- **OTA on a device with a backlog fails `err-get-1`** (fragmented heap ⇒ the 2nd TLS handshake
  can't get its ~40 KB). Queue `reboot`, wait for it to come back, THEN queue `ota` — the first poll
  after boot flashes with a clean heap. Recipe in `doc/07-runbook.md`.

**Firmware / hardware (ESP32-S3, `SATE_Recorder/`)** — recorder sketch is
`SATE_Recorder/SATE_Recorder.ino` (folder name matches the `.ino`, so `arduino-cli` builds it
directly, no temp-copy). Pendant firmware is `SATE_Pendant/` (see the pendant section). Coworker
setup + prebuilt flash assets: `SETUP.md` + the **GitHub Release** (`gh release … fw-1.5.12`:
`merged.bin` for flash-only, `sate-arduino-libs.zip` for exact libs). Bump the release tag per fw.
- 🛑🛑 **#1 BOOT-HANG TRAP — screen bright but frozen at the boot spinner is NOT a bad flash and NOT
  the code. It is `lv_conf.h` `LV_TICK_CUSTOM 0`.** The firmware never calls `lv_tick_inc()`, so if
  `LV_TICK_CUSTOM` isn't `1` (millis()) LVGL's clock is frozen → spinner sticks at frame 1, nothing
  ever repaints, yet `setup()` finishes (serial shows `[MEM] ready`). **Reinstalling lvgl resets
  this to 0.** Before wasting hours on flash params: check `~/Documents/Arduino/libraries/lv_conf.h`
  → `#define LV_TICK_CUSTOM 1` (+ montserrat 12/14/20).
- 🛑 **FLASH CONFIG (verified fw 1.5.12):** `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi`.
  Board = **16MB flash + 8MB octal (opi) PSRAM**. **`PartitionScheme=default_8MB` is mandatory — it
  has TWO app slots (`ota_0`+`ota_1`) so OTA works. NEVER `huge_app`** (it's literally "3MB **No
  OTA**", a single slot — flashing it silently kills OTA; the device records/registers but can't
  self-update). `PSRAM=opi` mandatory. Manual `esptool` merged-bin flashing needs flash mode
  **DIO** (qio = dead black screen); `arduino-cli upload` sets the mode itself. LVGL draw buffers +
  heap live in **PSRAM** (`lv_conf.h` `LV_MEM_CUSTOM 1`/`ps_malloc`, and `display.cpp`
  `MALLOC_CAP_SPIRAM`) so the register TLS handshake has contiguous internal RAM — don't move them
  back to internal DMA RAM (that caused "Server registration failed code -1"). See `doc/12-hardware.md` §3.
- **Battery sense = GPIO9 (ADC1), enabled** (`BAT_ADC_PIN 9`, `BAT_SENSE_ENABLED 1`) behind the
  board's on-board 0.5 divider (`analogReadMilliVolts × 2`) → Home chip + heartbeat telemetry +
  low-voltage cutoff. ⚠️ **Do NOT move it to GPIO34** — GPIO34 is a classic-ESP32 pin, wrong on the
  S3, and bootloops the board (that was the fw 1.0.6 mistake; GPIO9 is the fix). See `doc/12-hardware.md` §8.31.
- **Two-button pinout**: record = GPIO2, flag = GPIO14 (interrupt-latched). Flag markers
  flow device → sessions → recordings → web report seek-bar ticks. Don't reassign lightly.
- **GPIO3 is a GROUND RAIL, not a signal** (`GND_OUT_PIN`, fw 1.5.33): driven `OUTPUT`/`LOW`
  in `setup()` *before* the buttons, and latched low through deep sleep (`rtc_gpio_hold_en`,
  released by `rtc_gpio_hold_dis` at the top of `setup()`). **Don't drop the sleep hold** — a
  RECORD button whose common sits on IO3 loses its return path while asleep and the ext0 wake
  dies. Keep the sink under ~20 mA; it's a GPIO, not the ground plane. See §2 of `doc/12-hardware.md`.
- **Charge detect is inference, not a pin** (fw 1.5.33): the on-board charger exposes no CHRG
  line and the S3 has no VBUS-sense register, and `HWCDC::isPlugged()` only sees a real USB
  *host* (a wall charger sends no SOF packets) — **true is trustworthy, false is not**. So
  `batteryService()` layers host-attached/host-lost + a ≥4250 mV level + a ≥25 mV raw step +
  a 4-min ±8 mV trend. Two rules keep it honest, both found in simulation: **slow tests run on
  the smoothed EMA, only the step test on the raw read**, and the trend/full tests are windowed
  **slopes** (decide once per window, then reopen) — a threshold retested every sample against
  a fixed reference is eventually crossed by noise, sign a coin flip. §8.30.
- **Battery 100% is reachable now** (fw 1.5.33): the old LUT put 100% at 4200 mV — the CV
  setpoint the *sensed* node never shows, because the charger terminates and the cell relaxes
  to ~4.15–4.18 V, the ~120 mA load sags it further, and the 1-point gain is tuned on one unit.
  Full is now 4150 mV, plus a charge-terminated latch (< 6 mV climb per 4-min window on USB →
  real 100%, held until < 4050 mV). Don't "fix" a unit reading 95% by re-tuning `BAT_CAL_GAIN`
  first — check §8.31.
- **Connectivity runs on a core-0 task**, GUI + buttons on core 1 (fixed button lag + stuck
  uploads). Keep network work off the UI core.
- **OTA**: firmware pulls a `.bin` from Supabase Storage via the command channel; the web
  "Publish firmware" card uploads a release. Bump `FIRMWARE_VERSION` per release so the
  device reports it and the update banner works.
- 🛑 **EVERY firmware version is COMMITTED AND TAGGED BEFORE the next one is started. Mandatory,
  no exceptions.** Bump `FIRMWARE_VERSION`, get it building, then `git commit` + `git tag fw-<version>`
  — *then* start the next change. A version that only exists in the working tree is gone the moment
  the next edit lands.
  This is not hypothetical: on 2026-09-15 a bench unit was running **1.5.36** and that firmware could
  not be produced from anywhere — HEAD was 1.5.32, the published bucket topped out at 1.5.10, the
  newest GitHub release was 1.5.12, and 1.5.33→1.5.39 were one uncommitted 633-line blob. The request
  "flash 1.5.36 back so I can compare" was impossible to satisfy, and the only way to compare against
  an older build was to jump all the way back to 1.5.12.
  A tag is what makes a revert one command (`git checkout fw-1.5.39 -- SATE_Recorder/`), and what lets
  a unit reporting version X be matched to the source that produced it. Flashing a bench board with an
  uncommitted build is fine; *moving on to the next version* without committing the last one is not.
- **Building + publishing a firmware release (the exact recipe):**
  1. Bump `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`, then compile
     (`arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder`).
     The folder name matches the `.ino`, so it builds in place — no temp-copy. **Partition MUST be
     `default_8MB` (dual OTA), never `huge_app`** (see the FLASH CONFIG trap above). Flash the fleet
     with `arduino-cli upload -p <port> --fqbn "…" SATE_Recorder` (handles flash mode). Manual
     `esptool` merged-bin flashing (for a stuck board) needs `--flash_mode dio --flash_freq 80m
     --flash_size 16MB` at `0x0`.
     ⚠️ **`lv_conf.h` — `LV_TICK_CUSTOM` MUST be `1` (SILENT BRICK if 0).** The firmware calls
     `lv_tick_inc()` NOWHERE; it relies entirely on `LV_TICK_CUSTOM=millis()`. With it `0`, LVGL's
     clock is stuck at 0 → the boot spinner freezes at frame 1 and NO screen ever repaints after,
     while `setup()` still completes on wall-clock (serial reaches `[MEM] ready`). Looks exactly like
     a boot hang / bad flash — it is neither. **Reinstalling lvgl (the iCloud fix below) resets
     `lv_conf.h` and drops `LV_TICK_CUSTOM` back to 0** (it re-enables fonts but not the tick) — so
     after ANY `lib install lvgl`, re-check `~/Documents/Arduino/libraries/lv_conf.h`: line ~88
     `#define LV_TICK_CUSTOM 1` AND montserrat 12/14/20 enabled.
     ⚠️ **Reading serial to debug boot:** `Serial` output only appears when built with
     `CDCOnBoot=cdc,USBMode=hwcdc`; the board is `/dev/cu.usbmodem101` (USB-Serial-JTAG). Plain
     `cat` won't reset it and racing esptool for the port fails — use a pyserial script that opens
     the port, pulses `RTS`(EN)/`DTR`(GPIO0) to reset-to-run, then reads.
     ⚠️ **Compile gotcha:** `~/Documents/Arduino/libraries` is under **iCloud Drive** — lvgl gets
     evicted to 0-block placeholders and `cc1plus` then blocks forever in `read()` on the lvgl
     preprocess (looks like a hang; it is iCloud on-demand download stalling). Fix: `arduino-cli lib
     uninstall lvgl && arduino-cli lib install lvgl@8.4.0` to re-materialise it, then **re-fix
     `lv_conf.h`** (LV_TICK_CUSTOM 1 + montserrat 12/14/20 — see the tick warning above). Long-term:
     turn off "Optimize Mac Storage" / move the Arduino sketchbook out of iCloud. Also `arduino-cli
     config delete board_manager.additional_urls` if `init` hangs on the board-index fetch.
  2. The **OTA image is the APP bin** (`SATE_Recorder.ino.bin`, ~1.7 MB) — NOT `.ino.merged.bin`
     (the full 8MB image, first USB flash only).
  3. **Publish** = upload that `.bin` to the public `firmware` Storage bucket at path
     `sate_<version>.bin` (`upsert`, `application/octet-stream`) + insert a `sate_firmware` row
     `{version, url, notes}` where `url` is the bucket's public URL
     (`<SUPABASE_URL>/storage/v1/object/public/firmware/sate_<version>.bin`). `getLatestFirmware`
     orders by `created_at`, so the newest row wins; re-publishing a version overwrites its `.bin`.
     Two ways to do it:
     - **Web card** (`/admin` → "Publish firmware"): easiest for a human — uses the admin's browser
       session, no keys. But it needs a browser + admin login, so an agent can't drive it.
     - **Direct upload + row insert (easiest programmatic path — this is what to use):** two calls,
       no temp function, no browser.
       1. `curl -X POST "$SUPABASE_URL/storage/v1/object/firmware/sate_<v>.bin" -H "Authorization: Bearer $KEY" -H "apikey: $KEY" -H "Content-Type: application/octet-stream" -H "x-upsert: true" --data-binary @<bin>`
       2. `insert into sate_firmware (version, url, notes) values ('<v>', '$SUPABASE_URL/storage/v1/object/public/firmware/sate_<v>.bin', '<notes>');` — run it with the **Supabase MCP** `execute_sql`.
       Then verify: the public URL returns 200 and its SHA-256 matches the local `.bin`.
       `$KEY` = the Supabase **`sb_secret_…`** key (a new-style secret key works on Storage; the repo's
       `SERVICE_KEY` is a custom `svc-…` app key and is NOT it, and the MCP only exposes the anon key —
       so the secret has to be supplied). Project ref `zlgdpivcbmaodgokkdvz`. **Do NOT** deploy a
       throwaway edge function to do this — the two calls above are simpler. Treat a pasted `sb_secret`
       as compromised and tell the user to rotate it afterward.
  4. Queueing OTA to a device with a backlog fails `err-get-1` — `reboot` first, wait, then `ota`
     (see the runbook note above).
- **RECORD button is a GESTURE, not a tap (fw >=1.5.35): double-click starts, HOLD 3 s stops.**
  A single tap does nothing on Home and nothing during a take. One tap was too easy to do by
  accident on a device that lives in a bag: a stray tap mid-take ENDED a recording, a stray tap
  at Home started one nobody wanted. Three things this depends on, all easy to break:
  (a) stop reads the button's LEVEL (`digitalRead`), not `btnPressed()` — a hold is a duration
  and `btnPressed()` is a one-shot; it is still CALLED and its result discarded, or the latched
  taps queue up and the first fires the instant the take ends; (b) hold-to-stop only arms after
  the button has been seen released once, or holding the second click of the double-click stops
  the take 3 s after it starts; (c) the pill counts down `HOLD 3/2/1` — a silent 3-second hold
  is indistinguishable from a dead button and users let go at two.
  **The gesture applies to the PHYSICAL button only.** The on-screen record dot (`ACT_RECORD`),
  the on-screen Stop button and the remote `stop` command are all still a single action — which
  is why Home still reads "Ready to Record" and the gesture is taught by a transient toast fired
  from the physical-button path (`showToast`), not by a permanent label that would be wrong for
  anyone using the touchscreen. A lone physical press says "Double-click to start recording" at
  Home and "Hold 3s to stop recording" during a take; the double-click window is 700 ms so the
  hint outlasts reading it, and a late second tap just re-arms the window. ⚠️ **`sate ci` cannot test any of this** — it drives
  the device with REMOTE commands and never touches the physical button; the gesture needs a
  human. See `SATE_Recorder.ino` `REC_DOUBLE_CLICK_MS` / `REC_HOLD_STOP_MS`.
- **TLS is chosen by URL SCHEME, not by hostname (fw >=1.5.34).** `serverIsSupabase()` used to
  decide both "speak TLS?" and "send the `apikey` header?" from one `strstr(cfgServer,
  "supabase.co")`. That works for exactly one backend: point a recorder at any other https host
  and the command poll (`connectivity.cpp` `connHttpBegin`), the chunk upload (`sendSessionChunk`)
  and registration all built PLAIN HTTP against port 443 and failed with nothing useful in the
  log. Now `urlIsTls()`/`serverIsTls()` answer the TLS question and `serverIsSupabase()` is for
  the `apikey` header ONLY. OTA was already scheme-based. Don't re-merge them — the second
  backend (`sate-notes/`, the consumer lane on Cloudflare) depends on this.
- **Wi-Fi change without factory reset** is **app-driven**: the `change_wifi` BLE op or the
  `wifi_change` remote command re-associates and KEEPS the account/device key. Don't wipe the
  account binding for a Wi-Fi change. ⚠️ **Holding BOOT 5 s is a FULL factory reset**, claimed
  or not (`serviceFactoryResetButton()` in the `.ino` — verified in source 2026-07-28); the
  older "BOOT-hold just changes Wi-Fi" note (still in `connectivity.h`'s header comment) is
  stale. The other route to first-time setup is the server removing the device (heartbeat
  `unclaimed:true`).

**SATE Pendant (XIAO nRF52840 wearable)**
- Firmware is in the repo at `SATE_Pendant/` (`SATE_Pendant.ino` + `HARDWARE.md` +
  `INTEGRATION.md` + `flash_xiao.sh`). Build/flash from repo root: `./SATE_Pendant/flash_xiao.sh
  SATE_Pendant` — it compiles with the **Seeed** core and aborts on the `0x26000` SoftDevice trap
  (see below + `doc/09-pendant.md`). Needs the Seeed nRF52 board package installed.
- Streams raw PCM (16 kHz mono S16LE, 244 B/notify) over standard BLE → app wraps it
  in a WAV → same `uploadSession` pipeline, `device_serial` `pendant-<bleId>`.
  Pure ble-plx: **no native rebuild, no binding/lock concern** (unlike Plaud).
- **Advertising**: the audio service UUID `19b10000-…` is in the ADV packet, but the
  NAME (`SATE Pendant`) is only in the SCAN RESPONSE → iOS surfaces it as
  `localName`, not `name`, and `name` may be a STALE cached GAP name from an earlier
  firmware. So: **scan with NO service filter**, and match on `name` OR `localName`
  OR the advertised audio service. Verify what the device really broadcasts by
  scanning from the Mac (`bleak`) before blaming the app.
- 🛑 **Flash with the SEEED core, NOT the Adafruit Feather core.** FQBN
  `Seeeduino:nrf52:xiaonRF52840SensePlus`. The Adafruit `feather52840sense` links the app
  at `0x26000` → overwrites the last page of the S140 7.3.0 SoftDevice → BLE stack
  corrupted: **app runs but NEVER advertises, no CDC port** (hardfaults in
  `Bluefruit.begin()`). Correct core links at `0x27000` (the UF2 conversion prints it —
  `0x26000` = STOP). Recover a corrupted (or factory-fresh) board by DFU-restoring Seeed's
  SoftDevice+bootloader (`adafruit-nrfutil dfu serial … Seeed_…_s140_7.3.0.zip`), then
  reflash. `flash_xiao.sh` now uses the Seeed core + aborts on `0x26000`. Full recipe:
  `doc/09-pendant.md` + `SATE_Pendant/HARDWARE.md`.
- **Mic is very quiet.** The app peak-normalizes + applies a loudness drive with a
  tanh soft-clip (`applyGain` in `PendantLink.ts`; tune `LOUDNESS`/`MAX_GAIN`). The
  firmware has its own `MIC_GAIN`/`DIGITAL_GAIN` — don't stack both to the point of
  clipping.
- **Stop must gate accumulation.** BLE notifications keep arriving after `CMD_STOP`;
  without the `capturing` flag they tack extra seconds onto the take (duration crept
  to 0:01/0:02 after Stop).
- Paired pendants persist in AsyncStorage (`PendantStore.ts`) — a known pendant
  reconnects straight by BLE id, no rescan. **Nap mode**: a notification gap while
  connected is NORMAL (the pendant sleeps in silence), not a disconnect.
- Recordings upload as **Standalone** by default — assigning a patient is optional
  and can be done later on the web report. Don't force patient assignment at capture.

**SATE L816 handheld recorder (Android-only) — `src/l816/` + `modules/sate-asc/`**
- **THE FAMILY IS MULTI-MODEL (L816, L815, …) — `L816_MODELS` is the one list (2026-09-16).**
  They speak the same protocol, carry the same ASC-VI audio and share one `kind`, so a new
  model is an entry in that array plus a label, NOT a new device kind — adding a kind would
  mean auditing every branch that switches on it, to no purpose. 🛑 **The serial prefix is the
  MODEL and it is permanent**: `l816Serial(id, model)` writes it into the storage path of every
  recording that unit ever makes, so calling an L815 `l816-…` is a false statement about the
  hardware that cannot be corrected later without moving objects. The MAC already makes the
  serial unique — the prefix's only job is to say what the thing is. The model is only knowable
  while the peripheral is ADVERTISING (`l816ModelOf`), so it is captured at pair time and stored
  with the pairing; `rememberL816` refuses to downgrade a known model back to undefined, and a
  missing model (older pairing, or a unit that advertises only `2837`) falls back to the family
  default `l816`, which is what every existing unit already is. ⚠️ **Two WEB tables split on that
  prefix and must stay in step** or a unit uploads takes that look fine while its hardware never
  appears in Connected Recorders: `services/recordingName.ts` (matches the family as `l81\d`,
  and `label()` collapses the captured MODEL back to the family key — looking a model up
  directly returns undefined and silently relabels every L816 take as a numbered recorder
  session) and `contexts/DeviceProvider.tsx` `FAMILIES`.
- **Called a SATE L816 in the product; the hardware advertises `L816`.** Those are
  deliberately different strings: `L816_DISPLAY_NAME` (`src/l816/L816Link.ts`) is the ONE
  place the product name is written and is what a paired unit is remembered as, while the
  scan matcher and the diagnostics list keep using the raw advertised name — that list
  exists to show what the phone actually hears. Don't "fix" the mismatch by renaming
  either one, and don't hardcode the display string a second time.
- A BLE handheld ("2837 protocol family") the app drives directly: find → record →
  stop → download → upload, no vendor app and no vendor cloud. Plain ble-plx on the SHARED
  manager, radio owner `l816` — **no binding, no lock concern** (RULE #1 is Plaud-only).
  Full reference: `doc/14-l816.md`.
- **It is the MIRROR IMAGE of Plaud, and for the same kind of reason.** Plaud is iOS-only
  because its SDK is an arm64 *iOS* binary; the L816 is **Android-only** because its audio
  is ASC-VI and the only decoder in existence is a pair of proprietary ARM *Android* ELF
  binaries (`libasc_dec.so` + `libASCDecoder.so`) lifted from the vendor APK. They cannot
  load on iOS and cannot run in the x86 `cf-processor` container, so the conversion must
  happen on the phone. `L816_ENABLED = android && isAscAvailable()` — the second half
  matters: the `.so`s are git-ignored like the Plaud frameworks, so a clone without them
  still builds and simply never offers the device. Copy them in per
  `modules/sate-asc/README.md`. Everything else in the family is portable TypeScript.
- 🛑 **A TAKE IS DECODED TO A FILE, NEVER TO A base64 STRING (2026-09-16).** `decodeToWavFile`
  streams straight to the cache and returns a path; `decodeToWavBase64` is kept for short takes
  only. The base64 version killed the app on a real recording:
  `OutOfMemoryError: Failed to allocate a 183468512 byte allocation with 8694048 free bytes ...
  growth limit 268435456` — Android's heap ceiling is 256 MB and that path held FOUR TO FIVE
  live copies of the audio: the `ByteArrayOutputStream` (which doubles its buffer as it grows),
  `toByteArray()`, the `header + pcm` array concatenation, the base64 string at 1.33x, then the
  same string again in JS and a `Buffer` from it. And the WAV is already ~7.8x the ASC it came
  from, so ASC that fits comfortably becomes a WAV that cannot. The upload then streams from the
  file with `expo-file-system`'s `uploadAsync` + `BINARY_CONTENT` (a PUT whose body is read off
  disk), so nothing proportional to the take is ever in the heap. **The cache file is deleted
  only after the upload succeeds** — it can be hundreds of MB and nothing else collects it.
  ⚠️ The ASC input is still passed in as base64 (~14.8 MB/h, so ~40 MB of string for a 2-hour
  take); that is survivable today and is the next thing to move to a file if it ever is not.
- 🛑 **Do NOT rename/move `com.actions.asc.jni.ASCDecoder`.** The binary exports
  `Java_com_actions_asc_jni_ASCDecoder_decode`, so the symbols only resolve at exactly that
  fully-qualified name — and a rename fails with `UnsatisfiedLinkError` at the first
  `decode()`, not at load, so it reads as a codec bug rather than a packaging one.
- **The legacy length byte is the whole ballgame for the parser.** Framing is
  `55 AA <len> <op> <payload>` / `AA 55 …`, normally `len+3` bytes total — EXCEPT opcode
  `03` (declares `0x0F`, carries a 17-byte name) and `04`/`05`/`07` (declare `0x13`, carry
  a name + 4-byte size). Each is three bytes longer than the formula. Miss it and every
  packet after the first is lost, which on screen looks exactly like a dead device. The
  download REQUEST declares `0x13` while carrying 21 bytes for the same reason — mirroring
  the quirk is what makes the device accept it.
- **Enable all THREE notifies, in the order `1203a → 1204a → 1201a`.** With only the first
  two, transfers stall. `1201a` carries file bytes as well as record events, so both it and
  `1204a` feed the same assembler.
- **A transfer is complete on EOF (opcode 09) AND an exact byte match against the opcode-07
  ACK — never the list size.** The two differ by design (listed 204332 → 26158 transferred).
  A take that merely stopped arriving is truncated, and a truncated recording that uploads
  successfully is indistinguishable from a real one. Sizes that are not a multiple of 82
  are refused up front.
- **After Stop: wait 1500 ms → re-list → match the EXACT name Stop returned → wait 600 ms →
  download.** An immediate download returns error opcode `FD` (the device is still
  flushing), and "the last entry in the list" is a different take the moment anything else
  is on the device. Nothing is ever deleted from the L816, so a failed upload is still
  recoverable from the on-screen file list.
- **It keeps recording with the app closed or out of range** — `connect()` queries opcode
  `0F` and the screen picks the live state up instead of assuming idle. It also only talks
  to one phone at a time: if the vendor app holds the link, it will not be found.
- **A take started by the PHYSICAL button must reach SATE with no tap** — that's the take a
  user actually cares about (phone in a pocket). TWO signals feed it and you need both:
  an UNSOLICITED opcode `03`/`04` (instant, carries the file name — but no capture from the
  reference unit ever shows the device sending one, so it can't be relied on), and a 3 s
  poll of opcode `0F` (always works, no file name). 🛑 **`settle()` returns a boolean on
  purpose**: an `03`/`04` that NO waiter expected is by definition the user pressing the
  button, and that's what becomes an `L816DeviceEvent`. Swallow the unmatched response —
  which a promise-per-command port does by default — and the whole feature silently
  vanishes with nothing failing. The poll only sees the state FLIP, so a stop with no name
  goes to `fetchNewSince(knownNames)`, which DIFFS the file list (never "the last entry":
  these devices don't list in a guaranteed order). The poll must never run while a command,
  listing or transfer is in flight.
- **The background link is an Android FOREGROUND SERVICE (`modules/sate-fgservice`), and it
  does no Bluetooth.** Android stops scheduling a backgrounded app, so the 3 s poll — and
  with it the entire detect-a-take-started-on-the-device feature — dies the moment the user
  leaves the screen. The service exists ONLY to keep the process alive; BLE, the protocol
  and the upload stay in JS where they're already tested. `START_NOT_STICKY` + `onTaskRemoved`
  → stop, both deliberate: Android must never revive the service with no JS runtime behind
  it, because a notification claiming a live connection that nothing holds is worse than no
  notification. Swiping the app away stops it; backgrounding does not. iOS is NOT supported
  (a backgrounded iOS app keeps the BLE link but suspends JS timers, so the poll can't run).
  🛑 The permissions + `<service>` live in the MODULE's own `AndroidManifest.xml` (library
  manifests merge) — never in `app.json`'s android block or in `android/`, which is
  git-ignored and regenerated by prebuild.
- **The L816 SESSION IS APP-LEVEL, not screen-level (`src/l816/useL816Session.ts`, 2026-09-16).**
  The link, the device-event watch and the upload engine are mounted once at the root of BOTH
  apps (`App.tsx`, `src/sate/SateRoot.tsx`); `L816ConnectScreen` is a VIEW over it and owns only
  scanning. All of it used to live in that screen, whose unmount called `l816.disconnect()` — so
  the whole feature existed only while that one screen was on top. Walk to Reports and the
  recorder was connected to nothing. Four consequences, each a hole the screen version never had:
  (a) **a dropped link must be noticed** — nothing watched for one, and the 3 s poll swallows its
  own failures, so a dead link read exactly like an idle one (`L816Link.onDisconnected`, with a
  `closing` flag so OUR disconnect isn't mistaken for the device walking away); (b) **ble-plx's
  `connectToDevice` never times out** — on a timer, one attempt against a switched-off recorder
  hangs forever, leaves the `connecting` latch set and kills every later retry, so the feature
  dies for the process with one line in the log (`CONNECT_TIMEOUT_MS = 15000`, retry 20 s);
  (c) it **reconnects by itself, including at launch** to the last paired unit — that IS the
  "quick check on open" (connect → list → diff → upload); (d) the background reconnect must
  **never PROMPT** (`hasPermissions()` asks nothing) — and SATE and SATE Companion are separate
  packages with separate grants. 🛑 The radio arbiter had to learn this: `setL816Held(true)` makes
  `acquireRadio` call `stopL816Scan()` instead of `disconnectL816()`, and `L816Link.stopScan()`
  now only stops the radio if the scan is OURS (`scanActive`) — it reaches the SHARED manager's
  global `stopDeviceScan()`, and the session reconnects while AUTO-SYNC is scanning. RULE #2 is
  intact (one manager, never destroyed here); the Plaud handoff stays exempt and always releases.
- **A take that finishes WHILE A TRANSFER IS RUNNING used to be lost (fixed 2026-09-16).**
  `syncPending` now re-lists the device at the end of EVERY round and sweeps again if anything is
  unsent. That is not an optimisation — it is the only thing that catches such a take, and
  NEITHER of the two ways it happens reaches the event handler: a stop landing mid-transfer
  arrives with the lock held and every caller guarded `if (busyRef.current) return`, so the event
  was simply DROPPED; and a take that both starts and ends inside one transfer emits no event at
  all, because the 3 s poll is suspended for the duration (it must be) and only sees the state
  FLIP. So "record something while the app is uploading" meant the take sat on the device until
  the next connect — the exact case the feature exists for. `sweepOnce` is one pass returning
  false when it gave up; `syncPending` holds the lock across the loop and terminates because a
  round only repeats while a FRESH listing shows something unsent; `resweep` closes the last race
  by making a blocked caller LEAVE A NOTE instead of returning bare. Every other holder of the
  lock re-lists and calls `syncPending` on its way out.
- **Deleting a file ON the device is deliberately NOT implemented (decided 2026-09-16).**
  Storage is ~59 GB ≈ 4000 hours at 14.8 MB/h, so it cannot realistically fill; takes stay
  listed and the app now syncs them by itself, making the device a backup rather than a
  backlog. The opcode was never found: it appears in no string, class-name order in the Dart
  AOT is provably not declaration order, and live HCI captures caught no `DeleteRequest`
  at all. ⚠️ The vendor's Storage page CLAIMS files are "automatically deleted" after
  transfer — measured false: two downloads left both files on the device. Don't build on
  that claim. Bonus from the captures, unimplemented: opcode **`0x01`** (device info, 16-byte
  reply) and **`0x0E`** (2-byte reply — likely battery/storage).
- **Bytes on `1201a`/`1204a` outside a transfer are LOGGED, not dropped.** The reference app
  discards them, but `1201a` is named "Record Notify" in the vendor docs — if the device
  announces a button press anywhere, that's the likeliest channel and nobody has looked.
- **The device's clock lies** — the reference unit lists `01_20821119193921` (year 2082)
  beside takes from 2022. That becomes `session_number`, and 3.5e9 overflows a 32-bit
  column, so `takeTimestamp()` clamps outside 2000..(now+1d) back to now.
- **The web needs NO L816-specific code to process the audio** — the phone decodes ASC-VI to a
  plain 16 kHz mono WAV before upload, so `POST /api/sessions` gets the same shape the pendant
  sends and `cf-processor`/`finalize-session` never look at `device_serial`. ⚠️ But an L816 gets
  NO DEVICE ROW on the web: `GET /api/devices` returns `sate_devices` rows only, and
  `ManagedDevice.kind` is declared + branched on in `DeviceCard`/`DevicePanel` while **nothing
  populates it** — so that branching is unreachable for Plaud and the pendant too. Pre-existing,
  not L816-specific; an external take reaches the web as a session + recording, never as hardware.
- `device_serial` is `l816-<MAC, separators stripped>` (the serial lands in a storage key,
  so the colons come out in `l816Serial()`), and `session_number` is the take's own
  timestamp from `NN_yyyyMMddHHmmss` — stable across a retry, so a re-upload dedups instead
  of duplicating. That makes L816 the third family putting a TIMESTAMP where the recorder
  puts a take number; `recordingName.ts` labels it `L-3:17 PM`.

**The consumer ("Plaud-like") lane — `sate-notes/`**
- A SECOND backend for the same recorder, same firmware, same image: a device joins it purely by
  being provisioned with `cfgServer` pointing at it. Full Cloudflare — Worker + D1 + R2 + Workers
  AI (Whisper + an instruct model) + a Workflow. It shares no data, no DB and no AI capacity with
  the clinical stack, so a consumer backlog can never make a clinician's recording wait.
- **The pipeline is a Workflow, not a fetch handler** — same law as the clinical lane: a long
  transcription must never be awaited inside a serverless request. One `step.do` per audio chunk.
- ASR is ~96% of the cost ($0.031/audio-hour) and the summary ~4%, so the transcript is stored
  once and summaries live in their own table keyed by `(note, template, model)` — re-summarising
  (a different template, a bigger model) is nearly free and must NEVER re-transcribe.
- **Cloudflare-hosted models ONLY.** A product constraint, not a preference: no third-party
  inference API means no key to rotate, no second vendor to be down, and no audio or transcript
  leaving the account. ⚠️ **The `@cf/` prefix is NO LONGER proof of that** — the catalog now
  carries partner routes in the same namespace that are marked *Third-party*, including speech
  models (`@cf/xai/grok-stt`). `assertCloudflareModel()` therefore checks a **vendor allowlist**
  (`CF_HOSTED_VENDORS`), not the prefix; adding a vendor is a deliberate edit after reading the
  model page's "Cloudflare-hosted" label. Headroom for the summary model:
  `llama-3.3-70b-instruct-fp8-fast` (~$0.008/audio-hour, 24k context), `gpt-oss-120b`,
  `glm-4.7-flash` (131k context).
- **ASR is `@cf/deepgram/nova-3` with diarization (2026-09-08).** Whisper has no speaker
  support and hallucinates on quiet audio — the same 7.6 s SATE take came back `"Thank you."`
  from Whisper and `"Yeah. That's so nice to see that."` from nova-3. Cost is the trade: it is
  **$0.0052/audio-minute vs $0.00051** ($0.31 vs $0.031 per audio-hour), and ASR is ~96% of the
  feature's cost, so the lane costs ~10x what it did. `transcribeWhisper()` is kept and picked
  by model id, so rolling back is one env var.
  - **`audio.body` MUST be a `ReadableStream`.** Probed against the live model: `Uint8Array`,
    `ArrayBuffer` and `number[]` are all rejected with *"required properties at '/audio' are
    'body,contentType'"*. Use `new Response(bytes).body`.
  - **The published output schema is WRONG/incomplete.** It declares `words[]` as
    `{word,start,end,confidence}` with no `speaker` at all, and does not mention `utterances`.
    A real `diarize:true` call returns `speaker`, `speaker_confidence`, `punctuated_word` AND a
    `results.utterances[]` array. The adapter prefers `utterances` (already grouped per speaker)
    and falls back to grouping `words[]` on speaker change.
- **Speaker numbering is PER CHUNK, so it must be stitched — `stitchSpeakers()`.** Each chunk is
  diarized independently and numbers from 0, so chunk 1's "speaker 0" is not chunk 2's. Unmapped,
  a 6-chunk two-person meeting renders as up to twelve speakers. The overlap window is the only
  evidence (those seconds are transcribed twice), so speakers are matched by shared time in the
  overlap, strongest pair first, each global identity claimed once per chunk. **A local speaker
  who never talks during the overlap gets a NEW identity** — that over-counts rather than
  mis-attributes, which is the safe direction: a duplicate "Speaker 3" is confusing, but putting
  Speaker 1's words in Speaker 3's mouth is a lie. `CHUNK_SECONDS` is **600** (was 60) and
  `CHUNK_OVERLAP_SECONDS` **20** (was 2) for exactly this reason — fewer boundaries, and enough
  overlap to catch a real exchange. Verified on a 17-min two-person session: 2 chunks → 2 global
  speakers, identity held across the boundary.
- **The model is given a TIME- AND SPEAKER-STAMPED transcript (`promptTranscript()`), not the
  stored prose.** `transcripts.text` stays clean because that is what the note page renders. Two
  bugs died here: the highlight button was dead weight (the prompt announced "the user pressed
  highlight at 132 seconds" while handing over a wall of text with no timestamps anywhere), and
  "who agreed to do this" was unanswerable from one anonymous stream.
- **The map step of map-reduce needs the SAME anti-fabrication rules as the final pass.** It ran
  on a bare *"Summarise this part of a transcript in plain prose."* — no "transcript is the only
  source", no "fewer is correct". Whatever it invented became the only input the reduce step saw,
  and `sanitise()` cannot catch a fabrication already sitting in its input. So the LONGEST
  recordings — the ones a user is least able to check by ear — had no protection at all. Use
  `MAP_SYSTEM`, and split on line boundaries (`splitForMap`), never `slice()` mid-utterance.
- **The word count handed to the model must come from the ORIGINAL transcript.** It was measured
  on the post-reduction text, so a long meeting reported a few hundred words — and that number
  drives both the SHORT FRAGMENT branch and the chapter gate in `sanitise()`.
- **Whisper hallucinates on non-speech** (a pure tone came back as "Thank you."; a 6-minute
  silent take as "The car is a good one" on repeat), so the short-take guard runs BEFORE the
  model, and a session the clinical pipeline marked `no_text` is never offered a note.
- **An LLM pads a thin transcript, and padding is indistinguishable from a real summary.** An
  11 s clip of four half-sentences produced 9 key points, 3 action items and chapters at 0:30
  and 0:50 — past the end of the audio. Fixed at three levels and all three matter: the prompt
  must say fewer-is-correct (asking for "3-8 bullets" FORCES invention), the model must be told
  the recording's length and word count, and `sanitise()` must drop what cannot be true. Never
  ship a summariser without that last one — a prompt is guidance, not a guarantee.
- **Progress must come from the pipeline, not from an animation.** Transcription is one AI call
  per audio chunk, so "part 3 of 7" is a fact; it is written to `notes.chunks_done` INSIDE the
  `step.do` so a retried chunk cannot advance the bar twice. Stages that cannot be measured
  (queued, summarising) get an indeterminate bar and NO percentage — a bar creeping forward on
  a guess turns "I don't know how long this takes" into a promise.
- **A template must change WHAT IS EXTRACTED, not just the tone.** The first version gave every
  template the same six fields, so a lecture was still asked for "action items" — and a model
  asked for a field the recording cannot fill does not return `[]`, it INVENTS one. Each
  `TEMPLATES` entry now declares its own `sections` (and whether it has chapters), the prompt is
  built from that list, and `sanitise()` drops every key the template does not own. The smallest
  template (`tasks`, one section) is the safest.
- **A summary renders as a DOCUMENT, not a grid of cards** (`NoteDetail`/`SummaryView`): title,
  a metadata block for the facts we actually know, then headings with bullets. Items may carry
  `sub` (spoken sub-points) and a `"Label: text"` lead-in rendered bold — but both are gated
  hard in the prompt, because nesting and labels are two more surfaces to fabricate on. A short
  recording legitimately has neither; do not force them.
- **Strip placeholder items.** Asked for a section it cannot fill, a model writes "none
  mentioned" instead of `[]` — which renders as a bullet and reads like a finding. The prompt
  forbids it and `sanitise()` filters it; both, because the prompt is not a guarantee.
- **Only the DEFAULT template may set `notes.title`.** The title is the note's identity in the
  list; letting whichever template you last viewed rewrite it means reading a recording a
  different way renames it, and the sidebar stops matching the page.
- **Deleting a note has to OUTLIVE the row.** The Devices page auto-generates a note for
  anything recorded in the last 24 h, so a plain delete would be undone within seconds and the
  button would look broken. `DELETE /api/notes/:id` therefore writes a `note_optouts` row for
  the source session, `by-source` returns `{notes, optedOut}` so the auto-generator can skip it,
  and asking for the note again explicitly (the button on the session's row) clears the opt-out
  — that is also an intention. Any future automatic generation must honour that table.
- **Auto-generation is windowed to 24 h and runs one at a time.** This account has 176 sessions;
  sweeping the history on first page load spends real money on Workers AI and buries the list.
  Older sessions keep their own button.
- **Access is granted in the SATE app's Admin page → Users, and `sate_admins` is the ONE admin
  list.** The feature is OFF for every account until an admin turns it on there (device-api v21
  `GET /admin/users` lists the accounts from Supabase auth; the toggle PUTs to the Worker's
  `/admin/accounts`). Two things this fixed: the switch used to live on the Worker's own
  `/console` behind a shared `ADMIN_KEY` — a second URL and a second admin list, which drift —
  and a grant could only be given to an account that had ALREADY visited the notes lane, because
  `account_access` rows are created on first sight. The account list now comes from Supabase, so
  an admin can grant to anyone. The Worker learns "is this caller an admin?" by asking device-api
  `GET /admin/me` with the caller's own token (cached 60 s per isolate); `notes_admins` in D1
  stays only as a bench fallback and is EMPTY in prod. Don't reintroduce a second admin list.
- **A note REUSES SATE's own transcript instead of transcribing again (2026-09-16).** The
  clinical pipeline already runs ASR on every device session and stores
  `recordings.transcript` as `{segments:[{start,end,text,speaker?}]}` — the same shape this
  lane builds. `fromSession` now carries `recording_id`, `ingest` reads that transcript with
  the CALLER'S token through PostgREST (RLS decides what they may see) and seeds it onto the
  note, and the Workflow skips transcription. That removes ~96% of a note's cost, and it
  removes something worse than cost: two independent ASR runs over one recording disagree in
  small ways, and nobody should have to ask which of two transcripts of a clinical recording
  is real. 🛑 **BOTH halves are load-bearing** — seeding the row without the Workflow's
  `reuse clinical transcript` check means it transcribes anyway and OVERWRITES the seeded
  transcript, paying the full bill and silently discarding the clinical one. Reuse is
  best-effort at every step (no `recording_id`, still processing, `no_text`, a bad fetch) and
  falls back to ASR; it must never be able to cost someone their note. `chunks_total` is set
  to 0 so the progress bar shows no chunk counter for work that never happened.
- **Notes are made ON DEMAND from a recording the clinical stack already stored** (the
  "Meeting note" button on a Ready session in the Devices tab), NOT by rerouting the upload.
  The upload path is the one that has already destroyed a recording when it was got wrong;
  keep it out of this feature. The Worker fetches the audio from `device-api` with the CALLER'S
  own token, so ownership is enforced by the system that owns the recording.
- **R2 refuses a `ReadableStream` of unknown length** — the assembled WAV must go through a
  `FixedLengthStream`. `cloudflare/src/functions/deviceApi.ts` had this bug too (every chunked
  upload's final slice would have failed there); fixed 2026-09-01.

**Auth**
- 🛑 **`supabase.auth.signOut()` DEFAULTS TO `scope: 'global'` — it revokes the user's refresh
  tokens on EVERY device (2026-09-16).** The web app called it bare in `AuthProvider.signOut`,
  so logging out of the browser silently signed the user out of the SATE apps on their phone.
  From the phone it looked like a random "logged out after a while": nothing there had done
  anything wrong, its stored refresh token simply stopped existing, and the next refresh came
  back **`refresh_token_not_found`** — note the error, it means the row is GONE (session
  deleted server-side), not "already used" (rotation/reuse), so it points AWAY from the
  client's token handling and at whatever deleted the session. The normal logout is now
  `signOut({ scope: 'local' })` = log out of THIS browser. The one place global is right is a
  password change (`ResetPasswordPage`), which should end other sessions; that one is
  deliberately left bare.
- **The phone never revokes anything server-side.** Mobile `signOut()` only clears
  AsyncStorage, so it cannot cascade to the web or the other app. Keep it that way.
- **An unasked-for sign-out must say why.** `Settings.signedOutReason` is set when a refresh
  fails with a dead token and rendered on the login screen (cleared on the next successful
  sign-in). A session can be ended by something the phone never sees; landing on a login form
  with no explanation is what makes a normal revocation read as the app losing sessions at
  random.
- **Refresh-token rotation is why the refresh path uses synchronous refs, not state.** Supabase
  kills a refresh token the moment it is used; re-spending one is how the app used to sign
  itself out seconds after signing in. `liveRefreshToken`/`tokenRef`/`lastRefreshOk` are refs
  read inside `doRefresh`, with a shared in-flight promise so concurrent 401s make ONE call.
  Don't reintroduce reads of `settings.refreshToken` there — it is a render behind.

**Mobile UI**
- 🛑 **THE APP IS EDGE-TO-EDGE, AND NOTHING HAD A BOTTOM INSET (2026-09-18).**
  `android/gradle.properties` carries `edgeToEdgeEnabled=true` (Android 15 forces it for SDK 35
  targets), so the system status and navigation bars are painted **over** the app rather than
  around it — and `react-native-safe-area-context` was not even a dependency. Every screen's
  `paddingTop: 64` was a hand-rolled TOP inset; there was never a bottom one. On a gesture-nav
  phone that costs a few millimetres and reads as tight padding. On a **three-button** phone it
  swallowed the last control on the screen: the L816 screen's **"Unpair this SATE L816" was
  completely unreachable**, and unpairing is exactly what you need when a recorder is lost,
  broken or being handed on. `src/ui/insets.ts` `useBottomInset(extra)` is the one helper —
  `SafeAreaProvider` wraps both apps in `App.tsx`. Anything whose LAST child is a button or a
  link must use it; a screen that ends in a scrolling list only looks cramped.
  ⚠️ Adding it needed `expo prebuild` + a full native rebuild, so it is a native dependency, not
  a style fix. Test on a three-button phone, not only the gesture-nav Pixel.
- 🛑 **Android's "Bold text" accessibility setting silently CLIPS THE LAST GLYPH of any
  short label (2026-09-16).** `settings get secure font_weight_adjustment` returns `300` on
  the test Pixel. Android then draws every font that much heavier than the metrics React
  Native measured it with, so a `Text` whose content box is sized to its own measured width
  renders one character short — the L816 screen's "Close" button rendered as **"Clos"**.
  Three things make this expensive to diagnose: it looks exactly like a flex overflow (it is
  not — the button's box measured 188px around a word needing ~95), **`font_scale` was 1.0**
  so font scaling is a red herring, and it is invisible on a phone without the setting.
  Padding does not fix it (padding grows the box, not the content box); `flexShrink: 0`,
  `gap` removal and `minWidth` on the PARENT all do nothing. The fix is **`minWidth` on the
  `Text` itself** (plus `textAlign`), or an icon, which has an exact intrinsic size. Any
  short hugging label is affected — the pendant and Plaud connect screens say "Close" the
  same way.

**Dev environment**
- 🛑 **`npm run sate:build` FAILS SILENTLY without `JAVA_HOME` — and then `adb install` happily
  installs the PREVIOUS apk.** There is no JDK on this Mac's PATH (openjdk@17 is brew keg-only)
  and no Android SDK at the usual place, so gradle prints *"Unable to locate a Java Runtime"*,
  the npm script exits, and a `&& adb install …` chained after a pipe still runs. The app then
  launches showing the OLD build, which reads exactly like "my change had no effect" — an hour
  was lost to that here. Export both before any gradle run:
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`.
  **Verify the bundle, don't trust the build log**: `unzip -p <apk> assets/index.android.bundle |
  grep -c '<a string only the new code has>'`. A string the change introduced is the only proof
  the JS was re-bundled; Hermes keeps some literals as UTF-16, so grep both encodings.
- **A MAC-allowlist Wi-Fi looks exactly like a working connection.** A campus/device-registration
  SSID hands out a DHCP lease and then silently drops every packet until the MAC is registered:
  the recorder logs `[CONN] Online (Wi-Fi) - <ip>`, the UI says online, and NOTHING reaches the
  server — `sate_devices.last_seen` just stops advancing. fw >=1.5.34 prints the STA MAC in the
  boot log (`[CONN] serial=… provisioned=… mac=…`) precisely so this is a one-line diagnosis.
  Check `last_seen` on the server before believing "Online".
- **To move a recorder to another network, scan from the DEVICE, not the Mac.** `RecorderBle.
  scan_wifi()` lists what the recorder can actually hear (the Mac's radio and the recorder's
  disagree, and the recorder is 2.4 GHz only). Then `sate provision --wifi "SSID:PASS"` with no
  `--claim-token` = `change_wifi`: keeps the account and device key. ⚠️ BLE only advertises when
  Wi-Fi is DOWN, so a connected-but-useless unit cannot be re-pointed over BLE — stop it
  reaching the bad AP first, or use the `wifi_change` remote command.
- **The dev Mac's LAN IP is dynamic** — a stale IP breaks both app launch and provisioning.
  Check `ipconfig getifaddr en0` first when things "suddenly" can't reach the Mac.

**Features**
- **Mobile-link QR login** (2nd login method): web mints a one-time code/QR, the phone
  consumes it for a real session (`mobile-link` edge fn + `mobile_link_codes` table). Needs
  a native rebuild (expo-camera) + web redeploy (qrcode.react) to change.
- **A flag survives only if every hop carries it.** The flag button's ms offsets are written to
  `sate_device_sessions.flags` at upload — but `device-api`'s session list did not SELECT that
  column until v20, so nothing downstream could see them and a meeting note generated from a
  session silently lost every mark. When adding a consumer of a session, check the column is
  actually in the select; the data being in the row is not the same as it being reachable.
- **Flag markers** are one pipeline shared by SATE hardware (physical flag button) and Plaud
  (device tap): ms offsets → `flags` column → `recordings.flags` → seek-bar ticks on the web
  report. Reuse it; don't fork a parallel path.
- **The SATE Report is generated by the LSA service and SAVED ON THE RECORDING.** The web
  report button (`SateReportPopup.tsx`) converts the on-screen transcript to SALT with the
  existing `segmentsToSalt()`, posts it to `https://sate-lsa-report.ngrok.app/v1/lsa-report`
  (one LLM call, ~20 s) and renders the response. It shipped with the worked example
  hardcoded — one giraffe/elephant transcript and seven invented z-scores for every
  recording — which is why the rule is: nothing in that file is example data any more.
  Three things matter if you touch it:
  - **The service sends NO CORS header and answers a preflight with 405**, so the browser
    cannot call it. The `lsa-report` edge function proxies it (same fix as `childes-norms`)
    and keeps `verify_jwt:true` — childes-norms is public reference data, this carries a
    patient transcript. ~20 s fits the edge limit; the upstream fetch aborts at 120 s.
  - **The generated report lives in `recordings.lsa_report` (jsonb)**, stored WITHOUT the
    response's `latex` (~19 KB the app never reads) and WITH a fingerprint of the analysed
    SALT lines — reopening costs nothing, and an edited transcript marks the report stale
    instead of silently showing a report of something else. Missing column (`42703` /
    `PGRST204`) degrades to "generated but not saved", never to a lost report.
  - **Reference values are OPT-IN, behind the "z-scores vs CHILDES TD" checkbox.** Unticked,
    section 2 is the counts the service parsed (`derived_counts`) under an explicit note.
    Ticked, `lsaMetricsService.ts` computes this sample's MLUm/MLUw/TNW/NDW with
    `calculateSpeechAnalysis` (the app's own canonical metrics function) and pairs MLU with the
    SAME CHILDES query the Analysis tab runs (Eng-NA / narrative / TD), so the two screens
    cannot print different numbers for one recording; TNW/NDW come back `NO REF`. **The norms
    are fetched BEFORE the report** — a norms failure then costs nothing, instead of spending a
    ~20 s LLM call on a document that quietly lacks the comparison that was asked for. ⚠️
    `RightSidebar.tsx` still computes MLU/NDW inline with its own copy of the same logic;
    they agree today, and the next change there should make it consume
    `calculateSpeechAnalysis` rather than leave two implementations in step by luck.
  - **The drafted prose is EDITABLE, and edits are stored beside the response, never over it**
    (`edits` in `recordings.lsa_report`; `mergeEdits()` applies them at render). The footer's
    promise is that the observations are a model's draft that an SLP must review — so the
    reviewer needs somewhere to put the review, every field must revert to what the model
    actually wrote, and a report carrying the clinician's words says so in the footer. Only
    prose is editable: a count or a z-score is computed, not an opinion to correct. Regenerating
    replaces the draft, so it asks first when edits exist.
  - **The age is entered as two number boxes (yr / mo), not the SALT `6;6` string** — that
    notation is the wire format, not something to make a clinician type. A blank month is 0.

## Docs

`doc/` is the numbered project handbook (`08-plaud.md` = Plaud; `14-l816.md` = the L816
handheld; **`12-hardware.md`** = the deep recorder hardware reference + the device↔server API
contract — moved there from the repo root, so it now publishes to the internal docs site). `plaud-integration.md`
(repo root) is the Plaud deep dive. Keep docs current when behavior changes. Deeper /
cross-session context lives in the agent memory at
`~/.claude/projects/-Users-hoanglong-Documents-sate-companion/memory/`.
