# SATE Companion — Infrastructure Docs

Reference for the **current implementation** of the SATE recorder system: the ESP32-S3
recorder firmware, the nRF52840 pendant firmware, the iOS companion app, the React/Vite
web app, the Supabase + Cloudflare backend, and the async AI pipeline that turns a
recording into a clinical result.

These files are the **detailed engineering source of truth** — for humans and for AI
coding agents. Maximum specificity is the goal: real symbol names, real file paths, real
routes, columns, and constants. They describe what is actually built and running as of
**recorder firmware `1.5.32`** and **`device-api` `v18`**, not a roadmap.

> Version numbers drift. When in doubt, `git log` and the source win over any doc — grep
> `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino` and the `[v..]` banner at the
> top of `react_app_sate-ui_update/supabase/functions/device-api/index.ts`.

## Files

| File | Covers |
|------|--------|
| [01-architecture.md](01-architecture.md) | Components, the recorder's two connectivity modes, the four end-to-end flows, where state lives, trust/auth model |
| [02-firmware.md](02-firmware.md) | ESP32-S3 recorder (`SATE_Recorder/`): board, file map, dual-core model, LVGL/internal-RAM budget, connectivity state machine, **server-verified SD reclaim**, reboot-durable recording, uploader invariants |
| [03-companion-app.md](03-companion-app.md) | Expo / React Native iOS app (`src/`): stack, source map, screens, store, `sateApi.ts` client, provisioning, BLE link, mock mode |
| [04-ble-protocol.md](04-ble-protocol.md) | BLE service/characteristics, advertising, chunk framing, control ops + status events, provision + offline-bridge flows |
| [05-backend-supabase.md](05-backend-supabase.md) | Supabase project `zlgdpivcbmaodgokkdvz`: tables, `device-api` (v18) routes, chunk assembly, session verify + firmware publish, **async processing**, storage buckets, secrets, known-stale code |
| [06-ai-pipeline.md](06-ai-pipeline.md) | The async AI pipeline: state machine on `sate_device_sessions.status`, the Cloudflare Container (`cf-processor/`), the `/process` call, segments → result, retry/watchdog, manual vs device parity |
| [07-runbook.md](07-runbook.md) | Build / flash / deploy commands, firmware version history, publishing an OTA release, `err-get-1` recipe, `resync_all`, go-live checklist, troubleshooting |
| [08-plaud.md](08-plaud.md) | Optional Plaud recorder integration: device-lock safety, where it plugs in, token-off-device auth, sync flow, flag markers |
| [09-pendant.md](09-pendant.md) | SATE Pendant (XIAO nRF52840): where it plugs in, source map, BLE profile, **SoftDevice-corruption flash trap**, nap mode |
| [10-manual-testing.md](10-manual-testing.md) | Hands-on test passes against a real board + backend |
| [11-user-testing.md](11-user-testing.md) | Plain-language recorder test script for a non-technical tester |
| [12-hardware.md](12-hardware.md) | **Deep hardware reference:** board + chips, pin map, build/flash, audio + SD layout, session metadata, **the full device↔server contract (claim/register, heartbeat, chunked upload, verify, OTA, BLE GATT)**, and the memory / RAM / core optimization playbook |
| [13-system-test.md](13-system-test.md) | **Full system test, user-side.** All 88 cases (65 P0) from `SATE_Complete_English_Test_Cases.xlsx`, rewritten as steps a person can run with a recorder, a phone and a browser — each with a **server-side note** naming the actual table, route and constant to check, plus the known defects that will make specific cases fail |
| [14-l816.md](14-l816.md) | **SATE L816 handheld recorder** (Android-only): the `55 AA` BLE protocol, the three-notify setup, the legacy length quirk, the four rules that make a transfer trustworthy, and why the ASC-VI codec pins this family to Android |
| [15-sate-app.md](15-sate-app.md) | **The SATE app** — the second Android app (reports-first, installed alongside Companion): how one codebase builds two apps, why nothing is computed on the phone, the one permitted edit (renaming a speaker), why it still runs the L816 session, and what an iOS build can and cannot be |

## System in one paragraph

