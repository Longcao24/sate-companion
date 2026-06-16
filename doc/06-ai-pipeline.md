# 06 — AI pipeline

Turns a WAV into a clinical `recordings` row. The **device path and the manual web-upload path
run the same AI and the same analysis**, so a device recording is indistinguishable from a
hand-uploaded one in the app.

## AI endpoint

```
POST https://sate-v1-5.ngrok.io/process      (multipart/form-data, field: audio_file)
  → { segments: [...] }
```

- An **ngrok tunnel** (ephemeral). If manual upload works, the device path works — they hit the
  exact same URL.
- Override via the `AI_PROCESS_URL` function secret when the ngrok URL rotates.
- Default lives in `process-device-session` and in the web app's `audioProcessor.ts`.

## From segments to a result

Shared logic (ported into the edge function, identical to the web app):

```
{segments}
  → countErrors(segments)            → error_counts (jsonb)
  → calculateSpeechAnalysis(segments) → analysis (jsonb)
  → transcript (from segments)
```

These three jsonb fields plus `patient_id` are what the web app reads to render a result.

## Two entry points, one outcome

| | Manual (web app) | Device (recorder) |
|---|---|---|
| Trigger | SLP uploads audio in the SATE web app | Recorder uploads over Wi-Fi (or app bridges over BLE) |
| Transport | multipart upload → web app service | chunked HTTPS → `device-api` → `device-sessions` bucket |
| AI call | `audioProcessor.ts` → `/process` | `process-device-session` → `/process` |
| Analysis | `countErrors` + `calculateSpeechAnalysis` | same, ported into the edge fn |
| Patient | SLP picks one | auto-resolved from device→patient links ([05](05-backend-supabase.md)) |
| Result | INSERT `recordings` | INSERT `recordings` (same schema, same columns) |

## `recordings` shape (what the website reads)

```
recordings
  id            uuid
  patient_id    uuid  → patients(id)   (nullable; null = unassigned)
  transcript    jsonb
  error_counts  jsonb
  analysis      jsonb
  …             (audio backed by the recordings storage bucket)
```

The web app queries `recordings` (filtered by the SLP / patient) and renders transcript +
error_counts + analysis. A device upload that completes processing appears here automatically.

## Failure handling

- `process-device-session` is fired **fire-and-forget** by `device-api`
  (`EdgeRuntime.waitUntil`). If the AI call exceeds the edge wall-clock, the session stays
  `processed = false` with `process_error` set.
- **Retry:** re-invoke `process-device-session` in sweep mode to reprocess unprocessed sessions.
- **Idempotency:** `sate_device_sessions.processed` guards against double-processing; chunk
  re-sends at the same offset are idempotent.
- If the AI tunnel is down, no `recordings` row is written — the raw WAV is safe in the
  `device-sessions` bucket and reprocesses once the tunnel is back.

## Caveats

- `setInsecure()` on the device skips TLS cert validation (fine for now; pin the Supabase CA for
  production hardening).
- The ngrok dependency is the main external fragility — keep the tunnel up, or point
  `AI_PROCESS_URL` at a stable host.
