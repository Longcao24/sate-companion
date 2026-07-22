#!/usr/bin/env bash
# One-shot toolchain setup so a fresh machine can build + flash the SATE Recorder
# (ESP32-S3) and SATE Pendant (XIAO nRF52840). Idempotent — safe to re-run.
#
# Usage:  ./toolchain/setup-arduino.sh
# Then:   see SETUP.md for the flash commands.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> 1/6  arduino-cli"
if ! command -v arduino-cli >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then brew install arduino-cli
  else echo "Install arduino-cli first (https://arduino.github.io/arduino-cli/latest/installation/)"; exit 1; fi
fi
arduino-cli version

echo "==> 2/6  board manager URLs (ESP32 + Seeed nRF52)"
arduino-cli config init --overwrite >/dev/null 2>&1 || true
arduino-cli config add board_manager.additional_urls \
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json \
  https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json 2>/dev/null || true
arduino-cli core update-index

echo "==> 3/6  cores (esp32 for recorder, Seeeduino nrf52 for pendant)"
arduino-cli core install esp32:esp32@3.3.10
arduino-cli core install Seeeduino:nrf52 || echo "   (Seeed core optional — pendant only)"

echo "==> 4/6  libraries"
arduino-cli lib install "ArduinoJson" "NimBLE-Arduino" "TFT_eSPI"
arduino-cli lib install "lvgl@8.4.0"

echo "==> 5/6  drop in the load-bearing configs (lv_conf + Freenove TFT_eSPI display setup)"
LIBDIR="$(arduino-cli config get directories.user)/libraries"
[ -d "$LIBDIR" ] || { echo "libraries dir not found at $LIBDIR"; exit 1; }
# LVGL config — LV_TICK_CUSTOM=1 + LVGL heap in PSRAM (see SETUP.md / hardware.md §8.8)
cp "$HERE/lv_conf.h" "$LIBDIR/lv_conf.h"
# Freenove FNK0104AB display config: stock TFT_eSPI has no FNK setup, so overlay ours
cp "$HERE/tft_eSPI_freenove/User_Setup_Select.h" "$LIBDIR/TFT_eSPI/User_Setup_Select.h"
mkdir -p "$LIBDIR/TFT_eSPI_Setups"
cp "$HERE/tft_eSPI_freenove/FNK0104AB_2.8_240x320_ILI9341.h" "$LIBDIR/TFT_eSPI_Setups/"
echo "   configs installed into $LIBDIR"

echo "==> 6/6  verify — compile the recorder"
arduino-cli compile --clean \
  --fqbn "esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi" \
  "$HERE/../SATE_Recorder"

echo ""
echo "✅ Toolchain ready. Flash the recorder with:"
echo "   arduino-cli upload -p /dev/cu.usbmodemXXXX \\"
echo "     --fqbn \"esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=default_8MB,PSRAM=opi\" SATE_Recorder"
echo "   (find the port: ls /dev/cu.usbmodem*)  —  see SETUP.md for the pendant + gotchas."
echo ""
echo "No toolchain? Grab prebuilt assets from the GitHub Release instead:"
echo "   https://github.com/Longcao24/sate-companion/releases/tag/fw-1.5.12"
echo "   (merged.bin = flash-only via web flasher; sate-arduino-libs.zip = exact libs)"
