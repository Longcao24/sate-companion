# SATE Recorder — Hardware Reference

On-device firmware for the SATE clinical speech recorder. This documents the
board, pin map, build/flash, the audio + storage + connectivity pipeline, and —
the part most worth reading — **how the firmware is optimized for memory, RAM,
and the two CPU cores** so long recordings run smooth and never reboot.

Firmware lives in `SATE_Touch_Patient_Record_Play_White/`. Current good version:
**fw 0.9.4** (`main`). Rollback tag: `fw-0.9.1-working`.

---

## 1. Board + chips

| Part | Detail |
|------|--------|
| Board | Freenove ESP32-S3 Display **FNK0104AB**, 2.8" |
| MCU | ESP32-S3, dual-core Xtensa LX7 @ 240 MHz |
| Flash | 8 MB (QIO) |
| PSRAM | 8 MB **OPI** PSRAM |
| Screen | 2.8" **240×320 ILI9341** TFT (via TFT_eSPI) |
| Touch | **FT6336U** capacitive, I2C |
| Audio codec | **ES8311** (I2S): onboard analog mic in + speaker amp out |
| Storage | microSD over **SD_MMC 4-bit** bus |
| Power | USB-C (USB CDC serial on boot) |

Everything is on one board, zero external wiring for the demo.

---

## 2. Pin map

All pins are defined at the top of `SATE_Touch_Patient_Record_Play_White.ino`.

### SD card — SD_MMC 4-bit
| Signal | GPIO |
|--------|------|
| CLK | 38 |
| CMD | 40 |
| D0 | 39 |
| D1 | 41 |
| D2 | 48 |
| D3 | 47 |

`SD_MMC.setPins(CLK, CMD, D0, D1, D2, D3)` then `SD_MMC.begin()`. 4-bit bus =
4× the bandwidth of 1-bit SPI; matters for streaming WAV at 32 KB/s.

### Audio — ES8311 over I2S
| Signal | GPIO |
|--------|------|
| MCLK | 4 |
| BCLK | 5 |
| DIN (codec→MCU, mic) | 6 |
| DOUT (MCU→codec, speaker) | 8 |
| WS / LRCK | 7 |

MCLK = sample_rate × 256 = 16000 × 256 = **4.096 MHz**.

### I2C — shared bus (touch + ES8311 control)
| Signal | GPIO |
|--------|------|
| SCL | 15 |
| SDA | 16 |
| Speed | 400 kHz |

One `Wire.begin(SDA, SCL, 400000)` shared by FT6336U touch and the ES8311
register interface. Begun once, before display init.

### Misc
| Signal | GPIO | Note |
|--------|------|------|
| BOOT button | 0 | active LOW, `INPUT_PULLUP`; hold 5 s = factory reset |
| RECORD button | 3 | external, active LOW, `INPUT_PULLUP` to GND (fw 1.2.0+) |
| FLAG button | 14 | external, active LOW, `INPUT_PULLUP` to GND (fw 1.2.0+) |

**Demo buttons (fw 1.2.0+):** two external push buttons in `Hardware_w_Screen/`.
- **RECORD (GPIO3):** on Home a press starts a take, press again stops it; from
  any other screen a press jumps back to Home. (BOOT/GPIO0 is factory-reset only.)
- **FLAG (GPIO14):** while recording, each press marks the current moment as an
  important event (a live `Flags: N` counter shows on the record overlay). The
  offsets ride the upload to the web report, shown as amber ticks on the seek bar.

GPIO3 is an S3 strapping pin, but `INPUT_PULLUP` idles it HIGH and a momentary
press only pulls LOW after boot, so it doesn't affect the boot strap.

**Fully hardware-driven UI (fw 1.2.4+):** recording is started/stopped by the
physical RECORD button, so Home has **no on-screen record dial and no button
legend** — just the patient panel + live status. The recording overlay has **no
on-screen Stop** either (press RECORD to stop). Playback keeps an on-screen Stop
(there is no physical play button); the RECORD button also stops playback. Home
was rebalanced around the removed widgets (taller patient card, status centred).