A **SATE recorder** (ESP32-S3 touchscreen device, `SATE_Recorder/`) captures a patient
speech session to SD as WAV. It reaches the backend two ways: **directly over Wi-Fi**
(HTTPS to the `device-api` Edge Function) when provisioned and online, or **bridged
through the phone over BLE** when offline. Either path lands the WAV in Supabase Storage
and inserts a row into `sate_device_sessions` with `status='queued'`. The AI is **never**
run from an edge function — a long-lived **Cloudflare Container** (`cf-processor/`, Python,
`sate-processor.longcao.workers.dev`) claims the queued session, holds the `/process` call
with no wall-clock limit, then hands the transcript to the deployed **`finalize-session`**
edge fn, which runs the **same analysis** a manual web upload uses and writes a row into
`recordings` — making a device recording indistinguishable from a hand-uploaded one in the
web app. Recordings upload as **Standalone by default**; assigning a patient is optional
and done later on the web report (a server-side roster is *not* a patient assignment). The
**companion app** (`src/`) does first-time setup (BLE Wi-Fi provisioning + claiming the
device to the signed-in SLP account), bridges offline sessions, and sends remote commands.

## Components at a glance

```
┌─────────────────┐   BLE (setup + offline bridge)   ┌──────────────────┐
│  SATE recorder  │◄────────────────────────────────►│  Companion app   │
│  ESP32-S3 fw    │                                   │  Expo / RN iOS   │
│  1.5.32         │                                   │  (src/)          │
│ (SATE_Recorder/)│                                   └────────┬─────────┘
└────────┬────────┘                                            │
         │ HTTPS (Wi-Fi, when online)                          │ HTTPS (Supabase Auth
         │  device-key auth                                    │  + device-api, user JWT)
         ▼                                                     ▼
┌───────────────────────────────────────────────────────────────────────────┐
│  Supabase  project SATE  (ref zlgdpivcbmaodgokkdvz)                         │
│  Edge fns: device-api [v18]  ·  finalize-session  ·  process-device-session │
│                                 (must be a prod NO-OP)                       │
│  + Postgres (sate_device_sessions, recordings, sate_firmware, …) + Storage  │
└───────────────┬────────────────────────────────────────┬───────────────────┘
   status='queued'                                        ▲ finalize (analysis + insert recordings)
                │ claim_next_session() (atomic, SKIP LOCKED)                    │
                ▼                                                               │
   ┌──────────────────────────────┐   holds /process (no wall-clock)   ┌───────┴────────┐
   │  Cloudflare Container         │──────────────────────────────────►│  AI  /process   │
   │  cf-processor/ (Python)       │◄──── {segments} ──────────────────│  ngrok, CUDA    │
   │  sate-processor.workers.dev   │   pg_cron /tick keeps it warm      └────────────────┘
   └──────────────────────────────┘
```

- **AI never runs in an edge/Worker fetch.** Supabase edge has a hard ~150 s wall-clock
  and a plain Worker has the ~100 s 524 origin timeout — either kills a long transcription
  mid-call. The long call lives only in the container. See [06-ai-pipeline.md](06-ai-pipeline.md).
- **Async retry:** the `requeue_stale_sessions` watchdog reclaims jobs stuck in `processing`
  past `STUCK_MINUTES=90` up to `MAX_ATTEMPTS=3`; the AI read timeout is `AI_READ_TIMEOUT_S=3600`
  (1 h). `pg_cron` pings the Worker `/tick` every minute to keep the container warm.
- **`process-device-session` must be a 200 no-op in prod** — the container does the work.
  ⚠️ The copy checked into the repo is **NOT** the no-op (it still downloads the WAV, awaits
  the AI, and inserts `recordings`), which would race the container and duplicate rows. Do
  not deploy the repo file as-is. See [05-backend-supabase.md](05-backend-supabase.md).
- **`finalize-session`** is deployed (`.../functions/v1/finalize-session`, `verify_jwt:false`)
  but its source is **not** in the repo tree — only `device-api/` and `process-device-session/`
  live under `react_app_sate-ui_update/supabase/functions/`.

## Repository layout (current top level)

