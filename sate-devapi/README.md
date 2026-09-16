# SATE Developer API

A standalone web service that sells the SATE speech pipeline to third-party developers:
**send audio, get a transcript and a speech report.**

It is not part of the SATE clinical app and shares no data with it. There is no patient, no
clinician, no device, and no SATE account anywhere in this service — by design, not by
omission. The only thing it has in common with the clinical stack is the AI transcription
box it calls, and even that is reached through a priority gate so a developer's batch can
never make a clinician's recording wait.

```
developers-sate.long-cao.dev   portal: request access, keys, usage charts, playground, docs
api-sate.long-cao.dev/v1/*     the API: submit audio, read results
```

## What a developer gets

One pipeline, three views. The view is a projection of a single stored result, gated by the
scopes on the key — so the AI runs once regardless of tier, and widening a key's scopes
later retroactively unlocks richer views of jobs already processed.

| View | Scope | Contents |
|---|---|---|
| `transcript` | `transcript:read` | Speaker-attributed segments, per-word timings, plain text |
| `report` | `report:read` | Counts and metrics only — no words at all |
| `full` | any | Everything the key's scopes allow; anything withheld is named in `omitted` |

The report is computed by `src/analysis.ts`, ported from the clinical pipeline so a
developer's numbers match the first-party product's: annotation counts (pause, filler,
repetition, mispronunciation, morpheme, morpheme-omission, revision, utterance-error),
NTW, NDW, MLUw, MLUm, speaking rate, annotation rate.

## Architecture

```
        ┌── portal (cookie session) ──┐
Browser ┤                             ├──► Worker ──► D1   (developers, keys, jobs, usage)
        └── /v1 (API key) ────────────┘      │    └──► R2   (audio, in-flight only)
                                             │
                          POST /internal/claim│  ▲ complete / fail / heartbeat
                                             ▼  │
                                   Container (Python poll loop) ──► AI transcription box
```

**The AI call cannot live in the Worker.** A Worker dies at the ~100 s origin timeout,
mid-`fetch`, *before any catch block runs* — so a long job would strand in `processing` with
no error ever recorded. The container has no wall-clock. This is the same lesson the
clinical pipeline learned expensively (see the root `CLAUDE.md`); do not relitigate it by
making submission synchronous.

The container owns no state and speaks no SQL. It claims work over `/internal/*`, holds the
long call, and posts the result back. Everything restartable, nothing lost on a reboot.

### Clinical priority

The AI box has GPU concurrency of 1. Before running a developer job the container probes
`CLINICAL_PROBE_URL` and defers while the clinical queue has work. The deferral is bounded
by `MAX_DEFER_SEC` (10 min), so a permanently busy — or permanently unreachable — clinical
queue degrades developer latency rather than stopping developer traffic forever. With no
probe URL configured the gate is simply off.

## Access model

Registration is open; **access is not**. A request lands as `pending` with zero scopes and
can do nothing, so the public form can never spend a second of GPU time. An admin approves
it and assigns the allowance:

- **Scopes** — which of the three views the developer may reach. A developer can mint keys
  only within this allowance, and narrowing it takes effect on existing keys immediately.
- **Audio limit** — minutes, either `monthly` (rolls over) or `total` (a lifetime ceiling).
  **Reset used audio** moves the counting window to now; it never deletes usage rows, so
  billing history survives a reset.
- **Lock API** — stops all `/v1` traffic instantly with a reason the developer sees in every
  error, while leaving their portal login working so they can read why. Reversible, and
  distinct from suspending the account or revoking keys.
- **Rate limit** and **max keys**.

The first account registered with `BOOTSTRAP_ADMIN_EMAIL` is auto-approved as admin.

Portal cookies and API keys are strictly non-interchangeable: a leaked API key cannot mint
more keys or read the account, and a stolen cookie cannot be replayed against `/v1`.

## Admin monitoring

`/#admin` shows system-wide traffic (requests and audio minutes per day, errors stacked on
the same bars), **every live API key in the system** with the traffic it is pulling, usage
broken down by developer, live queue depth, and recent job errors — plus the per-developer
controls above.

