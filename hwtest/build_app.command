#!/bin/bash
# Regenerate "SATE Debugger.app" — a lightweight AppleScript launcher for the
# Tkinter Debugger window (no Electron, no extra deps). The .app is git-ignored,
# so run this once on a fresh checkout to (re)create the double-clickable icon.
#
# By default it also drops a copy on the Desktop, which is where it actually gets
# used. Pass a directory to put it elsewhere, or `--here` to build in place only.
set -e
cd "$(dirname "$0")"
HWTEST="$(pwd)"                      # absolute path baked into the app so it can
APP="SATE Debugger.app"              # be placed ANYWHERE (Desktop, Dock, …)

case "$1" in
  --here) DEST="" ;;
  "")     DEST="$HOME/Desktop" ;;
  *)      DEST="$1" ;;
esac

TMP="$(mktemp -t sate_launcher).applescript"
cat > "$TMP" <<APPLESCRIPT
-- SATE Debugger — double-click launcher. Points at a fixed hwtest folder so the
-- app works wherever you put it; runs debug.command (venv setup on first run) and
-- opens the Debugger window detached.
on run
	set hwtest to "$HWTEST"
	do shell script "cd " & quoted form of hwtest & " && nohup ./debug.command >/dev/null 2>&1 &"
end run
APPLESCRIPT

rm -rf "$APP"
osacompile -o "$APP" "$TMP"
rm -f "$TMP"
# ad-hoc sign + clear quarantine so Gatekeeper lets a locally-built app run
codesign --force --deep -s - "$APP" >/dev/null 2>&1 || true
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "Built \"$APP\"."

if [ -n "$DEST" ]; then
  rm -rf "$DEST/$APP"
  cp -R "$APP" "$DEST/$APP"
  xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
  echo "Copied to $DEST/$APP"
fi

echo "First launch: if macOS says \"unidentified developer\", right-click the app →"
echo "Open → Open. After that, double-click works normally."
