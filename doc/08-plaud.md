# 08 — Plaud integration

Optional third-party capture path: pair a **Plaud** recorder (NotePin S / NotePro) in the
companion app and sync its recordings into SATE. Plaud audio lands in the **same**
`recordings` table as a SATE recorder — indistinguishable in the web app and reports.

Scope today: **iOS**, **BLE sync**, **multi-device** (one SATE account can pair several
Plauds), in-app **record control** + **auto-upload**, and **live flag markers**. WiFi Fast
Transfer and Android are deferred (Plaud's Android SDK isn't released). Root deep-dive +
build steps: [`plaud-integration.md`](../plaud-integration.md). Project-wide invariants:
`CLAUDE.md` **RULE #1** (device-lock) and **RULE #2** (shared radio).

> The Plaud SDK is **arm64 device-only** — no simulator / Expo Go. Off-device the native
> module `PlaudSate` is absent (`requireNativeModule("PlaudSate")` throws → `isPlaudAvailable()`
> is `false`), and `makePlaudLink()` returns a **`MockPlaudLink`** (silent WAV, fake scan +
> marks) so the full UI + upload flow stays testable without hardware.

---

## ⚠️ Device-lock safety — read first (RULE #1)

A Plaud device binds to a **stable identity** and, unlike a SATE recorder (recoverable), a
mis-bound / desynced Plaud can be **permanently locked for that account**. There are
**FIVE** invariants (the exact set in `CLAUDE.md` RULE #1). Do not break any; treat any
change touching connect / identity / Keychain / BLE lifecycle / logout / multi-device as
high-risk.

### 1. Stable, account-derived identity — never random, never per-install

```ts
// src/plaud/PlaudLink.ts
export function plaudUserId(supabaseUserId: string): string {
  return `sate_${supabaseUserId}`;
}
```

`plaudUserId(uid) = "sate_<uid>"` is the SAME string used by both:

- the **`mint-plaud-token`** function as the Plaud `user_id` (step 2 of the OAuth: body
  `{ user_id: "sate_<uid>", expires_in: 86400 }`), and
- **`connect(deviceId, plaudUserId(userId))`** as the deviceToken — `PlaudConnectScreen.onPickDevice`
  passes `plaudUserId(userId)`, never a raw `userId`, a random value, or a per-device token.

Because it is derived from the Supabase account id and restored on every login, it **survives
an app reinstall** → a re-bind with the same `user_id` is idempotent (see the residual caveat
below).

### 2. Bind guard **before** connect

`PlaudConnectScreen.onPickDevice` reads `plaud.bindingOwner(sn)` first. If it is set and
`!== userId`, it REFUSES (sets `phase="error"`, "already linked to another SATE account… could
lock the device") and never calls `connect()`. Reconnect to your **own** binding; never
re-bind under a new identity. The auto-connect path in the scan callback is likewise gated on
`plaud.bindingOwner(d.sn) === userId`.

### 3. Binding lives in the iOS **Keychain** (`AfterFirstUnlock`)

`bindingOwner(sn)` / `recordBinding(account, sn)` / `forgetBinding(sn)` go through the native
Keychain (`PlaudSate.keychainGet/Set/Delete`), key **`plaud.bind.<sn>`** (`bindingKey(sn)`),
accessibility class **`AfterFirstUnlock`** so it **outlives an uninstall** (AsyncStorage does
NOT). The known-devices list for multi-device reconnect is Keychain too (key **`plaud.known`**,
a JSON array). Reinstall → the app sees the existing binding and **reconnects, never re-binds**.

### 4. NO auto-depair, ever

`PlaudSate.depair()` is exposed to JS ONLY through the user-initiated **`resetBinding(sn)`**
(the UNBIND button in `PlaudSettingsScreen`). Unmount / teardown / logout / radio-handoff must
only call **`disconnect()`** (drops the BLE link, KEEPS the binding). The radio arbiter's Plaud
release hook is `disconnectPlaud` → `plaud.disconnect()` (see `src/ble/radio.ts`, which spells
this out: *"MUST be `disconnect()` — never `depair()`"*). `PlaudConnectScreen`'s unmount
cleanup also calls `plaud.disconnect()`, gated by a `keepConnection` ref so navigating to
settings (where UNBIND needs the live link) doesn't drop it.

### 5. ACK-before-forget on unbind

Order is law (`resetBinding` in `PlaudLink.ts`):

```ts
async resetBinding(sn) {
  await PlaudSate!.depair();               // resolves ONLY after the device ACKs (bleDepair, status 0)
  PlaudSate!.keychainDelete(bindingKey(sn)); // ← only NOW forget the binding
  this.forgetDevice(sn);                    // and drop it from plaud.known so it won't auto-reconnect
}
```

The native layer **refuses depair while disconnected**, **fails fast** on a mid-command BLE
drop, and **times out (20 s)** instead of hanging. If `depair()` throws, `resetBinding` never
reaches the `keychainDelete` — the Keychain record is **KEPT** for retry. `PlaudSettingsScreen.doUnbind`
surfaces the failure as *"The binding was NOT removed… try again"*. Forgetting locally before
the device ACKs desyncs the binding — the device still thinks it's bound and freezes to protect
its data.

> **Residual (out of our control, not a code bug):** Plaud has not confirmed in writing that a
> re-bind with the same `user_id` is a guaranteed no-op, and iOS gives no uninstall hook so an
> unbind-before-delete can't be forced. The stable identity + Keychain make a same-account
> reinstall idempotent **iff** Plaud treats a same-`user_id` re-bind as a no-op. Open questions
> + the on-device verification checklist live in [`plaud-integration.md`](../plaud-integration.md).
> A "switch account", WiFi-transfer, or any flow that could change the identity or the binding
> lifecycle is high-risk — confirm with the user first.

---

## Where it plugs in

Plaud does **not** get its own backend path. A Plaud recording is exported as WAV, base64'd,
and pushed through the phone's existing **`api.uploadSession(...)`** — the same call
[03](03-companion-app.md) uses for a BLE-bridged SATE session. From there it's the ordinary
[05](05-backend-supabase.md) → [06](06-ai-pipeline.md) pipeline.

```
Plaud device ──BLE──▶ PlaudDeviceAgent (native SDK, arm64 device only)
                        │  modules/plaud-sate  (Expo native module, Swift bridge "PlaudSate")
                        ▼
   src/plaud/PlaudLink.ts  (NativePlaudLink ⟷ MockPlaudLink)   exportWav → base64 WAV + sampleRate + markOffsets
                        ▼
   api.uploadSession({ device_serial:"plaud-<sn>", patient_id, session_number,
                       sample_rate, wav_base64, flags })      ← UNCHANGED SATE path
                        ▼
   device-api  POST /sessions  (USER-authed — Plaud has NO sate_devices row / device key)
                        ▼
   storeSessionRecord → device-sessions bucket + sate_device_sessions row (status='queued', flags[])
                        ▼
   Cloudflare container (cf-processor) → finalize-session → recordings (flags → seek-bar ticks)
```

`device_serial` is prefixed **`plaud-<sn>`** so Plaud sessions are distinguishable from SATE
recorders in `sate_devices` / `recordings`. No schema change. Because Plaud has no device key,
the upload uses the **USER-authenticated** `POST /sessions` branch of `device-api` (stored under
`user.id`; see the in-code comment at `/sessions POST`, device-api **v18**), not the device-key
`/sessions/chunk` path the recorder uses.

**Multi-device.** One account can pair several Plauds. `rememberDevice(sn, name)` keeps a
most-recent-first, sn-deduped list in the Keychain (`plaud.known`); `knownDevices()` /
`lastDevice()` feed the Home screen so every paired Plaud shows as a device row on launch and
reconnects without a manual Connect. `App.tsx` `openPlaud(serial)` opens `PlaudConnectScreen`
with `targetSn`, which auto-connects that specific device (still gated on the bind guard);
`openPlaud()` with no target shows the scan/pick list.

**Radio ownership (RULE #2).** `openPlaud` calls `acquireRadio("plaud")` **synchronously in the
navigation handler**, which is the ONE path that **destroys** the shared ble-plx `BleManager`
(`link.teardown()` → `destroySharedBleManager()`) so the Plaud SDK's own `CBCentralManager` gets
the radio to itself. Leaving Plaud re-acquires `autosync`, whose `disconnectPlaud` hook is
`plaud.disconnect()` (RULE #1 invariant 4) and rebuilds the shared manager lazily. This is a
radio handoff only; it never touches the Plaud binding.

---

## Source map

| Path | Role |
|------|------|
| `modules/plaud-sate/` | Expo local native module wrapping `PlaudDeviceAgent` (iOS/Swift, module name `PlaudSate` / `PlaudSateModule`) |
| `modules/plaud-sate/index.ts` | JS surface of the native module: `PlaudSate` handle, `isPlaudAvailable()`, `addPlaudListener()`, and the `PlaudScanDevice` / `PlaudFileMeta` / `PlaudExportResult` / `PlaudEvent` types |
| `modules/plaud-sate/ios/PlaudSateModule.swift` | Native bridge: scan / connect / depair / listFiles / exportWav / deleteFile / record control / Keychain → Promises + events. **Not in this checkout** (proprietary + generated by prebuild); the JS contract above is authoritative for its surface |
| `modules/plaud-sate/ios/PlaudSate.podspec` | Vendors the Plaud frameworks + bundle (git-ignored, proprietary). **Not in this checkout** |
| `modules/plaud-sate/app.plugin.js` | Config plugin: adds Info.plist `NSLocalNetworkUsageDescription` + `NSLocationWhenInUseUsageDescription`. The Hotspot entitlement block is **commented out** (see Deferred) |
| `modules/plaud-sate/expo-module.config.json` | `platforms: ["apple"]`, `modules: ["PlaudSateModule"]` |
| `src/plaud/PlaudLink.ts` | JS interface + `NativePlaudLink` (real) + `MockPlaudLink`; `plaudUserId()`, `bindingKey()`, `makePlaudLink()` |
| `src/screens/PlaudConnectScreen.tsx` | Connect UI: mint → init → scan/auto-connect → bind guard → listFiles → record control → auto/manual upload → live flags |
| `src/screens/PlaudSettingsScreen.tsx` | The big UNBIND button (ACK-before-forget recovery flow) |
| `src/ble/radio.ts` | Radio arbiter; the ONLY destroy path is the Plaud handoff, and it releases Plaud with `disconnect()` not `depair()` |
| `src/api/sateApi.ts` | `getPlaudToken()`; `uploadSession()` (shared SATE path); `SUPABASE_URL` = project `zlgdpivcbmaodgokkdvz` |
| `cloudflare/src/functions/mintPlaudToken.ts` | Cloudflare Worker **port** of the token mint (mirror of the deployed Supabase edge fn); **disabled by default** (see Auth) |
| `App.tsx`, `src/screens/DeviceListScreen.tsx`, `src/components/AddDeviceSheet.tsx`, `app.json` | Route (`plaud` / `plaudSettings`), `openPlaud()`, the Plaud row in "Add a device" + paired-device rows, plugin. (There is no `HomeScreen.tsx` — the device list IS Companion's home.) |

The live app targets **Supabase** (`SUPABASE_URL/functions/v1/mint-plaud-token` and
`/functions/v1/device-api`). The Supabase edge source for `mint-plaud-token` is not checked into
this repo tree (`react_app_sate-ui_update/supabase/functions/` holds only `device-api` and
`process-device-session`); the Cloudflare port above is the authoritative in-repo reference for
its OAuth shape and safety gate.

---

## Auth — token stays off the device (`mint-plaud-token`)

Plaud partner secrets never touch the phone. The app calls the `mint-plaud-token` function with
the signed-in SLP's Supabase JWT; the function does Plaud's **2-step OAuth** server-side and
returns a per-user **24h** token (`expires_in: 86400`), which the app hands to
`PlaudSate.initSdk(token, "platform-us.plaud.ai")`.

```
app ──(Supabase JWT)──▶ mint-plaud-token
   │ 1. POST oauth/partner/access-token        (HTTP Basic PLAUD_CLIENT_ID:PLAUD_CLIENT_SECRET) → partner token
   │ 2. POST open/partner/users/access-token    (Bearer partner tok, { user_id:"sate_<uid>", expires_in:86400 }) → user token
   ▼
 { token, expiresAt: Date.now()+expires_in*1000 }  ──▶ initSdk(token, PLAUD_DOMAIN)
```

- Base URL in the CF port: `https://platform-us.plaud.ai/developer/api`. `PLAUD_DOMAIN` passed
  to `initSdk` is `platform-us.plaud.ai` (no scheme, per the SDK README).
- Client transport: `sateApi.getPlaudToken()` POSTs to `${SUPABASE_URL}/functions/v1/mint-plaud-token`
  with the user's JWT + the anon `apikey` header, and mirrors `req()`'s single 401-refresh-and-retry.
- **Deploy the Supabase edge fn with `--no-verify-jwt`** — it validates the user token itself
  (same rule as `device-api`; the CLI/MCP default `verify_jwt:true` breaks minting). See the
  memory note on `verify_jwt`.

> ⚠️ **Env-var name (corrected):** the partner secret is **`PLAUD_CLIENT_SECRET`** (with
> `PLAUD_CLIENT_ID`), not `PLAUD_API_KEY`. That is what the CF port reads and what the Basic
> auth header is built from.

### Why the Cloudflare port returns 501 by default

`cloudflare/src/functions/mintPlaudToken.ts` is a **device-lock safety gate**, not a feature
flag: it returns **501** unless `env.PLAUD_ALLOW_MINT === "1"`. The Cloudflare `users` table is a
separate user store with **new uuids**, so `sate_<cloudflare_uid> ≠ sate_<supabase_uid>` — pointing
the app at the CF backend while a device is bound under the Supabase identity would present a
**different** identity to an already-bound device (exactly the re-bind the RULE #1 bind guard
exists to refuse). Enable it only when (a) a clean-slate test fleet with no prior Supabase
binding, (b) the CF `users.id` is seeded with the same uuids as Supabase `auth.users`, or (c)
Plaud has confirmed the re-bind semantics in writing. The header comment in that file is the full
rationale.

---

## Native module surface (`PlaudSate`, `modules/plaud-sate/index.ts`)

The Swift is generated/proprietary (not in this checkout); its JS contract is authoritative:

- **Lifecycle:** `initSdk(token, domain)`, `setUserAccessToken(token)` (refresh without re-init),
  `startScan()`, `stopScan()`, `connect(deviceId, userId): Promise`, `disconnect(): Promise`,
  `depair(): Promise`.
- **Files:** `listFiles(): PlaudFileMeta[]`, `refreshFiles()`, `exportWav(sessionId): PlaudExportResult`,
  `deleteFile(sessionId)`.
- **Record control:** `startRecord()`, `stopRecord()`, `pauseRecord()`, `resumeRecord()`,
  `isRecording(): boolean`, `currentSessionId(): number`.
- **Keychain:** `keychainGet/Set/Delete` (the storage behind bindings + known-devices).
- **Events** (`addPlaudListener`): `onScanResult` `{devices}`, `onConnectState` `{state:number}`,
  `onExportProgress` `{sessionId, progress}`, `onRecordState` `{state, sessionId}`, `onMark`
  `{sessionId, count, offsets}`.
- **`PlaudFileMeta.penCount`** = flag count the DEVICE itself recorded (`BleFile.penCollect`) —
  authoritative, independent of the `getMarking` offset pull (used for the "🚩 N" badge on each
  file row). **`PlaudExportResult.markOffsets`** = the ms offsets pulled at export (see Flag
  markers for the unit caveat).

---

## Sync flow (`PlaudConnectScreen`)

1. **Mint + init.** `api.getPlaudToken()` → `plaud.initSdk(token)`; kick off `api.listPatients()`
   in parallel.
2. **Wait ~2 s, THEN scan.** `setPhase("scan")`, `await sleep(2000)`, then `plaud.startScan(...)`.
   The delay is load-bearing: `initSdk`'s RSA key exchange is async, and calling `startScan`
   before it lands finds nothing (confirmed on-device: `startScan()` logged before *"RSA key pair
   obtained and stored"*). Plaud's own template waits here too.
3. **Pick / auto-connect.**
   - No `targetSn` → the user picks from the scan list (`onPickDevice`).
   - With `targetSn` (multi-device reconnect from Home) → the scan callback auto-connects the
     first match **only** when `d.sn === targetSn` AND `plaud.bindingOwner(d.sn) === userId`
     (bind guard), once (`autoTried` ref).
4. **Bind guard → connect.** `onPickDevice` refuses if `bindingOwner(sn)` belongs to another
   account; otherwise `plaud.connect(d.id, plaudUserId(userId))` (resolves on the native connect
   handshake — `blePenState`), then `recordBinding(userId, sn)` (idempotent → Keychain) +
   `rememberDevice(sn, name)`.
5. **List files.** `plaud.listFiles()` → `phase="files"`; each row shows `penCount` (🚩) + duration.
6. **Record control (optional).** Start/stop the take from the app (`startRecord`/`stopRecord`)
   OR from the Plaud's own button — `onRecordState` tracks both. `state === "recording"`/`"resumed"`
   sets the UI recording; `"stopped"` waits ~1.5 s for the device to finalize, `refreshFiles()`,
   then (if auto-upload) uploads the new take(s).
7. **Upload.** `uploadOne(file)` = `exportWav` → `api.uploadSession({...})` → `deleteFile` **only
   after the server confirms** (a failed upload never loses the recording). A `uploadingRef` Set
   guards a session from being sent twice (auto vs. a manual "Sync" tap).
   - **Auto-upload** (default ON, `autoUpload`): every finished take is pushed immediately, no
     manual tap.
   - **Manual "Sync all"** (`onSync`): loops the file list with a progress bar.
   - If auto-upload fires before a patient is chosen, `patient_id` is `"Unassigned"` so the audio
     still reaches SATE (reassign later on the web report). `device-api` further defaults
     `device_serial→"plaud"` and `patient_id→"PT"` if absent.
   - `flags: wav.markOffsets.length ? wav.markOffsets : undefined` rides along on the upload.
8. **Settings / unbind.** "Device settings (unbind) ›" sets `keepConnection` (so unmount keeps the
   BLE link — depair needs it) and opens `PlaudSettingsScreen`.

---

## Unbind (`PlaudSettingsScreen`) — the recovery path

One deliberately huge red **UNBIND** button; it is the hand-off / recovery path and must be
instantly findable. `doUnbind` = `plaud.resetBinding(sn)` (ACK-before-forget, RULE #1 invariant 5)
→ `plaud.disconnect()`. On success `onUnbound` → `goHome` (which re-acquires `autosync`, i.e. a
plain disconnect + rebuild of the shared manager — the depair already happened, user-initiated).
On ANY failure the Keychain record is KEPT and the UI tells the user to keep the device close and
retry. A two-step destructive `Alert.alert` confirms before firing.

---

## Build

See [`plaud-integration.md`](../plaud-integration.md) for the full checklist. Short version, on a
Mac with a physical arm64 device:

1. Copy the SDK binaries into `modules/plaud-sate/ios/Frameworks/` (git-ignored, proprietary):
   `PlaudBleSDK.framework`, `PlaudWiFiSDK.framework`, `PlaudDeviceBasicSDK.framework` +
   `PlaudDeviceBasicSDK.bundle`.
2. `supabase secrets set PLAUD_CLIENT_ID=… PLAUD_CLIENT_SECRET=…` then
   `supabase functions deploy mint-plaud-token --no-verify-jwt`.
3. `npx expo prebuild -p ios && npx expo run:ios --device` (podspec auto-embeds the frameworks).

Compile-check the native module without a device/signing (per `CLAUDE.md`):
`xcodebuild -workspace ios/SATECompanion.xcworkspace -scheme SATECompanion -sdk iphoneos -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`.

---

## Flag markers — physical tap on the Plaud device

**Marking is NOT part of the Plaud Embedded SDK** (confirmed 2026-07-09 against the official
[iOS SDK docs](https://docs.plaud.ai/plaud-embedded/ios-sdk.md) and the starter app's
`DeviceManager.swift`/`SyncManager.swift`): the docs list no marking method, and the template
never implements `bleMarking` nor calls `getMarking`. The `getMarking` / `getRecordMarkingTags`
requests and their `bleMarking` / `bleGetRecordMarkingTags` responses (+ `BleFile.penCollect`)
live only on the **low-level `BleAgent`** that the SDK bundles but the supported `PlaudDeviceAgent`
wrapper does NOT expose. The consumer Plaud app that shows flags in realtime is built on the full
internal SDK, not Embedded. So everything below is a **best-effort hack into that hidden low-level
API** — unsupported, and to be verified on-device; if it can't surface marks, the fallback is to
ask Plaud to expose marking in the Embedded SDK.

Marks are created by a **physical action on the Plaud device itself** (tap / gesture) and are
**PULL, not push** (the first design assumed a push and always got empty flags). The high-level
`PlaudDeviceAgent` we use everywhere else — and its delegate — has **no marking method at all**,
so it silently drops those callbacks. So `exportWav` (native) briefly installs a **forwarding
proxy** (`BleAgentMarkTap`) as `BleAgent`'s single delegate: it tees the two marking callbacks and
forwards everything else to the real wrapper (connect/list/export/record keep working), fires both
the 2.x and 3.0 mark requests, waits (≤3.5 s), then restores the wrapper. The offsets come back as
`PlaudExportResult.markOffsets`; `PlaudConnectScreen.uploadOne` sends them as **`flags`** on
`uploadSession`.

**One shared flag pipeline.** `flags` is the SAME column the SATE hardware flag button uses:
`device-api`'s USER-authed `POST /sessions` (`storeSessionRecord`) filters them to finite numbers
and writes `sate_device_sessions.flags` (jsonb; `null` when empty); the AI/finalize step copies
them onto **`recordings.flags`**, which render as the same **seek-bar ticks** on the web report.
Reuse this pipeline — don't fork a parallel path. (`device-api`'s `/sessions` JSON path forwards
`flags` at line ~233; an earlier version silently dropped it even though the DB column and the
firmware `/sessions/chunk` path supported it.)

**Two counts, two sources.** `PlaudFileMeta.penCount` (`BleFile.penCollect`) is the device's own
authoritative flag count, shown as "🚩 N" on each file row without an export. `markOffsets` is the
`getMarking` offset pull done at export/live-poll time — those are the actual ms offsets attached
to the upload.

**Live in-app display.** The SDK has no real-time mark push, so while a take records the native
module keeps the proxy installed and **polls `getMarking` every ~2.5 s**, emitting an `onMark`
event (`{ sessionId, count, offsets }`) whenever the count grows. `PlaudConnectScreen` shows a live
"🚩 N flags" row with each flag's `m:ss` (`fmtOffset`, `offsets` treated as ms) as the user taps.
Polling starts on `bleRecordStart`, stops on `bleRecordStop` (with one final pull), and the proxy
is torn down on disconnect.

> **Unverified — needs an on-device rebuild:** (1) whether `bleMarking.markList` values are ms
> offsets (SATE's `flags` convention — `fmtOffset` and the UI assume ms), seconds, or absolute
> timestamps; the 3.0 path assumes absolute unix-seconds and computes `(timestamp - sessionId)*1000`.
> (2) whether the NotePin/NotePro answers `getMarking` (2.x) or `getRecordMarkingTags` (3.0). The
> native module prints `[PlaudSate] bleMarking …` / `bleGetRecordMarkingTags …` / `exportWav …
> attaching N mark(s)` — tap the Plaud at a known point, then read those logs to confirm the path
> and unit before trusting the displayed ticks. (3) how "live" it truly is depends on whether the
> device returns marks for an in-progress session or only after stop.

---

## Deferred

- **WiFi Fast Transfer** (~10× faster, `PlaudWiFiSDK` / `PlaudWiFiAgent`) — not bridged yet; BLE
  sync works. ⚠️ **The Hotspot entitlement is NOT yet added** — the `withEntitlementsPlist` block
  in `app.plugin.js` is **commented out**, because the capability must first be enabled for the App
  ID in the Apple Developer portal or auto-signing fails with *"profile does not support the Hotspot
  capability."* Only the Info.plist local-network + location strings are wired today. (Corrects the
  old claim that the entitlement was "already added.")
- **Android** — Plaud SDK not released.
- **Plaud MCP** (`@plaud-ai/mcp`) — a separate developer tool, not part of the app runtime.