## Layout

| Path | What |
|---|---|
| `src/index.ts` | Router; hostname decides portal vs API. Cron: keep-warm, requeue stale, retention sweep |
| `src/api.ts` | `/v1/*` — submit, poll, read, usage. Metering, rate limit, quota |
| `src/portal.ts` | Portal + admin JSON API |
| `src/internal.ts` | Container contract; the job state machine lives here and nowhere else |
| `src/auth.ts` | PBKDF2 passwords, cookie sessions, API key minting and verification, scopes |
| `src/analysis.ts` | The report — ported from the clinical pipeline, keep the two in step |
| `src/views.ts` | The three projections |
| `src/ui.ts` | The portal, one self-contained HTML document |
| `src/docs.ts` | Public API reference with runnable clients in 9 languages |
| `container/` | Python poll loop that holds the AI call |
| `test/run.mjs` | 163-check end-to-end suite |

## Live

Deployed 2026-07-29. Verified end to end in production: a 25 s clip was submitted, the
container claimed it, held the real AI call, and the report came back in ~15 s.

| | |
|---|---|
| Portal | https://developers-sate.long-cao.dev |
| API | https://api-sate.long-cao.dev |
| Docs | https://developers-sate.long-cao.dev/docs |
| D1 | `sate-devapi` · `52c7c0fa-c6af-4761-8478-2645ce3a72cf` |
| R2 | `sate-devapi-audio` |
| Container | `sate-devapi-devprocessor`, 1 instance, `standard-1` |

Redeploy with `npx wrangler deploy`. Run `npm test` first — it is the release gate.

## First-time setup (already done for the live instance)

```bash
npm install

npx wrangler d1 create sate-devapi           # paste the id into wrangler.toml
npx wrangler d1 execute sate-devapi --remote --file=./schema.sql
npx wrangler r2 bucket create sate-devapi-audio

# Secrets. INTERNAL_SECRET and TICK_SECRET should be freshly generated, never reused:
#   openssl rand -hex 32
npx wrangler secret put AI_PROCESS_URL       # https://sate-v1-5.ngrok.io/process
npx wrangler secret put INTERNAL_SECRET      # container <-> Worker
npx wrangler secret put TICK_SECRET          # gates POST /tick
npx wrangler secret put CLINICAL_PROBE_URL   # clinical priority gate — see below
npx wrangler secret put CLINICAL_PROBE_KEY

npx wrangler deploy
```

Then register `BOOTSTRAP_ADMIN_EMAIL` at the portal — that one address auto-approves as
admin; every other registration lands `pending`.

⚠️ **`AI_PROCESS_URL` is an ngrok tunnel.** If that URL changes, developer jobs fail with a
transient error and retry until they settle — the same exposure the clinical pipeline has.
Re-`secret put` it and requeue.

`CLINICAL_PROBE_URL` is any endpoint that answers with a non-empty JSON array (or
`{"busy":true}`) while clinical work is pending — e.g. a PostgREST query against the
clinical sessions table filtered to `status=in.(queued,processing)&limit=1`. It is
configuration-level coupling only: no shared code, no shared database.

Then register `BOOTSTRAP_ADMIN_EMAIL` at the portal to get the admin account.

## Test

```bash
npm test              # boots wrangler dev --local, rebuilds D1, runs 163 checks
npm test -- --keep    # leave the server up afterwards
npm run typecheck
```

Black-box over HTTP against the real Worker. The suite stands in for the container by
driving `/internal/*` directly — that is not a coverage gap, because `/internal` *is* the
container's entire contract, and driving it makes report numbers assertable exactly without
needing Docker or a GPU. It covers registration and approval, credential separation, scope
gating, exact report arithmetic (derived by hand from a canned transcript), tenant
isolation, retry and settlement, quota including reset and lifetime caps, the API lock,
rate limiting, admin monitoring, and retention.

**Run it before every deploy.** Same rule as the firmware gate in the root `CLAUDE.md`: no
release without a passing suite.
