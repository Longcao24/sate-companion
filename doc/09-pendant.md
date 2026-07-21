# 09 — SATE Pendant integration

Optional capture path: connect a **SATE Pendant** (Sona/Nuna — a Seeed XIAO nRF52840
Sense running `xiao_audio_ble.ino`) over BLE and stream its live mic audio into SATE.
Pendant audio lands in the **same** `recordings` table as everything else.

Unlike Plaud (proprietary arm64 SDK, device-lock risk), the pendant is **standard BLE
GATT** driven by `react-native-ble-plx` — the SAME stack SATE recorders use. So:

- **No native rebuild** to add/change it — ble-plx is already linked. Metro reload is enough.
- **No binding / device-lock concern** (nothing like Plaud's identity binding).
- Off a dev build (Expo Go) BLE is unavailable, same as SATE.

## Where it plugs in

Like Plaud, the pendant reuses the phone's existing upload — no new backend path:

```
Pendant ──BLE (raw PCM notify)──▶ PendantLink (react-native-ble-plx)
                        │  src/pendant/PendantLink.ts
                        ▼  accumulate PCM → WAV
   api.uploadSession({ device_serial:"pendant-<id>", patient_id, session_number,
                       sample_rate:16000, wav_base64 })   ← UNCHANGED SATE path
                        ▼
   device-api (user-authed /sessions) ──▶ process-device-session ──▶ recordings
```

`device_serial` is prefixed **`pendant-<id>`** (the ble-plx peripheral id). The web
`/devices` page synthesizes a passive device from these sessions
(`deriveExternalDevices` handles both `plaud-` and `pendant-`), so pendant recordings
show up as a device with their recordings, same as Plaud.

## Source map

| Path | Role |
|------|------|
| `src/pendant/PendantLink.ts` | BLE scan/connect/stream/control + PCM→WAV |
| `src/screens/PendantConnectScreen.tsx` | Connect UI: scan → connect → record → upload |
| `App.tsx` | `pendant` link + route `{name:"pendant"}`; `onConnectPendant` tears down SATE's ble-plx manager first (two ble-plx managers contend for the one radio) |
| `src/screens/HomeScreen.tsx` | "+ Connect a pendant" entry in the device list |
| web `DeviceProvider.deriveExternalDevices` + `DevicePanel`/`DeviceCard` | pendant shown as a passive device on `/devices` |

## BLE profile (from the pendant firmware)

Firmware project: `~/Desktop/necklace-insole/firmware` (`xiao_audio_ble.ino`).

```
Device name      SATE Pendant
Audio service    19b10000-e8f2-537e-4f6c-d104768a1214   (lowercase for ble-plx)
  Audio (notify) 19b10001-…  → 244 B = 122 × int16 LE PCM
  Control (write)19b10002-…  → 0x01 start / 0x00 stop / 0x02 find-me
Battery service  0000180f-… / level 00002a19-…  → byte; percent = b & 0x7F, charging = b & 0x80
Audio format     PCM S16LE, 16000 Hz, mono   (no codec — finished cleaned voice)
MTU / PHY        247 / 2M preferred
```

**Flow:** connect → request MTU 247 → subscribe `19b10001` → write `0x01` → PCM notifications
accumulate → write `0x00` → wrap the PCM in a 44-byte WAV header → `uploadSession`.

## Flashing the pendant firmware (⚠️ SoftDevice-corruption trap)

Firmware lives at `~/Desktop/necklace-insole/firmware/` (`xiao_audio_ble/`,
`flash_xiao.sh`, `HARDWARE.md` — the full hard-won recipe). Board = **Seeed XIAO
nRF52840 Sense Plus**, flashed by UF2 (double-tap reset → `XIAO-SENSE` drive mounts →
raw-write the `.uf2`).

🛑 **Build with the SEEED core, never the Adafruit Feather core.**
`FQBN = Seeeduino:nrf52:xiaonRF52840SensePlus`.

- Building with `adafruit:nrf52:feather52840sense` links the app at **`0x26000`**, which
  overwrites the last flash page of the **S140 7.3.0 SoftDevice** → BLE stack corrupted.
  **Symptom: the app runs but NEVER advertises, and no CDC serial port appears** (it
  hardfaults in `Bluefruit.begin()`). Non-BLE sketches still run — that's the giveaway
  it's the SoftDevice, not the code.
- The **correct** core links at **`0x27000`**. The UF2 conversion prints the start
  address — `0x27000` = good, `0x26000` = STOP, wrong core. `flash_xiao.sh` now aborts
  on `0x26000`.
- Recovering a corrupted board (no J-Link needed): DFU-restore Seeed's SoftDevice+bootloader,
  then reflash the correct-core app UF2.
  ```bash
  # 1. double-tap into bootloader, note the /dev/cu.usbmodem* port, then:
  ZIP=~/Library/Arduino15/packages/Seeeduino/hardware/nrf52/1.1.13/bootloader/Seeed_XIAO_nRF52840_Sense_Plus/Seeed_XIAO_nRF52840_Sense_Plus_bootloader-0.6.2_s140_7.3.0.zip
  adafruit-nrfutil --verbose dfu serial -pkg "$ZIP" -p /dev/cu.usbmodemXXXX -b 115200   # ~20s, do NOT unplug
  # 2. double-tap again, then flash the correct-core app:
  ./flash_xiao.sh ~/Desktop/necklace-insole/firmware/xiao_audio_ble
  ```
  A **factory-fresh** board needs this DFU restore too — its SoftDevice state isn't
  Bluefruit-compatible until you flash Seeed's own bootloader+SoftDevice.

**Verify from the Mac** (macOS is flaky at surfacing scan-response *names* — match on the
audio service UUID): a `bleak` scan should show `SATE Pendant` advertising service
`19b10000-…`. Blue LED blink = advertising, solid = connected. If a LiPo battery is
attached, unplug it while debugging (USB won't power-cycle it → unreliable resets).

## Nap mode — a gap is NOT a disconnect

To save battery the pendant **naps during silence**: after ~30 s quiet it stops sending
notifications and the radio idles, resuming instantly on sound. The BLE link stays up.
`PendantConnectScreen` treats a gap as "quiet / listening", never an error, and keeps the
subscription open. (Tunable in firmware: `SLEEP_AFTER_MS`, `WAKE_MEANABS`.)

## Deferred

- Persist a known pendant for one-tap reconnect (like Plaud's `knownDevices`) — currently
  re-scan each time.
- Live waveform / level meter from the audio stream.
