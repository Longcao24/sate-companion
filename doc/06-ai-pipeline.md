# 06 — AI pipeline

Turns a WAV into a clinical `recordings` row. The **device path and the manual web-upload path
run the same AI and the same analysis**, so a device recording is indistinguishable from a
hand-uploaded one in the app.

The device half is the async processor in **`cf-processor/`** — a Cloudflare Worker (thin trigger)
plus a long-lived Cloudflare Container (a Python poll loop). This doc is the source of truth for that
loop, its constants, and its failure handling. See [05-backend-supabase.md](05-backend-supabase.md)
for the edge functions and the `sate_device_sessions` table, and [07-runbook.md](07-runbook.md) for
operational recovery.

## ⚠️ The AI call is ASYNC — never run it from an edge function

**The long transcription MUST run in a long-lived process, NOT in a serverless request.** Supabase
edge has a hard ~150 s wall-clock (not configurable); a plain Cloudflare Worker has a ~100 s origin
timeout (524). Either one **kills the worker mid-`fetch`, before your `try/catch`**, on a long take —
so `process_error` is never written and the session hangs in `processing` forever. A 32-min take once
showed 70 min stuck (edge kill → cron retry → kill …). The AI is not slow; the request just can't
hold the call. This is the single most important rule in the pipeline.

## Architecture (state machine + Cloudflare Container)

Processing is a state machine on `sate_device_sessions.status`:
`queued → processing → done | error` (`no_text` sessions finalize to `done` with no `recordings`
row). Columns added by the `async_processor_state_machine` migration:
`status`, `processing_started_at`, `attempts`, `worker_id`, `heartbeat_at`. New rows default to
**`queued`** (a column default, so `device-api` needs no change to enqueue).

```
device-api  → assemble chunks → INSERT sate_device_sessions (status=queued)
                     │           └─ fire-and-forgets process-device-session (a NO-OP in prod)
                     │
pg_cron /tick (1/min)│ POST /tick (Bearer TICK_SECRET) → Worker wakes the container
                     ▼
Cloudflare Container (cf-processor/, Python, sate-processor.<subdomain>.workers.dev)  ← long-lived, NO wall-clock
  loop() every POLL_INTERVAL (10 s):
    requeue_stale_sessions()  in-loop watchdog: reclaim jobs a dead/recycled worker left in 'processing'
    claim_next_session()      atomic, SKIP LOCKED  → status=processing, returns the oldest queued row
     → download_wav()   GET  device-sessions/<storage_path>          (connect 30 s, read 900 s)
     → call_ai()        POST AI_PROCESS_URL  (the long transcription) (connect 30 s, read 3600 s) → { segments }
     → (no speech?) finalize({no_text:true}) → done, no recording
     → upload_recording() POST recordings/<user_id>/<ms>_<file>.wav  (connect 30 s, read ∞)
     → finalize()       POST FINALIZE_URL (finalize-session edge)     (total 120 s)  ← the LIGHT half
          finalize-session: countErrors + calculateSpeechAnalysis → INSERT recordings → status=done
     → on Transient: requeue_session() with backoff (up to MAX_ATTEMPTS); on Permanent: fail_session() → error
```

### The pieces (real files & symbols)

- **`cf-processor/src/index.ts`** — the Worker + Container Durable Object (`ProcessorContainer`,
  `defaultPort = 8080`, `sleepAfter = '20m'`). The Worker **does no processing and never waits on the
  AI**. Two routes:
  - `GET /health` — unauthenticated `{ ok: true }`.
  - `POST /tick` — auth: `Authorization: Bearer <TICK_SECRET>` (401 otherwise). Calls
    `getContainer(env.PROCESSOR).fetch('http://container/health')` to boot/keep-warm the **singleton**
    container. A boot-in-progress error is swallowed as `{ ok: true, note: 'container waking' }` — the
    next tick picks it up.
  - The DO constructor injects the Python env vars (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
    `AI_PROCESS_URL`, `FINALIZE_URL`, `STUCK_MINUTES`, `MAX_ATTEMPTS`, `POLL_INTERVAL`, `WORKER_ID`).
- **`cf-processor/app/main.py`** — container entrypoint. Starts `processor.loop()` in a **daemon
  thread**, then serves a trivial `HTTPServer` on `$PORT` (8080) that returns `{"ok":true}` to any GET.
  The HTTP server exists only so the Worker's `/health` fetch resets the container's idle timer; **all
  real work is in the loop, not in a request handler**.
- **`cf-processor/app/processor.py`** — the poll loop, the AI call, storage I/O, and the retry state
  machine. Everything below lives here unless noted.
