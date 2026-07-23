#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# EASIEST WAY TO RUN: double-click this file in Finder.
# First run sets up a private .venv and installs deps (~1 min); after that it
# just opens the SATE hardware-test window. Nothing to type.
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

echo "SATE hardware test — starting…"

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
  echo "Created config.toml from the example — edit it for real hardware (serial port, server, pendant name)."
fi

# 3) open the desktop window (falls back to sim if nothing is attached)
echo "Opening the test window…  (Run (sim) works with no device; pick a device + Run (hardware) for a real board.)"
exec .venv/bin/python gui.py --config config.toml