⚠️ **Do NOT attach serial (`cat`/monitor) while recording** — opening the CDC
port toggles DTR/RTS and resets the board mid-take. Watch the on-screen UI
instead (see §3 for the same caveat on the record-and-upload path).

---

## 3. Build + flash

Toolchain: `arduino-cli` 1.5.x, ESP32 core 3.3.x.

**FQBN (exact):**
```
esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi
```

Key options and why:
- `PSRAM=opi` — the board has OPI (octal) PSRAM; QSPI setting won't init it.
- `PartitionScheme=huge_app` — the sketch is ~1.6 MB; huge_app gives a 3 MB app
  partition with headroom. (Arduino IDE equivalent: "Huge APP".)
- `USBMode=hwcdc,CDCOnBoot=cdc` — native USB CDC serial; the port enumerates as
  `/dev/cu.usbmodem101`.

**Compile + flash:**
```bash
cd SATE-companion
arduino-cli compile --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi" SATE_Touch_Patient_Record_Play_White
arduino-cli upload  -p /dev/cu.usbmodem101 --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=8M,PartitionScheme=huge_app,PSRAM=opi" SATE_Touch_Patient_Record_Play_White
```

A good flash ends with `Hard resetting via RTS pin...` + `New upload port`.

**Footprint (fw 0.9.4):** flash 1.63 MB = **51%** of 3 MB; static RAM 99 KB =
**30%** of 320 KB, leaving ~228 KB for local/heap.

⚠️ **Do NOT `cat`/open the serial port while a recording is running.** Opening
the CDC port toggles DTR/RTS and **resets the board** mid-record. Use the app /
on-screen UI to watch; only attach serial when idle or for boot logs.

---

## 4. Firmware file map

| File | Role |
|------|------|
| `SATE_Touch_Patient_Record_Play_White.ino` | main: UI (LVGL), record/play, SD, setup/loop |
| `display.cpp` / `.h` | ILI9341 + LVGL init, DMA draw buffers |
| `es8311.cpp` / `.h` / `_reg.h` | ES8311 codec driver |
| `connectivity.cpp` / `.h` | Wi-Fi upload + command poll, BLE provisioning, sync logic |
| `sate_logo_white.h` | boot logo bitmap |

---

## 5. Audio pipeline

| Spec | Value |
|------|-------|
| Sample rate | 16 kHz |
| Bit depth | 16-bit |
| Channels | mono |
| Bitrate | 32 KB/s ≈ **1.9 MB/min** |
| Record ceiling | `RECORD_MAX_SECONDS = 3700` (~62 min safety cap) |
| Stop | runs until the user taps **Stop** (or hits the ceiling) |

**Recording is segmented**, not one giant file:
- Each minute is written as `session_NNNN.partKK.wav` (`SEGMENT_SECONDS = 60`).
- part00 keeps a full WAV header; later parts are raw PCM (header stripped on
  upload). **No on-device merge** — the parts upload directly and the server
  stitches them + patches the RIFF/`data` sizes. Half the SD I/O, no "Saving…"
  stall, and a crash mid-session only loses the current minute.

Capture/playback both stream through one **static 4 KB** buffer
(`audioChunk[AUDIO_CHUNK_BYTES]`) — see optimization #1.

---

## 6. Storage layout (SD)

```
/sate/patients.json                                 roster
/sate/patients/<patient_id>/session_XXXX.part00.wav segment 0 (has WAV header)
/sate/patients/<patient_id>/session_XXXX.partNN.wav segment N (raw PCM)
/sate/patients/<patient_id>/session_XXXX.json       metadata
/sate/patients/<patient_id>/session_XXXX.synced     "on server" marker
```

Session "exists" if it has any part file, a legacy merged `.wav`, **or** a
`.synced` marker. After a successful upload the audio is deleted and only
`.synced` (+ `.json`) remain, so the SD doesn't fill with synced audio — but the
session still counts for numbering so reboots never overwrite a recording.

---

## 7. Connectivity + auto-sync

- **Wi-Fi mode:** auto-uploads sessions to the SATE server, polls
  `GET /api/devices/:id/commands` (~3 s) for `sync_now` / `reload_patients` /
  `record` / `reboot`.