- **`cf-processor/Dockerfile`** — `python:3.12-slim`, `pip install -r app/requirements.txt`,
  `CMD ["python", "main.py"]`.
- **`cf-processor/wrangler.toml`** — `name = "sate-processor"`, `compatibility_date = "2025-06-01"`,
  `compatibility_flags = ["nodejs_compat"]`. One container: `[[containers]] class_name =
  "ProcessorContainer", image = "./Dockerfile", max_instances = 1, instance_type = "standard-1"`.
  Non-secret `[vars]`: `SUPABASE_URL`, `FINALIZE_URL`, `STUCK_MINUTES=45`, `MAX_ATTEMPTS=3`,
  `POLL_INTERVAL=10`, `WORKER_ID=cf-container-1`. `[observability] enabled = true`.

### Why a single container / single worker

`max_instances = 1` and one internal worker thread: GPU concurrency on the AI box is 1 anyway, and the
loop drains the queue **serially**. `claim_next_session()` uses `SELECT … FOR UPDATE SKIP LOCKED`, so
even if a second instance ever existed it could not double-claim a row.

### `pg_cron` keeps it warm — it is NOT a separate watchdog service

`pg_cron` runs every minute (`'* * * * *'`) and `net.http_post`s the Worker `/tick` with
`Authorization: Bearer <TICK_SECRET>` (the deployed secret is `SATE_2026`). That single fetch boots the
container if it slept and resets its idle timer. If ticks ever stop, the container sleeps after
`sleepAfter = '20m'` and reboots on the next tick, resuming straight from the queue (state lives in
Supabase, not in the container). **The watchdog (`requeue_stale_sessions`) is NOT its own service — it
is a call at the top of the container's own loop** (see below). `device-api` may _also_ hit `/tick`
right after a session's final chunk for lower latency, but the minute cron already guarantees
correctness.

## The poll loop (`loop()` in processor.py)

Every iteration, in order:

