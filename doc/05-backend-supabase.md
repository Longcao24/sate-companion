# 05 — Backend (Supabase)

Project **SATE**, ref `zlgdpivcbmaodgokkdvz`, URL
`https://zlgdpivcbmaodgokkdvz.supabase.co`. Postgres + Storage + Edge Functions (Deno). Edge
functions live in `react_app_sate-ui_update/supabase/functions/`.

> **Version anchors (audited 2026-07-24 against the code).** `device-api` is at **v18**
> (in-comment `[v18]` at the top of `device-api/index.ts` — the header/table used to say "v33",
> which was never real; the source has never gone past v18). Recorder firmware is at
> **1.5.32** (`SATE_Recorder/SATE_Recorder.ino` `FIRMWARE_VERSION`). Version numbers drift; the
> file header and `git log` are the source of truth.

## Tables (public schema)

RLS is enabled on all tables. Device routes bypass RLS via the **service role** inside the edge
function (the device authenticates with its device key, not a user JWT; the function does the
owner check itself with an explicit `.eq('user_id', …)` on every query).

There is **no `supabase/migrations/` directory checked into the repo** — the live schema is owned
in the Supabase dashboard/DB. The two authoritative in-repo mirrors of the shape are
`cloudflare/schema.sql` (the D1/SQLite port — types differ, and note it is a *port*, so it lags:
it does **not** carry the async state-machine columns; see the ⚠️ below) and the columns the edge
functions actually read/write. What follows is reconstructed from those.

| Table | Role |
|-------|------|
| `recordings` | **The clinical result.** `transcript` / `error_counts` / `analysis` / `flags` / `flag_notes` (jsonb), `patient_id → patients(id)`, `user_id`, `file_path`, `file_name`, `file_size`, `duration`, `recording_name`, `protocol`, `notes`, `needs_review`, `segments_edited`. The web report reads this; a device upload writes here **identically** to a manual web upload. |
| `patients` | Clinical patients. `slp_id → users(id)`, name/DOB/diagnosis/etc., and **`device_patient_id text`** which links a recorder's text patient id (e.g. `"PT-2001"`) to a clinical patient row. Indexed on `(slp_id, device_patient_id)`. |
| `sate_devices` | Registered recorders. Columns: `id` (`dev-<serial>`), `user_id` (owner), `name`, `serial`, `fw`, `online`, `ip`, `last_seen`, `pending_sessions`, `state`, `slp`, `slp_id`, `ota_state`, `battery_pct`, `battery_mv`, `total_recordings`, `created_at`. |
| `sate_device_sessions` | Raw uploaded device sessions + the **async processing state machine** (see below). |
| `sate_device_patients` | Device roster ↔ clinical patient bridge: `user_id`, `patient_id` (text), `name`, `age`, `session_type`, `clinician`, **`clinical_patient_id → patients(id)`**. Unique on `(user_id, patient_id)` — the `sendCommand`/`replacePatients` upsert relies on that constraint. |
| `sate_device_commands` | Remote command queue the device polls. `device_id`, `op`, `patient` (jsonb — also carries OTA `{url,version}` and the v17 `{seconds}` payload), `consumed`, `created_at`. |
| `sate_claim_tokens` | One-time provisioning tokens: `token` (`claim-xxxxxxxx`), `user_id`, `user_name`, `used`. Minted by the app, consumed at register. |
| `sate_firmware` | OTA release rows: `version`, `url` (public bucket URL), `notes`, `created_at`. `getLatestFirmware` orders by `created_at` desc, so the newest row wins. |
| `sate_admins` | Admin allowlist **by email** (`email` PK). The entire `/admin/*` surface is gated on membership here. |
| `subscriptions`, `payments`, `stripe_customers`, `stripe_webhook_events` | Stripe billing. |
| `invite_codes`, `invite_code_usage` | Invite/access codes. |
| `mobile_link_codes` | One-time QR/code phone-login codes (see `mobile-link`). |

### `sate_device_sessions` — the columns that matter

Two generations of columns coexist on this table:

- **Upload identity + payload:** `id` (`s-xxxxxxxx`), `user_id`, `device_serial`, `patient_id`
  (text, default `'PT'`), `session_number` (int), `sample_rate` (default 16000), `bytes`,
  `storage_path` (`<user>/<serial>/<sessionId>.wav` in `device-sessions`), `flags` (jsonb: ms
  offsets), `created_at`.
