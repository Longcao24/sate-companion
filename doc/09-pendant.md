# 09 — SATE Pendant integration

Optional capture path: connect a **SATE Pendant** (a Seeed **XIAO nRF52840 Sense Plus**
wearable, marketed as Sona/Nuna) over BLE and stream its live mic audio into SATE. The
firmware is in the repo at `SATE_Pendant/SATE_Pendant.ino`; pendant audio lands in the
**same** `recordings` table as everything else.

Unlike Plaud (proprietary arm64 SDK, permanent device-lock risk — see [08-plaud.md](08-plaud.md)),
the pendant is **standard BLE GATT** driven by `react-native-ble-plx` — the SAME stack SATE
recorders use. So:

- **No native rebuild** to add/change it — ble-plx is already linked. A Metro reload is enough.
- **No binding / device-lock concern** whatsoever (nothing like Plaud's Keychain identity binding).
- On a non-dev build (Expo Go) BLE is unavailable, same as SATE. `PendantLink.isAvailable()`
  returns `true` because the manager is built lazily, but an actual scan needs a dev build on a
  physical phone (simulators/emulators have no Bluetooth).

**Firmware version:** `FIRMWARE_VERSION = "1.0.0"` in `SATE_Pendant.ino` — the first versioned
release. ⚠️ It is **not yet exposed over BLE** (no version characteristic, no DIS firmware-revision
string), so the app currently cannot read the running pendant firmware version. Bump it on every
release and record it in the "Version log" below.

## Where it plugs in

Like Plaud, the pendant reuses the phone's existing upload — no new backend path:

```
Pendant ──BLE (raw PCM notify, 244 B)──▶ PendantLink (react-native-ble-plx)
                        │  src/pendant/PendantLink.ts
                        ▼  accumulate PCM chunks → applyGain → wrap in 44-byte WAV
   api.uploadSession({ device_serial:"pendant-<bleId>", patient_id, session_number,
                       sample_rate:16000, wav_base64 })   ← UNCHANGED SATE path
                        ▼
   device-api (user-authed POST /api/sessions) ──▶ [Cloudflare container] ──▶ finalize-session ──▶ recordings
```

The backend pipeline (queue state machine → Cloudflare container → `finalize-session`) is
identical to a SATE recorder upload; see [05-backend-supabase.md](05-backend-supabase.md). The
pendant has no `sate_devices` row and no device key — it uses the **user-authed** `POST /api/sessions`,
exactly like Plaud.

### `device_serial`, `session_number`, `patient_id` (exact values the app sends)

From `PendantConnectScreen.uploadTake()` → `SateApi.uploadSession()`:

- **`device_serial`** = `` `pendant-${connectedId}` `` — `connectedId` is the ble-plx peripheral id
  (a per-phone CoreBluetooth UUID on iOS, MAC-derived on Android). This is the synthetic device
  identity; the web `deviceTypes.ts` `kind` union is `'sate' | 'plaud' | 'pendant'` and
  `DeviceCard.tsx` / `DevicePanel.tsx` render a `kind === 'pendant'` serial as a **passive external
  device** (grouped with Plaud: no Wi-Fi commands, no OTA card, `extLabel = 'Pendant'`).
- **`session_number`** = `Math.floor(Date.now() / 1000)` — a **Unix-seconds timestamp**, NOT a
  recorder-style monotonic 1..99 slot. The pendant has no on-device session numbering; the phone
  is the source of the record, so it just needs a unique per-take number.
- **`patient_id`** = `patientId || "Unassigned"`. If the user does not pick a patient, the app sends
  the literal sentinel `"Unassigned"`. Because that is not a 36-char UUID, the web
  (`MainApp.tsx`: `patient_id !== 'None' && patient_id !== 'Standalone' && patient_id.length === 36`)
  treats it as **Standalone / unassigned** and it lands in the "Standalone Recordings" bucket. The
  user can tag it to a patient later on the web report. **Never force patient assignment at capture.**
- **`sample_rate`** = `16000`, **`wav_base64`** = the finished WAV (header + gained PCM).

## Source map

| Path | Role |
|------|------|
| `SATE_Pendant/SATE_Pendant.ino` | Pendant firmware (nRF52840, Seeed core / Bluefruit) |
| `SATE_Pendant/HARDWARE.md` | Hard-won flash/BLE/SoftDevice notes (some stale — see below) |
| `SATE_Pendant/INTEGRATION.md` | Vendor-neutral BLE integration guide (advertised name is current; only its title still reads "Sona / Nuna") |
| `SATE_Pendant/flash_xiao.sh` | Compile (Seeed core) → UF2 → raw-write; **aborts on `0x26000`** |
| `src/pendant/PendantLink.ts` | BLE scan/connect/stream/control + PCM→WAV + gain/loudness |
| `src/pendant/PendantStore.ts` | Remembered pendants in AsyncStorage (`pendant.known`) |
| `src/screens/PendantConnectScreen.tsx` | Connect UI: scan → connect → record → (auto-)upload |
| `src/components/AddDeviceSheet.tsx` | "Pendant" entry (`onPickPendant`) in the add-device sheet |
| `src/screens/DeviceListScreen.tsx` | Shows a paired pendant as a device row ("tap to connect & stream") |
| `App.tsx` | `pendant` link, `openPendant(targetId?)` route, radio handoff, `rememberPendant` |
| `src/ble/radio.ts` | Radio arbiter — `RadioOwner` `'pendant'`; hands the shared manager over (stopScan, **never destroy**) |
| web `deviceTypes.ts` / `DeviceCard.tsx` / `DevicePanel.tsx` | pendant shown as a passive external device on `/devices` |

## BLE profile (from the pendant firmware)

Firmware project: the in-repo `SATE_Pendant/` folder (`SATE_Pendant.ino`). UUIDs are declared
uppercase in firmware; `PendantLink.ts` uses the lowercase form ble-plx normalizes to.

```
Device name      "SATE Pendant"   (Bluefruit.setName; in the SCAN RESPONSE, not the ADV packet)
Audio service    19b10000-e8f2-537e-4f6c-d104768a1214   (advertised in the ADV packet)
  Audio (notify) 19b10001-…  → fixed 244 B = 122 × int16 LE PCM  (setFixedLen(PKT_SAMPLES*2))
  Control (write)19b10002-…  → 1 byte: 0x01 start / 0x00 stop / 0x02 find-me (write-with-response)
Battery service  0000180f-… / level 00002a19-…  → 1 byte; percent = b & 0x7F, charging = b & 0x80
OTA DFU service  Nordic/Adafruit BLE DFU (BLEDfu) — added FIRST so its handle is fixed across versions
Audio format     PCM S16LE, 16000 Hz, mono   (no codec — on-device HPF + gain = finished voice)
Packet rate      ~131 notify/s while streaming (16 kHz mono ÷ 122 samples/pkt)
MTU / PHY        247 / 2M preferred; connection interval 30 ms (24 × 1.25 ms)
```

**App-side flow** (`PendantLink`): `connect(deviceId, {requestMTU:247})` →
`discoverAllServicesAndCharacteristics()` → `monitorCharacteristicForService(AUDIO_SERVICE, AUDIO_CHAR)`
(and battery) → `writeControl(0x01)` → PCM notifications accumulate into `chunks[]` (only while the
`capturing` flag is set) → `writeControl(0x00)` → `takeWav()` concatenates the chunks, applies gain,
prepends a 44-byte WAV header, and returns base64 for `uploadSession`.

### Control commands

| Byte | Constant (`PendantLink.ts`) | Firmware action (`onCtrlWrite`) |
|------|-----------------------------|----------------------------------|
| `0x01` | `CMD_START` | `recording=true`, `micStart(SAMPLE_RATE/7)` — drops ~140 ms of mic-settle "pop" |
| `0x00` | `CMD_STOP` | `recording=false`, `PDM.end()` |
| `0x02` | `CMD_FIND_ME` | flash LEDs ~5 s (`findMeUntil = millis()+5000`) — locate the pendant |

Control writes are **write-with-response** (`writeCharacteristicWithResponseForService`).

## App-side capture details (`PendantLink.ts` + `PendantConnectScreen.tsx`)

### Scanning — no service filter, match on name OR service

`startScan()` first waits for the adapter to report `PoweredOn` via `onStateChange` (surfacing the
state to the UI: `PoweredOn` / `Unauthorized` / `PoweredOff`…). It then calls
`startDeviceScan(null, { allowDuplicates: true }, …)` — **no service filter**, because:

- The pendant advertises the **audio service UUID** in the ADV packet but its **name only in the
  SCAN RESPONSE**. iOS surfaces those as `serviceUUIDs` and `localName`, and can deliver them across
  **separate** callbacks — so `allowDuplicates:true` is required to see both sightings.
- `dev.name` on iOS may be a **stale cached GAP name** from earlier firmware (e.g. an old
  "Nuna-Necklace"/"friends"). So the auto-match tests `/sate|pendant|nuna/i` against **both**
  `dev.name` and `dev.localName`, **OR** the advertised audio service UUID as ground-truth fallback:
  `matched = nameMatches || advertisesAudio`.

Every peripheral heard is reported via the optional `onSeen` callback (diagnostics + manual pick);
matched ones also fire `onFound`. `PendantConnectScreen` renders both: a "Nearby pendants" list of
matches and a "Bluetooth diagnostics" card that shows the radio state, how many devices were heard,
and a tappable list to pick the pendant manually if auto-match misses it.

Before scanning, `startScan()` calls `this.manager.stopDeviceScan()` — ble-plx allows only one scan
per manager and this manager is **shared** with SATE/auto-sync, so a stale scan would block ours.

### One shared `BleManager` — NEVER destroy on the SATE↔pendant handoff

`PendantLink` gets its manager from `getSharedBleManager()` (`src/ble/bleManager.ts`) — the **same**
instance SATE uses. This is a hard safety invariant (CLAUDE.md RULE #2):

> Two ble-plx `BleManager` instances — **or destroying one and immediately creating another** —
> leave the native iOS BLE stack broken: scans return **zero devices with no error**. That exact
> bug (SATE→pendant handoff used to destroy the manager and the pendant built its own) is what
> stopped the pendant being found for days.

So on the SATE↔pendant handoff the radio arbiter (`src/ble/radio.ts`) does `stopBleScan()` **only —
never `destroyBle()`**. `destroyBle()` is reserved for the Plaud handoff (its SDK needs the radio to
itself). `teardown()` and `acquireRadio('pendant')` both drop the connection/scan but keep the shared
manager alive. `App.openPendant()` calls `acquireRadio('pendant')` **synchronously in the navigation
handler** (not in an effect — a parent effect runs after the child's and would stop the scan the
screen just started).

### Connect

`connect(deviceId)` → `manager.connectToDevice(deviceId, { requestMTU: 247 })` →
`discoverAllServicesAndCharacteristics()`, then subscribes to the audio characteristic (`chunks`
accumulation) and, best-effort, the battery characteristic (byte where bit 7 = charging, low 7 bits
= percent). Battery monitor failures are swallowed (battery is optional).

### Stop must gate accumulation (`capturing` flag)

BLE notifications keep arriving for a moment after `CMD_STOP` (in-flight packets during the write
round-trip). The audio monitor callback **drops any packet while `!this.capturing`**. `stop()` sets
`capturing = false` **before** writing `CMD_STOP`, so those trailing packets can't tack extra tenths
onto the take (the "duration crept to 0:01/0:02 after Stop" bug). `start()` resets `chunks`,
`capturedBytes`, and sets `capturing = true` — so a `start()` following a stop-without-`takeWav()`
(e.g. an upload error dropped the link) begins from an empty buffer instead of prefixing the new take
with stale audio.

### Mic loudness handling (quiet mic → gain on BOTH ends)

The raw PDM mic is very quiet, so gain is applied in two places — **don't stack both to the point of
clipping:**

**Firmware (`SATE_Pendant.ino`):**
- `MIC_GAIN 64` — PDM analog gain (0..80, default 20). 64 is a bit louder than stock and still clean;
  **70+ clips inside the decimator into a harsh "rè" buzz — keep ≤ ~66.**
- `DIGITAL_GAIN 6.0f` — makeup gain applied per-sample **after** the PDM, with a **tanh soft-clip**
  (`32767 * tanhf(y*DIGITAL_GAIN/32767)`) so loud peaks bend smoothly toward full-scale instead of
  hard-clipping; tanh output is bounded to (-1,1) so it can never exceed int16 range.
- `HPF_R 0.976f` — one-pole DC-blocking high-pass, `y = x - x1 + R*y1`, fc ≈ 60 Hz. PDM mics carry a
  DC bias + sub-bass rumble that muddies the raw stream; removing it is the single biggest clarity win.
  Speech fundamentals + chewing energy sit above 60 Hz, so detection is unaffected. Filter state is
  reset per stream in `micStart()`.

**App (`PendantLink.applyGain`, applied in `pcmToWavBase64` at `takeWav()`):** peak-normalize + a
perceived-loudness drive:
- Find the take's loudest sample, compute `gain = min(MAX_GAIN, max(1, TARGET_PEAK/peak)) * LOUDNESS`
  with `TARGET_PEAK = 0.97*32767`, `MAX_GAIN = 40` (ceiling so a near-silent take doesn't blow the
  noise floor up to a roar), `LOUDNESS = 2.6` (drives the signal past the peak so tanh compresses the
  loud parts and lifts the quiet parts — like a limiter; lower toward 1.5 if it sounds harsh/"rè").
- Never attenuate (`gain ≥ 1`); a per-sample `tanh` soft-clip keeps any residual peak inside int16.

### WAV wrapping

`pcmToWavBase64()` writes a standard 44-byte little-endian PCM WAV header (RIFF/WAVE/fmt /data,
audioFormat=1, channels=1, sampleRate=16000, byteRate=32000, blockAlign=2, bits=16) followed by the
gained PCM, base64-encoded. `takeWav()` returns `{ wavBase64, sampleRate:16000, bytes: pcm.length+44,
durationMs }` and resets the buffer. `capturedMs()` = `capturedBytes / (16000*2) * 1000`.

### Auto-upload on stop

`PendantConnectScreen` defaults **Auto-upload on stop = ON**. Stopping a recording (`onToggleRecord`)
calls `uploadTake(false)` — a silent auto-upload that stays on the recorder screen and shows a status
line ("Auto-uploading…" / "Uploaded to SATE ✓" / a retry prompt on failure). The explicit **"Stop &
upload to SATE"** button (`onSync` → `uploadTake(true)`) stops if needed, uploads, and advances to the
Done screen. A take with `bytes <= 44` (no PCM) is treated as "nothing captured".

### Nap-aware UI

Battery + live-audio subscriptions (`onBattery`, `onAudio`) feed the UI. While recording, a 1 s timer
ticks the duration and flags **quiet** when no audio has arrived for > 2.5 s — the screen shows
"Listening… (quiet — the pendant naps in silence, this is normal)" instead of an error (see Nap mode).

## Pairing persistence (one-tap reconnect)

Paired pendants persist in **AsyncStorage** via `src/pendant/PendantStore.ts` (key `pendant.known`,
a list of `{ id, name }`). Because the pendant is plain BLE with **no binding/lock concern** (unlike
Plaud, whose binding MUST live in the iOS Keychain), a simple AsyncStorage list is sufficient — no
device-lock safety to preserve.

- `onConnected` in `PendantConnectScreen` → `rememberPendant(id, name)` on first successful connect.
- `DeviceListScreen` shows a remembered pendant as a device row ("Paired pendant · tap to connect &
  stream"); tapping it calls `openPendant(serial)` which passes `targetId`, so `PendantConnectScreen`
  **connects straight to that BLE id with no scan**. If the direct connect fails (out of range / off),
  it falls back to a normal scan.
- `forgetPendant(id)` removes it.

(The `id` is the per-phone ble-plx peripheral id, which is fine for reconnect on the same phone.)

## Nap mode — a gap is NOT a disconnect

To save battery the pendant **naps during silence** (`SATE_Pendant.ino` loop):

- While streaming, if audio stays below `LOUD_MEANABS` (1400, mean |sample|) for `SLEEP_AFTER_MS`
  (30 s) the pendant enters `napping`: `PDM.end()`, no BLE notifies, radio idles.
- While napping, every `NAP_CHECK_MS` (2 s) it briefly restarts the mic and listens for
  `NAP_LISTEN_MS` (180 ms, incl. ~`NAP_SETTLE_MS` 60 ms settle), computes `drainMeanAbs()`, and if it
  exceeds `WAKE_MEANABS` (1400) resumes streaming instantly (clears the ring for a clean restart);
  otherwise `PDM.end()` back to rest.
- **The BLE link stays up the whole time.** `PendantConnectScreen` treats a notification gap as
  "quiet / listening", never an error, and keeps the subscription open.

Tunable in firmware: `SLEEP_AFTER_MS`, `WAKE_MEANABS` / `LOUD_MEANABS`, `NAP_CHECK_MS`,
`NAP_LISTEN_MS`. If you need continuous audio regardless of silence, raise `SLEEP_AFTER_MS`.

## Firmware internals worth knowing

- **Throughput.** 16 kHz × 16-bit = 256 kbps, right at BLE's practical ceiling. Three things together
  make it clean: `Bluefruit.configPrphBandwidth(BANDWIDTH_MAX)` **before** `begin()` (this is what
  raises the negotiated MTU from 23 → 247; without it every notify truncates to 20 B = 92% loss);
  the **2M PHY** requested on connect (`requestPHY(BLE_GAP_PHY_2MBPS)`); and a **ring buffer + notify
  retry** — the PDM ISR (`onPDMdata`) fills an 8192-sample ring, `loop()` drains it in 122-sample
  packets and **only advances the tail when `notify()` succeeds** (`break` and retry next loop
  otherwise), so a briefly-busy link never loses data.
- **Connection interval 30 ms** (`requestConnectionParameter(24)`, 24 × 1.25 ms), not 7.5 ms. At
  2M PHY + MTU 247 one connection event still carries the ~4 packets/event the 16 kHz stream needs,
  but the radio wakes ~4× less often → big streaming-power saving; the 0.5 s ring absorbs the added
  latency. (Note: `HARDWARE.md`'s sample snippet still shows `requestConnectionParameter(6)`/7.5 ms —
  the shipped firmware uses 24.)
- **Overrun guard.** If the BLE consumer stalls (notify() failing under a sagging low-battery rail)
  and the ring fills, the ISR **drops the newest sample** (`ringDropped++`) rather than overwriting
  un-sent audio — one clean gap when the link recovers, not mid-buffer corruption. The HPF state keeps
  advancing so the filter stays time-aligned across the gap.
- **DC/DC regulator.** `setup()` calls `sd_power_dcdc_mode_set(NRF_POWER_DCDC_ENABLE)`. Under the
  streaming load the radio draws hard current bursts; on the default LDO those pull ~2× peak current,
  sagging a low/high-ESR LiPo enough to miss connection events → dropped packets (why drops only
  appeared at low battery). DC/DC ~halves the peak draw. The XIAO populates the required inductors,
  so this is safe; it must go through the SoftDevice API (it owns POWER).
- **TX power 0 dBm** (`setTxPower(0)`) — the pendant is <2 m from the phone; +4 dBm just wastes radio
  power. `autoConnLed(false)` — LEDs are driven manually to save ~1 mA.
- **Battery.** VBAT on P0.31/AIN7 behind the on-board 1M/510k divider, enabled by pulling P0.14 LOW;
  `readBatteryPct()` uses the 2.4 V internal ref at 12-bit, discards the first (stale) SAADC read
  after switching the reference, averages 16 reads, disconnects the divider afterward (~4 µA saving),
  and maps voltage to % with a piecewise-linear LiPo curve (3.3 V empty .. 4.1 V full). USB-present
  (charging) is detected directly via `NRF_POWER->USBREGSTATUS` VBUS (the XIAO has no charge-status
  pin). `publishBattery()` packs `pct & 0x7F | (charging ? 0x80 : 0)` and refreshes every 60 s (and
  instantly on plug/unplug).
- **LEDs (active-LOW).** `LED_RED` = P0.26, `LED_BLUE` = P0.06 — both **duty-cycled, not solid**
  (a solid LED burns ~1 mA): streaming = red at ~10% duty (30 ms on / 270 ms off); connected-idle =
  blue blip every 3 s; napping = blue blip every 5 s ("alive"); advertising = blue blink ~1.6 Hz;
  find-me = loud alternating red/blue flash for 5 s. (So "solid = connected" is **not** accurate —
  connected shows a brief periodic blue blip.)
- **BLE OTA DFU.** `bledfu.begin()` (added FIRST so the DFU attribute handle stays fixed across
  versions). The board ships the Adafruit/Seeed DFU bootloader (0.6.2 + S140 7.3.0), so a phone can
  push new pendant firmware over BLE by writing the DFU control point (board reboots into the
  bootloader and streams the image). **The app side does not yet implement the Nordic BLE DFU
  protocol** — the service is present and ready but unused by SATE Companion today.
- **IMU removed.** Older builds also streamed an IMU characteristic (`19B10003`, LSM6DS3). The product
  is audio-only food-intake detection now; the IMU char and all accel/gyro code were deleted. If you
  flash an old UF2 that still advertises `19B10003`, the current app ignores it.

## Flashing the pendant firmware (⚠️ SoftDevice-corruption trap)

Firmware is in the repo at `SATE_Pendant/` (`SATE_Pendant.ino`, `flash_xiao.sh`, `HARDWARE.md`,
`INTEGRATION.md` — the full hard-won recipe). Board = **Seeed XIAO nRF52840 Sense Plus**, flashed by
UF2 (double-tap reset → the `XIAO-SENSE` drive mounts → raw-write the `.uf2`). Build/flash from repo
root with `./SATE_Pendant/flash_xiao.sh SATE_Pendant`.

🛑 **Build with the SEEED core, never the Adafruit Feather core.**
`FQBN = Seeeduino:nrf52:xiaonRF52840SensePlus` (Seeed board package must be installed; index URL
`https://files.seeedstudio.com/arduino/package_seeeduino_boards_index.json`, core `Seeeduino:nrf52@1.1.13`).
It uses the `bluefruit.h` API (the Seeed core is a Bluefruit/Adafruit fork) — **NOT** the mbed core.

- Building with `adafruit:nrf52:feather52840sense` links the app at **`0x26000`** (the S140 6.1.1
  layout), which overwrites the last flash page of the board's **S140 7.3.0 SoftDevice** → BLE stack
  corrupted. **Symptom: the app runs but NEVER advertises, and no USB-CDC serial port enumerates**
  (it hardfaults in `Bluefruit.begin()`). Non-BLE sketches (blink) still run — that's the giveaway
  it's the SoftDevice, not the code.
- The **correct** core links at **`0x27000`**. The UF2 conversion prints the start address —
  `0x27000` = good, `0x26000` = STOP, wrong core. `flash_xiao.sh` aborts if it sees `0x26000` (and
  also if it does not see `0x27000`).

### `flash_xiao.sh` — what it does

1. Sets up a `python` → `python3` shim on PATH (the Seeed build recipe calls `python`, absent on
   macOS) and copies the sketch to a **space-free** `/tmp/<name>` (the recipe doesn't quote paths).
2. `arduino-cli compile -b Seeeduino:nrf52:xiaonRF52840SensePlus`.
3. Converts the emitted `.hex` → `.uf2` with Microsoft's `uf2conv.py` (`--family 0xADA52840`) and
   **guards on the start address** (`0x27000` required, `0x26000` aborts).
4. Waits for `/Volumes/XIAO-SENSE` (double-tap reset), then **raw-writes** the UF2 via `os.open`/
   `os.write` — **not** Finder drag-drop (which fails with error -36: Finder writes xattrs and the
   bootloader reboots mid-copy). A prior failed copy can leave the FAT "dirty" so macOS remounts
   read-only; fix with `diskutil unmount force /Volumes/XIAO-SENSE` then double-tap again.

### Recovering a corrupted (or factory-fresh) board

**Every new board needs this too** — a brand-new, factory-fresh Sense Plus that was *only* ever
flashed correct `0x27000` firmware **still** crashes in `Bluefruit.begin()` (no blue LED, not
advertising). The factory SoftDevice state isn't Bluefruit-compatible until you DFU-flash Seeed's own
bootloader+SoftDevice. No J-Link needed — Seeed ships the image inside the core:

```bash
# 1. double-tap into bootloader, note the /dev/cu.usbmodem* port, then:
ZIP=~/Library/Arduino15/packages/Seeeduino/hardware/nrf52/1.1.13/bootloader/Seeed_XIAO_nRF52840_Sense_Plus/Seeed_XIAO_nRF52840_Sense_Plus_bootloader-0.6.2_s140_7.3.0.zip
pip3 install adafruit-nrfutil --break-system-packages    # one-time
adafruit-nrfutil --verbose dfu serial -pkg "$ZIP" -p /dev/cu.usbmodemXXXX -b 115200   # ~20s, prints "Device programmed." — do NOT unplug
# 2. double-tap again, then flash the correct-core app:
./SATE_Pendant/flash_xiao.sh SATE_Pendant
```

Interrupting the DFU can brick the board (then you'd need SWD/J-Link). This rewrites S140 7.3.0 +
bootloader (downgrades the bootloader to 0.6.2, which is fine).

**Diagnosis trick:** USB-CDC port presence = crash test. After flashing a BLE sketch,
`ls /dev/cu.usbmodem*` — port present = firmware running (BLE OK); no port = crashed in
`Bluefruit.begin()` (SoftDevice broken).

**Verify from the Mac** (macOS is flaky at surfacing scan-response *names* — match on the **audio
service UUID** `19b10000-e8f2-537e-4f6c-d104768a1214`): a `bleak` scan should show the pendant
advertising that service. Blue LED blink = advertising, brief periodic blip = connected. **If a LiPo
battery is attached, unplug it while debugging** — USB won't power-cycle it, so resets/boots get
unpredictable and you chase ghosts. USB-only = clean, repeatable state.

**Stale docs to watch:** `SATE_Pendant/HARDWARE.md` (line ~200) still shows the old advertised name
**"Nuna-Necklace"**; the shipped firmware advertises **"SATE Pendant"** (`Bluefruit.setName`).
(`INTEGRATION.md` already uses "SATE Pendant" as the advertised name — only its *product title* reads
"Sona / Nuna".) `PendantLink.ts`'s comment also references an old sketch
name `xiao_audio_ble.ino` — the real file is `SATE_Pendant.ino`. Trust the `.ino`.

## Version log

| Firmware | Notes |
|----------|-------|
| `1.0.0` | First versioned release. Audio-only (IMU removed). Nap mode, DC/DC regulator, tanh soft-clip gain, BLE OTA DFU service present. Version not yet exposed over BLE. |

## Gotchas / invariants (quick reference)

- **Never use a second `BleManager`, and never destroy the shared one on the SATE↔pendant handoff** —
  it makes iOS scans return zero devices. Radio handoff is `stopScan()` only (`radio.ts`); destroy is
  Plaud-only.
- **Flash with the Seeed core (`0x27000`), never Adafruit Feather (`0x26000`)** — the latter corrupts
  the SoftDevice (app runs, never advertises, no CDC port). `flash_xiao.sh` guards this.
- **Every board (even factory-fresh) needs the Seeed SoftDevice+bootloader DFU restore first.**
- **Scan with no service filter; match name OR localName OR advertised audio service** — the name is
  in the scan response and `dev.name` may be a stale cached GAP name.
- **`capturing` flag gates accumulation** — without it, post-`CMD_STOP` in-flight packets inflate the
  duration.
- **Uploads default to Standalone** (`patient_id: "Unassigned"`); patient assignment is optional and
  can be done later on the web report. Don't force it at capture.
- **A notification gap while connected is nap mode, not a disconnect** — keep the subscription open.
- **Gain lives on both ends** (firmware `MIC_GAIN`/`DIGITAL_GAIN` + app `LOUDNESS`/`MAX_GAIN`); don't
  stack them into clipping (harsh "rè" buzz). Keep PDM analog gain ≤ ~66.

## Related docs

- [05-backend-supabase.md](05-backend-supabase.md) — the shared upload → queue → container →
  `finalize-session` → `recordings` pipeline the pendant reuses.
- [08-plaud.md](08-plaud.md) — the other external-device path (and why the pendant is the easy one:
  no binding/lock risk).
- [07-runbook.md](07-runbook.md) — operational recipes.
