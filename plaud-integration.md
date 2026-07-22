# Plaud integration — "Connect with Plaud"

Adds a **Connect with Plaud** option to the mobile app: pair a Plaud NotePin S /
NotePro over BLE, pull its recordings, and push them through the **same** SATE
pipeline a SATE recorder uses (`uploadSession` → `device-api` → Supabase → AI →
`recordings`). Plaud audio shows up on the home screen and in reports exactly
like SATE-recorded audio.

Scope of this pass: **iOS**, **BLE sync** (WiFi Fast Transfer is stubbed for a
later pass). Android SDK isn't released by Plaud yet.

## ⚠️ Device-lock safety (highest priority)

Binding a Plaud device to a **different** identity can **permanently lock** it.
Three invariants prevent that — never break them:

1. **Stable, account-derived identity.** `plaudUserId(uid) = "sate_<uid>"`,
   used identically by (a) `mint-plaud-token` as the Plaud `user_id` and (b)
   `PlaudLink.connect(...)` as the `deviceToken`. Restored on login → survives
   app reinstall. Never random, never per-install.
2. **Binding lives in the iOS Keychain** (`plaud.bind.<sn>` → account), which
   outlives an uninstall — AsyncStorage does not. On reinstall the app sees the
   binding and **reconnects instead of re-binding**. A serial bound to a
   different account is **refused** in `PlaudConnectScreen`.
3. **No automatic depair.** `depair(clear:true)` is exposed only as user-initiated
   recovery (`PlaudLink.resetBinding`), never automatic.
4. **ACK-before-forget (desync guard).** An unbind is a distributed delete; the
   order is law: (1) send depair to the device → (2) device confirms
   (`bleDepair` ACK) → (3) only then forget locally. The native module enforces
   it: depair is **refused while disconnected**, **fails fast** if BLE drops
   mid-command, and **times out** instead of hanging — and `resetBinding` keeps
   the Keychain record on any failure. Deleting local state first leaves the
   device convinced it's still bound → it freezes to protect its data.
   (Caveat: the SDK's *internal* key deletion order inside `depair` is Plaud's
   binary — if it clears its own key before the ACK, only Plaud can fix that.
   Raised as a question to Plaud below.)

**Not yet a hardware-proven guarantee.** Plaud docs: *"a device can only be bound
to one application at a time"* and *"binding is tied to app installation — unbind
before uninstalling."* iOS has no uninstall hook, so unbind-before-delete can't be
forced. The invariants make a same-account reinstall safe **iff** re-binding with the
same `user_id` is idempotent on Plaud's side.

**OPEN QUESTIONS to confirm with Plaud (these close the guarantee):**
> 1. After an app reinstall, connecting the same device with the same
>    `deviceToken` / `user_id` — does the SDK/server re-bind idempotently
>    (safe), or does it reject / lock because the prior installation never
>    depaired?
> 2. Inside `depair(clear:true)`, does the SDK delete its local key **before**
>    or **after** the device ACKs the unbind? If before, a BLE drop mid-depair
>    desyncs the binding (app forgot, device still bound → frozen). What is the
>    recovery path for a device stuck in that state?

Verification checklist on a real device:
- [ ] Bind device → delete app → reinstall → sign in → connect. Does it reconnect?
- [ ] If it fails, does `resetBinding` (depair) reclaim it?
- [ ] Bind on account A → try connect on account B → must be refused, device stays usable on A.

## How it fits together

```
Plaud device ──BLE──▶ PlaudDeviceAgent (native SDK, arm64 device only)
                        │  modules/plaud-sate  (Expo native module, Swift)
                        ▼
   JS  src/plaud/PlaudLink.ts  (real ⟷ mock)
                        │  exportWav → base64 WAV + sampleRate
                        ▼
   api.uploadSession({ device_serial:"plaud-<sn>", patient_id, session_number,
                       sample_rate, wav_base64 })   ← UNCHANGED SATE path
                        ▼
   device-api → device-sessions → [Cloudflare container] → finalize-session → recordings
```

Token: partner secrets never touch the phone. The app calls the
`mint-plaud-token` Edge Function, which does the 2-step Plaud OAuth server-side
and returns a per-user 24h token.

## Files added / changed

| File | Purpose |
|------|---------|
| `modules/plaud-sate/` | Expo local native module wrapping `PlaudDeviceAgent` |
| `modules/plaud-sate/ios/PlaudSateModule.swift` | Swift bridge (scan/connect/list/exportWav/delete) |
| `modules/plaud-sate/ios/PlaudSate.podspec` | Vendors the 3 Plaud frameworks + bundle |
| `modules/plaud-sate/app.plugin.js` | Info.plist + Hotspot entitlement (survive prebuild) |
| `src/plaud/PlaudLink.ts` | JS interface + real (native) + mock (simulator) |
| `src/screens/PlaudConnectScreen.tsx` | The connect/scan/sync UI |
| `react_app_sate-ui_update/supabase/functions/mint-plaud-token/` | Mints per-user Plaud token |
| `src/api/sateApi.ts` | `getPlaudToken()` |
| `App.tsx`, `src/screens/HomeScreen.tsx`, `app.json` | Route + button + plugin wiring |

## One-time setup (on the Mac, with a physical arm64 device)

1. **Drop in the SDK binaries** (proprietary, git-ignored). From the
   `plaud-sdk-public` repo copy into `modules/plaud-sate/ios/Frameworks/`:
   ```
   PlaudBleSDK.framework  PlaudWiFiSDK.framework
   PlaudDeviceBasicSDK.framework  PlaudDeviceBasicSDK.bundle
   ```
2. **Set the Edge Function secrets** (Plaud Developer Portal creds):
   ```
   supabase secrets set PLAUD_CLIENT_ID=… PLAUD_API_KEY=…
   supabase functions deploy mint-plaud-token --no-verify-jwt
   ```
   `--no-verify-jwt` is required — the function validates the user token itself
   (same rule as the other SATE functions, see memory note on `verify_jwt`).
3. **Build the dev client** (SDK is device-only, not in Expo Go / simulator):
   ```
   npx expo prebuild -p ios
   npx expo run:ios --device        # or an EAS dev build
   ```
   The podspec auto-embeds the frameworks; no manual Xcode steps.

Off-device (simulator / Expo Go) the module isn't present, so `PlaudLink` falls
back to a **mock** — the whole UI + upload flow is exercisable with a fake
silent WAV.

## Notes / next passes

- **`device_serial` is `plaud-<sn>`** so Plaud sessions are distinguishable from
  SATE recorders in `sate_devices` / `recordings`. No schema change needed.
- **WiFi Fast Transfer** (~10× faster) is available in the SDK
  (`PlaudWiFiAgent`) but not yet bridged — BLE sync works today. The Hotspot
  entitlement is already added by the config plugin for when it's wired.
- **Handshake ready signal**: `connect()` resolves on `blePenState`. If pairing
  a brand-new device needs the `bleBind` step first, add that to the delegate.
- **Delete-after-upload** only fires after the server confirms the upload, so a
  failed upload never loses the recording.
```