- **Legacy processing flags (still written for compatibility):** `processed` (bool),
  `processed_at`, `recording_id → recordings(id)`, `process_error`, `no_text` (bool).
- **Async state machine (the live path — added by the `async_processor_state_machine` migration):**
  **`status`** (`queued | processing | done | error`, default `queued`), **`attempts`**,
  **`processing_started_at`**. New rows are `queued` by column default. These are what
  `device-api`, `healthAlerts`, `adminStatus`, and the Cloudflare container read/write.

Idempotency key: `(user_id, device_serial, patient_id, session_number, bytes)` — the tuple the
uploader's dedup probe in `storeSessionRecord` matches on (the chunk final-slice probe omits
`patient_id`). ⚠️ **There is no DB *unique* constraint on it yet** — that probe (plus an
`objectExists` check) is the only guard against a duplicate row.

> ⚠️ **The D1 port (`cloudflare/schema.sql`) is behind.** Its `sate_device_sessions` has only
> `processed / processed_at / process_error / no_text` — **not** `status / attempts /
> processing_started_at`. The async pipeline lives on Supabase only; do not treat the D1 schema as
> the source of truth for processing state.

## Edge functions

| Function | in repo? | `verify_jwt` | Role |
|----------|----------|--------------|------|
| `device-api` | ✅ `functions/device-api/index.ts` | **false** | The device + app REST surface (**v18**). Routes by auth header: device key (`Bearer key-…`) vs SLP user JWT. |
| `process-device-session` | ✅ `functions/process-device-session/` | **false** | ⚠️ **Must be a 200 NO-OP in prod.** `device-api` still fire-and-forgets to it, but it must NOT process, or it races the container and duplicates `recordings`. **See the ⚠️ audit note below — the repo copy is NOT the no-op.** |
| `finalize-session` | ❌ **deployed only, not in the repo tree** | **false** | The **light half** of device processing: resolve patient → `countErrors` + `calculateSpeechAnalysis` → INSERT `recordings` → set `status=done`. The Cloudflare container calls it (`FINALIZE_URL`) after it holds the long AI call. Present in prod; do not be surprised it's absent from `functions/`. |
| `mint-plaud-token` | ✅ | **false** | 2-step Plaud OAuth server-side → Plaud `user_id` token (see `plaud-integration.md`). |
| `mobile-link` | ✅ | **false** | Mints/consumes one-time QR/code for phone login (`mobile_link_codes`). |
| `create-checkout-session`, `create-portal-session`, `cancel-subscription`, `get-invoices`, `stripe-webhook` | ✅ | — | Stripe billing. |

> **The long AI transcription lives in NO edge function.** It runs in a long-lived **Cloudflare
> Container** (`cf-processor/`, Python `app/processor.py`, `sate-processor.longcao.workers.dev`)
> that has no serverless wall-clock. It claims `queued` sessions (`claim_next_session`, SKIP
> LOCKED), holds the ngrok `/process` call, copies the audio into `recordings`, then POSTs
> `finalize-session`. `pg_cron` pings the Worker `/tick` every minute to keep the container warm.
> Constants (`app/processor.py`): `AI_READ_TIMEOUT_S=3600` (1 h read ceiling on one AI call),
> `STUCK_MINUTES=90` (watchdog requeue threshold — must exceed the 60-min AI read ceiling),
> `MAX_AUDIO_SEC=14400`, `MAX_ATTEMPTS=3`, `POLL_INTERVAL=10`.
> **Never move the AI call into an edge fn or a Worker `fetch`** — Supabase edge has a hard ~150 s
> wall-clock (not a timeout we set; it kills the worker *before* the `try/catch`), and a plain CF
> Worker has the ~100 s 524 origin timeout. Either kills a long transcription mid-call and leaves
> the session stuck in `processing` forever. See [06-ai-pipeline.md](06-ai-pipeline.md).

**`verify_jwt` MUST stay `false`** on `device-api` / `finalize-session` / `process-device-session`
/ `mint-plaud-token`: the **device** has no Supabase user JWT — it presents a device key
(`Bearer key-<device-id>`) that the function validates itself. Redeploying with the Supabase
CLI/MCP default of `verify_jwt:true` makes the gateway reject the device key before the function
runs → recorder registration fails ("Setup link expired") and the pipeline / Plaud minting break.
Always deploy with `--no-verify-jwt` (CLI) / `verify_jwt:false` (MCP). The Supabase edge
**gateway** still requires the public `apikey` header on every call regardless.

