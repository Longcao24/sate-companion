# 08 — Plaud integration

Optional third-party capture path: pair a **Plaud** recorder (NotePin S / NotePro) in the
companion app and sync its recordings into SATE. Plaud audio lands in the **same**
`recordings` table as a SATE recorder — indistinguishable in the web app and reports.

Scope today: **iOS**, **BLE sync**. WiFi Fast Transfer and Android are deferred (Plaud's
Android SDK isn't released). Root deep-dive + build steps: `plaud-integration.md`.

> The Plaud SDK is **arm64 device-only** — no simulator / Expo Go. Off-device the native
> module is absent and `PlaudLink` falls back to a **mock** (silent WAV), so the full UI +
> upload flow stays testable without hardware.

## ⚠️ Device-lock safety — read first

A Plaud device binds to a **stable identity** (`deviceToken`). Binding the same device to a
**different** identity can **permanently lock** it. Three invariants protect against this;
do not break them:

1. **Identity is account-derived, never random.** `plaudUserId(uid) = "sate_<uid>"` — the
   SAME string the `mint-plaud-token` function uses as the Plaud `user_id`, and the SAME
   value passed to `connect(...)`. It is restored on login, so it survives an app
   **reinstall**. Never generate a per-install / per-device token.
2. **Binding recorded in the iOS Keychain**, not AsyncStorage — the Keychain outlives an
   uninstall. `PlaudLink.bindingOwner(sn)` reads it. On reinstall the app sees the existing
   binding and **reconnects** (never re-binds). If a serial is bound to a **different**
   account, `PlaudConnectScreen` refuses to connect rather than risk a lock.
3. **Never auto-depair.** `depair(clear:true)` exists **only** as a user-initiated recovery
   (`PlaudLink.resetBinding`) — never call it automatically, and never on a reinstall.
4. **ACK-before-forget.** Unbind order is law: send depair → device ACKs (`bleDepair`) →
   only then forget locally. Native module refuses depair while disconnected, fails fast on
   a mid-command BLE drop, and times out instead of hanging; `resetBinding` keeps the
   Keychain record on any failure. Forgetting locally before the device ACKs desyncs the
   binding — the device still thinks it's bound and freezes to protect its data.

**Reality check — this is mitigation, not a hardware-proven guarantee.** Plaud's own docs:
*"a device can only be bound to one application at a time"* and *"binding is tied to app
installation — unbind before uninstalling."* iOS gives no uninstall hook, so we cannot
guarantee an unbind-before-delete. The stable identity + Keychain make a **same-account
reinstall** reconnect cleanly **iff** Plaud treats a re-bind with the same `user_id` as
idempotent — **confirm this with Plaud** (undocumented). If a device does end up bound to a
dead install, `resetBinding` (depair) is the recovery path. See `plaud-integration.md` for
the open question + verification checklist.

If you add multi-device, WiFi transfer, or a "switch account" flow, keep all three intact.

## Where it plugs in

Plaud does **not** get its own backend path. It reuses the phone's existing upload:
a Plaud recording is exported as WAV, base64'd, and pushed through
`api.uploadSession(...)` — the same call [03](03-companion-app.md) uses for a BLE-bridged
SATE session. From there it's the ordinary [05](05-backend-supabase.md) →
[06](06-ai-pipeline.md) pipeline.

```
Plaud device ──BLE──▶ PlaudDeviceAgent (native SDK)
                        │  modules/plaud-sate  (Expo native module, Swift)
                        ▼
   src/plaud/PlaudLink.ts  (real ⟷ mock)   exportWav → base64 WAV + sampleRate
                        ▼
   api.uploadSession({ device_serial:"plaud-<sn>", patient_id, session_number,
                       sample_rate, wav_base64 })      ← UNCHANGED SATE path
                        ▼
   device-api ──▶ device-sessions bucket ──▶ [Cloudflare container] ──▶ finalize-session ──▶ recordings
```

`device_serial` is prefixed **`plaud-<sn>`** so Plaud sessions are distinguishable from
SATE recorders in `sate_devices` / `recordings`. No schema change.

## Source map

| Path | Role |
|------|------|
| `modules/plaud-sate/` | Expo local native module wrapping `PlaudDeviceAgent` (iOS/Swift) |
| `modules/plaud-sate/ios/PlaudSateModule.swift` | Bridge: scan / connect / listFiles / exportWav / deleteFile → Promises + events |
| `modules/plaud-sate/ios/PlaudSate.podspec` | Vendors the 3 Plaud frameworks + bundle (CocoaPods auto-embeds) |
| `modules/plaud-sate/app.plugin.js` | Config plugin: Info.plist (local network / Bonjour) + Hotspot entitlement |
| `src/plaud/PlaudLink.ts` | JS interface + real (native) + mock (simulator) impls |
| `src/screens/PlaudConnectScreen.tsx` | Connect UI: scan → connect → pick patient → sync |
| `src/screens/PlaudSettingsScreen.tsx` | Plaud settings: the big UNBIND button (ACK-before-forget recovery flow) |
| `react_app_sate-ui_update/supabase/functions/mint-plaud-token/` | Mints per-user Plaud token, secrets server-side |
| `src/api/sateApi.ts` | `getPlaudToken()` |
| `App.tsx`, `src/screens/HomeScreen.tsx`, `app.json` | Route + "＋ Connect with Plaud" button + plugin |

## Auth — token stays off the device

Plaud partner secrets (`PLAUD_CLIENT_ID`, `PLAUD_API_KEY`) live only in the
`mint-plaud-token` Edge Function. The app calls it with the signed-in SLP's Supabase JWT;
the function does Plaud's 2-step OAuth and returns a per-user **24h** token, which the app
hands to `PlaudSate.initSdk(...)`.

```
app ──(Supabase JWT)──▶ mint-plaud-token
                          │ 1. POST oauth/partner/access-token   (Basic CLIENT_ID:API_KEY)
                          │ 2. POST open/partner/users/access-token (Bearer partner tok,
                          │                                          user_id=sate_<uid>)
                          ▼
                        { token, expiresAt }  ──▶ initSdk(token, "platform-us.plaud.ai")
```

Deploy with `--no-verify-jwt` — the function validates the user token itself (same rule as
`device-api`; see the memory note on `verify_jwt`).

## Sync flow (`PlaudConnectScreen`)

1. `getPlaudToken()` → `initSdk` → `startScan`.
2. Tap a device → `connect(deviceId, userId)` (resolves on the `blePenState` handshake).
3. `listFiles()` → show recordings; SLP picks a patient.
4. Per file: `exportWav` (WAV+sampleRate) → `uploadSession` → `deleteFile` **only after the
   server confirms** (a failed upload never loses the recording).

## Build

See `plaud-integration.md` for the full checklist. Short version, on a Mac with a physical
device:

1. Copy the SDK binaries into `modules/plaud-sate/ios/Frameworks/` (git-ignored, proprietary).
2. `supabase secrets set PLAUD_CLIENT_ID=… PLAUD_API_KEY=…` then
   `supabase functions deploy mint-plaud-token --no-verify-jwt`.
3. `npx expo prebuild -p ios && npx expo run:ios --device`.

## Flag markers — physical tap on the Plaud device

**Marking is NOT part of the Plaud Embedded SDK** (confirmed 2026-07-09 against the official
[iOS SDK docs](https://docs.plaud.ai/plaud-embedded/ios-sdk.md) and the starter app's
`DeviceManager.swift`/`SyncManager.swift`): the docs list no marking method, and the template
never implements `bleMarking` nor calls `getMarking`. The `getMarking` / `getRecordMarkingTags`
requests and their `bleMarking` / `bleGetRecordMarkingTags` responses (+ `BleFile.penCollect`)
live only on the **low-level `BleAgent`** that the SDK bundles but the supported
`PlaudDeviceAgent` wrapper does NOT expose. The consumer Plaud app that shows flags in
realtime is built on the full internal SDK (complete `BleAgentProtocol`), not Embedded. So
everything below is a **best-effort hack into that hidden low-level API** — unsupported, and
to be verified on-device; if it can't surface marks, the fallback is to ask Plaud to expose
marking in the Embedded SDK.

Marks are created by a **physical action on the Plaud device itself** (tap / gesture).

**Marks are PULL, not push** (this bit us — the first design assumed a push and always got
empty flags). Marking lives ONLY on the low-level `BleAgent`, via the `getMarking(sessionId)`
/ `getRecordMarkingTags(uid,start,end)` **requests** and their `bleMarking` /
`bleGetRecordMarkingTags` **responses**. The high-level `PlaudDeviceAgent` we use everywhere
else — and its `PlaudDeviceAgentProtocol` delegate — has **no marking method at all**, so it
silently drops those callbacks. So `exportWav` (native) briefly installs a **forwarding
proxy** (`BleAgentMarkTap`) as `BleAgent`'s single delegate: it tees the two marking
callbacks and forwards everything else to the real wrapper (connect/list/export/record keep
working), fires both the 2.x and 3.0 mark requests, waits (≤3.5 s), then restores the
wrapper. The offsets come back as `markOffsets`, and `PlaudConnectScreen` sends them as
`flags` on `uploadSession` — the SAME column the SATE hardware flag button uses, so
`finalize-session` copies them to `recordings.flags` and they render as the same
seek-bar ticks on the web report.

**Live in-app display.** The SDK has no real-time mark push, so while a take is recording
the native module keeps the proxy installed and **polls `getMarking` every ~2.5 s**, emitting
an `onMark` event ({ sessionId, count, offsets }) whenever the count grows. `PlaudConnectScreen`
shows a live "🚩 N flags" row with each flag's `m:ss` as the user taps the Plaud. Polling
starts on `bleRecordStart`, stops on `bleRecordStop` (with one final pull), and the proxy is
torn down on disconnect. How "live" it truly is depends on whether the device returns marks
for an in-progress session or only after stop — verify on-device.

> **Unverified — needs an on-device rebuild:** (1) whether `bleMarking.markList` values are
> ms offsets (SATE's `flags` convention), seconds, or absolute timestamps; the 3.0 path
> assumes absolute unix-seconds and computes `(timestamp - sessionId) * 1000`. (2) whether
> the NotePin/NotePro answers `getMarking` (2.x) or `getRecordMarkingTags` (3.0). The native
> module prints `[PlaudSate] bleMarking …` / `bleGetRecordMarkingTags …` / `exportWav …
> attaching N mark(s)` — tap the Plaud at a known point, then read those logs to confirm the
> path and unit before trusting the displayed ticks.

Also fixed while wiring this: `device-api`'s `/sessions` JSON path (what the phone calls)
was silently dropping the `flags` field even though the DB column and the `/sessions/chunk`
firmware path already supported it — now forwards it.

## Deferred

- **WiFi Fast Transfer** (~10× faster, `PlaudWiFiAgent`) — not bridged yet; BLE sync works.
  The Hotspot entitlement is already added for when it is.
- **Android** — Plaud SDK not released.
- **Plaud MCP** (`@plaud-ai/mcp`) — a separate developer tool, not part of the app runtime.
