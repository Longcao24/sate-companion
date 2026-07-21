# Sona / Nuna Pendant — BLE Integration Guide

How to connect any app to the pendant and receive its audio. The pendant is a
**Seeed XIAO nRF52840 Sense Plus** running `xiao_audio_ble/xiao_audio_ble.ino`.
It streams the onboard mic over BLE as **raw 16-bit PCM** — no codec, no
decoding needed on your side.

---

## 1. Discover & connect

| | Value |
|---|---|
| Advertised name | `SATE Pendant` |
| Advertised service | `19B10000-E8F2-537E-4F6C-D104768A1214` |
| Role | Peripheral (the pendant); your app is the central |

Scan for either the name `SATE Pendant` **or** the service UUID above, then
connect and discover services/characteristics.

**Recommended after connect (for throughput):**
- Request a larger MTU — the pendant is configured for **MTU 247**.
- Request the **2M PHY** (`BLE_GAP_PHY_2MBPS`) if your platform allows it. Raw
  PCM at 16 kHz is 256 kbps — the 2M PHY gives the headroom. The pendant already
  requests 2M on its side; both ends must agree.

---

## 2. GATT profile

### Audio service — `19B10000-E8F2-537E-4F6C-D104768A1214`

| Characteristic | UUID | Properties | Payload |
|---|---|---|---|
| Audio data | `19B10001-…` | **Notify** | 244 bytes = 122 × `int16` PCM samples |
| Control | `19B10002-…` | **Write** | 1 byte command (see below) |

### Battery — standard Battery Service

| | UUID |
|---|---|
| Service | `0000180F-0000-1000-8000-00805F9B34FB` |
| Level char | `00002A19-0000-1000-8000-00805F9B34FB` (Read + Notify) |

---

## 3. Control commands

Write **one byte** to the Control characteristic `19B10002`:

| Byte | Action |
|---|---|
| `0x01` | **Start** streaming — pendant begins Audio-data notifications |
| `0x00` | **Stop** streaming |
| `0x02` | **Find-me** — flashes the LED ~5 s (locate the pendant) |

You must send `0x01` to start; the pendant does not stream until asked. Enable
notifications on `19B10001` (write its CCCD) before or right after sending
`0x01`.

**Typical flow:**
```
connect → discover → (request MTU 247 + 2M PHY)
        → subscribe to 19B10001 notifications
        → write 0x01 to 19B10002        ← audio starts flowing
        ... receive PCM notifications ...
        → write 0x00 to 19B10002        ← audio stops
```

---

## 4. Audio format

Each notification on `19B10001` is a fixed **244-byte** packet:

| Property | Value |
|---|---|
| Encoding | **Raw PCM, signed 16-bit** (no header, no codec) |
| Byte order | **Little-endian** (nRF52 native) |
| Samples per packet | **122** (`244 bytes ÷ 2`) |
| Sample rate | **16 000 Hz** |
| Channels | **1 (mono)** |
| Packet rate | ~131 packets/s while streaming |

Decode: read the 244 bytes as 122 consecutive `int16` little-endian samples and
append to your audio buffer. No framing/length prefix — every notification is a
whole number of samples. Concatenate packets in arrival order to rebuild the
continuous stream.

**Reassemble to a WAV (16 kHz / mono / 16-bit PCM)** by writing a standard 44-byte
WAV header followed by the concatenated sample bytes.

> Note: the pendant applies a mic gain + high-pass filter on-device, so the PCM
> is already cleaned voice-band audio. You get finished PCM, not codec frames —
> nothing to decode.

---

## 5. Battery level

Read or subscribe to `00002A19` (Battery Service). One byte, but **bit 7 is a
charging flag**, not part of the percentage:

```
raw      = <byte value>          // e.g. 0xC1
percent  = raw & 0x7F            // 0–100  → 0x41 = 65 %
charging = (raw & 0x80) != 0     // USB plugged / topped off
```

Always mask with `0x7F` for the percentage; test `0x80` to show a charging
indicator.

---

## 6. Nap mode (important for integrators)

To save battery the pendant **naps during silence**. After ~30 s below the sound
threshold while streaming, it turns the mic off and stops sending notifications —
the radio goes idle. It wakes and resumes instantly when it hears sound again.

Consequences for your app:
- **A gap in notifications is normal**, not a disconnect. Don't treat "no audio"
  as an error while connected — it means the room is quiet.
- The BLE connection stays up during a nap. Keep your subscription open; audio
  resumes on the next sound (speech, a bite, noise) with no re-arming needed.
- If you need continuous audio regardless of silence, that behavior is tunable in
  firmware (`SLEEP_AFTER_MS`, `WAKE_MEANABS` in `xiao_audio_ble.ino`).

---

## 7. Quick reference (copy/paste)

```
Device name      SATE Pendant
Audio service    19B10000-E8F2-537E-4F6C-D104768A1214
  Audio (notify) 19B10001-E8F2-537E-4F6C-D104768A1214  → 244 B = 122×int16 LE PCM
  Control (write)19B10002-E8F2-537E-4F6C-D104768A1214  → 0x01 start / 0x00 stop / 0x02 find-me
Battery service  0000180F-0000-1000-8000-00805F9B34FB
  Level          00002A19-…  → byte; percent = b & 0x7F, charging = b & 0x80
Audio format     PCM S16LE, 16000 Hz, mono
MTU / PHY        247 / 2M preferred
```