## `device-api` — routing model

`device-api/index.ts` is one `serve()` handler doing internal path routing. The path is matched
with `/\/device-api(\/.*)?$/`; the leading **`/api` prefix is then stripped** (`/api/sessions/chunk`
→ `/sessions/chunk`), so firmware's mock-server-style `/api/*` paths and bare `/*` paths both work.
The **auth header decides the branch**, and the device-key branches are checked **before** the user
JWT is ever fetched:

- `Authorization: Bearer key-<device-id>` → device-key branch (recorder). The device id is the
  literal suffix; the row is looked up in `sate_devices` by `id`.
- `Authorization: Bearer <supabase-jwt>` → `supabase.auth.getUser(token)`; a failure is `401`.
- No auth needed: `/register`, and `/health/alerts` (shared-secret query param instead).

CORS: `Access-Control-Allow-Methods` explicitly lists `DELETE` and `PATCH` (not CORS-safelisted),
or the browser preflight fails with "Failed to fetch".

### Device-key routes (`Bearer key-…`)

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/register` or `/devices/register` | POST | `handleDeviceRegister` | Validate a `claim_token` (unused row in `sate_claim_tokens`), upsert `sate_devices` (`id=dev-<serial>`), mark the token used, return `{ device_id, device_key: "key-<id>", slp, slp_id }`. `claim_token` is required; there is no other registration path. |
| `/devices/:id/commands` | GET | `handleDeviceHeartbeat` | The heartbeat + command poll (see below). |
| `/sessions`, `/sessions/raw`, `/sessions/chunk` | POST | `handleSessionUpload` | Upload a take. `/sessions` = base64 JSON body; `/sessions/raw` = raw body + query meta; `/sessions/chunk` = the chunked assembler (`?offset=&final=&total=&session_number=&patient_id=&device_serial=&sample_rate=&flags=`). |
| `/sessions/verify` | GET | `handleSessionVerify` | **Read-only** verified-storage gate (see below). |
| `/patients` | GET | inline → `listPatients` | Device fetches its owner's roster with its device key; the handler resolves the device's `user_id` from `sate_devices`, then returns that user's `sate_device_patients` (optional `?slp=` filters on `clinician`). |

The device-key session routes are also matched **only** when the header starts with `Bearer key-`;
otherwise a `POST /sessions` falls through to the user-JWT variant (Plaud/phone uploads).

### The heartbeat / command poll (`GET /devices/:id/commands`)

`handleDeviceHeartbeat` is the recorder's once-every-heartbeat call. It:

1. If the row is **gone** (SLP removed the device), returns `{ unclaimed: true, commands: [] }` —
   the **only** server path that tells a recorder to reset to first-time setup. (Holding BOOT only
   re-provisions Wi-Fi now; it does not unclaim.)
2. Updates `online:true`, `last_seen:now`, and, from query params if present: `pending_sessions`
   (`?pending=`), `state` (`?state=`), `fw` (`?fw=`), `ota_state` (`?ota=`).
3. Reads unconsumed `sate_device_commands` (oldest first), marks them `consumed`, and returns:
   ```json
   { "commands": ["record", …],
     "active_patient": <record cmd's patient jsonb | null>,
     "record_seconds": <record cmd payload .seconds | null>,   // [v17] exact-duration take
     "ota": <ota cmd's {url,version} | null> }
   ```

`listDevices` and the admin/health readers also lazily flip a device `online:false, state:'idle'`
when `last_seen` is older than **45 s** (the offline rule), so a dead recorder drops off without
its own cooperation.

### `[v17]` timed record — `{ seconds: N }`

A `record` command may carry an exact duration. When the app `POST`s
`/devices/:id/commands` with `{ op:"record", seconds:N }`, `sendCommand` writes `seconds` into the
jsonb `patient` payload col (the same column `ota` reuses), and the heartbeat surfaces it as
`record_seconds`. The **firmware stops the take itself at exactly N seconds of PCM** (sample-exact)
instead of the caller racing a `stop` through the poll channel (+3–12 s of slop). Because the
firmware ignores a patient payload with no `patient_id`, a bare `{seconds}` cannot accidentally set
an active patient.

### SLP user-JWT routes

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `/devices` | GET | `listDevices` | List the caller's devices (flips stale rows offline first). |
| `/devices/claim-token` | POST | `createClaimToken` | Mint a one-time `claim-xxxxxxxx` token. |
| `/devices/:id/commands` | POST | `sendCommand` | Queue a remote command (`record`/`stop`/`reboot`/`ota`/…); optional `{patient}` / `{seconds}`. Upserts the roster row when `patient.patient_id` is present. |
| `/devices/:id/commands` | GET | `handleDeviceHeartbeatUser` | Owner-scoped heartbeat read (delegates to `handleDeviceHeartbeat` after an ownership check). |
| `/devices/:id` | PATCH | `renameDevice` | Rename. |
| `/devices/:id` | DELETE | `removeDevice` | Unlink (owner-scoped). |
| `/firmware/latest` | GET | `getLatestFirmware` | Newest `sate_firmware` row. |
| `/firmware` | POST | `publishFirmware` | Publish an OTA release. ⚠️ **see the admin-gap note.** |
| `/patients` | GET / PUT | `listPatients` / `replacePatients` | Roster read / full replace. |
| `/sessions` | POST | `storeSessionRecord` | **User-authed** upload for a device with no device key — a **Plaud** recorder (never in `sate_devices`) or a BLE-bridged SATE session. Stored under `user.id`; `device_serial` defaults to `'plaud'`. |
| `/sessions` | GET | `listSessions` | Last 20 sessions (optional `?device=`), returning `status` + `attempts` alongside the legacy `processed`/`process_error`/`no_text`, plus `at` (alias of `created_at`). |
| `/sessions/upload-progress` | GET | `uploadProgress` | **[v16]** Live bytes of an in-flight chunked upload (see below). |
| `/sessions/:id/audio` | GET | `getSessionAudio` | 302-redirect to a 1-hour signed URL for the stored WAV. |
| `/sessions/:id/retry` | POST | `retrySession` | **[v14]** Re-queue an `error` session (`status→queued`, `process_error→null`, `attempts→0`). Only an `error` session may be retried (else `409`). |
| `/sessions/:id` | DELETE | `deleteSession` | Delete one session row + its stored WAV (owner-scoped). A linked `recordings` row is left intact. |

### Admin routes (`/admin/*`, gated by `sate_admins`)

Everything under `/admin` first resolves `isAdmin(user.email)` against `sate_admins`. `/admin/me`
returns `{isAdmin}` for anyone; every other admin route `403`s a non-admin. These span **all**
users, so the gate is load-bearing.

| Route | Method | Handler |
|-------|--------|---------|
| `/admin/me` | GET | membership check, always allowed |
| `/admin/status` | GET | `adminStatus` — pipeline head counts per `status`, stuck list, recent errors, fleet + `fw_breakdown`, firmware, `recordings_total`. |
| `/admin/devices` | GET | `adminListDevices` (+ `owner_email` via `ownerEmailMap`) |
| `/admin/firmware` | GET | `adminListFirmware` |
| `/admin/firmware/:id` | DELETE | `adminDeleteFirmware` (removes the `.bin` from Storage too) |
| `/admin/devices/:id` | DELETE | `adminDeleteDevice` (no `user_id` filter — admin can unlink any device; the recorder learns via `{unclaimed:true}`) |

> ⚠️ **Known gap (audit 2026-07-22, still open).** `POST /firmware` (`publishFirmware`) is routed
> **above** the `/admin` `isAdmin()` gate, so **any authenticated user can push fleet-wide OTA**.
> `publishFirmware` now validates the image (plain semver, `0xE9` ESP32 magic byte, `≥1 KB` and
> `≤4 MB`) but it still needs an `isAdmin()` gate. Same gap in the Cloudflare port. Fix before GA.

### `[v18]` `GET /health/alerts` — the error-alert digest

`GET /health/alerts?key=<secret>` (no user JWT; gated by a shared secret `HEALTH_ALERT_KEY` —
missing or mismatched → `403`). Read-only, service role. `healthAlerts` returns a compact digest:
`error_count` (sessions with `status='error'`), `stuck_count` + `stuck_list` (still `processing`
past the 90-min `STUCK_MS` threshold — keep it equal to cf-processor's `STUCK_MINUTES`, or this
emails the operator about jobs that are simply still running), `recent_errors` (last 10 error rows), `offline_devices`
(flips stale rows offline first), plus a **`signature`** — a stable JSON of the current problem set
so the caller only emails on a *change*.

The consumer is the **status Worker** (`status/src/worker.js`): every probe cycle it fetches
`…/device-api/api/health/alerts?key=$HEALTH_ALERT_KEY`, dedups on the `signature`, and emails the
operator (`caothohoanglong2404@gmail.com`) via Cloudflare Email on a **new** problem set and once
more with an "All clear" when it resolves. This is the system-wide error-email path.

## Session upload — chunk assembly (`/sessions/chunk`, v12+)

`handleSessionUpload` for `/sessions/chunk` stores each firmware ~1 MB slice as its **own object**
at `<device>/_tmp/<patient>/s<n>/<zero-padded-offset>.part`, then stitches once on `final=1`.
Flow on the final slice: confirm an existing byte-exact row isn't already stored (idempotency);
list the parts; verify they form one **gap-free** stream *from the listed sizes first* (before
downloading a byte); verify `assembledLen == total` when the firmware sent `&total=` (≥1.5.9);
allocate the buffer **once** and stream parts into place in **parallel batches of 8**
(`DL_CONCURRENCY`); `patchWavHeader` (RIFF size @4, data size @40); `storeSessionRecord`; and only
**then** delete the parts.

Rules that are load-bearing — an earlier version broke each one and it cost recordings:

- **Never rewrite a whole temp blob per slice.** v11 downloaded + re-uploaded the entire blob on
  every slice: quadratic, so a 30-min session pushed ~1.5 GB through the function and the late
  slices blew past the firmware's 12 s timeout. Each timeout restarted at offset 0, which truncated
  the blob back to the first slice — a backlog that could never drain ("8 recordings uploading, no
  progress"). Per-part objects make each slice O(1); the full file materialises once, on final.
- **`offset=0` purges the part dir first.** offset 0 = the device is (re)starting this session, so
  anything already in `s<n>` is from an abandoned attempt and must go, or a stale *higher*-offset
  part survives and gets stitched onto the new upload. ⚠️ **Doc correction:** the *rationale* here
  is no longer "sessions are renumbered on delete" (the in-code comment still says that, and it is
  stale). **Sessions are NEVER renumbered (fw ≥1.5.20)** — numbers are allocated monotonically and
  **wrap at 99**, holes are legal. A given `s<n>` can still be *reused later* (after a delete +
  wrap), so purging an abandoned attempt's parts before a fresh take remains necessary; the guard
  is correct, only the comment's explanation is outdated.
- **Part dir is scoped by patient.** Session numbers restart at 1 per patient, so `s1` alone
  collides between two patients on the same device and a resume could stitch a WAV out of BOTH
  patients' audio. `patient_id` is sanitised (`[^A-Za-z0-9_-]` stripped) because it's a storage path.
- **A gap → `409`, not a corrupt WAV.** A missing/overlapping offset means the device and the
  function disagree about what landed; the function `409`s and the device restarts the session from 0.
- **`total=` mismatch → `409`** (firmware ≥1.5.9): assembled length must equal the device's declared
  total or the take is rejected before it's stored.
- **The final-slice idempotency probe checks the OBJECT, not just the row.** Assembling a long take
  takes a while and the device gives up after 60 s; if it times out on a final that actually
  succeeded, it retries the final — but the parts are gone (removed on success), so a naive
  contiguity check would `409` and force a full re-upload (~9 min for a 118 MB take, never
  converging). Instead: look up the byte-exact row and confirm its storage object really exists
  (`objectExists`) — if real, return `{id, idempotent:true}` (a lost ACK becomes a no-op); if the
  row is a **ghost** (object never landed — the 413 class), **delete it** and re-store.

## `storeSessionRecord` — the shared store path

Every upload path (chunk final, `/sessions/raw`, `/sessions` device-key, `/sessions` user-JWT)
converges here. It:

1. **Idempotency probe:** look up an existing row by the natural identity
   `(user_id, device_serial, patient_id, session_number, bytes)` and confirm the storage object
   exists. If genuinely stored → return `{id, idempotent:true}` (dedups a re-uploaded take after a
   lost BLE `mark_synced` ACK or a user double-tap-Sync). If a ghost row → delete it and continue.
   ⚠️ There is **no DB unique-constraint backstop** — this probe is the only guard.
2. Upload the WAV to `device-sessions` at `<user>/<serial>/<sessionId>.wav`. **A failed upload
   THROWS** — it must never `console.error` and insert the row anyway. That old bug returned 2xx on
   a rejected upload, so the recorder marked the take synced (and pre-1.5.9 deleted its only copy)
   while the server held a row pointing at nothing — how a 118 MB take once hit Storage's 413 and
   was lost.
3. Insert the `sate_device_sessions` row (`status` defaults to `queued`).
4. `triggerProcessor(sessionId)` — fire-and-forget `POST` to `process-device-session`, kept alive
   past the response with `EdgeRuntime.waitUntil`, so the device's HTTP POST returns immediately.
   (This is now a no-op call; the container is what actually processes. The cron sweep is the
   fallback if the trigger is ever dropped.)

## `GET /sessions/verify` — the verified-storage gate (device-key, read-only)

`handleSessionVerify` answers "is session N with exactly B bytes durably stored?" for the
recorder's **SD-audio reclaim** gate (fw ≥1.5.13 verified trim). Query:
`?session_number=&bytes=[&patient_id=&device_serial=]`. It resolves the device's `user_id`/`serial`
from the `Bearer key-` id, finds the byte-exact `sate_device_sessions` row, and returns
**`{ stored: true }` only when the row exists AND `objectExists` confirms the storage object is
really present.** A row alone is not proof — the 413 bug once left ghost rows, and trusting one
would let the recorder free its only copy of the audio.

**It must never mutate.** Ghost-row cleanup is owned by the chunk-final / `storeSessionRecord`
idempotency probes; this endpoint is deliberately read-only. The recorder's `trimPatientSyncedAudio()`
keeps the newest `KEEP_AUDIO_SESSIONS` (=5) device-wide, and frees only synced **and** verified
audio; any doubt (offline, non-2xx, parse fail, byte mismatch) keeps the audio and retries next
cycle. See [02-firmware.md](02-firmware.md) and [07-runbook.md](07-runbook.md).

## `[v16] GET /sessions/upload-progress` — live in-flight bytes

`uploadProgress(user, ?device_serial=)` reports a chunked upload while it is still streaming. The
session row only exists after the final stitch, so mid-upload the **only** server-side truth is the
`_tmp/<patient>/s<n>/<offset>.part` objects. It walks that tree (user must own the device), sums
the parts, and returns `{ uploading, uploads:[{patient_id, session_number, parts, bytes,
last_activity}] }`. Two subtleties: only parts touched in the **last 10 minutes** count (a real
31 MB *orphan* dir in prod must not read as "uploading"), and the list is sorted by most-recent
activity (session numbers restart per patient, so number order is meaningless). The device knows
the total; the server doesn't — callers show bytes + rate, not a percentage.

## Processing a device session (ASYNC — container + `finalize-session`)

`process-device-session` is a **200 no-op** in prod (don't revive it). The work is split so the
long AI call lives in a process with no wall-clock:

**Cloudflare container** (`cf-processor/app/processor.py`, long-lived) — per `queued` session:

1. `requeue_stale()` watchdog first (`requeue_stale_sessions` RPC — reclaim jobs a dead worker left
   in `processing` past `STUCK_MINUTES=90`, up to `MAX_ATTEMPTS=3`, else → `error`).
2. `claim_next()` (`claim_next_session` RPC, atomic, SKIP LOCKED) → `status=processing`.
3. `download_wav` from `device-sessions` (15-min read ceiling).
4. **HOLD** the AI `/process` POST (multipart `audio_file`, `device=cuda`, `pause_threshold=0.25`)
   — the long transcription, `AI_READ_TIMEOUT_S=3600`.
5. If there's usable speech: `upload_recording` copies the WAV into the `recordings` bucket, then
   `finalize()` POSTs `finalize-session` with `{session_id, transcript, rec_path, file_name,
   file_size}`. No-speech takes call `finalize({session_id, no_text:true})`.
6. Failure classification: `Transient` (network / `408`/`429`/`5xx` / ngrok down) → `requeue_session`
   with backoff up to `MAX_ATTEMPTS`, then `fail_session`; `Permanent` (`4xx`, no segments) →
   `fail_session` immediately. **`fail_session` never deletes the device audio.**

**`finalize-session`** (deployed-only edge fn, the light half, fits the 150 s limit): resolve the
patient (`sate_device_patients.clinical_patient_id`, else `patients` matched on
`slp_id + device_patient_id`, else `null` = Standalone — never fabricate a patient), run
`countErrors` + `calculateSpeechAnalysis` (identical to the web app), INSERT `recordings`, set
`status=done` + `recording_id`. See [06-ai-pipeline.md](06-ai-pipeline.md).

The RPCs `claim_next_session` / `requeue_stale_sessions` / `requeue_session` / `fail_session` are
defined **in the Supabase DB**, not checked into the repo. `pg_cron` pings the Worker `/tick` every
minute to keep the container warm.

> ⚠️ **Audit 2026-07-22 (still true 07-24): the `process-device-session` copy checked into the repo
> is NOT the no-op.** `functions/process-device-session/index.ts` still downloads the WAV, `await`s
> `AI_PROCESS_URL` (default `https://sate-v1-5.ngrok.io/process`) synchronously, and inserts into
> `recordings` — filtering on `processed=false` while the container claims on `status`, so **both**
> would process the same session (→ duplicate recordings + the 150 s edge-kill hang). **Prod is
> deployed as the no-op; do NOT deploy the repo file as-is.** Make it a real early-return before GA.
> It still supports `PROCESSOR_SECRET` as an alternate to the service-role key in the `Authorization`
> header — irrelevant once it's a true no-op.

## Storage buckets

| Bucket | Visibility | Holds |
|--------|------------|-------|
| `device-sessions` | private | Raw device-uploaded WAVs (`<user>/<serial>/<id>.wav`) + `_tmp/<patient>/s<n>/*.part` chunk parts |
| `recordings` | private | Final WAVs backing `recordings` rows (manual + device) |
| `firmware` | public | OTA `.bin` releases (`sate_<version>.bin`) |
| `mobile` | public | Mobile uploads |

### ⚠️ Two file-size limits, and the BUCKET's is the one that bit us

There are two, and **whichever is smaller wins** — so checking only one is how the wrong one gets
blamed:

| Where | Read it with | Value (2026-09-16) |
|---|---|---|
| Project-wide | Management API `GET /v1/projects/<ref>/config/storage` → `fileSizeLimit` | **5 GB** |
| Per bucket | Storage API `GET /storage/v1/bucket/device-sessions` → `file_size_limit` | **5 GB** |

This document used to say the project limit *overrides* the bucket's. **That is backwards.**
Measured empirically: with the project already at 500 MB, uploads failed at exactly **200 MiB**
(`413 EntityTooLarge`, "The object exceeded the maximum allowed size") — the bucket's own limit.
Both were raised to 5 GB (~43 h of 16 kHz mono) and an 8 h / 922 MB take then uploaded and
registered. 5 GB is a **bound, not "off"**: far past anything the hardware can produce, still small
enough that a bug cannot write a 50 GB object.

Probe the real ceiling by bisecting actual PUTs rather than trusting either number.

**The older, worse failure this section was written for** is still the reason to check here first:
a 413 was once *swallowed* by `storeSessionRecord`, the row was inserted anyway, the device got a
2xx and marked the session synced — a 62-minute recording lost to a silent limit plus a swallowed
error. The upload now **throws**. If large sessions land as rows with
`process_error: "download failed: Object not found"`, this limit is still the first thing to check.

## Uploading a take from the PHONE — three routes, one of them with no ceiling

The recorder has its own device key and uses `/sessions/chunk` (see above). Hardware that has **no
`sate_devices` row and no device key** — the L816/L815 handhelds, the pendant, Plaud — uploads
through the phone as a signed-in *user*, and that path has its own history worth knowing.

| Route | Auth | Ceiling | Use |
|---|---|---|---|
| `POST /sessions` (`wav_base64` in JSON) | user JWT | ~62 min | short takes |
| `POST /sessions/chunk` `[v26]` | user JWT **or** device key | assembly holds one copy | firmware; available to the phone |
| `POST /sessions/upload-url` + `/sessions/register` `[v27]` | user JWT | **none in this tier** | anything long |

**`[v26]` The single-shot route was killing the function on long takes.** Three innocent lines —
`await req.json()`, destructure, `Uint8Array.from(atob(...))` — hold **four copies at once**: the
raw request text, the parsed object's copy of the base64 string, the binary string `atob` returns,
and the byte array. Ten minutes of 16 kHz mono is ~19 MB of PCM and ~26 MB base64'd, so that is
upwards of 100 MB for 19 MB of audio, and the worker is killed **part-way through** with
**HTTP 546 `WORKER_RESOURCE_LIMIT` — "Function failed due to not having enough compute resources"**.

🛑 **That message says *compute*, so it reads as an AI/model problem.** It is not: it is this
function running out of **memory**. Worth recognising on sight — it sent a whole investigation at
Workers AI, which this project calls in exactly one place (`sate-notes`), where nothing had failed.

`readSessionBody` now **streams** the body: metadata is collected as text (it is tiny) and the
base64 value is decoded four characters at a time straight into one pre-sized buffer, so peak
memory is the audio once. Measured against the deployed function: 1 / 5 / 10 / 20 / 40 min and
**62 min (119 MB WAV, 159 MB body) all 200**, 9 s at 62 min. **90 min is a 502 at the gateway** —
above the function entirely, so no server code moves it.

**`[v27]` Which is why the bytes stop coming through at all.** `POST /sessions/upload-url` returns a
signed Storage URL **at the take's final path** (the session id is issued then, so nothing is copied
or moved afterwards); the client PUTs the WAV straight into Storage; `POST /sessions/register`
writes the row. The function only ever handles metadata.

Two guards, both easy to leave out and both verified:

- **`storage_path` is confined to the caller's own `<user id>/` prefix.** The caller names the path,
  so the caller could name *any* path — without this a signed-in user could register another
  account's audio as their own session. The signed URL only permits writes there, but this route
  must not depend on that having been the way in. (Three out-of-prefix paths → three 403s.)
- **The byte count comes from Storage, never from the client**, and a path with no object gets a
  **409 instead of a row**. A row whose object is not really there is the ghost the old 413 bug left
  behind, and it strands the recording on the device for ever.

Parts on the chunk path are rooted at `u_<user id>` for the same reason, never at a caller-supplied
serial.

## Migrations (no `migrations/` dir in the repo — DB-owned)

- **`device_to_recordings_bridge`** (additive): `patients.device_patient_id text` (+ index on
  `slp_id, device_patient_id`); `sate_device_patients.clinical_patient_id uuid → patients(id)`;
  `sate_device_sessions.{ recording_id, processed, processed_at, process_error }` (+ later `no_text`,
  `flags`).
- **`async_processor_state_machine`** (additive): `sate_device_sessions.{ status, attempts,
  processing_started_at }` with `status` defaulting to `queued`; and the container RPCs
  `claim_next_session` / `requeue_stale_sessions` / `requeue_session` / `fail_session`. This is the
  live processing path; the older `processed*` columns are still written for compatibility.

## Secrets / config

- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — server-side, used by every edge fn for DB/storage.
- `AI_PROCESS_URL` — the AI `/process` endpoint (default in `process-device-session`:
  `https://sate-v1-5.ngrok.io/process`; the container reads it from its own env).
- `HEALTH_ALERT_KEY` — the shared secret gating `GET /health/alerts` (must match the status Worker).
- `PROCESSOR_SECRET` — legacy alternate auth for `process-device-session` (moot once it's a no-op).
- `FINALIZE_URL`, `STUCK_MINUTES`, `MAX_ATTEMPTS`, `AI_READ_TIMEOUT_S`, `POLL_INTERVAL`,
  `WORKER_ID` — the container's env (`cf-processor`).

## Known stale code

- `process-mobile-uploads` — an earlier mobile-path function using **wrong columns**
  (`transcript_data`, `issue_counts`) that are not the live `recordings` schema (`transcript`,
  `error_counts`). Do not model new work on it; `finalize-session` is the correct reference.
- The repo `process-device-session/index.ts` — see the ⚠️ above; the checked-in copy is the old
  synchronous processor, not the deployed no-op.
- The in-code `offset=0` purge comment in `device-api` still claims "sessions are renumbered when the
  SLP deletes one" — stale wording (no-renumber since fw 1.5.20); the guard itself is still correct.
