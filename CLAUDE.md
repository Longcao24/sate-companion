# SATE Companion — project instructions

## ⚠️ RULE #1 — Plaud device-lock safety (READ BEFORE ANY CHANGE)

**A Plaud device can be PERMANENTLY LOCKED if its binding is mishandled.** Unlike a
SATE recorder (recoverable), a mis-bound / desynced Plaud is bricked for that account.
So **every** new feature, refactor, or "small" edit that touches Plaud — connect,
identity, Keychain, BLE lifecycle, teardown, account/login, provisioning, multi-device,
sync, settings — MUST preserve these invariants. When in doubt, stop and re-read
`doc/08-plaud.md` + `plaud-integration.md` before writing code.

Five invariants (verified airtight; do NOT break any):

1. **Stable, account-derived identity — never random/per-install.**
   `plaudUserId(uid) = "sate_<uid>"` is the SAME string used by (a) the
   `mint-plaud-token` edge fn as the Plaud `user_id`, and (b) `connect(deviceId, ...)`
   as the deviceToken. It is restored on login → survives reinstall. Never pass a raw
   uid, a random value, or a per-device token to `connect()`.

2. **Bind guard before connect.** If `bindingOwner(sn)` is set and ≠ this account,
   REFUSE to connect (don't re-bind under a new identity). Reconnect to your own
   binding; never re-bind.

3. **Binding lives in the iOS Keychain** (`plaud.bind.<sn>`), `AfterFirstUnlock`, so it
   outlives uninstall (AsyncStorage does NOT). Reinstall → reconnect, never re-bind.

4. **No auto-depair, ever.** `depair(clear:true)` is exposed ONLY via the user-initiated
   `resetBinding` (the UNBIND button). Unmount/teardown/logout must only `disconnect()`
   (drops the BLE link, keeps the binding) — never depair.

5. **ACK-before-forget on unbind.** Order is law: send depair → device ACKs
   (`bleDepair`, status 0) → ONLY THEN delete the local Keychain record. Native refuses
   depair while disconnected, fails fast on a mid-command BLE drop, and times out (20s)
   instead of hanging; `resetBinding` keeps the Keychain record on ANY failure.
   Forgetting locally before the device ACKs desyncs the binding and freezes the device.

Residual (not a code bug, out of our control): Plaud hasn't officially confirmed that a
re-bind with the same `user_id` is a guaranteed no-op, and iOS can't guarantee Keychain
survives every uninstall path. Our stable identity makes a re-bind idempotent either way —
but if you add a "switch account" flow, WiFi transfer, or anything that could change the
identity or the binding lifecycle, treat it as high-risk and confirm with the user.

Where the logic lives: `src/plaud/PlaudLink.ts` (identity, bindings, resetBinding),
`src/screens/PlaudConnectScreen.tsx` (connect guard), `src/screens/PlaudSettingsScreen.tsx`
(UNBIND), `modules/plaud-sate/ios/PlaudSateModule.swift` (native connect/depair + ACK).

## Build / verify

- **Mobile (Expo, iOS-only for Plaud — arm64 device SDK, no simulator):** the user builds
  via Xcode. Compile-check the native module without a device/signing:
  `xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos \
   -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`
- **Typecheck:** mobile `npx tsc --noEmit` (repo root); web `npx tsc --noEmit` in
  `react_app_sate-ui_update/`.
- Proprietary Plaud frameworks are git-ignored (`modules/plaud-sate/ios/Frameworks/`) —
  never commit them. Deploy `mint-plaud-token` with `--no-verify-jwt`.

## Project knowledge & gotchas (from accumulated notes)

Durable lessons — check the ones relevant to what you're touching. Version numbers drift;
`git log` is the source of truth for current firmware/edge-fn versions.

**Backend / Supabase edge functions**
- **`device-api` and `mint-plaud-token` MUST deploy with `verify_jwt:false`** (they validate
  the token themselves). Redeploying with the MCP default `verify_jwt:true` breaks recorder
  registration ("Setup link expired") and Plaud token minting. Always pass
  `--no-verify-jwt` / `verify_jwt:false`.
- `device-api` is versioned in-comment; bump it when you change routes. Plaud upload uses a
  USER-authed `POST /sessions` (Plaud has no `sate_devices` row / device key).
- **Admin page** `/admin` manages ALL devices + firmware system-wide, gated by the
  `sate_admins` table (by email). Don't expose admin routes without that gate.

**Firmware / hardware (ESP32-S3, `Hardware_w_Screen/`)**
- **GPIO34 cannot be used for battery ADC on the S3** — it bootloops the board. Battery
  sensing was disabled; a real ADC1 pin or a fuel-gauge IC is required.
- **Two-button pinout**: record = GPIO2, flag = GPIO14 (interrupt-latched). Flag markers
  flow device → sessions → recordings → web report seek-bar ticks. Don't reassign lightly.
- **Connectivity runs on a core-0 task**, GUI + buttons on core 1 (fixed button lag + stuck
  uploads). Keep network work off the UI core.
- **OTA**: firmware pulls a `.bin` from Supabase Storage via the command channel; the web
  "Publish firmware" card uploads a release. Bump `FIRMWARE_VERSION` per release so the
  device reports it and the update banner works.
- **Wi-Fi change without factory reset**: BOOT-hold re-provisions Wi-Fi and KEEPS the
  account; a full reset is only for when the server removed the device (heartbeat
  `unclaimed:true`). Don't wipe the account binding for a Wi-Fi change.

**Dev environment**
- **The dev Mac's LAN IP is dynamic** — a stale IP breaks both app launch and provisioning.
  Check `ipconfig getifaddr en0` first when things "suddenly" can't reach the Mac.

**Features**
- **Mobile-link QR login** (2nd login method): web mints a one-time code/QR, the phone
  consumes it for a real session (`mobile-link` edge fn + `mobile_link_codes` table). Needs
  a native rebuild (expo-camera) + web redeploy (qrcode.react) to change.
- **Flag markers** are one pipeline shared by SATE hardware (physical flag button) and Plaud
  (device tap): ms offsets → `flags` column → `recordings.flags` → seek-bar ticks on the web
  report. Reuse it; don't fork a parallel path.

## Docs

`doc/` is the numbered project handbook (`08-plaud.md` = Plaud). `plaud-integration.md`
(repo root) is the Plaud deep dive. Keep docs current when behavior changes. Deeper /
cross-session context lives in the agent memory at
`~/.claude/projects/-Users-hoanglong-Documents-sate-companion/memory/`.
