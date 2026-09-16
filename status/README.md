# SATE status page

A self-hosted, **status.claude.com-style** page: overall status banner, per-service
Operational / Degraded / Outage, and **90-day uptime bars** with an uptime %.

- **Live:** https://sate-status.longcao.workers.dev
- **How it works:** a Cloudflare Worker with a **cron** (every 5 min) probes each
  service and records the result to **D1**; the page renders the 90-day history from
  D1. The bars fill in as the cron runs — history builds over time.

## ⚠️ Important limitation (error 1042)

A Cloudflare Worker **cannot probe resources on the same Cloudflare account**
(Pages / other Workers) — the platform blocks it with error `1042`. So this Worker
monitors **external** services only. Your CF-hosted pieces — the **docs site**, the
**service monitor**, and the **cf-processor** Worker — are **not** covered here.

To monitor those, use an **external** prober:
- **[Upptime](https://upptime.js.org/)** — free, GitHub-Actions-powered, produces the
  same status.claude.com look (90-day uptime + response-time graphs), probes from
  outside Cloudflare so it can see everything.
- or a SaaS (Better Stack, Instatus, Cronitor, …).

## Configure

Edit `TARGETS` in `src/worker.js` (currently the Supabase device-api / API / storage
and the AI `/process` host — **verify the Supabase ref and ngrok host for your
project**). Each target:

```js
{ name: 'device-api (Supabase)', url: '…/device-api/firmware/latest',
  expect: [200, 401, 404], reachableIsUp: true }
```
- `expect` — HTTP codes counted as **up**.
- `reachableIsUp` — treat any response (even 401/404) as up (good for an API whose
  root needs auth but is clearly alive).
- `authSecret` — name of a Worker secret sent as `Authorization: Bearer` (e.g. an
  admin JWT so a target can be `…/device-api/admin/status`).
- `minIntervalSec` — rate-limit this target's **network** probe below the 5-min cron.
  Between real probes the last recorded status is carried forward (re-inserted with the
  current timestamp — no fetch), so the 90-day bar stays continuous without spending an
  upstream request. Used for the **ngrok** hosts to conserve ngrok quota: the AI
  `/process` target is `24 * 3600` (once per day → ~1 hit/day instead of ~288). The
  cost: a fresh AI outage isn't seen until the next real probe (≤24h later); a
  carried-forward `down` keeps alerting in the meantime.
  ⚠️ Carried rows are written with `checks.carried = 1` and the throttle only measures
  from `carried = 0` rows. Do NOT drop that filter: the carried row is the newest row
  for the component, so an unfiltered "last probe" lookup sees a 5-minute-old probe
  forever and the target is never probed again (that bug ran 2026-08-04 → 08-11 —
  one real AI probe, 2,314 copies, a status page that looked live and wasn't).

## Deploy / operate

```bash
cd status
npx wrangler deploy                         # deploy the Worker + cron
npx wrangler d1 execute sate-status --remote --file=schema.sql   # (first time)
npx wrangler d1 execute sate-status --remote --file=migrations/001_carried.sql  # existing DBs, once
curl https://sate-status.longcao.workers.dev/check               # probe now (seed)
```

- `GET /` — the status page.
- `GET /api/history` — the raw 90-day JSON.
- `GET /check` — probe on demand (gate with a `CHECK_KEY` secret:
  `npx wrangler secret put CHECK_KEY`, then call `/check?key=…`).

## Next steps

- **Pipeline health as a signal:** add a target hitting `device-api/admin/status`
  with an admin JWT (`authSecret`), and extend `runChecks` to mark **degraded** when
  `pipeline.stuck > 0` or the error rate is high — so the page turns yellow when the
  processing queue wedges, not just when a host is down.
- **Gate the page** with Cloudflare Access if it should be team-only.
