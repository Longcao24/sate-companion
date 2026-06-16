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

### Chunk upload assembly

`/sessions/chunk?...&offset=&final=` appends ~1 MB slices into one object; on `final=1` the
function **patches the WAV header** (RIFF/data sizes) so the stitched file is a valid WAV. Slices
are idempotent (re-sending the same offset is safe). On completion the function inserts
`sate_device_sessions` and fires `process-device-session` fire-and-forget
(`EdgeRuntime.waitUntil(triggerProcessor(session_id))`).

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
| `device-sessions` | private | Raw device-uploaded WAVs (pre-processing) |
| `recordings` | private | Final WAVs backing `recordings` rows (manual + device) |
| `mobile` | public | Mobile uploads |

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
