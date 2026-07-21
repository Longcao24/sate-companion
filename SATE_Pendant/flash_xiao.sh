#!/bin/bash
# Flash XIAO nRF52840 Sense Plus via UF2 — CORRECT core.
# Usage: ./flash_xiao.sh <sketch_dir>
# Example (from repo root): ./SATE_Pendant/flash_xiao.sh SATE_Pendant
#
# ⚠️ MUST use the Seeed core, NOT adafruit:nrf52:feather52840sense.
#    The Adafruit Feather variant links the app at 0x26000, which overwrites the
#    last flash page of the S140 7.3.0 SoftDevice -> BLE stack corrupted: the app
#    runs but NEVER advertises and no CDC serial port enumerates (crashes in
#    Bluefruit.begin()). Recovery then needs a DFU SoftDevice restore
#    (adafruit-nrfutil dfu serial ... Seeed_..._s140_7.3.0.zip). See HARDWARE.md.
#    Correct core links at 0x27000 — this script aborts if it sees 0x26000.
set -e
FQBN="Seeeduino:nrf52:xiaonRF52840SensePlus"

SKETCH_DIR="$1"
if [ -z "$SKETCH_DIR" ]; then echo "Usage: $0 <sketch_dir>"; exit 1; fi
SKETCH_NAME=$(basename "$SKETCH_DIR")

# The Seeed build recipe calls `python` (macOS only has python3) and does not quote
# paths, so build from a space-free copy with a python shim on PATH.
mkdir -p ~/.local/pyshim && ln -sf "$(command -v python3)" ~/.local/pyshim/python
export PATH="$HOME/.local/pyshim:$PATH"
BUILD_SRC="/tmp/$SKETCH_NAME"
rm -rf "$BUILD_SRC" && cp -r "$SKETCH_DIR" "$BUILD_SRC"

echo "Compiling $SKETCH_NAME (Seeed core)..."
arduino-cli compile -b "$FQBN" "$BUILD_SRC"

HEX=$(find ~/Library/Caches/arduino/sketches -name "${SKETCH_NAME}.ino.hex" 2>/dev/null | head -1)
if [ -z "$HEX" ]; then echo "No hex found"; exit 1; fi

# uf2conv (Microsoft's) — fetch once.
[ -f /tmp/uf2conv.py ] || curl -sL https://raw.githubusercontent.com/microsoft/uf2/master/utils/uf2conv.py -o /tmp/uf2conv.py

echo "Converting to UF2..."
OUT=$(python3 /tmp/uf2conv.py --family 0xADA52840 --convert "$HEX" --output /tmp/flash_xiao.uf2 2>&1)
echo "$OUT"
# Guard: correct-core app links at 0x27000. 0x26000 == Adafruit Feather core == will
# corrupt the SoftDevice. Abort before writing.
if echo "$OUT" | grep -q "0x26000"; then
  echo "ABORT: start address 0x26000 — wrong core, would corrupt the SoftDevice. Use the Seeed core." >&2
  exit 1
fi
if ! echo "$OUT" | grep -q "0x27000"; then
  echo "ABORT: expected start address 0x27000, not seen. Refusing to flash." >&2
  exit 1
fi

echo "Double-tap reset on XIAO now (waiting for XIAO-SENSE volume)..."
until ls /Volumes/XIAO-SENSE 2>/dev/null; do sleep 0.3; done

echo "Flashing..."
# Raw write (no xattrs — Finder drag-drop fails with error -36).
python3 -c "
import os
data = open('/tmp/flash_xiao.uf2','rb').read()
fd = os.open('/Volumes/XIAO-SENSE/flash_xiao.uf2', os.O_WRONLY|os.O_CREAT, 0o644)
os.write(fd, data)
os.close(fd)
"
echo "Done. Board rebooting. Blue LED should blink (advertising)."
