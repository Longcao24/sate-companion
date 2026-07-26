# Progress log

## 2026-07-22 — Arduino toolchain setup + pendant low-battery fixes + OTA

### 1. Repo / app setup
- Cloned `sate-companion`, `npm install` on the root Expo app (640 packages). App source (`src/`, `App.tsx`, `modules/`) typechecks with 0 errors. `.env` already present.
- Note: root `tsc` also sweeps the `cloudflare/` + `cf-processor/` subprojects (separate Worker projects, own deps/tsconfigs) — expected noise for the mobile app.

### 2. Arduino toolchain
- Ran `./toolchain/setup-arduino.sh`: arduino-cli 1.5.1, cores `esp32@3.3.10` + `Seeeduino:nrf52@1.1.13`, libs (`ArduinoJson 7.4.3`, `NimBLE-Arduino 2.5.0`, `TFT_eSPI 2.5.43`, `lvgl 8.4.0`), plus the load-bearing configs (`lv_conf.h`, Freenove TFT_eSPI setup). Arduino dir is NOT under iCloud (good).

### 3. Recorder compile — root-caused a broken ctags (GitHub issue #2)
- **Symptom:** `setup-arduino.sh` verify-compile failed — every auto-generated function prototype had its return type stripped (`static  isrFlagBtn();`), cascading into 77 `-fpermissive` errors.
- **Root cause:** `~/Library/Arduino15/packages/builtin/tools/ctags/5.8-arduino11/ctags` was a **symlink to Homebrew's `universal-ctags` 6.2.1**. Universal Ctags emits `typeref:typename:`; arduino-cli 1.5.1's prototype parser expects Exuberant Ctags 5.8's `returntype:` field → it dropped every return type. (Not the firmware, not arduino-cli build — tested both Homebrew + official 1.5.1, identical failure.)
- **Fix (environment):** restored the genuine Arduino Exuberant Ctags 5.8 binary over the symlink.
- **Result:** unchanged recorder source now compiles clean — `1,726,730 B (51%)`, exit 0.
- Maintainer's forward-decl commits (`220f189`, `bec8b5a`) were narrowing the symptom; harmless (byte-identical output) — keep as defense-in-depth or revert, their call. Full writeup posted to issue #2.
- Also: pendant build's final UF2 step calls `python` (this box only has `python3`) → used a `python`→`python3` shim. `flash_xiao.sh` already handles this via `~/.local/pyshim`.

### 4. Pendant firmware — "drops audio packets when battery low" (`SATE_Pendant/SATE_Pendant.ino`)
**Why it happened:** low LiPo = higher internal resistance → deeper voltage sag under BLE TX bursts. The SoC runs on the **LDO** (DC/DC never enabled) which pulls ~2× peak current, so at low battery the sag makes the SoC miss connection events → `notify()` fails. The ring buffer producer (PDM ISR) had **no overrun guard**, so once the stalled consumer let the 0.5 s ring fill, the ISR overwrote unsent samples → dropped/garbled audio (despite the "nothing drops" claim in code + HARDWARE.md).

**Fixes applied (compiled clean, exit 0):**
1. **Enable DC/DC regulator** — `sd_power_dcdc_mode_set(NRF_POWER_DCDC_ENABLE)` after `Bluefruit.begin()`. ~2× lower peak draw → rail holds at low battery. (Root fix for the battery correlation.)
2. **Ring overrun guard** — in `onPDMdata()`, if `(h - t) >= RING_SIZE` drop the newest sample (`ringDropped++`) instead of overwriting unsent audio. Keeps the stream contiguous (one clean gap on recovery, no mid-buffer corruption); HPF state keeps advancing so the filter stays time-aligned. Added `ringDropped` counter for diagnostics.

### 5. Pendant OTA over BLE
- **No bootloader swap needed** — the XIAO already ships the Adafruit/Seeed DFU bootloader (`0.6.2 + S140 7.3.0`), which supports UF2 + serial DFU + BLE OTA DFU. Swapping it is brick-prone (the `0x26000` SoftDevice-corruption trap) and out of scope.
- **Added `BLEDfu` service** (`bledfu.begin()` first, per Adafruit) — the running pendant now advertises the DFU service so a phone can trigger OTA over BLE without a manual double-tap reset.
- Compile with all 3 changes: **`122,500 B (15%)`, RAM `31,952 B (13%)`, exit 0.**

### Follow-ups (need physical device / app work — not done here)
- Flash this build once over USB (`./SATE_Pendant/flash_xiao.sh SATE_Pendant`) so the `BLEDfu`-enabled firmware is on the device; OTA works from then on.
- App side: implement the Nordic BLE DFU protocol (package firmware as a DFU `.zip`, push it). Test first with nRF Connect / nRF Toolbox.
- Optional docs: update `SATE_Pendant/HARDWARE.md` + `INTEGRATION.md` with the 2 battery fixes + OTA notes.
- Optional: harden `setup-arduino.sh` — assert ctags is Exuberant (not a Homebrew symlink) and handle the `python` alias (see issue #2).
