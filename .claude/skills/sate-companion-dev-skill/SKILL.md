---
name: sate-companion-dev-skill
description: Operational playbook for working on the SATE Companion system — the ESP32-S3 recorder firmware, the nRF52840 pendant firmware, the React Native mobile app, the React/Vite web app, and the Supabase + Cloudflare backend. Use this whenever a task involves building, flashing, deploying, testing, or editing ANY part of the sate-companion repo. It encodes the safety invariants that can brick a device or lose patient audio, the real build/run/release commands, and a mandatory pre-flight review.
---

# SATE Companion — Dev Skill

SATE Companion is a speech-capture and analysis platform for speech-language pathologists:
a handheld **recorder** (ESP32-S3) and a wearable **pendant** (nRF52840) capture audio, a
**mobile app** (React Native / iOS) and **web app** (React/Vite) surround it, and a
**Supabase + Cloudflare** backend runs an async AI pipeline that transcribes and analyses.

## When to use this skill

Use it for any task that touches this repo: firmware edits/flashing, app or web changes,
backend/edge-function or Cloudflare processor work, firmware releases/OTA, or hardware
testing. It keeps you from the mistakes that permanently brick a Plaud device, break the
shared BLE radio, hang the AI pipeline, or lose a patient's recording.

## Where the source of truth lives

- **`CLAUDE.md`** (repo root) — the **agent doc**. It carries the line-precise, code-anchored
  detail (exact functions, files, and line numbers). When you need to know *exactly where* a
  behavior lives, read it there. Keep line-precise notes here, not in the published docs.
- **`doc/01..09`** — the numbered engineering handbook (architecture, firmware, app, BLE,
  backend, AI pipeline, runbook, plaud, pendant).
