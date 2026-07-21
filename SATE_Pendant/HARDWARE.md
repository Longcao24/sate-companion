# XIAO nRF52840 Sense Plus — Hardware & Firmware Notes

Hard-won setup notes for flashing and BLE on this board. Read before touching firmware again — most of these cost hours to figure out.

## Board identity

Read from `INFO_UF2.TXT` (double-tap reset → open the `XIAO-SENSE` drive):

```
Model:       Seeed XIAO nRF52840 Sense Plus
Board-ID:    nRF52840-SeeedXiaoSense-v1
SoftDevice:  S140 7.3.0          <-- app must link at 0x27000
Bootloader:  0.9.2 (factory) / 0.6.2 after our SoftDevice restore
```

- **App flash start address MUST be `0x27000`** (S140 7.3.0). A build that links at `0x26000` (S140 6.1.1 layout) will overwrite the tail of the SoftDevice and **corrupt the BLE stack**. This is what bit us — see "SoftDevice corruption" below.
- Reset behavior: **blank board (no app) = single-tap** to bootloader. **With an app flashed = double-tap.**

## Correct toolchain (USE THIS — not Adafruit)

We initially used `adafruit:nrf52:feather52840sense` as a stand-in. **Do not.** Non-BLE sketches run, but BLE links at the wrong address and crashes/corrupts. Use Seeed's own core.

Board manager index URL:
```
https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
```

Install:
```bash
arduino-cli config add board_manager.additional_urls https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json
arduino-cli core update-index
arduino-cli core install Seeeduino:nrf52@1.1.13
```

FQBN for this exact board:
```
Seeeduino:nrf52:xiaonRF52840SensePlus
```
(Use `bluefruit.h` API — the Seeed core is a Bluefruit/Adafruit fork. NOT the mbed core.)

## Build gotchas

1. **`python` shim required.** The Seeed build recipe calls `python`, but macOS only has `python3`. Without it: `exec: "python": executable file not found in $PATH`.
   ```bash
   mkdir -p ~/.local/pyshim
   ln -sf "$(command -v python3)" ~/.local/pyshim/python
   export PATH="$HOME/.local/pyshim:$PATH"   # prepend before compiling
   ```

2. **No spaces in the sketch path.** The Seeed recipe doesn't quote paths, so a path like
   `.../necklake and insole/...` breaks (`error: and: No such file or directory`).
   Copy the sketch to a space-free dir before compiling:
   ```bash
   cp -r "<sketch>" /tmp/sketch && arduino-cli compile -b Seeeduino:nrf52:xiaonRF52840SensePlus /tmp/sketch
   ```

3. **Compile → UF2.** Seeed core emits `.hex`, not `.uf2`. Convert with Microsoft's `uf2conv.py`:
   ```bash
   # one-time: fetch the tool + family table
   curl -sL https://raw.githubusercontent.com/microsoft/uf2/master/utils/uf2conv.py     -o /tmp/uf2conv.py
   curl -sL https://raw.githubusercontent.com/microsoft/uf2/master/utils/uf2families.json -o /tmp/uf2families.json

   HEX=$(find ~/Library/Caches/arduino/sketches -name "<sketch>.ino.hex" | head -1)
   python3 /tmp/uf2conv.py --family 0xADA52840 --convert "$HEX" --output out.uf2
   ```
   Confirm the conversion prints `start address: 0x27000`. If it says `0x26000`, you built against the wrong core — stop, it will corrupt the SoftDevice.

## Flashing a UF2 (macOS)

Double-tap reset → `XIAO-SENSE` drive mounts → write the `.uf2`.

- **Do NOT drag-drop in Finder.** It fails with **error -36** (Finder writes extended attributes; the bootloader also reboots mid-copy).
- **Use a raw write (no xattrs):**
  ```bash
  python3 -c "import os;d=open('out.uf2','rb').read();fd=os.open('/Volumes/XIAO-SENSE/fw.uf2',os.O_WRONLY|os.O_CREAT,0o644);os.write(fd,d);os.close(fd)"
  ```
- **Permission denied / read-only mount:** a prior failed Finder copy leaves the FAT "dirty" so macOS remounts read-only. Fix: `diskutil unmount force /Volumes/XIAO-SENSE`, then double-tap again for a clean mount.

