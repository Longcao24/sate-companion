# SATE hardware-in-the-loop test harness

Automated pre-release checks that a **compiler cannot catch**. The worst bugs in
the audit only appear on real timing and real silicon — reboot mid-recording,
dropped BLE packets truncating a WAV, delete-during-upload splicing two takes,
verified trim, crash-safe delete, OTA. This harness drives a real recorder over
USB (and the `device-api` backend) and asserts on **the firmware's own serial log
+ the bytes the server actually stored**.

Real hardware is the target. `--sim` replays the firmware's log lines with no
board attached, purely to self-test the harness's own assertions.

## The `sate` CLI (recommended)

One professional entry point for the whole SATE family — test, flash, and inspect
the recorder and pendant:

```bash
# from the repo root — zero install:
./hwtest/sate test --sim            # run the recorder harness (no hardware)
./hwtest/sate test                  # real recorder over USB serial
./hwtest/sate test -t pendant       # pendant over BLE
./hwtest/sate flash recorder        # build + flash the recorder (auto-detects the port)
./hwtest/sate flash pendant         # build + flash the pendant (Seeed core)
./hwtest/sate devices --ble         # list serial ports + scan for the pendant
./hwtest/sate doctor                # check the toolchain + environment
./hwtest/sate doctor --device       # reset the board + diagnose real hardware faults
./hwtest/sate doctor -d -t pendant  # BLE probe: advertising, connect, battery
./hwtest/sate version               # CLI + firmware source versions
./hwtest/sate gui | ./hwtest/sate dashboard

# or install it as a real `sate` command on PATH:
pip install -e hwtest
sate test --sim
```

`sate` wraps everything below; the raw `run.py`/`gui.py`/`dashboard.py` entry
points still work. Run `sate <command> -h` for options.

## What it checks (each maps to an audit bug)

| Scenario | Guards |
|---|---|
| `boot_health` | Boots to `[MEM] ready`, no crash/hang (LV_TICK_CUSTOM trap, heap/PSRAM) |
| `reboot_resume` | A take interrupted by a reboot **auto-resumes**, and stays remote-controllable while it does |
| `byte_match` | Uploaded bytes on the server **== bytes the device sent** (no truncation/mismatch) |
| `verified_trim` | SD audio is freed **only after** the server confirms it (never on `.synced` alone) |
| `delete_journal` | A delete interrupted by a reboot **heals** (no take hidden behind a numbering hole) |
| `delete_during_upload` | Delete during an upload doesn't **splice two takes** (assisted) |

## Setup

```bash
cd hwtest
python3 -m venv .venv && source .venv/bin/activate   # optional
pip install -r requirements.txt                      # pyserial (for real serial)
cp config.example.toml config.toml                   # then edit it
```

Fill in `config.toml`: the serial `port` (`ls /dev/cu.usbmodem*`), and the
`server` block (`base_url`, `device_key`, `device_serial`, `anon_key`) so the
byte-match check can query `GET /sessions/verify`.

The recorder's firmware must be built with `CDCOnBoot=cdc,USBMode=hwcdc` or no
serial appears (see repo `CLAUDE.md`). The harness resets the board by pulsing
`RTS(EN)`/`DTR(GPIO0)`.

## Easiest: double-click

- **`SATE Hardware Test.app`** — double-click in Finder → opens the test window.
  (First launch only: if macOS says "unidentified developer", right-click → Open →
  Open.) The app is git-ignored; on a fresh checkout run **`build_app.command`** once
  to (re)create it.
- **`start.command`** — same thing without the app icon (opens via Terminal). First
  run sets up a private `.venv` and installs deps (~1 min); after that it's instant.

Then pick a device (Recorder / Pendant) and click **Run (sim)** to try it with no
board, or **Run (hardware)** for a real device. Everything below is the manual /
CLI path.

## Run — two devices, two transports

