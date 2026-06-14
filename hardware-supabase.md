# Hardware → Supabase → AI → `recordings` (direct integration)

Goal: a SATE recorder uploads a session straight to the **live Supabase** backend
(project `SATE`, ref `zlgdpivcbmaodgokkdvz`); the session is auto-assigned to the
SLP's existing patient, run through the **same AI** a manual web upload uses, and
written into the `recordings` table — so a device recording is indistinguishable
from a hand-uploaded one in the app.

## Data flow

```
device (fw 1.0.0, HTTPS)
  │  POST /functions/v1/device-api/api/sessions/chunk?...&offset&final   (apikey + Bearer key-dev-…)
  ▼
device-api edge fn  ── stitches ~1 MB slices → patches WAV header → device-sessions bucket
  │                      inserts sate_device_sessions  →  triggerProcessor(session_id)
  ▼
process-device-session edge fn
  │  1. download WAV (device-sessions bucket)
  │  2. resolve patient: device patient_id (text) → patients.id (uuid)  [SLP's existing patient]
  │  3. POST https://sate.ngrok.io/process   (multipart audio_file)  ← SAME AI as manual
  │  4. countErrors + calculateSpeechAnalysis (ported from the web app, identical)
  │  5. copy WAV → recordings bucket
  │  6. INSERT recordings { transcript, error_counts, analysis, patient_id, … }
  │  7. mark sate_device_sessions.processed + recording_id
  ▼
recordings  ── shows in the app exactly like a manual upload
```

## What was deployed (live on `zlgdpivcbmaodgokkdvz`)

- **Migration** `device_to_recordings_bridge` (additive):
  - `patients.device_patient_id text` (+ index on `slp_id, device_patient_id`)
  - `sate_device_patients.clinical_patient_id uuid → patients(id)`
  - `sate_device_sessions.{recording_id, processed, processed_at, process_error}`
- **Edge fn `process-device-session`** (v1) — the AI/recordings bridge. `verify_jwt=false`;
  auth = service-role key OR `PROCESSOR_SECRET`. Batch sweep + single `{session_id}` mode.
- **Edge fn `device-api`** (v2) — now: accepts `/api/*` path alias, **assembles** chunked
  uploads (offset+final) into one WAV + patches the header, fires `process-device-session`.

## Patient auto-assignment

Device = the **SLP's** device; the patient already exists. Resolution (no fabrication):
1. `sate_device_patients(user_id, patient_id).clinical_patient_id` — the app sets this
   uuid when it pushes the device roster (primary path).
2. else `patients` where `slp_id = device owner` and `device_patient_id = <device patient_id>`.
3. else `patient_id = null` (unassigned), same as a manual upload with no patient chosen.

To wire a patient: set one of those links, e.g.
```sql
update patients set device_patient_id = 'PT-2001'
where id = '<clinical patient uuid>' and slp_id = '<slp user uuid>';
```

## Firmware (fw 1.0.0)

- Sends the Supabase **`apikey`** header (project anon key, public — embedded as a
  constant, same trust level as the web bundle) on every request when `cfgServer`
  contains `supabase.co`.
- **HTTPS/TLS**: keep-alive client, chunk-upload socket, and the register POST now use
  `WiFiClientSecure` (`setInsecure()`) when the server is Supabase; plain `WiFiClient`
  for a local mock. Upload port defaults to **443** for `https://`.
- No firmware change is needed for the mock-server path — it still works.

## Go-live checklist (hardware-in-the-loop)

1. **Provision the device to Supabase** (via the app's BLE provisioning):
   - `server` = `https://zlgdpivcbmaodgokkdvz.supabase.co/functions/v1/device-api`
   - `claim_token` = minted by a logged-in SLP (`POST /device-api/devices/claim-token`)
   - The register response returns `device_key = key-dev-<serial>` → stored as `cfgDeviceKey`.
2. **Flash fw 1.0.0** to the recorder.
3. Ensure the **AI tunnel** `https://sate.ngrok.io/process` is up (same dependency as
   manual upload; swap via the `AI_PROCESS_URL` function secret if the ngrok URL rotates).
4. Record on the device → it auto-uploads to Supabase → appears in `recordings`.

## Caveats / notes

- **AI endpoint** is an ngrok tunnel (ephemeral). The bridge uses the exact URL the
  web app uses; if manual upload works, the bridge works. Set `AI_PROCESS_URL` secret to override.
- **TLS memory**: `WiFiClientSecure` uses mbedTLS (~30–45 KB internal RAM per handshake).
  Keep-alive + one chunk upload at a time fits within the ~138 KB free internal heap, but
  watch `[MEM] min` on long sessions. `setInsecure()` skips cert validation — fine for a
  first cut; pin the Supabase CA for production hardening.
- **Processing trigger**: `device-api` fires `process-device-session` fire-and-forget
  (`EdgeRuntime.waitUntil`). If a long AI call exceeds the edge wall-clock, the session stays
  `processed=false` with `process_error` set — re-invoke `process-device-session` (sweep mode)
  to retry. A pg_cron sweep can be added (kept out here to avoid embedding the service key in SQL).
- **Idempotency**: `sate_device_sessions.processed` guards against double-processing; chunk
  re-sends at the same offset are idempotent.
