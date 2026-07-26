# Backend pipeline & hardware testing

## Async AI pipeline (the shape)

New device sessions are a state machine on `sate_device_sessions.status`
(`queued → processing → done | error`). The path is **edge fn → Cloudflare → Storage**:

1. **`device-api`** (Supabase edge fn, `verify_jwt:false`) is the whole device + app REST
   surface. It accepts the chunked upload, assembles + byte-verifies the WAV in Storage, inserts
   the session (`status=queued`), and fire-and-forgets a processor trigger.
2. **`cf-processor`** (Cloudflare Worker + Container) does the heavy work. The Worker `/tick`
   (gated by `TICK_SECRET`) wakes the long-lived container; `pg_cron` pings `/tick` every minute
   to keep it warm. The container `claim_next_session()` (atomic, SKIP LOCKED) → **downloads the
   WAV from Storage itself** → HOLDS the ngrok `/process` AI call → copies audio to the
   `recordings` bucket → POSTs `finalize-session`.
3. **`finalize-session`** (edge fn, `verify_jwt:false`) writes the light half back: analysis +
   insert `recordings` + set `done`.

Audio never flows *through* Cloudflare; Cloudflare reads it out of Storage. The device never
uploads to Cloudflare directly.

## Deploy (always `--no-verify-jwt` for the token-validating fns)

```bash
supabase functions deploy device-api --no-verify-jwt
supabase functions deploy finalize-session --no-verify-jwt
supabase functions deploy mint-plaud-token --no-verify-jwt
```

Redeploying `device-api`/`mint-plaud-token` with the MCP default `verify_jwt:true` breaks
recorder registration and Plaud token minting.

**Hazards (see `doc/05-backend-supabase.md`):**
- `process-device-session` must be a **200 no-op** in prod. The repo copy still processes
  (downloads WAV, awaits AI, inserts `recordings`) → duplicate recordings + the 150 s edge-kill
  hang. Do NOT deploy the repo file as-is.
- The CF Worker port `cloudflare/src/functions/processDeviceSession.ts` is the OLD synchronous
  path — a regression; do not run it.
- Storage project-wide file-size limit overrides the bucket's (defaults 50 MB; a full take is
  ~118 MB). It's set to 500 MB now; a swallowed 413 + a false `.synced` once destroyed a take.

## Retry / watchdog

`requeue_stale_sessions` auto-requeues stalled `processing` jobs up to `MAX_ATTEMPTS` then →
`error`. Transient failures (network/5xx/408/429) requeue with backoff; permanent (4xx, no
segments) → `error`. User Retry button = `POST /sessions/:id/retry` (device-api ≥v14, only for
`status='error'`).

**Empty/too-short takes (guard, `cf-processor/app/processor.py`):** the AI service returns HTTP
**500** on a near-empty WAV (a ~32 ms / ~1 KB accidental tap), and a 5xx is classified transient →
it would retry-loop into a permanently stuck `error` (hit real: SATE-D0FDD4 session 35). `process()`
now finalizes any take shorter than `MIN_AUDIO_SEC` (env, default **0.4 s**) as `no_text` WITHOUT
calling the AI. So don't "fix" a stuck empty take by retrying — it's handled up front. NB deploying a
new container image doesn't instantly swap the running singleton (an in-flight claim is killed →
orphaned in `processing` until the 45-min watchdog); to re-run one now, owner-PATCH its row back to
`queued` via PostgREST.

## Monitoring & alerting

The `sate-status` Cloudflare worker (cron `*/5 * * * *`, `status/src/worker.js`) probes each tier and
emails `caothohoanglong2404@gmail.com` via the Cloudflare Email binding, pulling the device-api
`/api/health/alerts` digest (errors / stuck / offline). **Alert policy:** a settled `error` session is
mailed ONCE (it can't auto-clear); only ACTIVE conditions (a service DOWN, a job stuck in
`processing`) re-remind, at most every 24h — this killed a repeated-same-error email loop. A full
**daily infrastructure report** is emailed at **08:00 America/New_York** (DST-aware). `GET /check`
runs the probe on demand; `GET /check?daily=1` force-sends the daily report. Note: a Worker cannot
probe same-account Cloudflare resources (error 1042), so the `cf-processor` worker is monitored
indirectly via the pipeline digest.

## Hardware-in-the-loop testing (run before ANY firmware release)

A compiler can't catch reboot-mid-record, dropped-BLE truncation, delete-during-upload
splicing, verified trim, crash-safe delete, or OTA. The `hwtest/` harness (Python) can — it
resets the board over serial, drives record/reboot/delete, and asserts on both the firmware log
and the bytes the server stored (`GET /sessions/verify`).

Use the `sate` CLI (`pip install -e hwtest`, or run in place with `./hwtest/sate`):

```bash
sate test --sim                # self-test the harness, no hardware
sate test                      # recorder over USB serial
sate test -t pendant           # pendant over BLE
sate test --only byte_match    # a subset of scenarios
sate doctor --device           # reset the board + diagnose real hardware faults
sate flash recorder            # build + flash (auto-detects the port)
sate firmware                  # list flashable images (cache + GitHub releases)
sate flash recorder --version 1.5.12   # put a published older build back on
sate gui                       # native window   |   sate dashboard = browser
sate debug                     # desktop Debugger: screen mirror + remote control
sate ci                        # THE firmware gate: build + flash + standard suite
```

**Regression rule: re-run `sate ci` before ANY feature/fix lands** (and `sate e2e` when the
backend is touched). Deeper layers: `sate e2e` follows one take recorder → Supabase →
Cloudflare → AI → done with per-stage timings (no USB needed); `sate infra` probes every
tier with latency (incl. the deployed `/sessions/verify` route and the AI queue state);
`sate pipeline` opens the live animated map.

**`sate ci` is the release criterion.** Every firmware version must pass it on a real
board before it ships; it writes a per-version report to `hwtest/ci-reports/`. Do not
cut a release, publish an OTA, or tag a version without a passing `sate ci` run.

`sate ci` runs the standard HANDS-OFF suite (7 scenarios: boot, resume, byte-match, verified-trim,
unsynced-kept, reclaim-idle, standalone-default) — the harness drives `record` / `stop` / `reboot`
through `device-api` with the signed-in clinician session. The delete scenarios in the fuller
`sate test` suite still need a human (there is no remote delete command).

**A serial DTR/RTS reset cannot reboot a recording device.** On the debug build `Serial` is
USB-CDC, whose reset is handled in software, and the capture loop never services USB — the
pulse is never seen. Reboot mid-take with the remote `reboot` command (core-0 net task).
Flashing is unaffected: esptool resets through the USB-Serial-JTAG hardware, which works even
when the firmware is wedged.

**Check what is DEPLOYED, not just what is in the repo.** A verified-trim failure on the bench
traced to a `device-api` deployment that predated `/sessions/verify`: every probe 401'd and the
device never reclaimed SD, with nothing wrong in the source. `supabase functions deploy … --use-api`
avoids the Docker bundler.

`sate doctor --device` resets the board, reads the boot log, and reports real faults (no
serial output, crash/panic/brownout, SD init failure, ES8311 audio failure, PSRAM not
detected, setup never reaching `[MEM] ready`, unclaimed/failing registration). The raw
`python3 hwtest/run.py …` entry points still work.

Log tags the harness asserts on: `[MEM] ready`, `[CONN] resume … session …`,
`[CONN] uploaded … (N bytes)`, `[REC] healed interrupted delete`, `[REC] resume session …
from part …` (and `[REC] resume: ABORT - …`, which gives the reason a resume did not happen). See `hwtest/README.md`.
