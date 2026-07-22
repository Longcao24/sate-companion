# 05 — Backend (Supabase)

Project **SATE**, ref `zlgdpivcbmaodgokkdvz`, URL
`https://zlgdpivcbmaodgokkdvz.supabase.co`. Postgres + Storage + Edge Functions (Deno). Edge
functions live in `react_app_sate-ui_update/supabase/functions/`.

## Tables (public schema)

| Table | Role |
|-------|------|
| `recordings` | **The clinical result.** transcript / error_counts / analysis (jsonb), `patient_id → patients(id)`. The web app reads this; a device upload writes here exactly like a manual upload. |
| `patients` | Clinical patients. `device_patient_id text` links a recorder's patient id to a clinical patient. |
| `sate_devices` | Registered recorders: serial, device_key, `slp_id` (owner), online/last_seen, live state. |
| `sate_device_sessions` | Raw uploaded device sessions; `recording_id`, `processed`, `processed_at`, `process_error`. |
| `sate_device_patients` | Device roster ↔ clinical patient: `clinical_patient_id → patients(id)`. |
| `sate_device_commands` | Remote command queue (the device polls this). |
| `sate_claim_tokens` | One-time provisioning tokens (minted by the app, consumed at register). |
| `subscriptions`, `payments`, `stripe_customers`, `stripe_webhook_events` | Stripe billing. |
| `invite_codes`, `invite_code_usage` | Invite/access codes. |

RLS is enabled on all tables. Device routes bypass RLS via the service role inside the edge
function (the device authenticates with its device key, not a user JWT).

## Edge functions

| Function | `verify_jwt` | Role |
|----------|--------------|------|
| `device-api` | **false** | The device + app REST surface. Routes by auth header: device key (`Bearer key-…`) vs SLP user JWT. Current ~v33. |
| `finalize-session` | **false** | The **light half** of device processing: `countErrors` + `calculateSpeechAnalysis` → INSERT `recordings` → set `status=done`. Called by the Cloudflare container after it holds the AI call. |
| `process-device-session` | **false** | ⚠️ **200 NO-OP now.** `device-api` still fire-and-forgets to it, but it must NOT process (would race the container + duplicate `recordings`). Don't revive it. |
| `mint-plaud-token` | **false** | 2-step Plaud OAuth server-side → Plaud `user_id` token (see `plaud-integration.md`). |
| `mobile-link` | **false** | Mints/consumes one-time QR/code for phone login. |
| `create-checkout-session`, `create-portal-session`, `cancel-subscription`, `get-invoices`, `stripe-webhook` | — | Stripe billing. |

> **The long AI transcription does NOT live in any edge function.** It runs in a long-lived
> **Cloudflare Container** (`cf-processor/`, `sate-processor.longcao.workers.dev`) that claims
> `queued` sessions (SKIP LOCKED), holds the ngrok `/process` call, then calls `finalize-session`.
> `pg_cron` pings the Worker `/tick` every minute to keep it warm. **Never move the AI call into an
> edge fn or a Worker `fetch`** (150 s edge / ~100 s Worker 524 kills it mid-call). See
> [06-ai-pipeline.md](06-ai-pipeline.md). ⚠️ Redeploying `device-api` / `finalize-session` /
> `process-device-session` with the MCP default `verify_jwt:true` breaks device registration + the
> pipeline — always pass `verify_jwt:false` / `--no-verify-jwt`.

`verify_jwt=false` on `device-api` is required because the **device** has no Supabase user JWT —
it presents a device key the function validates itself. The Supabase Edge **gateway** still
requires the public `apikey` header on every call.

### `device-api` routes

Prefix `/api` is stripped (`/api/devices` → `/devices`). Auth header decides the branch.

Device-key routes (`Authorization: Bearer key-…`):

| Route | Method | Purpose |
|-------|--------|---------|
| `/register` or `/devices/register` | POST | Validate claim token, insert `sate_devices`, return `device_key` |
| `/devices/:id/commands` | GET | Device polls queued commands (sends `pending`, `state`) |
| `/sessions`, `/sessions/raw`, `/sessions/chunk` | POST | Upload a session (chunked = `?offset=&final=`) |

SLP user-JWT routes:

| Route | Method | Purpose |
|-------|--------|---------|
| `/devices` | GET | List the SLP's claimed devices |
| `/devices/claim-token` | POST | Mint a one-time claim token |
| `/devices/:id/commands` | POST/GET | Queue / read remote commands |
| `/devices/:id` | PATCH/DELETE | Rename / remove |
| `/patients` | GET/PUT | Roster read / push |
| `/sessions` | GET | List uploaded sessions |
| `/sessions/:id/audio` | GET | Stream session audio |

### Chunk upload assembly (v12+)

`/sessions/chunk?...&offset=&final=&total=` stores each ~1 MB slice as its **own object** under
`<device>/_tmp/<patient>/s<n>/<zero-padded-offset>.part`. On `final=1` the function lists the parts,
verifies they form one gap-free stream (from the listed sizes, before downloading a byte), pulls
them in parallel batches into a single pre-allocated buffer, **patches the WAV header** (RIFF/data
sizes), stores the WAV, inserts `sate_device_sessions`, fires `process-device-session`, and only
then deletes the parts. Re-sending a slice is idempotent (`upsert`).

