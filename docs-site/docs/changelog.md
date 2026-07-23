---
title: Version log
sidebar_position: 8
---

# Version log

The canonical record of **every released version** of each component. Update the
relevant table on every release. Versions are independent per component (the
recorder firmware, the app, and the web app do **not** share a number).

<div class="badge-row">
<span class="sate-badge">recorder 1.5.18</span>
<span class="sate-badge">pendant 1.0.0</span>
<span class="sate-badge">app 0.1.0</span>
<span class="sate-badge">web 1.5.9</span>
<span class="sate-badge">device-api v15</span>
</div>

```mermaid
timeline
  title Recorder firmware timeline
  2026-06 : 0.8.2 segmented WAV : 1.0.1 chunk upload : 1.0.6 GPIO9 battery fix
  2026-06 to 07 : 1.5.0 SLP UI + telemetry : 1.5.1-1.5.8 battery/mic/loudness
  2026-07 : 1.5.9 device-holds-only-copy : 1.5.12 reclaim keep-newest-5
  2026-07-22 : 1.5.13 server-verified trim + auto-resume + crash-safe delete : 1.5.14 screen mirror
  2026-07-23 : 1.5.15 remote stop : 1.5.16 remote takes resume : 1.5.17 resume keeps the network up : 1.5.18 stop never swallowed
```

## Where each version is defined (source of truth)

| Component | Field / source of truth | Current |
|---|---|---|
| Recorder firmware | `SATE_Recorder/SATE_Recorder.ino` → `FIRMWARE_VERSION` | **1.5.18** |
| Pendant firmware | `SATE_Pendant/SATE_Pendant.ino` → `FIRMWARE_VERSION` (added 2026-07-22) | **1.0.0** |
| Mobile app | `app.json` `version` (+ `package.json`) | **0.1.0** |
| Web app | `react_app_sate-ui_update/package.json` `version` | **1.5.9** |
| Backend (`device-api`) | in-comment `[vNN]` header of `.../functions/device-api/index.ts` | **v15** |

:::note Pendant version field (new)
`SATE_Pendant.ino` now has a `FIRMWARE_VERSION` constant (`1.0.0`, added 2026-07-22)
so releases can be logged here. It is **not yet exposed over BLE** — add a version
characteristic (or a Device Information Service firmware-revision string) so the app
can read/verify what's flashed. The device already ships a `BLEDfu` OTA service.
:::

> `git log` remains the ground truth for what actually shipped; this page is the
> human-readable summary. The recorder **source** version can be ahead of the
> **GitHub release asset** tag (e.g. `FIRMWARE_VERSION=1.5.13` while prebuilt bins
> are still tagged `fw-1.5.12` if no release was cut).

---

## Recorder firmware

