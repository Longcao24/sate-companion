---
title: Architecture
sidebar_position: 2
---

# Architecture & data flow

How a recording travels from a device to the clinician's report — and why the long AI
step runs in a long-lived container rather than a serverless function.

<div class="badge-row">
<span class="sate-badge">async pipeline</span>
<span class="sate-badge">state machine</span>
<span class="sate-badge">Cloudflare Container</span>
</div>

## End-to-end: a recording's journey

```mermaid
sequenceDiagram
  participant D as Recorder
  participant API as device-api (edge)
  participant S as Storage
  participant DB as Postgres
  participant P as cf-processor (container)
  participant AI as AI /process
  participant W as Web app

  D->>D: Record → 1-min WAV segments on SD (flush ~5s)
  D->>API: POST /sessions/chunk (offset, final, total)
  API->>S: assemble parts, verify byte count
  API->>DB: insert sate_device_sessions (status=queued)
  API->>P: kick the processor (Worker /tick wakes container)
  Note over P: pg_cron /tick also keeps it warm
  P->>DB: claim_next_session() (SKIP LOCKED) → processing
  P->>S: download the WAV from Storage
  P->>AI: hold the long transcription call
  P->>S: copy audio to recordings bucket
  P->>API: finalize-session (analysis + insert recordings + done)
  W->>DB: read recordings
  W->>S: signed URL → play audio
```

**Who triggers what.** The audio never flows *through* Cloudflare. `device-api` (the Supabase
edge function) is the only thing devices talk to: it stores the assembled WAV in Storage and
queues the session, then **kicks off processing** (a fire-and-forget trigger). The long-lived
Cloudflare container is woken by the Worker's `/tick` endpoint — pinged every minute by
`pg_cron` and designed to also be poked by `device-api` on new audio — after which it
**claims the queued session and pulls the WAV from Storage itself** before holding the AI
call. So the path is **edge fn → Cloudflare → Storage**: Cloudflare reads the audio out of
Storage; the edge function never streams audio to it, and the device never uploads to
Cloudflare directly.

:::note Upload transport history
Earlier firmware streamed device audio to Supabase over a **WebSocket**. The current path is
**resumable chunked HTTPS** (`POST /sessions/chunk`) — the server reassembles the ~1 MB
slices and byte-verifies before accepting, which survives drops and mid-upload reboots that a
single long-lived socket could not.
:::

## Why processing is asynchronous

Supabase edge functions have a **hard ~150 s wall-clock limit** (not configurable).
A long transcription exceeds it, and the worker is **killed mid-fetch before the
`try/catch`**, so the session hangs in `processing` forever. The fix is a **state
machine** on `sate_device_sessions.status` (`queued → processing → done | error`)
drained by a **long-lived Cloudflare Container** (`cf-processor/`) that has no
wall-clock limit and holds the AI call itself.

<div class="spec-grid"><div class="spec-tile"><div class="k">Edge wall-clock limit</div><div class="v">~150 s</div></div><div class="spec-tile"><div class="k">CF Worker 524 origin</div><div class="v">~100 s</div></div><div class="spec-tile"><div class="k">Container wall-clock</div><div class="v">none</div></div></div>

The status column moves through exactly four states — the container is the only thing
that can hold `processing` long enough to reach `done`:

```mermaid
stateDiagram-v2
    [*] --> queued: insert sate_device_sessions (status=queued)
    queued --> processing: claim_next_session() (SKIP LOCKED)
    processing --> done: finalize-session inserts recordings
    processing --> error: failure
    done --> [*]
    error --> [*]
```

:::warning Never move the AI call back into an edge/Worker fetch
Any serverless request (Supabase edge **or** a plain CF Worker with its ~100 s 524
origin timeout) will kill a long transcription. The long call must live in the
container. See [Backend pipeline](guides/backend).
:::

## Capture paths

```mermaid
flowchart TD
  subgraph Recorder path
    R1["RECORD button"] --> R2["segments on SD"]
    R2 --> R3{"online?"}
    R3 -- "Wi-Fi" --> R4["chunked HTTPS upload"]
    R3 -- "offline" --> R5["BLE bridge → app relays"]
  end
  subgraph Pendant path
    P1["BLE notify (PCM)"] --> P2["app assembles WAV"]
    P2 --> P3["app HTTPS upload"]
  end
  R4 --> API["device-api"]
  R5 --> API
  P3 --> API
```

- **Recorder (online):** uploads directly over Wi-Fi in ~1 MB chunks; the server
  reassembles and byte-verifies before accepting.
- **Recorder (offline):** the mobile app pulls sessions over a BLE bridge and
  relays them to `device-api`.
- **Pendant:** always via the app — it streams PCM over BLE, the app wraps a WAV
  and uploads (`device_serial = pendant-<bleId>`).

## Storage & data model (summary)

| Bucket / table | Visibility | Holds |
|---|---|---|
| `device-sessions` (Storage) | **private** (signed URLs) | raw uploaded WAVs |
| `recordings` (Storage) | **private** (signed URLs) | processed audio for the report |
| `firmware` (Storage) | **public** | OTA `.bin` images |
| `sate_device_sessions` (DB) | RLS by user | upload + processing state machine |
| `recordings` (DB) | RLS by user/patient | transcript, analysis, flags |
| `patients` (DB) | RLS by SLP | patient roster |

Full schema and RLS notes: [Reference → Data model](reference/data-model).

## Concurrency notes

- **Recorder:** connectivity runs on a **core-0** FreeRTOS task; GUI + buttons +
  recording on **core-1**. They share the SD/FATFS volume, guarded cooperatively
  by a `uiSdBusy` flag. See [Recorder firmware](guides/recorder#concurrency-model).
- **Mobile:** three BLE stacks (SATE, Pendant, Plaud) share **one** `BleManager`
  via a radio arbiter (`src/ble/radio.ts`). See [Mobile app](guides/mobile-app).
