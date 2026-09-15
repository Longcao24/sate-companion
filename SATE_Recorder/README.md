# SATE Clinical Recorder — ESP32-S3 firmware

**Current firmware: fw 1.5.12.** Sketch: `SATE_Recorder.ino` (folder name matches the `.ino`, so
`arduino-cli` builds it in place). Build/flash from scratch: [`../SETUP.md`](../SETUP.md). Deep
reference (pin map, build/flash, LVGL/PSRAM budget, optimization playbook): [`../doc/12-hardware.md`](../doc/12-hardware.md).
Flash FQBN: `esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi` (⚠️ `default_8MB`
= dual OTA, never `huge_app`). The note below is the original v0.5 connectivity write-up (still
broadly accurate for the Wi-Fi/BLE model):

**Connectivity** (see `connectivity.h/.cpp`):

- **Wi-Fi mode (default once provisioned).** Boot tries the saved Wi-Fi for
  ~12 s. Online, the recorder auto-uploads pending sessions to the SATE
  server (`POST /api/sessions`), heartbeats + polls remote commands every
  15 s (`GET /api/devices/:id/commands?pending=N` - sync_now /
  reload_patients / identify / reboot), and pulls the patient list.
- **BLE mode (fallback).** No Wi-Fi -> advertises the SATE GATT service with
  manufacturer data `[0x5A, flags, pending, 0]` so the companion app can do
  first-time provisioning (Wi-Fi scan -> credentials + claim token ->
  register) and bridge-sync sessions over BLE. Identify / reboot also work
  point-to-point over BLE. Protocol mirrors the app's `src/protocol.ts`.
- Mode switching is automatic; the header shows a Wi-Fi / Bluetooth icon.
- Patient list: `/sate/patients.json` (pushed by server or app) overrides
  the built-in demo patients.

**Extra libraries (Library Manager):** `NimBLE-Arduino` (v2.x),
`ArduinoJson` (v7.x).

**Test without real backend:** run `mock-server/` from the companion app
repo and provision with server URL `http://<your-ip>:4000`.

---

A handheld demo device for Speech-Language Pathologists. The SLP selects the
assigned patient, records a speech sample, reviews sessions on-device, then
taps **Sync to SATE**. The device simulates the upload to SATE Cloud and the
SATE AI analysis, then shows a SATE-style results card (speech rate WPM,
mispronunciation / filler words / grammar counts).

**Everything is offline.** The sync, cloud, and AI analysis are simulated for
demo purposes - no network connection of any kind.

## Demo flow (what to show in a pitch)

```text
1. Power on  -> SATE logo pop-in, tagline, live init checklist:
               Display & touch -> SD card -> Audio codec -> SATE services
2. Home      -> assigned patient card (name, ID chip, age, session type, SLP)
               status line shows "N sessions - M pending sync"
3. Record    -> full-screen countdown ring, 30 s streamed to SD,
               automatic review playback through the speaker
4. Sessions  -> list of recordings (newest first), each tagged
               "SATE" (synced, green) or "pending" (amber); tap to replay
5. Sync      -> pending count + [Transfer to SATE]
6. Transfer  -> per-file simulated upload (progress bar, KB counter,
               realistic speed jitter), then "SATE AI analyzing speech..."
7. Results   -> SATE analysis card: duration, speech rate WPM (Good/Monitor),
               total issues, mispronunciation / filler words / grammar
               + "N session(s) synced to SATE Cloud"
```

Analysis numbers are deterministic per file (hashed from the filename + size),
so repeating the demo gives consistent results.

## Hardware concept

Current demo hardware (all on one board, zero wiring):

```text
Board    Freenove ESP32-S3 Display FNK0104AB
MCU      ESP32-S3 (dual-core LX7, 8 MB flash, OPI PSRAM)
Screen   2.8" 240x320 ILI9341 TFT + FT6336U capacitive touch (I2C)
Audio    ES8311 codec (I2S): onboard analog mic in, speaker amp out
Storage  microSD via SD_MMC 4-bit bus (WAV + JSON per session)
Power    USB-C
```

Suggested next steps toward a real product:

```text
Battery   1S LiPo 1500-2500 mAh + charger/fuel-gauge PMU, USB-C charging
Mic       Dedicated MEMS or electret capsule near a front grille
          (better SNR than the dev-board mic for clinical samples)
Sync      Wi-Fi (already in the ESP32-S3) uploading WAV+JSON to the SATE
          API over TLS; the .synced marker logic in this firmware maps
          directly onto real upload-confirmation
Identity  Device ID + clinician login PIN; patient list pulled from SATE
Case      Handheld enclosure, lanyard, wipeable surface for clinics
```

## Saved files

```text
/sate/patients/<patient_id>/session_XXXX.wav      16 kHz 16-bit mono WAV
/sate/patients/<patient_id>/session_XXXX.json     session metadata
/sate/patients/<patient_id>/session_XXXX.synced   demo sync marker
```

Delete the `.synced` files on the SD card to reset the demo to "pending".

## Memory / stability design

- Recording is STREAMED mic -> static 4 KB chunk -> SD. No large mallocs;
  working memory is constant regardless of recording length.
- Playback is STREAMED SD -> the same 4 KB chunk -> I2S.
- No Arduino `String` in hot paths (fixed char buffers everywhere).
- `[MEM]` heap telemetry on serial at boot/record/play/sync.
- LVGL double-buffered draw buffers in DMA-capable internal RAM
  (display.cpp), with automatic static fallback.
- Session numbering scans the SD card; reboots never overwrite recordings.
- WAV header is written up-front and patched at the end, so interrupted
  recordings are still valid files; failed recordings are deleted.
- Touch callbacks only set a pending-action flag; all heavy work runs from
  loop(), so LVGL is never re-entered from an event handler.

## Arduino IDE settings

```text
Board: ESP32S3 Dev Module
USB CDC On Boot: Enabled
Flash Size: 8MB (64Mb)
Partition Scheme: 8M with spiffs (3MB APP/1.5MB SPIFFS) or Huge APP
PSRAM: OPI PSRAM
Core Debug Level: None
Erase All Flash Before Sketch Upload: Enabled for first upload
```

## Notes

- No BOOT button. Touch-only UI (plus remote/BLE commands in v0.5.0).
- Touch uses a Wire-only FT6336U reader; ES8311 uses a Wire-only driver.
- SD card is required (FAT32).
- `lv_spinner` requires `LV_USE_SPINNER 1` in lv_conf.h (default on).
