---
title: The sate CLI
sidebar_position: 4
---

# The `sate` command

One command-line tool to **test, flash, and diagnose** the SATE recorder and pendant from a
laptop. It wraps the hardware-in-the-loop test harness, the firmware build/flash steps, and
the live diagnostics behind a single `sate` entry point.

<div class="badge-row">
<span class="sate-badge">test harness</span>
<span class="sate-badge">flash &amp; release</span>
<span class="sate-badge">diagnostics</span>
</div>

```bash
pip install -e hwtest      # install once (or run in place with ./hwtest/sate)
sate --version             # print the CLI version
sate <command> -h          # per-command help and flags
```

## Test & CI

| Command | What it does |
|---|---|
| `sate ci` | **The standard firmware gate.** Builds and flashes the debug firmware, runs the full hands-off test suite on a real board, and writes a per-version report. Every firmware version must pass this before release. |
| `sate test` | Run the hardware-in-the-loop tests on a connected board. Flags: `--sim` (no board — self-test the harness), `--only <scenario>` (a subset), `-t pendant` (test the pendant over Bluetooth). |
| `sate e2e` | Deep whole-system test: records a take and follows it recorder → backend → processor → AI → done, with per-stage timings. Flag: `--take <seconds>`. |
| `sate infra` | Connection test — one probe per tier the audio depends on (auth, database, device API, verify route, storage, processor, AI-queue state, device heartbeat), with latency. |

:::note[Regression rule]
Any new feature or fix re-runs `sate ci` (the standard suite) before it lands; changes that
touch the backend also run `sate e2e`. When a symptom is reported, look at the device first
(`sate debug` or the on-device diagnostics) before digging into code.
:::

## Flash & firmware

| Command | What it does |
|---|---|
| `sate flash recorder` | Build and flash the recorder firmware (auto-detects the port). Flags: `--version <v>` (flash a published older build), `--image <file>` (a specific binary), `--debug` (enable the serial log). |
| `sate flash pendant` | Build and flash the pendant firmware. |
| `sate firmware` | List every firmware image you can flash (local cache + published releases). |

## Diagnose & monitor

| Command | What it does |
|---|---|
| `sate doctor` | Check the toolchain and environment. Add `--device` to reset the board and report real hardware faults (storage, audio codec, memory, boot, registration). |
| `sate devices` | List connected devices / serial ports. Flag: `--ble` (scan for the pendant). |
| `sate monitor` | Mirror the recorder's live state from its serial log. |
| `sate screenshot` | Capture the recorder's screen to a PNG (debug build only). |
| `sate provision` | Push Wi-Fi to the recorder over Bluetooth (first-time setup/claim, or change Wi-Fi). |

## Graphical tools

| Command | What it does |
|---|---|
| `sate debug` | Launch the desktop **Debugger** app — live screen mirror + remote actions (record / stop / reboot / sync), the scenario runner, and firmware flashing. |
| `sate pipeline` | Live animated map of the audio pipeline (desktop window) — real-time upload progress, per-tier health, and the session being processed. |
| `sate gui` | Launch the native test window. |
| `sate dashboard` | Launch the browser test dashboard. |
| `sate version` | Show the CLI **and** firmware versions (recorder + pendant). For just the CLI version, use the `sate --version` flag. |

The test harness (`sate ci`, `sate test`, `sate e2e`) is the release gate: it exits non-zero on
any fault, so it doubles as a pre-flash check in automation. See
[Hardware testing](../operations/hardware-testing) for how the suite is run, and
[Firmware release](../operations/firmware-release) for the build-and-publish flow.