The **recorder** (ESP32-S3) is tested over **USB serial + device-api**. The
**pendant** (XIAO nRF52840) has no serial and doesn't upload to the server — it
streams PCM over **BLE** — so it's tested with the Mac acting as a BLE central
(the app's role). Pick the device with `--target`.

### Recorder (USB)
```bash
python3 run.py --list                          # show all scenarios
python3 run.py --sim                            # self-test the harness (no board)
python3 run.py --config config.toml             # full run on the attached recorder
python3 run.py --config config.toml --only reboot_resume,byte_match
python3 gui.py --config config.toml             # native window
python3 dashboard.py --config config.toml       # browser control panel
```

### Pendant (BLE)
1. `pip install bleak`, and grant **Bluetooth permission** to Terminal/Python
   (System Settings → Privacy & Security → Bluetooth).
2. Power the pendant on and keep it in range (unpaired from the phone — one BLE
   central at a time).
3. Run:
```bash
python3 run.py --target pendant --sim                    # self-test, no board
python3 run.py --target pendant --config config.toml      # real pendant over BLE
python3 run.py --target pendant --config config.toml --only pendant_stream
```
Pendant scenarios: `pendant_advertise`, `pendant_stream` (make continuous sound
when prompted — catches the nap-wipe / dropped-packet "stuck audio"), `pendant_stop`
(notifies must stop after 0x00), `pendant_battery`, `pendant_findme` (visual LED
confirm). Full end-to-end pendant→server upload is the phone app's job, not this
harness — this checks the pendant firmware's BLE stream + control directly.

Exit code is non-zero if any scenario FAILs or ERRORs, so it drops straight into
CI / a pre-flash gate.

## The bench rig (what needs hardware, not software)

- **USB serial**: always. Reset-to-run is automated (DTR/RTS).
- **Starting a take**: `record_mode = "remote"` queues a `record` command through
  `device-api` with the signed-in clinician session, so no one has to be at the bench.
  `record_mode = "manual"` prompts an operator instead (Enter in the CLI, a **Done**
  button in the dashboard/desktop app).
- **Stopping a take**: the remote `stop` command (fw >=1.5.15). Before it existed, a
  server-started take could only be ended at the device or by the ~62-min ceiling.
- **Reboot**: the remote `reboot` command by default. For a **true brownout**, use
  `reboot_mode = "manual"` (prompted power cut) or wire a USB power relay.
- **A serial reset CANNOT reboot a recording device.** On the debug build `Serial` is
  USB-CDC, whose DTR/RTS reset is handled in software, and the capture loop never
  services USB — the pulse is never seen, the board just keeps recording and the test
  sees nothing. `trigger_reboot()` prefers the remote command and only falls back to
  the serial line. Flashing is unaffected: esptool resets through the USB-Serial-JTAG
  **hardware**, which works even when the firmware is wedged.
- **Auto-resume covers every take** since fw 1.5.16 (button and remote alike), and
  since 1.5.17 a resumed take keeps its network up, so `reboot_resume` is fully
  hands-off: remote record → remote reboot → assert resume → remote stop.

## When the board vanishes from USB

Occasionally, usually right after a run, the recorder stops enumerating entirely -
`sate doctor` reports "no recorder serial port detected" and `/dev/cu.usbmodem*` does
not exist at all. The unit also goes offline on Wi-Fi at the same time, so it is not
merely a lost CDC interface.

Nothing in software reaches it in that state: there is no port to reset and no
network to command. **Unplug the USB cable and plug it back in.** Root cause is not
established yet; if you catch it, note what the last operation was.

Distinguish this from the CDC-reset limitation above: there, the port still exists
and flashing still works - the board just ignores a DTR/RTS reset while recording.

## Honest limitations

- `boot_health` proves `setup()` finished; a *frozen* LVGL still prints `[MEM] ready`,
  so add a post-boot UI-liveness marker to the firmware for full boot-hang coverage.
- `delete_during_upload` and a true mid-renumber interruption need precise timing —
  best with a power relay; the prompted versions are "assisted".
- The harness reads the device's own log for byte counts; it trusts the firmware's
  print, then cross-checks against the server. For end-to-end paranoia, add a WAV
  download + SHA compare (needs a user JWT / signed URL — not wired yet).

## Layout

```
hwtest/
  run.py            CLI
  dashboard.py      local web desktop app (stdlib http.server)
  config.example.toml
  hwtest/
    link.py         serial (real) + queue (sim) + line-matching helpers
    server.py       device-api client (GET /sessions/verify, device-key auth)
    context.py      test context + bench actions (reset / prompt / record)
    scenarios.py    the scenarios + firmware log markers
    sim.py          in-memory device that replays the firmware's log lines
    runner.py       orchestrate + report
```
