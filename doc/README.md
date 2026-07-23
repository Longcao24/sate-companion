# SATE Companion — Infrastructure Docs

Reference for the **current implementation** of the SATE recorder system: hardware
firmware, the iOS companion app, the Supabase backend, and the AI pipeline that turns
a recording into a clinical result.

These files describe what is actually built and running, not a roadmap.

## Files

| File | Covers |
|------|--------|
| [01-architecture.md](01-architecture.md) | Components, the four end-to-end data flows, where state lives |
| [02-firmware.md](02-firmware.md) | ESP32-S3 recorder: board, file map, state machine, connectivity, optimization |
| [03-companion-app.md](03-companion-app.md) | Expo / React Native iOS app: screens, store, API client, auth |
| [04-ble-protocol.md](04-ble-protocol.md) | BLE service/characteristics, advertising, framing, ops + events |
| [05-backend-supabase.md](05-backend-supabase.md) | Supabase project: tables, edge functions, storage buckets, auth |
| [06-ai-pipeline.md](06-ai-pipeline.md) | AI `/process` call, error counting + speech analysis, manual vs device parity |
| [07-runbook.md](07-runbook.md) | Build / flash / deploy commands, go-live checklist, troubleshooting |
| [08-plaud.md](08-plaud.md) | Optional Plaud recorder integration: BLE sync into the same `recordings` pipeline |

## System in one paragraph

A **SATE recorder** (ESP32-S3 touchscreen device) captures a patient speech session to
SD as WAV. It reaches the backend two ways: **directly over Wi-Fi** (HTTPS to a Supabase
Edge Function) when provisioned and online, or **bridged through the phone over BLE** when
offline. Either path lands the WAV in Supabase, which runs it through the **same AI** a
manual web upload uses, auto-assigns it to the SLP's patient, and writes a row into the
`recordings` table — making a device recording indistinguishable from a hand-uploaded one
in the web app. The **companion app** does first-time setup (BLE Wi-Fi provisioning +
claiming the device to the signed-in SLP account), bridges offline sessions, and sends
remote commands.

## Components at a glance

```
┌─────────────────┐   BLE (setup + offline bridge)   ┌──────────────────┐
│  SATE recorder  │◄────────────────────────────────►│  Companion app   │
│  ESP32-S3 fw    │                                   │  Expo / RN iOS   │
│  (firmware/)    │                                   │  (src/)          │
└────────┬────────┘                                   └────────┬─────────┘
         │ HTTPS (Wi-Fi, when online)                          │ HTTPS (Supabase Auth + device-api)
         │                                                     │
         ▼                                                     ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Supabase  project SATE  (ref zlgdpivcbmaodgokkdvz)                     │
│  Edge fns: device-api, finalize-session (+ Cloudflare container)   +  Postgres + Storage  │
└───────────────────────────────┬───────────────────────────────────────┘
                                 │ multipart audio_file
                                 ▼
                   ┌──────────────────────────────┐
                   │  AI  https://sate-v1-5.ngrok  │
                   │  .io/process  → {segments}    │
                   └──────────────────────────────┘
```

## Repository layout

```
sate-companion/
├── src/                                   companion app (Expo / React Native)
│   ├── screens/  ble/  api/  components/  sync/
│   ├── protocol.ts   store.tsx   theme.ts
├── SATE_Recorder/                         recorder firmware (Arduino / ESP32-S3, fw 1.5.13)
│   ├── SATE_Recorder.ino  connectivity.*  display.*  es8311.*  lv_conf.reference.h
├── SATE_Pendant/                          pendant firmware (XIAO nRF52840) + flash_xiao.sh
├── react_app_sate-ui_update/              SATE web app (Vite/React) + Supabase
│   ├── src/                               web app source
│   └── supabase/functions/                edge functions (device-api, process-device-session, …)
├── mock-server/                           Node mock backend for local dev
└── doc/                                   ← this folder
```

## Related root docs

- `hardware.md` — deep hardware reference + the memory/RAM/core optimization playbook.
- `hardware-supabase.md` — the original device→Supabase→AI→`recordings` integration note.
- `doc.md` — chronological work log / change history.
- `plaud-integration.md` — Plaud "Connect with Plaud" build steps + file map (see [08](08-plaud.md)).

The `doc/` folder reorganizes the same material into topic files; the root docs remain as
deep-dives and history.
