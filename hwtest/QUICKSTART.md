# Quick start — SATE debug CLI

Automatic setup — **you don't pip-install or edit anything to get going.**

## Option A — the Debugger window (easiest)
Double-click **`debug.command`** (or **SATE Debugger.app** after running `build_app.command`).
First launch builds a private `.venv` and installs everything (~1 min), then opens the
Debugger. **Sign in with your SLP account in the window** — the same way the mobile app does.
No config file to edit.

## Option B — the command line
From this folder:

```bash
./sate help
```

The first run auto-creates a `.venv`, installs the dependencies, and (for the account-driven
tests) copies `config.example.toml` → `config.toml`. After that it just runs.

Common commands:

```bash
./sate doctor --device      # diagnose a connected recorder (SD, audio, memory, boot…)
./sate devices --ble        # list serial devices / scan for the pendant
./sate flash recorder       # build + flash the recorder (auto-detects the port)
./sate flash recorder --version 1.5.32   # flash a published build (no firmware source needed)
./sate debug                # open the Debugger window
```

## Requirements
- **Python 3.10+** (the launcher makes its own venv).
- **arduino-cli** only if you build firmware from source; flashing a *published* build and all
  the diagnose/monitor/provision commands need no toolchain.

## When you DO need config.toml
Only the account-driven tests — `sate ci`, `sate e2e`, and remote record/stop — need your
account + device. Open `config.toml` (auto-created from the example) and fill in the
`[account]` email/password and `[server]` device serial. Everything else works without it.
Your `config.toml` stays local and is git-ignored — never commit it.