- **`docs-site/`** — the published human docs ([sate-docs.pages.dev](https://sate-docs.pages.dev)):
  *how it works*, deliberately **without** line numbers so it stays maintainable.
- **`git log`** — the ground truth for current firmware/edge-fn versions (numbers drift).

## Common tasks → what to do

| Goal | Do this |
|---|---|
| **Build / flash the recorder** | `references/build-flash-release.md` → recorder section (FQBN with `default_8MB`; check `lv_conf.h`). |
| **Build / flash the pendant** | `./SATE_Pendant/flash_xiao.sh SATE_Pendant` (Seeed core only). See `references/build-flash-release.md`. |
| **Cut a firmware release + OTA** | Bump `FIRMWARE_VERSION` → compile → upload the app `.bin` to the `firmware` bucket + insert a `sate_firmware` row → verify 200 + SHA → `reboot` then `ota`. Full recipe in `references/build-flash-release.md`. |
| **Run the mobile app** | `npm install && npm run ios` (physical iOS device; Plaud has no simulator). Read RULE #1/#2 first if touching Plaud/BLE. |
| **Run / deploy the web app** | `cd react_app_sate-ui_update && npm run dev`; `npm run build` before `git subtree push … webapp <branch>`. |
| **Deploy backend edge fns** | `supabase functions deploy <fn> --no-verify-jwt`. Never `verify_jwt:true`. See `references/backend-and-testing.md`. |
| **Touch the AI pipeline** | Keep the long call in `cf-processor` (container); `process-device-session` stays a 200 no-op. `references/backend-and-testing.md`. |
| **Verify a firmware change** | Run the `hwtest/` harness on a real board (`python3 run.py --config config.toml`). Never ship firmware unverified. |
| **Edit / deploy the docs** | `cd docs-site && npm start`; `npm run deploy:cf`. Keep line numbers OUT of published docs. |
| **Anything touching Plaud / BLE / audio integrity** | STOP and read `references/safety-invariants.md` + `CLAUDE.md` first — these are the brick / data-loss paths. |

## MANDATORY pre-flight review (run all 5 rows before you change anything)

Fill this in for the task at hand. If any row is unchecked, stop and resolve it first.

| # | Review row | What to confirm before writing code |
|---|---|---|
| 1 | **Blast radius** | Which component(s) does this touch — recorder / pendant / app / web / backend? Read the matching `doc/0N-*.md` **and** the relevant section of `CLAUDE.md` first. |
| 2 | **Plaud device-lock safety** | If it touches Plaud connect/identity/Keychain/BLE lifecycle/account/sync at all, re-read `CLAUDE.md` RULE #1 and `doc/08-plaud.md`. A mis-bound Plaud is **permanently bricked**. Preserve all 5 invariants (stable `sate_<uid>` identity, bind-guard, Keychain binding, no auto-depair, ACK-before-forget). |
| 3 | **Shared BLE radio** | If it touches SATE/Pendant BLE, honor `CLAUDE.md` RULE #2: SATE + Pendant **share one `BleManager`**; handoff is `stopScan()` only, **never destroy** (destroying → zero-device scans). Only `src/ble/radio.ts` hands the radio over; `acquireRadio()` is called synchronously in the `App.tsx` nav handler, never in an effect. |
| 4 | **Data-integrity & no-stuck** | Will this risk losing/mismatching patient audio or wedging a feature? Keep audio the device's only copy until server-verified; SD reclaim is **server-verified** (`GET /api/sessions/verify`, byte-exact) never on the `.synced` marker alone; never move the long AI call into an edge/Worker fetch (~150 s edge / ~100 s 524 kills it — it lives in the `cf-processor` container). |
| 5 | **Build + verify path** | Know how you'll compile and verify BEFORE editing (commands below). Firmware changes must be checked with the **hardware-in-the-loop harness** (`hwtest/`) on a real board — a compiler can't catch reboot-mid-record, dropped-BLE truncation, delete-during-upload splicing, verified trim, or crash-safe delete. |

## Build / run / verify (real commands)

**Recorder firmware (ESP32-S3)** — folder name matches the `.ino`, builds in place:
```bash
arduino-cli compile --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
arduino-cli upload -p <port> --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" SATE_Recorder
```
Two silent bricks to check first: `PartitionScheme` MUST be `default_8MB` (dual OTA slots — never `huge_app`); `lv_conf.h` `LV_TICK_CUSTOM` MUST be `1` (else the boot spinner freezes though `setup()` finishes). Re-check `lv_conf.h` after any `arduino-cli lib install lvgl`.

**Pendant firmware (nRF52840)** — Seeed core only (Adafruit Feather core bricks the BLE stack at `0x26000`):
```bash
./SATE_Pendant/flash_xiao.sh SATE_Pendant     # FQBN Seeeduino:nrf52:xiaonRF52840SensePlus
```

**Mobile app (Expo, iOS-only for Plaud — physical device, no simulator):**
```bash
npm install && npm run ios        # expo run:ios (dev client); npm start = Metro
npx tsc --noEmit                   # typecheck (filter react_app_sate-ui_update @/… alias noise)
xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build   # compile-check native module
```

**Web app (React 19 + Vite 6):**
```bash
cd react_app_sate-ui_update && npm install
npm run dev
npm run build        # tsc -b && vite build — REQUIRED before push (noUnusedLocals fails on unused vars)
git subtree push --prefix=react_app_sate-ui_update webapp <branch>   # deploy (Vercel builds the subtree)
```

**Backend** — edge fns validate their own tokens, so ALWAYS `--no-verify-jwt`:
```bash
supabase functions deploy device-api --no-verify-jwt
supabase functions deploy finalize-session --no-verify-jwt
supabase functions deploy mint-plaud-token --no-verify-jwt
```
The long AI call lives in `cf-processor/` (Cloudflare container), triggered via the Worker `/tick` (kept warm by `pg_cron`); it pulls the WAV from Storage itself. `process-device-session` must stay a 200 no-op in prod — do NOT deploy the repo copy, which still processes.

**Hardware-in-the-loop tests (run before any firmware release):**
```bash
cd hwtest && python3 run.py --sim            # self-test, no hardware
python3 run.py --config config.toml          # recorder over USB serial
python3 run.py --target pendant --config config.toml
python3 gui.py                               # native window   |   python3 dashboard.py = browser
```

**Docs site:**
```bash
cd docs-site && npm install && npm start      # dev
npm run build && npm run deploy:cf            # build + wrangler pages deploy → sate-docs.pages.dev
```

## Firmware release (condensed — full recipe in `CLAUDE.md` / `doc/07-runbook.md`)

1. Bump `FIRMWARE_VERSION` in the sketch, compile with the FQBN above (`default_8MB`, not `huge_app`).
2. The OTA image is the **app** bin (`SATE_Recorder.ino.bin`), not `.ino.merged.bin`.
3. Publish: upload the `.bin` to the public `firmware` Storage bucket at `sate_<version>.bin`
   (`upsert`) + insert a `sate_firmware` row `{version, url, notes}`. Verify the public URL 200s
   and its SHA-256 matches the local bin.
4. OTA on a device with a backlog fails `err-get-1` — queue `reboot`, wait, then `ota`.

## Reference playbooks (load as needed)

Deeper, task-specific playbooks live alongside this file in `references/`:

- **`references/safety-invariants.md`** — the five production guardrails in full (Plaud
  device-lock, shared BleManager, no-serverless-AI, server-verified SD reclaim, flash traps).
  Read this before any change to Plaud, BLE, the pipeline, or firmware flashing.
- **`references/build-flash-release.md`** — every build/flash/run command per component, plus
  the firmware-release + OTA recipe and the flash gotchas.
- **`references/backend-and-testing.md`** — the async AI pipeline shape, edge-fn deploy commands,
  the `process-device-session` hazard, and the `hwtest/` hardware-in-the-loop harness.

## Doc conventions (so this stays maintainable)

- **Published docs (`docs-site/`)**: describe how it works. Keep file/function names for
  navigation, but **no line numbers** — they churn on every edit.
- **Agent doc (`CLAUDE.md`) + `doc/`**: this is where line-precise, code-anchored detail belongs.
- After changing behavior, update the matching `docs-site` page **and** `CLAUDE.md`.
