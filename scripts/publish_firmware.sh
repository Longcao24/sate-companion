#!/usr/bin/env bash
# publish_firmware.sh — one-shot "update the fleet" for the SATE recorder.
#
# Bumps FIRMWARE_VERSION, compiles the shipping build, and PUBLISHES the .bin to
# the SATE backend so every online device pulls it over-the-air (no USB). This is
# exactly what the web Admin "Publish firmware" card does, scripted end-to-end.
#
#   ./scripts/publish_firmware.sh            # auto-bump patch (1.5.0 -> 1.5.1)
#   ./scripts/publish_firmware.sh 1.6.0      # explicit version
#   ./scripts/publish_firmware.sh 1.6.0 "notes shown in the admin release list"
#
# Auth: reads scripts/.publish.env (gitignored) for SATE_ADMIN_EMAIL/PASSWORD and
# logs in to Supabase to mint a short-lived JWT. The admin must be in sate_admins.
#
# Requires: arduino-cli, curl, jq. ESP32 core 3.3.x + the board libs already set up.
set -euo pipefail

# ---- constants (public; the anon key is the client key, safe to embed) --------
SUPABASE_URL="https://zlgdpivcbmaodgokkdvz.supabase.co"
ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0.x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ"
DEVICE_API="${SUPABASE_URL}/functions/v1/device-api"
# OTA REQUIRES the dual-app-slot partition. Do NOT change to huge_app (see Hardware.md).
FQBN="esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKETCH_DIR="${ROOT}/Hardware_w_Screen"
INO="${SKETCH_DIR}/SATE_Touch_Patient_Record_Play_White.ino"
ENV_FILE="${ROOT}/scripts/.publish.env"

say() { printf '\033[1;36m[publish]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[publish] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v arduino-cli >/dev/null || die "arduino-cli not found"
command -v jq >/dev/null || die "jq not found (brew install jq)"
[ -f "$INO" ] || die "sketch not found: $INO"
[ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy scripts/.publish.env.example and fill it in"

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
[ -n "${SATE_ADMIN_EMAIL:-}" ] && [ -n "${SATE_ADMIN_PASSWORD:-}" ] || die "SATE_ADMIN_EMAIL / SATE_ADMIN_PASSWORD unset in $ENV_FILE"

# ---- 1. work out the new version ---------------------------------------------
CUR="$(grep -oE 'FIRMWARE_VERSION[[:space:]]*=[[:space:]]*"[^"]+"' "$INO" | grep -oE '"[^"]+"' | tr -d '"')"
[ -n "$CUR" ] || die "could not read current FIRMWARE_VERSION"

NEW="${1:-}"
NOTES="${2:-}"
if [ -z "$NEW" ]; then
  # auto-bump the patch component (1.5.0 -> 1.5.1); strips any suffix like -1c
  base="${CUR%%-*}"
  IFS='.' read -r MA MI PA <<<"$base"
  NEW="${MA}.${MI}.$(( PA + 1 ))"
fi
[ "$NEW" != "$CUR" ] || die "new version ($NEW) equals current ($CUR) — bump it (never reuse a version)"
say "version: ${CUR} -> ${NEW}"

# ---- 2. write the new version into the sketch --------------------------------
# macOS/BSD sed in-place
sed -i '' -E "s/(FIRMWARE_VERSION[[:space:]]*=[[:space:]]*)\"[^\"]+\"/\1\"${NEW}\"/" "$INO"
say "patched FIRMWARE_VERSION in the sketch"

# ---- 3. compile (arduino-cli needs folder name == .ino name) -----------------
BUILD_PARENT="$(mktemp -d)"
BUILD_DIR="${BUILD_PARENT}/SATE_Touch_Patient_Record_Play_White"
mkdir -p "$BUILD_DIR"
cp "${SKETCH_DIR}/"*.ino "${SKETCH_DIR}/"*.cpp "${SKETCH_DIR}/"*.h "$BUILD_DIR/"
say "compiling (${FQBN}) ..."
arduino-cli compile --fqbn "$FQBN" --output-dir "${BUILD_DIR}/out" "$BUILD_DIR" >/dev/null
BIN="$(ls "${BUILD_DIR}/out/"*.ino.bin 2>/dev/null | head -1)"
[ -f "$BIN" ] || die "compile produced no .bin"
SIZE=$(wc -c <"$BIN" | tr -d ' ')
say "built $(basename "$BIN") — ${SIZE} bytes"

# ---- 4. admin login -> JWT ----------------------------------------------------
say "logging in as ${SATE_ADMIN_EMAIL} ..."
JWT="$(curl -fsS "${SUPABASE_URL}/auth/v1/token?grant_type=password" \
  -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
  -d "{\"email\":\"${SATE_ADMIN_EMAIL}\",\"password\":\"${SATE_ADMIN_PASSWORD}\"}" | jq -r '.access_token')"
[ -n "$JWT" ] && [ "$JWT" != "null" ] || die "login failed (check credentials in $ENV_FILE)"

# ---- 5. publish the .bin ------------------------------------------------------
say "publishing to the fleet ..."
Q="version=${NEW}"
[ -n "$NOTES" ] && Q="${Q}&notes=$(jq -rn --arg n "$NOTES" '$n|@uri')"
RESP="$(curl -fsS -X POST "${DEVICE_API}/firmware?${Q}" \
  -H "Authorization: Bearer ${JWT}" -H "apikey: ${ANON_KEY}" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${BIN}")"
echo "$RESP" | jq . >/dev/null 2>&1 || die "publish failed: $RESP"

rm -rf "$BUILD_PARENT"
say "✅ published firmware ${NEW}. Online devices OTA it on their next heartbeat."
say "   Admin dashboard shows it as the latest release."
echo "$RESP" | jq '{version, url}'
