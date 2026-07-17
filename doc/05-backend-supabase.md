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
| `device-api` | **false** | The device + app REST surface. Routes by auth header: device key (`Bearer key-…`) vs SLP user JWT. |
| `process-device-session` | **false** | AI/recordings bridge. Auth = service-role key or `PROCESSOR_SECRET`. |
| `create-checkout-session`, `create-portal-session`, `cancel-subscription`, `get-invoices`, `stripe-webhook` | — | Stripe billing. |

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

### `process-device-session`

1. Download the WAV from the `device-sessions` bucket.
2. **Resolve patient** (no fabrication):
   1. `sate_device_patients.clinical_patient_id` (the app sets this when it pushes the roster), else
   2. `patients` where `slp_id = owner` and `device_patient_id = <device patient id>`, else
   3. `null` (unassigned — same as a manual upload with no patient chosen).
3. POST the WAV to the AI `/process` endpoint (multipart `audio_file`).
4. `countErrors` + `calculateSpeechAnalysis` (ported from the web app, identical) — see [06](06-ai-pipeline.md).
5. Copy the WAV into the `recordings` bucket.
6. **INSERT `recordings`** `{ transcript, error_counts, analysis, patient_id, … }`.
7. Mark `sate_device_sessions.processed = true`, set `recording_id`.

Modes: single `{ session_id }` or a batch sweep over unprocessed sessions. `processed` guards
double-processing.

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
`error_counts`). Do not model new work on it; the device path (`process-device-session`) is the
correct, live reference.