Ready-made double-click flashers live in `~/Desktop/xiao_firmware/`:
`FLASH_test.command`, `FLASH_audio.command` (handle the raw write + read-only remount).

## SoftDevice corruption (the big one)

**Symptom:** non-BLE sketches (blink) run fine, but **every** BLE sketch — including Seeed's own `beacon` example — hardfaults at `Bluefruit.begin()`: USB CDC serial port never enumerates and the board never advertises.

**Cause:** flashing an app linked at `0x26000` (Adafruit Feather / S140 6.1.1 layout) overwrote the last flash page of the S140 7.3.0 SoftDevice → corrupted BLE stack.

**Diagnosis trick:** USB CDC port presence = crash test.
- After flashing a BLE sketch, `ls /dev/cu.usbmodem*`:
  - port present → firmware running (BLE OK)
  - no port → crashed in `Bluefruit.begin()` (SoftDevice broken)
- Independent advertising check from the Mac (`bleak`):
  ```bash
  pip3 install bleak --break-system-packages
  python3 -c "import asyncio;from bleak import BleakScanner
  async def m():
   d=await BleakScanner.discover(timeout=10,return_adv=True)
   print([ (a.local_name or x.name,a.rssi) for k,(x,a) in d.items() if 'xiao' in (a.local_name or x.name or '').lower()])
  asyncio.run(m())"
  ```
  Note: macOS is flaky at surfacing scan-response **names** — scan by **service UUID** `19b10000-e8f2-537e-4f6c-d104768a1214` for a reliable hit.

