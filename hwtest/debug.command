#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EASIEST WAY TO RUN THE DEBUGGER: double-click this file (or "SATE Debugger.app").
# First run sets up a private .venv and installs deps (~1 min); after that it just
# opens the Debugger window. Nothing to type.
#
# The Debugger opens on a login page — sign in with the SLP account, the same way
# the mobile app does. Everything after that (remote record/stop/reboot, the test
# suite, firmware flashing) runs against the device on that account.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

echo "SATE Debugger — starting…"

# 1) private virtualenv + dependencies (first run only)
if [ ! -x .venv/bin/python ]; then
  echo "First run: creating .venv and installing pyserial + bleak (one-time, ~1 min)…"
  python3 -m venv .venv
  .venv/bin/pip install -q --upgrade pip >/dev/null 2>&1 || true
  .venv/bin/pip install -q -r requirements.txt
fi

# 2) make a config.toml from the example if you haven't yet (edit it for real hardware)
if [ ! -f config.toml ]; then
  cp config.example.toml config.toml
  echo "Created config.toml from the example — edit it for real hardware (serial port, server)."
fi

# 3) open the Debugger window
exec .venv/bin/python debugger.py --config config.toml