- **BLE mode:** when Wi-Fi is down, advertises to the companion app for
  provisioning + bridge sync.

**Auto-sync is automatic and hands-off.** On a new recording (or on going
online at boot) the device flags an upload sweep; `connLoop()` then uploads each
pending session one ~1 MB slice at a time, writes `.synced`, deletes the local
audio, and moves on. Validated end-to-end at scale (a 64 MB / ~33-min session
auto-uploads cleanly; device stays online throughout).

---

## 8. ⭐ Memory / RAM / core optimization playbook

This is the core of keeping the device smooth on long sessions. Each technique,
why it matters, and where it lives.

### 8.1 Stream everything — no length-proportional mallocs
Recording and playback move audio through **one static 4 KB buffer**
(`audioChunk`, `.ino`). Working memory is **constant** whether the session is
10 s or 60 min. A 64 MB recording uses the same RAM as a 1 MB one. Never buffer
a whole file in RAM (the old base64-the-whole-WAV path needed ~12.7 MB and
failed — deleted).

### 8.2 Keep big buffers static, off the task stack
Hot buffers are file-scope `static`, not stack locals:
`audioChunk[4096]`, connectivity's `ioChunk[4096]` / `upBuf[4096]`, the 32 KB
merge buffer, plus `static` HTTP response buffers ("keeps 1–2 KB off the
loop-task stack"). The loop task runs LVGL + Wi-Fi + JSON on **one** stack;
large locals would blow it.

### 8.3 Size the loop-task stack deliberately
```c
SET_LOOP_TASK_STACK_SIZE(16 * 1024);   // default 8 KB overflows
```
The default 8 KB overflows on the Wi-Fi-online path (HTTPClient fetch + JSON
parse of the roster) and crashes with a corrupted backtrace right after
"Connecting to Wi-Fi". 16 KB gives headroom.

### 8.4 No Arduino `String` in hot paths
Fixed `char[]` buffers + `snprintf` everywhere. Avoids heap fragmentation from
thousands of transient `String` allocs during recording/upload/UI refresh.

### 8.5 `delay(1)` yield in the record loop — the long-session stability fix
The record loop is a tight `read I2S → write SD` loop. Without yielding it
**starves the idle task on that core**, and after ~3 min the board reboots.
The fix is one line every ~120 ms tick:
```c
delay(1);   // yields to idle/RTOS so long records don't trip the watchdog
```
This was misdiagnosed as a watchdog-subscription bug — the loop task isn't on
the TWDT; `esp_task_wdt_reset()` just spammed "task not found". The real cure is
the yield. (Removed the dead `esp_task_wdt_reset` calls.)

### 8.6 Cooperative, sliced upload — stay responsive + online
`connLoop()` sends **one ~1 MB slice per pass** (`UPLOAD_CHUNK_BYTES = 1 MB`),
then returns to `loop()`. The GUI keeps painting and command-polling continues,
so a 64 MB upload doesn't freeze the screen or drop the device offline. HTTP
**keep-alive** (`s_http`, `setReuse`) avoids a TCP handshake per slice.

### 8.7 Segment recording, zero merge — less I/O, less risk
1-min segments stream straight to SD and upload directly (§5). No giant
contiguous file, no merge pass (merge was ~30 s for 6.4 MB and overflowed the
loop stack via deep `lv_timer_handler` re-entry — eliminated).

### 8.8 Double-buffered DMA draw buffers
`display.cpp` allocates **two** LVGL draw buffers of `240 × 24` pixels from
**DMA-capable internal RAM** (`MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA`), with an
automatic single-buffer fallback. 24-line strips (not a full framebuffer) keep
internal RAM free; DMA lets the LCD flush one strip while LVGL renders the next.

### 8.9 Cache the pending-session scan
`scanPending()` walks the whole `/sate/patients` tree (slow, ~15 s hitch on a
full card). It's cached behind a `pendDirty` flag — only re-walked when a
recording is saved, a session syncs, or the roster changes. Everything else
reads the cached count instantly.
> Bug history: `scanPending` once `break`-ed at the first audio-purged session,
> hiding all later ones — they never uploaded and Home falsely read
> "all synced". Fix (fw 0.9.3): check the `.synced` marker before deciding a
> slot is empty; stop only when wav+parts+marker are all absent.

### 8.10 Self-cleaning SD
On boot, `purgeSyncedAudio()` frees the audio of any already-`.synced` session
(server has it; the marker stays for numbering). Keeps a small card from filling.

### 8.11 Touch sets a flag; heavy work runs in `loop()`
Touch callbacks only set `pendingAction`; record/upload/screen-rebuild run from
`loop()`. LVGL is never re-entered from an event handler (re-entrancy =
stack/heap corruption). Same rule lets long blocking work call
`sateHookGuiPump()` to service one GUI tick at a safe depth.

### 8.12 PSRAM vs internal RAM split
8 MB OPI PSRAM holds big/cold allocations; the hot, latency-sensitive buffers
(DMA draw buffers, audio chunk) stay in internal SRAM. `[MEM]` telemetry tracks
both: internal `free`/`largest`/`min` and `psram free`.

### 8.13 Small audio slices = responsive UI (fw 1.2.3+)
The record/playback loops move audio in **1 KB slices (~32 ms)**, not one 4 KB
block (~128 ms), and call `lv_timer_handler()` **every slice (~30 Hz)**. A 4 KB
block meant the GUI/touch were serviced only ~8x/sec, so the on-screen Stop
button missed quick taps and the ring stuttered. The I2S DMA ring absorbs the
few-ms per-slice GUI/SD overhead, so audio timing is unaffected. Ring/elapsed
text still refreshes only a few times a second (cheap to skip).

### 8.14 Never full-rebuild Home on a connectivity ping (fw 1.2.4+)
A connectivity state change (`connStateReq`) used to call `showHomeScreen()`,
which does `lv_obj_clean()` + ~20 widget re-creations + a full repaint. Firing
that on every ping caused periodic jank. Now it calls only `updateConnBadge()`
(the small conn icon); the live status line + counts refresh on their own 250 ms
cadence, and a real roster change still rebuilds Home via `connPatientsReq`.

### Core model
One Arduino **loop task** owns LVGL + connectivity (single-threaded — no locks
needed; that's why `static` scratch buffers are safe). I2S DMA + the LCD flush
run on hardware/DMA in the background. The discipline is: never block the loop
task long without a `delay(1)`/GUI-pump yield (§8.5), and never do
length-proportional work on it (§8.1).

---

## 9. Reading `[MEM]` telemetry

Serial prints heap at boot/record/play/sync:
```
[MEM] boot       int free=233668  largest=180212  min=228272  psram free=8386096
[MEM] ready      int free=138632  largest= 98292  min=137244  psram free=8350368
```
- `int free` — free internal SRAM right now.
- `largest` — biggest contiguous internal block (fragmentation indicator).
- `min` — lowest internal free ever seen (worst-case watermark; the number to
  watch on long sessions).
- `psram free` — free PSRAM.

Healthy: `min` stays well above ~40 KB and is **flat** across a long record
(constant-memory streaming working). A steadily falling `min` = a leak.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Reboot after ~3 min recording | record loop starves idle task | `delay(1)` yield (§8.5) — fixed |
| Record aborts mid-session | serial `cat` toggled DTR/RTS = board reset | don't attach serial mid-record |
| App can't reach device / upload fails | Mac/server LAN IP changed | `ipconfig getifaddr en0`, re-check server IP |
| "auto-records after flash" | stale queued `record` commands on server | clear the server command queue |
| Home "all synced" but a session stuck "queued" | old `scanPending` early-break | fw 0.9.3+ — fixed |
| Crash right after "Connecting to Wi-Fi" | loop-task stack overflow | `SET_LOOP_TASK_STACK_SIZE(16K)` (§8.3) — fixed |
| Screen pans sideways | scrollable LVGL screen + overrun child | scroll disabled globally (fw 0.9.4) — fixed |

---

## 11. Toward a real product (not yet built)

Battery (1S LiPo + PMU/fuel-gauge, USB-C charge); dedicated MEMS/electret mic
near a front grille for better clinical SNR; TLS uploads; device ID + clinician
PIN; handheld wipeable enclosure.