| Version | Date | Notes |
|---|---|---|
| **1.5.18** | 2026-07-23 | **A remote `stop` issued while a take is starting is no longer swallowed.** Take start cleared `connStopReq` outright to drop a stale stop, which also threw away a stop that arrived during the take's own start sequence — the status screen and its ~1.5 s GUI pump. A resumed take, which is stopped from the server the moment it is noticed, hit that window every time and then ran on for minutes with nothing able to end it (observed: 4.5 minutes, `part 6`, 8.6 MB). A stop is now latched only while a take is *armed* — set before the start sequence, cleared when capture returns — so it can never go stale and never be dropped. Full hands-off suite green on hardware: `boot_health`, `reboot_resume`, `byte_match`, `verified_trim`. |
| 1.5.17 | 2026-07-23 | **Resume runs from `loop()`, not `setup()` — fixes a device that goes dark after a mid-take reboot.** `maybeResumeRecording()` blocks inside the capture until Stop, so calling it at the end of `setup()` meant `loop()` never ran and `connStartNetTask()` never started: the unit recorded on with **no heartbeat, no remote `stop`, and no serial** — unreachable until someone pressed the button or the ~62-min ceiling hit. Latent before 1.5.16 (only button takes resumed, and an operator was there to stop them); 1.5.16 made *every* take resume, which exposed it. The resume now waits for the net task (or ~8 s if offline), so a resumed take stays controllable for its whole length. Verified on hardware: `[CONN] Online` → `[REC] resume session 24 from part 1 (321536 bytes already on card)` → remote `stop` accepted. |
| 1.5.16 | 2026-07-23 | **Remote takes auto-resume after a reboot.** `recCrashMark()` now marks *every* take crash-resumable (was on-device/`review` takes only), so a server/app-started recording interrupted by a brownout continues instead of ending early — from local NVS + the SD segments alone, **no Wi-Fi or server needed**. Added `[REC] resume …` diagnostics: the resume path was previously silent, so a failed resume was invisible; every branch now logs why (incl. the boot-loop guard, missing patient, missing `part00`). |
| 1.5.15 | 2026-07-23 | **Remote `stop` command.** A server/app-started take could previously only be ended at the device (or by the ~62-min ceiling) — `REMOTE_RECORD_SECONDS` was declared but never used, so a remote take ran unbounded. `stop` ends the take exactly like the RECORD button. Verified on hardware: rescued a unit stuck recording (`state: recording → idle`). |
| 1.5.14 | 2026-07-22 | **On-demand screen mirror**: a `SCREENDUMP` serial command base64-streams one RGB565 `lv_snapshot` of the active screen. **DEBUG (USB-CDC) builds only** (gated on `ARDUINO_USB_CDC_ON_BOOT`), never auto-fires, refuses while recording; production carries none of the code. Powers `sate screenshot` / the desktop Debugger app. |
| 1.5.13 | 2026-07-22 | **Server-verified trim** (`GET /api/sessions/verify` before freeing SD audio) · reboot **auto-resume** of a local take (~5 s flush + restart empty `part00`) · **crash-safe delete/renumber** (NVS journal + boot heal). Source only — no GitHub release cut yet. |
| 1.5.12 | 2026-07-21 | Sketch restructure + full hardware doc refresh; bounded reclaim `trimPatientSyncedAudio` (keep newest 5 synced sessions per patient). |
| 1.5.9 | 2026-07 | Reclaim policy change: device holds the only copy until user delete (the three old auto-purge paths removed). |
| 1.5.5 – 1.5.8 | 2026-07-01 | Battery calibration, Wi-Fi TX power, mic gain, loudness. |
| 1.5.1 – 1.5.4 | 2026-07-01 | Unstick save; charging + battery fix; add cell-mV telemetry. |
| 1.5.0 | 2026-06-30 | SLP-focused recorder UI, auto-dim, device telemetry to admin. |
| 1.0.6 | 2026-06 | Battery ADC on GPIO34 (wrong for S3) → bootloop; fixed by moving to GPIO9. |
| 1.0.x | 2026-06-16 | OTA firmware updates, battery %, MAC onboarding, web update UI. |
| 1.0.1 | 2026-06-14 | Companion app → Supabase; chunk-upload path fix. |
| 0.8.2 | 2026-06-13 | Record long sessions as 1-min segments + merge. |

:::note Upload transport migration
Early builds streamed device audio to Supabase over a **WebSocket**. That was replaced by
the current **resumable chunked HTTPS** upload (`POST /sessions/chunk`, byte-verified on
assembly), which survives connection drops and mid-upload reboots a single long-lived socket
could not. See [Architecture → Who triggers what](architecture).
:::

## Pendant firmware

| Version | Date | Notes |
|---|---|---|
| **1.0.0** | 2026-07 | First versioned pendant firmware. BLE PCM streaming (16 kHz mono, 244 B notifies), DC-block HPF + tanh soft-clip gain, nap mode, overrun guard, DC/DC regulator, `BLEDfu` OTA. (Pendant work landed 2026-07-10; sketch moved to `SATE_Pendant/` 2026-07-21; `FIRMWARE_VERSION` field added 2026-07-22.) |

## Mobile app

| Version | Date | Notes |
|---|---|---|
| **0.1.0** | current | Recorder + Pendant + Plaud support; auto-sync; QR/mobile-link login. |

## Web app

| Version | Date | Notes |
|---|---|---|
| **1.5.9** | current | Clinician report, SALT transcript editing, annotations, clinical metrics, admin firmware publish, Stripe billing. |

## Backend — `device-api`

| Version | Date | Notes |
|---|---|---|
| **v15** | 2026-07-22 | `GET /sessions/verify` (device-key, read-only) · `storeSessionRecord` idempotency probe (dedup a re-uploaded take) · `publishFirmware` validation (semver + `0xE9` magic + size). |
| v14 | — | Async processing state machine on `sate_device_sessions.status` (`queued→processing→done\|error`, `attempts`) · `POST /sessions/:id/retry`. Processing moved to the container; `process-device-session` became a 200 no-op. |
| v12 | — | `/sessions/chunk` stores each slice as its own part and stitches on final (was quadratic) · accepts `&total=` from firmware ≥1.5.9 and rejects a size mismatch. |

---

## How to add a release entry

1. Bump the version **in its source of truth** (table at the top).
2. Add a row to that component's table here: `| <version> | <YYYY-MM-DD> | <what changed> |`.
3. For firmware, also follow [Firmware release & OTA](operations/firmware-release)
   (build, publish the `.bin`, insert the `sate_firmware` row).
4. Commit both together so `git log` and this page agree.

The **live** deployed versions (what's actually running in the field) will also
surface in the service-monitoring dashboard — the recorder reports its `fw` in each
heartbeat, and the app/web report their build version.
