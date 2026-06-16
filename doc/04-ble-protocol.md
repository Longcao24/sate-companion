# 04 — BLE protocol

Recorder ↔ companion app over BLE: provisioning and offline bridge sync. The same constants are
mirrored by the firmware (NimBLE). Canonical definition: `src/protocol.ts`.

## Service + characteristics

Service UUID `53415445-0001-4a7e-8c5e-000000000001` (`"SATE\0\x01…"`).

| Char | UUID suffix | Properties | Payload |
|------|-------------|------------|---------|
| `CHAR_INFO` | `…0010` | Read | One-shot identity JSON `{ model, fw, serial, provisioned }` |
| `CHAR_CONTROL` | `…0020` | Write | JSON commands from app (chunk-framed if large) |
| `CHAR_STATUS` | `…0030` | Notify | JSON events from device (chunk-framed) |
| `CHAR_DATA` | `…0040` | Notify | Raw WAV bytes for a pulled session (chunk-framed) |

Connect requests MTU 247.

## Advertising

Service UUID + 4 bytes manufacturer data:

```
[0] 0x5A magic   [1] flags   [2] pending sessions (0-255)   [3] reserved
flags bit0 (0x01) = unprovisioned (needs setup)
flags bit1 (0x02) = needs sync    (has pending sessions, no Wi-Fi)
```

The app reads this during scan to show "needs setup" / "needs sync" / pending count **without
connecting**. (On Android `ble-plx` prepends the 2-byte company id, so the parser checks offsets
0 and 2.)

## Chunk framing

Any payload (JSON or binary) larger than one packet is split:

```
[ flag : 1 byte ][ payload bytes ]
flag 0x01 = partial (more follow)
flag 0x02 = final packet of the message
```

`FrameAssembler` reassembles partials until a final frame; `frameChunks()` splits with a 180-byte
payload MTU. Both `CHAR_STATUS` and `CHAR_DATA` use the same flag byte.

## Control ops (app → device, `CHAR_CONTROL`)

| Op | Args | Effect |
|----|------|--------|
| `scan_wifi` | — | Device async-scans Wi-Fi, replies `ev:scan` (not used in BLE-only onboarding) |
| `provision` | `ssid, pass, server, claim_token` | Join Wi-Fi + register/claim; streams `ev:state` |
| `list_sessions` | — | Replies `ev:sessions` with pending sessions |
| `send_session` | `n` | Replies `ev:file` then streams WAV on `CHAR_DATA`, ends `ev:file_done` |
| `mark_synced` | `n` | Mark session uploaded; acks `ev:ok` |
| `set_patients` | `patients[]` | Push the patient roster to the device; acks `ev:ok` |
| `identify` | — | Beep + flash so the SLP can find the unit |
| `reboot` | — | Acks `ev:ok` then restarts |

## Status events (device → app, `CHAR_STATUS`)

| Event | Fields |
|-------|--------|
| `scan` | `networks: [{ ssid, rssi, sec }]` |
| `state` | `state, ip?, device_id?, msg?` — provisioning progress |
| `sessions` | `items: [{ n, patient_id, bytes }]` — pending only |
| `file` | `n, bytes, meta` — then raw bytes arrive on `CHAR_DATA` |
| `file_done` | `n` |
| `ok` / `err` | `op` (+ `msg` on err) |

Provisioning `state` sequence: `connecting → wifi_ok → registering → registered` (or `error`).

## Flows

### Provision

```
App ── write {op:provision, ssid, pass, server, claim_token}
Device ── notify ev:state connecting
       ── notify ev:state wifi_ok
       ── notify ev:state registering   (POST /api/devices/register)
       ── notify ev:state registered (device_id)   | ev:state error (msg)
```

App guards the whole exchange with a 60 s timeout (firmware worst case ≈ 28 s Wi-Fi connect +
~8 s register).

### Pull a session (offline bridge)

```
App ── write {op:list_sessions} ── ◄ ev:sessions [{n,patient_id,bytes}]
App ── write {op:send_session, n} ── ◄ ev:file {n,bytes,meta}
                                   ── ◄ raw WAV bytes (framed) on CHAR_DATA …
                                   ── ◄ ev:file_done {n}
App ── upload WAV to backend (same recordings path as a manual upload)
App ── write {op:mark_synced, n} ── ◄ ev:ok
```

`pullSession()` accumulates `CHAR_DATA` chunks into a base64 WAV, reporting progress against the
`bytes` from `ev:file`.
