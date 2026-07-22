# SATE hardware — build & flash setup (from scratch)

Everything a fresh Mac needs to build and flash the **SATE Recorder** (ESP32-S3) and the
**SATE Pendant** (XIAO nRF52840). Firmware source is in the repo — `SATE_Recorder/` and
`SATE_Pendant/`. Deeper reference: [`hardware.md`](hardware.md), [`doc/07-runbook.md`](doc/07-runbook.md),
[`doc/09-pendant.md`](doc/09-pendant.md).

## One-command setup

```bash
./toolchain/setup-arduino.sh
```

Idempotent. It installs `arduino-cli`, the **esp32** + **Seeed nRF52** cores, the libraries
(`ArduinoJson`, `NimBLE-Arduino`, `lvgl@8.4.0`, `TFT_eSPI`), then drops in the two **load-bearing
configs** and compiles the recorder to verify. If it ends with `✅ Toolchain ready`, you can flash.

### The two configs the script installs (and why they matter)

These live outside the sketch (in the Arduino `libraries/` dir), so a plain `lib install` is NOT
enough — the script copies them from `toolchain/`:

1. **`lv_conf.h`** (LVGL config) — needs `LV_TICK_CUSTOM 1` and `LV_MEM_CUSTOM 1`/`ps_malloc`.
   - `LV_TICK_CUSTOM 0` → **boot spinner freezes at frame 1, screen never repaints** (the firmware
     never calls `lv_tick_inc()`). Looks like a dead board; it isn't.
   - LVGL heap must be in PSRAM or the Wi-Fi **register TLS handshake fails "code -1"**.
   - ⚠️ **Reinstalling lvgl resets `lv_conf.h`** → re-run the script (or re-copy `toolchain/lv_conf.h`).
2. **Freenove `TFT_eSPI` display setup** (`User_Setup_Select.h` + `FNK0104AB_2.8_240x320_ILI9341.h`) —
   stock `TFT_eSPI` has **no** FNK0104AB config, so the screen won't work without these.

## Flash the recorder (ESP32-S3)

```bash
ls /dev/cu.usbmodem*                                  # find the port (e.g. usbmodem101)
arduino-cli upload -p /dev/cu.usbmodem101 \
  --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" \
  SATE_Recorder
```

- 🛑 **`PartitionScheme=default_8MB`, NEVER `huge_app`.** `default_8MB` has two app slots
  (`ota_0`+`ota_1`) so OTA works; `huge_app` is single-slot and **silently disables OTA**.
- `FlashSize=16M`, `PSRAM=opi` are mandatory (16 MB flash + 8 MB octal PSRAM).
- `arduino-cli upload` does **not** erase NVS → a provisioned device stays claimed. Only a full
  `esptool erase_flash` wipes the Wi-Fi creds + account (then it must be re-provisioned in the app).
- **First upload / stuck board:** if it says *"No serial data received"*, the running app owns the
  USB-CDC — put it in download mode: **hold BOOT → tap RESET → release BOOT**, then re-run.

### Publishing an OTA release (fleet update)
Bump `FIRMWARE_VERSION` in `SATE_Recorder/SATE_Recorder.ino`, compile, upload the **app** bin
(`SATE_Recorder.ino.bin`, ~1.7 MB — not the merged bin) to the `firmware` Storage bucket + insert a
`sate_firmware` row. Full recipe: [`doc/07-runbook.md`](doc/07-runbook.md), [`hardware.md` §12](hardware.md).

## Flash the pendant (XIAO nRF52840)

```bash
./SATE_Pendant/flash_xiao.sh SATE_Pendant
```

- 🛑 **Uses the SEEED core, never the Adafruit Feather core.** The wrong core links the app at
  `0x26000` and corrupts the S140 SoftDevice → the board runs but **never advertises + no serial
  port**. `flash_xiao.sh` aborts if it sees `0x26000` (correct = `0x27000`).
- A factory-fresh or corrupted board first needs a DFU restore of Seeed's SoftDevice+bootloader
  (`adafruit-nrfutil`, `pip install adafruit-nrfutil`). Full recipe: [`doc/09-pendant.md`](doc/09-pendant.md).

## Known gotchas

- **iCloud eviction:** if `~/Documents/Arduino/libraries` is under iCloud Drive, lvgl gets evicted to
  0-byte placeholders and `arduino-cli compile` hangs forever in the lvgl preprocess. Fix:
  `arduino-cli lib uninstall lvgl && arduino-cli lib install lvgl@8.4.0`, then re-copy
  `toolchain/lv_conf.h`. Long-term: move the sketchbook out of iCloud.
- **Reading boot serial:** build with `CDCOnBoot=cdc,USBMode=hwcdc` and read `/dev/cu.usbmodem101`
  with a pyserial script that pulses RTS/DTR to reset (plain `cat` won't reset). See `doc/07-runbook.md`.
- Board specs (verified via esptool): ESP32-S3, **16 MB flash (DIO)**, **8 MB octal PSRAM**.
