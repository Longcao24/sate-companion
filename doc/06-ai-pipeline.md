# 06 — AI pipeline

Turns a WAV into a clinical `recordings` row. The **device path and the manual web-upload path
run the same AI and the same analysis**, so a device recording is indistinguishable from a
hand-uploaded one in the app.

## ⚠️ The AI call is ASYNC — never run it from an edge function

**The long transcription MUST run in a long-lived process, NOT in a serverless request.** Supabase
edge has a hard ~150 s wall-clock (not configurable); a plain Cloudflare Worker has a ~100 s origin
timeout (524). Either one **kills the worker mid-`fetch`, before your `try/catch`**, on a long take —
so `process_error` is never written and the session hangs in `processing` forever. A 32-min take once
showed 70 min stuck (edge kill → cron retry → kill …). The AI is not slow; the request just can't
hold the call. This is the single most important rule in the pipeline.

## Architecture (state machine + Cloudflare Container)

Processing is a state machine on `sate_device_sessions.status`:
`queued → processing → done | error` (cols `status`, `processing_started_at`, `attempts`, added by
the `async_processor_state_machine` migration; new rows default to **`queued`**).

```
device-api  → INSERT sate_device_sessions (status=queued)   [fire-and-forgets process-device-session, a NO-OP]
                     │
pg_cron /tick (1/min)│ keeps the container warm
                     ▼
Cloudflare Container (cf-processor/, Python, sate-processor.longcao.workers.dev)  ← long-lived, NO wall-clock
  claim_next_session()      atomic, SKIP LOCKED  → status=processing
   → download the WAV from the device-sessions bucket
   → HOLD the ngrok POST /process (the long transcription) → { segments }
   → copy audio into the `recordings` bucket
   → POST finalize-session (edge)   ← the LIGHT half, fits the 150 s edge limit
        finalize-session: countErrors + calculateSpeechAnalysis → INSERT recordings → status=done
```

- **`process-device-session` is a 200 NO-OP.** `device-api` still fire-and-forgets to it, but it
  must NOT process — that would race the container and duplicate `recordings`. Don't revive it.
  ⚠️ **Known gap (audit 2026-07-22):** the copy checked into the repo is NOT the no-op — it still
  processes and inserts `recordings`. Prod is deployed as the no-op; do NOT deploy the repo file as-is.
- **`finalize-session`** and **`device-api`** must stay `verify_jwt: false`.
- The container's own loop drains the queue; `pg_cron` pinging the Worker `/tick` just keeps it warm.

## AI endpoint

```
POST https://<ngrok>/process      (multipart/form-data, field: audio_file)  → { segments: [...] }
```
- An **ngrok tunnel** to the self-hosted CUDA box (ephemeral URL). Override via the `AI_PROCESS_URL`
  secret when it rotates. The **container** holds this call (never an edge fn / Worker fetch).
- Manual web uploads hit the same `/process` from the web app's `audioProcessor.ts`.

## From segments to a result (shared, identical to the web app)

```
{segments}
  → countErrors(segments)             → error_counts (jsonb)
  → calculateSpeechAnalysis(segments) → analysis (jsonb)
  → transcript (from segments)
```
`finalize-session` runs these three (ported, identical to the web app) plus the auto-resolved
`patient_id`, then INSERTs `recordings`. These jsonb fields are what the web report renders.

## Two entry points, one outcome

| | Manual (web app) | Device (recorder / Plaud / Pendant) |
|---|---|---|
| Trigger | SLP uploads audio in the web app | Recorder uploads over Wi-Fi; Plaud/Pendant via the phone app |
| Transport | multipart → web app | chunked HTTPS → `device-api` → `device-sessions` bucket |
| Queue | processed inline by the web app | `sate_device_sessions` row, `status=queued` |
| AI call | `audioProcessor.ts` → `/process` | **container** holds `/process`, then `finalize-session` |
| Analysis | `countErrors` + `calculateSpeechAnalysis` | same, in `finalize-session` |
| Result | INSERT `recordings` | INSERT `recordings` (same schema) |

## `recordings` shape (what the website reads)

```
recordings
  id            uuid
  patient_id    uuid → patients(id)   (nullable; null = Standalone / unassigned)
  file_name / recording_name  text    (device rows: device_<serial>_s<n>.wav)
  transcript    jsonb
  error_counts  jsonb
  analysis      jsonb
  flags         jsonb                 (flag-button / device-tap markers → seek-bar ticks)
  …             (audio in the recordings storage bucket)
```

## Failure handling & retry

- **Watchdog** `requeue_stale_sessions` re-queues a job stuck in `processing` up to `MAX_ATTEMPTS`,
  then → `error`.
- **Transient** failures (network / `5xx` / `408` / `429`) → `requeue_session` with backoff.
- **Permanent** failures (`4xx`, no segments) → `error` immediately.
- **No usable speech** (AI returns 0 words) → `no_text`, no `recordings` row (device tab shows
  "No text in audio" + delete).
- **User Retry** button → `POST /sessions/:id/retry` (device-api ≥ v14) re-queues an `error` session.
- The raw WAV stays in the `device-sessions` bucket until a run succeeds, so a failure never loses audio.

> ⚠️ **Storage's project-wide file-size limit overrides the bucket's** (defaulted 50 MB; a full take
> is ~118 MB → silent 413 that once destroyed a 62-min recording). Set to **500 MB**. If big sessions
> land as `error` with `download failed: Object not found`, check that first. See
> [05-backend-supabase.md](05-backend-supabase.md).

## Caveats

- `setInsecure()` on the device skips TLS cert validation (fine for now; pin the Supabase CA for
  production hardening).
- **Never move the AI call back into an edge/Worker fetch** — it must live in the container. See the
  boxed rule at the top.