**Fix — restore SoftDevice + bootloader via DFU** (no J-Link needed). Seeed ships the image inside the core:
```bash
ZIP=~/Library/Arduino15/packages/Seeeduino/hardware/nrf52/1.1.13/bootloader/Seeed_XIAO_nRF52840_Sense_Plus/Seeed_XIAO_nRF52840_Sense_Plus_bootloader-0.6.2_s140_7.3.0.zip

pip3 install adafruit-nrfutil --break-system-packages   # one-time

# Double-tap into bootloader first, then (PORT is the usbmodem that appears):
adafruit-nrfutil --verbose dfu serial -pkg "$ZIP" -p /dev/cu.usbmodem1101 -b 115200
```
Takes ~20s, prints `Device programmed.` **Do not unplug during this** — interruption can brick the board (then you'd need an SWD/J-Link to recover). This rewrites S140 7.3.0 + bootloader (downgrades bootloader to 0.6.2, which is fine).

After restore: reflash the app UF2; BLE works.

### IMPORTANT: every new board needs this restore

This is **not** a one-off from corruption — a brand-new, factory-fresh Sense Plus that
was *only* ever flashed correct `0x27000` firmware **still** crashes at `Bluefruit.begin()`
(no blue LED, not advertising). The factory SoftDevice state isn't compatible with the
Bluefruit core until you DFU-flash Seeed's own bootloader+SoftDevice. So for **every new
board**, the setup is:

1. Double-tap → bootloader → `adafruit-nrfutil dfu serial -pkg <seeed sd_bl zip> -p <port>`
2. Flash `1_audio_full.uf2`
3. Blue LED blinks = advertising → done

Tell on a bad board: **no blue LED + not advertising + `Bluefruit.begin()` never returns.**
Non-BLE sketches still run fine, which is the giveaway it's the SoftDevice, not your code.

**Gotcha:** if the board has a **LiPo battery attached**, remove it while debugging.
Unplugging USB won't power-cycle it (battery keeps it alive), so resets/boots get
unpredictable and you chase ghosts. USB-only = clean, repeatable state.

## Pin map (XIAO nRF52840, active-LOW LEDs)

| Function        | nRF pin | Notes |
|-----------------|---------|-------|
| LED Red         | P0.26   | active low (clear = on) |
| LED Green       | P0.30   | active low |
| LED Blue        | P0.06   | active low |
| PDM mic power   | P1.10   | drive HIGH to power the onboard mic |
| PDM CLK         | P1.00   | |
| PDM DATA        | P0.16   | |
| Charge LED      | —       | hardware (charger IC). **Blinks red/orange forever when USB-powered with no/low battery — normal, ignore.** |

Our audio firmware uses blue = BLE status (blink=advertising, solid=connected), red = recording.

## App side (Expo / react-native-ble-plx)

App lives at `~/dev/collect` (moved off the space-containing Desktop path — gradle/Xcode also choke on spaces).

- **BLE needs a dev build**, not Expo Go: `npx expo run:android` (Android JDK 21). Emulators have **no Bluetooth** — must use a physical phone.
- **Scan-response name appears as `localName` on Android, `name` on iOS.** Match both:
  ```js
  const advName = device?.name ?? device?.localName;
  if (advName !== 'XIAO-Audio') return;
  ```
- **Android BLE scan needs Location/GPS ON** (not just the BT permission) or scan results are silently empty.
- iOS Simulator also has no Bluetooth — iOS BLE testing needs a physical iPhone + Apple signing.

## Clear audio streaming (16 kHz mic over BLE)

16 kHz * 16-bit = 256 kbps — right at BLE's practical ceiling. Getting *clear* voice needed three things together; any one missing = noisy or choppy:

1. **Use the `PDM` library, NOT raw nRF PDM registers.** `#include <PDM.h>` then
   `PDM.setGain(40); PDM.begin(1, 16000);` with an `onReceive` callback. The library
   has the correct gain/edge/clock for the XIAO mic. Hand-rolled register config
   sounded noisy/unclear — this was the main culprit. Exact 16000 Hz also avoids the
   pitch/speed mismatch you get from the raw ~16125 Hz clock.
2. **2M PHY + max bandwidth** for throughput (doubles raw rate, big notify queue):
   ```cpp
   Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);   // BEFORE begin(): MTU 247 + queue
   // in the connect callback:
   conn->requestPHY(BLE_GAP_PHY_2MBPS);            // note: _2MBPS, not _2M
   conn->requestMtuExchange(247);
   conn->requestConnectionParameter(6);            // 7.5 ms interval = most pkts/sec
   ```
   `BANDWIDTH_MAX` is what finally raised the **negotiated MTU from 23 → 247**. Without
   it, every notification truncates to 20 bytes (92% data loss) regardless of what the
   app requests.
3. **Ring buffer + notify retry** so nothing drops when BLE is briefly busy:
   PDM callback pushes samples into a ring; the loop drains it in 244-byte packets and
   **only advances the tail if `notify()` succeeds** (`break` and retry next loop
   otherwise). Don't clear/skip data on a failed notify — that's what caused gaps.

App side: request MTU explicitly after connect (`await dev.requestMTU(247)` — the
`connect({requestMTU})` option is unreliable on Android) and build the WAV at **16000 Hz**.
Don't bother downsampling to 8 kHz — with the above, 16 kHz streams clean and sounds
better; 8 kHz was worse.

Measured good run: ~390 packets / ~95 KB for a 3 s clip, near-zero loss.

## Firmware BLE protocol (for the app)

```
Service  19B10000-E8F2-537E-4F6C-D104768A1214
Audio    19B10001  NOTIFY  244 bytes = 122 int16 PCM samples (~16 kHz mono)
Control  19B10002  WRITE   1 byte: 0x01 = start, 0x00 = stop
Adv name: "Nuna-Necklace"  (also advertises the service UUID)
```

**IMU removed.** The old build also streamed an IMU characteristic (`19B10003`) from
the onboard LSM6DS3. The product is now audio-only food-intake detection — the IMU
char, the `LSM6DS3` include, and all accel/gyro code were deleted. If you flash an
old UF2 that still advertises `19B10003`, the current app ignores it.

## Quick rebuild recipe

```bash
export PATH="$HOME/.local/pyshim:$PATH"
FQBN=Seeeduino:nrf52:xiaonRF52840SensePlus
cp -r "/Users/hoanglong/Desktop/necklake and insole/xiao_audio_ble" /tmp/xiao_audio_ble
arduino-cli compile -b "$FQBN" /tmp/xiao_audio_ble
HEX=$(find ~/Library/Caches/arduino/sketches -name "xiao_audio_ble.ino.hex" | head -1)
python3 /tmp/uf2conv.py --family 0xADA52840 --convert "$HEX" --output ~/Desktop/xiao_firmware/1_audio_full.uf2
# verify it prints: start address: 0x27000
# then double-tap board, run FLASH_audio.command
```
