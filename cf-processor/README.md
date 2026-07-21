# SATE async processor (Cloudflare Worker + Container)

Fixes device-session takes getting **stuck in "processing"**. The old path ran the AI
call *inside* a Supabase edge function; Supabase's ~150s wall-clock timeout killed long
takes mid-request (before any error was written), so they hung forever.

Now: the AI call runs in a **Cloudflare Container** (a long-lived process with no such
timeout). Supabase stays the source of truth. The AI server (ngrok) is **not touched**.

## Flow

```
device --> Storage + sate_device_sessions.status = 'queued'   (column default)

pg_cron (every 1 min) --> Worker /tick --> wakes the Container (singleton)

Container poll loop:
  requeue_stale_sessions()   # watchdog: reclaim dead 'processing' jobs
  claim_next_session()       # atomic grab of oldest 'queued'
  download WAV from Storage
  POST ngrok /process        # HELD as long as needed (no wall-clock)
  copy WAV -> recordings bucket
  POST finalize-session edge # analysis + insert recordings + status='done'
  (on error) fail_session()  # status='error'; device audio never deleted
```

## What is already deployed (Supabase side, done)

- Migration `async_processor_state_machine`: adds `status` / `processing_started_at` /
  `attempts` / `worker_id` / `heartbeat_at` to `sate_device_sessions`, plus RPCs
  `claim_next_session`, `requeue_stale_sessions`, `fail_session`, `heartbeat_session`.
- Edge `finalize-session` (verify_jwt=false): runs analysis, inserts `recordings`,
  flips the session to done. Idempotent.
- Edge `process-device-session` neutered to a 200 no-op (device-api still pings it) so
  it can't race the container.

New device sessions become `status='queued'` automatically (column default) — no
device-api change needed.

## Deploy this service (Cloudflare — your account)

Prereqs: Workers Paid + Containers enabled, Docker running locally, `wrangler` logged in.

```bash
cd cf-processor
npm install

# secrets (NOT in wrangler.toml)
wrangler secret put SUPABASE_SERVICE_KEY   # Supabase service_role key
wrangler secret put AI_PROCESS_URL         # e.g. https://sate-v1-5.ngrok.io/process
wrangler secret put TICK_SECRET            # SATE_2026  (shared with pg_cron below)

npm run deploy
```

Non-secret config (`SUPABASE_URL`, `FINALIZE_URL`, thresholds) is in `wrangler.toml`.

After deploy, note the Worker URL, e.g. `https://sate-processor.<subdomain>.workers.dev`.

## Wire the heartbeat (Supabase SQL — run once, after deploy)

Replace the URL with your deployed Worker URL, then run in the Supabase SQL editor.
`pg_cron` + `pg_net` are already enabled on the project.

```sql
select cron.schedule(
  'sate-processor-tick',
  '* * * * *',  -- every minute
  $$
  select net.http_post(
    url     := 'https://sate-processor.<subdomain>.workers.dev/tick',
    headers := jsonb_build_object('Authorization', 'Bearer SATE_2026', 'Content-Type', 'application/json'),
    body    := '{}'::jsonb
  );
  $$
);
```

To change/remove later: `select cron.unschedule('sate-processor-tick');`

(Optional, lower latency) also `POST /tick` with the same `Authorization` from device-api
right after a session's final chunk — the pg_cron tick already guarantees correctness, so
this is just to start sooner.

## Verify

```bash
wrangler tail          # watch container logs
```
- Record a short take on the device → within ~1 min: `claimed ... -> done -> recording ...`
- Long take (30+ min): stays `processing` with a fresh heartbeat, completes when the AI
  returns — no more infinite hang.
- Kill the container mid-job → after `STUCK_MINUTES` the watchdog requeues it.

## Tunables (wrangler.toml `[vars]`)

| var             | default | meaning                                        |
|-----------------|---------|------------------------------------------------|
| `STUCK_MINUTES` | 45      | reclaim a `processing` job stalled beyond this |
| `MAX_ATTEMPTS`  | 3       | after this many tries a stuck job → `error`    |
| `POLL_INTERVAL` | 10      | seconds between empty-queue polls              |