Rules that are load-bearing — an earlier version broke each one and cost a 62-minute recording:

- **Never rewrite a whole temp blob per slice.** v11 downloaded + re-uploaded the entire blob on
  every slice: quadratic, so a 30-min session pushed ~1.5 GB through the function and the late
  slices blew past the firmware's timeout. Each timeout restarted at offset 0, which truncated the
  blob back to the first slice — a backlog that could never drain.
- **`offset=0` purges the part dir first.** Session numbers are reused after a delete renumbers
  sessions, so stale parts from an abandoned attempt must not be stitched onto new audio.
- **Part dir is scoped by patient.** Session numbers restart at 1 per patient; `s1` alone collides.
- **A failed storage upload MUST throw** (see `storeSessionRecord`). It used to `console.error` and
  insert the row anyway, returning 2xx — the recorder marked the session synced while the server
  held a row pointing at nothing.
- **`total=` is verified** against the assembled length (firmware ≥1.5.9) before storing; a mismatch
  is a 409 and the device restarts the session.
- **The idempotency probe checks the object, not just the row.** A row is not proof the audio
  landed; answering "already stored" for a ghost row strands the recording on the device forever.

### Processing a device session (ASYNC — split container + `finalize-session`)

`process-device-session` is a **200 no-op** now (don't revive). The work is split so the long AI
call lives in a process with no wall-clock:

**Cloudflare container** (`cf-processor/`, long-lived) — for each `queued` session:
1. `claim_next_session()` (atomic, SKIP LOCKED) → `status=processing`.
2. Download the WAV from the `device-sessions` bucket.
3. **HOLD** the AI `/process` POST (multipart `audio_file`) — the long transcription.
4. Copy the WAV into the `recordings` bucket.
5. POST `finalize-session` with the segments.

**`finalize-session`** edge fn (the light half, fits the 150 s limit):
6. **Resolve patient** (no fabrication): `sate_device_patients.clinical_patient_id`, else
   `patients` matched on `slp_id` + `device_patient_id`, else `null` (Standalone).
7. `countErrors` + `calculateSpeechAnalysis` (ported from the web app, identical) — see [06](06-ai-pipeline.md).
8. **INSERT `recordings`** `{ transcript, error_counts, analysis, flags, patient_id, … }`, set
   `sate_device_sessions.status=done` + `recording_id`.

State machine `queued → processing → done | error | no_text`; the watchdog re-queues stalled jobs;
the user Retry button re-queues an `error`. Never move the AI call into an edge fn / Worker fetch.

## Storage buckets

| Bucket | Visibility | Holds |
|--------|------------|-------|
| `device-sessions` | private | Raw device-uploaded WAVs (pre-processing) + `_tmp/` chunk parts |
| `recordings` | private | Final WAVs backing `recordings` rows (manual + device) |
| `firmware` | public | OTA `.bin` releases (`sate_<version>.bin`) |
| `mobile` | public | Mobile uploads |

### ⚠️ The project-wide file size limit overrides the bucket's

**A bucket's `file_size_limit` is not the real ceiling.** The project's *global* file size limit
(Dashboard → Storage → Settings) takes precedence, and it is **50 MB by default**. `device-sessions`
was set to 200 MB, yet a 118 MB WAV was rejected with:

```
413 Payload too large — "The object exceeded the maximum allowed size"
```

A full-length take is ~118 MB (`RECORD_MAX_SECONDS` 3700 s × 32 KB/s), so the global limit **must**
stay well above that — it is currently **500 MB**. On the Free plan 50 MB is a hard cap; raising it
needs Pro or above.

This cost a real 62-minute recording: the 413 was swallowed by `storeSessionRecord`, the row was
inserted anyway, the device got a 2xx and marked the session synced. Two independent bugs — a
silent limit and a swallowed error — had to line up. Both are fixed, but check this limit first if
large sessions land as rows with `process_error: "download failed: Object not found"`.

Probe the real ceiling empirically rather than reading settings:

```bash
dd if=/dev/zero of=/tmp/p.bin bs=1m count=120
npx supabase storage cp /tmp/p.bin ss:///device-sessions/_probe/p.bin --linked --experimental
```

## Migration

`device_to_recordings_bridge` (additive):
- `patients.device_patient_id text` (+ index on `slp_id, device_patient_id`)
- `sate_device_patients.clinical_patient_id uuid → patients(id)`
- `sate_device_sessions.{ recording_id, processed, processed_at, process_error }`

## Secrets / config

- `AI_PROCESS_URL` — overrides the default AI endpoint (`https://sate-v1-5.ngrok.io/process`).
- `PROCESSOR_SECRET` — alternative auth for `process-device-session`.
- Service-role key — server-side only, used by the edge functions for DB/storage writes.

## Known stale code

`process-mobile-uploads` was an earlier mobile-path function that uses **wrong columns**
(`transcript_data`, `issue_counts`) — not the live `recordings` schema (`transcript`,
`error_counts`). Do not model new work on it; the live device path (`finalize-session`) is the correct reference.