1. **Config gate.** `_missing_config()` checks `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `AI_PROCESS_URL`, `FINALIZE_URL`. If any is unset it logs and `sleep(15)` — it will not hammer
   Supabase or crash before secrets are wired.
2. **`requeue_stale()`** → RPC `requeue_stale_sessions(p_stuck_minutes=STUCK_MINUTES,
   p_max_attempts=MAX_ATTEMPTS)`. The **in-loop watchdog**.
3. **`claim_next()`** → RPC `claim_next_session(p_worker=WORKER_ID)`. Atomic `SKIP LOCKED` claim of the
   oldest `queued` row; flips it to `processing`, stamps `processing_started_at`/`worker_id`, returns
   the row (`id`, `storage_path`, `device_serial`, `session_number`, `user_id`, `bytes`, `attempts`).
   If nothing is queued → `sleep(POLL_INTERVAL)` and continue.
4. **`process(s)`** the claimed row (below), wrapped in the retry classifier.

`attempt = int(s.get("attempts") or 1)` is read from the claimed row and drives the retry budget.

### The in-loop watchdog is single-threaded — what it can and cannot do

`requeue_stale()` runs at the **top** of each loop iteration, but the loop is **blocked inside
`process()`** for the whole duration of a job (download + AI + upload + finalize). So the watchdog
**cannot preempt the job this worker is currently running** — it only fires between jobs. Its real job
is to reclaim rows left in `processing` by a **previous container incarnation that crashed or was
recycled mid-job** (the DO can sleep/reboot). Those orphaned rows have a stale `processing_started_at`;
once older than `STUCK_MINUTES` (45) and under `MAX_ATTEMPTS` (3) tries, `requeue_stale_sessions` flips
them back to `queued` for the next `claim_next()`; past `MAX_ATTEMPTS` it drives them to `error`.

> Tension worth knowing: `AI_READ_TIMEOUT_S` (3600 s = 60 min) is **longer** than `STUCK_MINUTES`
> (45 min). A single AI read may legitimately run past the stale cutoff, but because the watchdog is
> in-loop and this is the only worker, a still-running job is never actually requeued out from under
> itself — the watchdog only sees a `processing` row as "stale" when no worker is holding it. In
> practice transcription of even a ~62-min take finishes in minutes; the 1 h ceiling exists purely to
> guarantee the single worker returns if the AI accepts the connection and then hangs.

### `process(s)` step by step

1. `path = s["storage_path"]`; if missing → **`Permanent("session has no storage_path")`**.
2. `file_name = f"device_{s['device_serial']}_s{s['session_number']}.wav"` — the exact name the device
   uploaded. `session_number` is used verbatim; the firmware allocates numbers **monotonically and
   wraps at 99, never renumbers**, so holes are legal and the processor makes no assumption about
   contiguity.
3. **`download_wav(path)`** → `GET {SUPABASE_URL}/storage/v1/object/device-sessions/{path}` with
   service-role auth, `timeout=(30, 900)` (connect 30 s, **15-min read ceiling** — large files, but
   never a wedged worker). Network error → `Transient`; non-2xx → classified by `_raise_http`.
4. **`call_ai(file_name, wav)`** → `POST AI_PROCESS_URL`, `multipart/form-data`:
   `files={"audio_file": (file_name, data, "audio/wav")}`,
   `form={"device": "cuda", "pause_threshold": "0.25"}`, header `Accept: application/json`,
   **`timeout=(30, AI_READ_TIMEOUT_S)` = (30 s connect, 3600 s read)**. Returns parsed JSON.
5. Guard: if the result is falsy or `segments` is not a list → **`Permanent("AI returned no
   segments")`**.
6. **No-speech branch.** `_has_text(transcript)` scans every `segment` for a non-empty `word` in
   `words[]` or a non-empty `segment.text`. If there is no text → `finalize({"session_id": sid,
   "no_text": True})`, log `no_text`, and **return with no recording** (the device tab shows "No text
   in audio" + a delete option).
7. **`upload_recording(rec_path, wav)`** where `rec_path = f"{s['user_id']}/{int(time.time()*1000)}_
   {file_name}"` → `POST {SUPABASE_URL}/storage/v1/object/recordings/{rec_path}` with
   `Content-Type: audio/wav`, `x-upsert: true`, `timeout=(30, None)` (connect 30 s, **read unbounded**
   — the one uncapped read; bounded in practice by the payload). This copies the raw WAV into the
   `recordings` bucket so app playback is identical to a manual upload.
8. **`finalize(payload)`** → `POST FINALIZE_URL` with `{session_id, transcript, rec_path, file_name,
   file_size=len(wav)}`, `timeout=120`. Logs the returned `recording_id`.

### `finalize-session` (the light half — the edge function)

`finalize-session` is a Supabase edge function (`verify_jwt: false`), **deployed but not checked into
this repo**. Per `cf-processor/README.md` it runs `countErrors` + `calculateSpeechAnalysis`, INSERTs
`recordings`, flips the session to `done`, and is **idempotent** (a re-finalize of the same session
does not create a second recording). It fits the ~150 s edge limit because it does no AI — just
analysis + a DB insert.

The analysis it runs is the port checked into
`react_app_sate-ui_update/supabase/functions/process-device-session/analysis.ts`:
`countErrors(segments)` and `calculateSpeechAnalysis(transcriptData, targetSpeaker?)`. Note
`calculateSpeechAnalysis` takes the **whole transcript object**, not just `segments`.

## The Supabase RPCs (the `async_processor_state_machine` migration)

All called via `POST {SUPABASE_URL}/rest/v1/rpc/<fn>` with the service key, `timeout=30`.

| RPC | Called by | Effect |
|---|---|---|
| `claim_next_session(p_worker)` | every loop | `SKIP LOCKED` claim of the oldest `queued` row → `processing`; stamps `processing_started_at`, `worker_id`; returns the row |
| `requeue_stale_sessions(p_stuck_minutes, p_max_attempts)` | every loop (watchdog) | rows `processing` past the cutoff & under `MAX_ATTEMPTS` → `queued`; past it → `error` |
| `requeue_session(p_id)` | transient retry | bump attempt, back to `queued` |
| `fail_session(p_id, p_msg)` | permanent / exhausted retry | `status=error`, store `p_msg` (truncated 500 chars); **never deletes device audio** |
| `heartbeat_session` | (defined by the migration, **not called by the current loop**) | the container relies on `processing_started_at` + the 45-min cutoff instead of live heartbeats |

## AI endpoint

```
POST AI_PROCESS_URL   (multipart/form-data: audio_file, device=cuda, pause_threshold=0.25)  → { segments: [...] }
```
- An **ngrok tunnel** to the self-hosted CUDA box (ephemeral URL, e.g.
  `https://sate-v1-5.ngrok.io/process`). Set/rotate via the `AI_PROCESS_URL` **secret** (`wrangler
  secret put AI_PROCESS_URL`). The **container** holds this call — never an edge fn / Worker fetch.
- Manual web uploads hit the same `/process` from the web app (`audioProcessor.ts`) with the same
  form fields, so device and manual transcripts are byte-for-byte comparable.

## From segments to a result (shared, identical to the web app)

```
{segments}
  → countErrors(segments)                → error_counts (jsonb)
  → calculateSpeechAnalysis(transcript)  → analysis (jsonb)  (includes totalDuration)
  → transcript stored as-is (jsonb)
```
`finalize-session` runs these (ported, identical to the web app) plus the auto-resolved `patient_id`,
then INSERTs `recordings`. These jsonb fields are what the web report renders.

## Two entry points, one outcome

| | Manual (web app) | Device (recorder / Plaud / Pendant) |
|---|---|---|
| Trigger | SLP uploads audio in the web app | Recorder uploads over Wi-Fi; Plaud/Pendant via the phone app |
| Transport | multipart → web app | chunked HTTPS → `device-api` → `device-sessions` bucket |
| Queue | processed inline by the web app | `sate_device_sessions` row, `status=queued` |
| AI call | `audioProcessor.ts` → `/process` | **container** `call_ai()` holds `/process`, then `finalize-session` |
| Analysis | `countErrors` + `calculateSpeechAnalysis` | same, in `finalize-session` |
| Result | INSERT `recordings` | INSERT `recordings` (same schema) |

Device recordings default to **Standalone** — `patient_id` is nullable and resolved by
`resolvePatient` only if the SLP has an explicit roster link (`sate_device_patients.clinical_patient_id`)
or a tagged `patients.device_patient_id`. A server roster is **not** a patient assignment; assigning a
patient is optional and can be done later on the web report. Never fabricate a patient.

## `recordings` shape (what the website reads)

```
recordings
  id             uuid
  user_id        uuid
  patient_id     uuid → patients(id)   (nullable; null = Standalone / unassigned)
  file_path      text                  (recordings bucket key: <user_id>/<ms>_<file_name>)
  file_name / recording_name  text     (device rows: device_<serial>_s<n>.wav)
  file_size      int
  duration       numeric               (= analysis.totalDuration || 0)
  transcript     jsonb
  error_counts   jsonb
  analysis       jsonb
  flags          jsonb                 (flag-button / device-tap markers → seek-bar ticks)
  protocol       text                  (device: 'auto')
  needs_review   boolean               (device: false → report opens straight away)
  notes          text                  (device: 'Auto-imported from SATE hardware device')
```

## `process-device-session` — the NO-OP that must stay a no-op

`device-api`'s `triggerProcessor()` still **fire-and-forgets** a `POST
/functions/v1/process-device-session {session_id}` (kept alive past the response with
`EdgeRuntime.waitUntil`). In **prod that function is a 200 no-op** — if it actually processed, it would
race the container and duplicate `recordings`. Don't revive it.

> ⚠️ **Known gap (still true — audit 2026-07):** the copy **checked into the repo**
> (`react_app_sate-ui_update/supabase/functions/process-device-session/index.ts`) is **NOT** the
> no-op — it still downloads the WAV, awaits the AI, and inserts `recordings`. It filters on
> `processed=false` while the container claims on `status`, so if this file were deployed as-is **both
> paths would process the same session** → duplicate recordings + the 150 s edge-kill hang. Prod is
> deployed as the no-op; do **not** deploy the repo file. Make it a real early-return before GA. See
> the CLAUDE.md audit note.

`finalize-session` and `device-api` must stay `verify_jwt: false` (they check auth themselves).

## Failure handling & retry (the classifier in `loop()`)

Two exception classes drive everything (`_raise_http` maps HTTP codes):

- **`Transient`** — network error, or HTTP `408` / `429` / `>= 500` (ngrok down, connection reset,
  read failure). Worth retrying.
- **`Permanent`** — HTTP `4xx` (other), malformed AI response, missing `storage_path`, no segments. A
  retry would just fail the same way.

Handling of a claimed job (`attempt` from the row):

| Outcome | Action |
|---|---|
| `Transient` and `attempt < MAX_ATTEMPTS` | `sleep(min(60, POLL_INTERVAL * attempt))` backoff, then `requeue_session()` → back to `queued` |
| `Transient` and `attempt >= MAX_ATTEMPTS` | `fail_session()` → `error` ("transient, gave up after N attempts") |
| `Permanent` | `fail_session()` → `error` immediately |
| any other `Exception` | treated as transient: `requeue_session()` if `attempt < MAX_ATTEMPTS`, else `fail_session()`; `traceback` printed |
| outer-loop `Exception` (RPC/claim itself failed) | `traceback` + `sleep(POLL_INTERVAL)`, loop continues |

- **Empty / too-short take** (guard, added 2026-07-26) → `process()` computes `_wav_seconds(wav)`
  and if `< MIN_AUDIO_SEC` (env, default **0.4 s**) finalizes `{no_text:true}` and **returns WITHOUT
  calling the AI**. Rationale: the AI service returns HTTP `500` on a near-empty WAV (a ~32 ms /
  ~1 KB accidental tap), and a `5xx` is classified `Transient` → it would retry-loop into a stuck
  `error` (hit real: `SATE-D0FDD4` session 35). The post-AI `no_text` path below only runs after a
  *successful* AI call, which this input never reaches. NB deploying a new container image doesn't
  instantly swap the running singleton — an in-flight claim is killed → orphaned in `processing`
  until the 45-min watchdog; to re-run one now, owner-PATCH its row to `queued` via PostgREST.
- **No usable speech** (AI returns 0 words) → `finalize({no_text:true})` → session `done`, **no
  `recordings` row** (device tab shows "No text in audio" + delete). Not an error.
- **User Retry** button → `POST /sessions/:id/retry` (device-api, current in-comment version **v18**;
  the state machine + retry landed in v14). `retrySession` refuses anything not in `status='error'`
  (409) and otherwise sets `status='queued', process_error=null, attempts=0` so the container reclaims
  it.
- The raw WAV stays in the `device-sessions` bucket until a run succeeds — a failure **never loses
  audio**. `fail_session` only writes status/error text; it never touches storage.

### Constants (verified against the code, 2026-07)

| Constant | Value | Source | Meaning |
|---|---|---|---|
| `AI_READ_TIMEOUT_S` | **3600** (1 h) | `processor.py` (env, default 3600) | max the AI read may hang; covers the longest take, guarantees the worker returns |
| connect timeout (AI/download/upload) | **30 s** | `processor.py` | tuple `(30, …)` on every request |
| `download_wav` read | **900 s** (15 min) | `processor.py` | `(30, 900)` |
| `upload_recording` read | **∞** (`None`) | `processor.py` | `(30, None)` — the only uncapped read |
| `finalize` total | **120 s** | `processor.py` | `timeout=120` |
| `_rpc` total | **30 s** | `processor.py` | all RPCs |
| `STUCK_MINUTES` | **45** | `processor.py` / `wrangler.toml` | watchdog reclaim threshold; matches device-api `healthAlerts`/`adminStatus` `STUCK_MS` |
| `MAX_ATTEMPTS` | **3** | `processor.py` / `wrangler.toml` | after this many tries a stuck/transient job → `error` |
| `POLL_INTERVAL` | **10 s** | `processor.py` / `wrangler.toml` | empty-queue poll + backoff base |
| `WORKER_ID` | **`cf-container-1`** | both | claim owner |
| `sleepAfter` | **20 m** | `src/index.ts` | container idle window before sleep |
| `sate-processor` | **1 instance**, `standard-1` | `wrangler.toml` | serial queue drain (GPU concurrency 1) |

## Monitoring & alerting

- `device-api` `GET /admin/status` (admin-gated) and `GET /health/alerts?key=…` (secret-gated,
  device-api **v18**) surface the live pipeline: per-status head counts (`queued/processing/done/
  error`), the **stuck list** (rows `processing` past the same 45-min cutoff — a non-empty list means
  the pipeline is wedged), recent errors, and offline devices. `healthAlerts` returns a stable
  `signature` so the alerting worker only emails on a change.
- **Error-email alerting:** any system error (pipeline errors/stuck jobs, offline devices) is emailed
  to the operator via the 5-min status worker (Cloudflare Email + the status worker + device-api
  `/health/alerts`). A wedged pipeline is therefore visible even though the container has no dashboard.
- `wrangler tail` streams the container's `[processor]` logs live (`claimed …`, `… done -> recording
  …`, `no_text`, `transient (…); requeue in Ns`, `permanent failure: …`).

## Caveats

- The container relies on `processing_started_at` + the 45-min cutoff, not live `heartbeat_at` — the
  `heartbeat_session` RPC exists but is unused by the current loop. If you add concurrency/instances,
  wire heartbeats and re-derive the stuck cutoff from them.
- **Storage's project-wide file-size limit overrides the bucket's** (defaulted 50 MB; a full take is
  ~118 MB → a silent 413 that once destroyed a 62-min recording). Set to **500 MB**. If big sessions
  land as `error` with `download failed: Object not found`, check that first. See
  [05-backend-supabase.md](05-backend-supabase.md).
- `setInsecure()` on the device skips TLS cert validation (fine for now; pin the Supabase CA for
  production hardening).
- **Never move the AI call back into an edge/Worker fetch** — it must live in the container. See the
  boxed rule at the top, and [07-runbook.md](07-runbook.md) for recovering a stuck queue.