```
sate-companion/
├── src/                        Companion app (Expo / React Native, iOS-only for Plaud)
│   ├── screens/  ble/  api/  components/  devices/  sync/
│   ├── plaud/                  Plaud SDK link (device-lock safety — CLAUDE.md RULE #1)
│   ├── pendant/                Pendant BLE link + store
│   └── protocol.ts  store.tsx  theme.ts
├── SATE_Recorder/              Recorder firmware (Arduino / ESP32-S3, fw 1.5.32)
│   ├── SATE_Recorder.ino  connectivity.{cpp,h}  display.{cpp,h}  es8311.*
│   └── lv_conf.reference.h     (real lv_conf.h lives in ~/Documents/Arduino/libraries/)
├── SATE_Pendant/               Pendant firmware (XIAO nRF52840) + flash_xiao.sh, HARDWARE.md
├── react_app_sate-ui_update/   SATE web app (Vite/React) + the live Supabase backend
│   ├── src/                    Web app source (components, hooks, services, lib, contexts)
│   └── supabase/functions/     Edge fns: device-api [v18], process-device-session
├── cf-processor/               Cloudflare Container — the async AI processor (Python)
│   ├── app/{main.py,processor.py}   claim → download → hold /process → finalize
│   └── src/index.ts  Dockerfile  wrangler.toml   (sate-processor.longcao.workers.dev)
├── cloudflare/                 Parallel backend port: Workers + D1 + R2 (NOT the live stack)
│   └── src/{auth,rest,storage,policy,rpc,email}.ts  functions/  web/  schema.sql
├── hwtest/                     Hardware-in-the-loop test harness (Python) + SATE Debugger.app
│   ├── run.py  gui.py  dashboard.py  debugger.py  pipeline_view.py  hwtest/  ci-reports/
│   └── sate                    `sate ci|e2e|infra|gui|debug|flash|pipeline` CLI wrapper
├── status/                     Status page Cloudflare Worker (+ D1) — 90-day uptime + email alerts
├── monitoring/                 Service-monitor SPA (index.html) — polls device-api /admin/status
├── docs-site/                  Public Docusaurus site (the OPPOSITE of doc/ — audience-facing)
├── mock-server/                Node mock backend for local dev
└── doc/                        ← this folder (detailed internal handbook)
```

Notes on what actually lives where:

- The recorder sketch folder is **`SATE_Recorder/`** (not `firmware/`); the folder name
  matches `SATE_Recorder.ino` so `arduino-cli` builds it in place. Board = 16 MB flash +
  8 MB octal PSRAM, partition `default_8MB` (dual OTA). See [02-firmware.md](02-firmware.md)
  and [07-runbook.md](07-runbook.md).
- The **live** backend is Supabase, deployed from `react_app_sate-ui_update/supabase/`.
  `cloudflare/` is a **separate, self-contained** Workers+D1+R2 re-implementation
  (`cloudflare/src/policy.ts` re-implements tenant isolation because D1 has no RLS) — it does not
  touch the Supabase stack, the web `src/`, or the firmware.
- **Error-email alerting**: the `status/` Worker (`status-sate.long-cao.dev`, cron
  every 5 min) plus `device-api`'s secret-gated `GET /api/health/alerts?key=…` (v18) email
  the operator (`caothohoanglong2404@gmail.com`) via the Cloudflare Email binding on any new
  pipeline error / stuck job, and once more when it clears.
- `hwtest/` is the firmware release gate: `sate ci` builds + flashes the debug build and
  runs `boot_health`, `reboot_resume`, `byte_match`, `verified_trim` against a real board,
  writing `hwtest/ci-reports/fw-<version>_<stamp>.json`. No firmware ships without a passing
  report. See [07-runbook.md](07-runbook.md).

## Related root docs

- `hardware-supabase.md` — the original device → Supabase → AI → `recordings` integration note.
- `plaud-integration.md` — Plaud "Connect with Plaud" build steps + file map (see [08-plaud.md](08-plaud.md)).
- `CLAUDE.md` — project rules & accumulated gotchas (Plaud device-lock safety, the one-shared-BleManager rule, build/verify commands, the async-AI redesign).
- `doc.md` / `progress.md` — chronological work log / change history.
- `SETUP.md` / `README.md` — coworker setup + prebuilt flash assets (see the GitHub Release per firmware tag).

The `doc/` folder reorganizes the same material into topic files; the root docs remain as
deep-dives and history.

## Published doc sites

Two Docusaurus sites are deployed, from two different content sets:

- **Public** — `docs-site/` → **[sate-docs.pages.dev](https://sate-docs.pages.dev)** (no auth). A
  general/conceptual product & architecture overview: **no source-file names, function names, or
  line numbers**. Deploy: `cd docs-site && npm run deploy:cf`.
- **Private** — `docs-site-internal/` → **[sate-docs-internal.pages.dev](https://sate-docs-internal.pages.dev)**,
  HTTP Basic Auth (user `sate`; password in the Cloudflare `SITE_PASSWORD` secret — never in git; the
  gate fails closed if unset). This is **the detailed handbook** — it regenerates from THIS `doc/`
  folder at deploy time (`cd docs-site-internal && npm run deploy:cf` syncs `../doc/*.md` first), so
  `doc/` stays the single source of truth. Auth logic: `docs-site-internal/functions/_middleware.js`.
