# 03 — Companion app

Expo SDK 54 / React Native 0.81 iOS app. It is the SLP's window into their devices: it does
first-time BLE setup of a SATE recorder, claims devices to the signed-in account, bridges a
recorder's offline sessions to the server over Bluetooth, sends remote commands, connects a
**Plaud** recorder and a **SATE Pendant**, and shows the processed report. Every device family
feeds the SAME server-side upload → AI → `recordings` pipeline. Source: `src/` + `App.tsx`.

> Requires a **dev build** (`npx expo run:ios`) — `react-native-ble-plx` and the Plaud native
> module are native code, so Expo Go cannot load them. JS changes hot-reload via Metro; native
> changes need a rebuild. The Plaud SDK is **arm64 device-only** (no simulator). See CLAUDE.md
> "Build / verify".

> **Current-state anchors (verify against code, don't trust prose):** recorder firmware
> `FIRMWARE_VERSION = "1.5.32"` (`SATE_Recorder/SATE_Recorder.ino`); `device-api` is `[v18]`
> (in-comment version, `…/supabase/functions/device-api/index.ts`). Sessions are never
> renumbered — numbers are monotonic and wrap at 99, holes are legal (fw ≥1.5.20); SD-audio
> reclaim is server-verify-gated (fw ≥1.5.13); auto-resume runs from `loop()` (fw ≥1.5.17). Those
> are recorder/backend facts — see [02-firmware.md](02-firmware.md) / [05-backend-supabase.md](05-backend-supabase.md).
> They matter here only because the app renders their consequences (a `pending_sessions` count
> that never renumbers, a `nearby` recorder that still holds the only copy of a take until the
> server verifies it).

## Stack

- **Expo SDK ~54**, **React Native 0.81.5**, TypeScript (`package.json`)
- `react-native-ble-plx@^3.5.0` — BLE central, used by BOTH SATE recorder and Pendant through
  ONE shared `BleManager` (see the radio-ownership section)
- `modules/plaud-sate` — the proprietary Plaud native module (arm64 device only); its own
  `CBCentralManager`, separate from ble-plx
- `@react-native-async-storage/async-storage` — persisted settings + known pendants
- `expo-audio` (`useAudioPlayer`) — in-app playback on the detail + report screens
- `expo-camera` (`QrScannerModal`) — QR quick-sign-in
- Backend: Supabase Auth (`/auth/v1/token`) + the `device-api` Edge Function + a few direct
  Supabase REST/edge calls. There is no separate app server.

## Source map

| Path | Role |
|------|------|
| `App.tsx` | `Root` — the whole nav state machine, radio wiring, session-refresh timer, and the top-level hooks (`useAutoSync`, `useManagedDevices`) |
| `src/protocol.ts` | BLE UUIDs, advertising constants, framing flags, and ALL shared TS types (`ManagedDevice`, `UploadedSession`, `Recording`, `Patient`, `RemoteCommand`, `BleCommand`, …). See [04-ble-protocol.md](04-ble-protocol.md) |
| `src/ble/bleManager.ts` | The ONE shared ble-plx `BleManager` (`getSharedBleManager` / `hasSharedBleManager` / `destroySharedBleManager`) |
| `src/ble/radio.ts` | Radio arbiter — the single source of truth for who owns the phone's radio (`acquireRadio`, `autoSyncAllowed`, `registerRadio`, `subscribeRadio`) |
| `src/ble/SateBle.ts` | `SateLink` interface + `BleLink` class + `makeLink()` — scan, connect, provision, change-Wi-Fi, list/pull sessions, mark-synced, commands, teardown |
| `src/sync/AutoSync.ts` | `useAutoSync` — background BLE bridge; also the only scanner, publishes the `nearby` set |
| `src/devices/useManagedDevices.ts` | `useManagedDevices` — merges SATE (server) + Plaud (Keychain) + pendants (storage) into ONE `ManagedDevice[]` |
| `src/api/sateApi.ts` | `SateApi` interface + `HttpApi` class + `makeApi()`; plus `refreshSession`, `consumeMobileLink`, `RefreshError`, and the `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `DEVICE_API_URL` constants |
| `src/store.tsx` | `StoreProvider` / `useStore` — settings + auth tokens, persisted to AsyncStorage |
| `src/plaud/PlaudLink.ts` | `PlaudLink` interface + `NativePlaudLink` / `MockPlaudLink` + `makePlaudLink()`; identity, Keychain bindings, `resetBinding`. See [08-plaud.md](08-plaud.md) |
| `src/pendant/PendantLink.ts` | `PendantLink` interface + `NativePendantLink` + `makePendantLink()`; PCM capture → WAV, gain. See [09-pendant.md](09-pendant.md) |
| `src/pendant/PendantStore.ts` | Known-pendant list in AsyncStorage (`loadKnownPendants` / `rememberPendant` / `forgetPendant`) |
| `src/screens/` | UI screens (below) |
| `src/components/` | UI kit (`ui.tsx`), `AddDeviceSheet`, `WifiSteps`, `QrScannerModal`, `DeviceFrame`, `PlaudDeviceCard`, `PendantDeviceCard` |
| `src/theme.ts` | Dark-theme tokens (`D`, `C`, `radius`) used everywhere |

> **Note:** the header comment block at the top of `src/api/sateApi.ts` still lists a
> `POST /api/auth/login` endpoint. That is stale — the real `login()` authenticates directly
> against Supabase Auth (`/auth/v1/token?grant_type=password`). Trust the code below, not the
> comment.

## Navigation & screen model (`App.tsx`)

There is **no navigation library**. `Root` holds a single `Screen` union in `useState`, and each
branch renders one screen component. The `Screen` variants:

```
home | recorderDetail{device} | provision | changeWifi{device} | recorderSettings{device}
| preview | plaud{targetSn?} | plaudSettings{sn,deviceName} | pendant{targetId?}
| report{session} | settings
```

`Root` constructs the four singletons once with `useMemo`: `api = makeApi(...)`,
`link = makeLink()`, `plaud = makePlaudLink()`, `pendant = makePendantLink()`. Two always-mounted
hooks run underneath every screen so background work survives navigation:

- `useAutoSync(settings.autoSync, link, api, !!settings.token)` → `{ nearby }` (the BLE bridge)
- `useManagedDevices(api, plaud, knownPendants, !!settings.token)` → `{ devices, loaded, fetchFailed, refresh }`

If `!ready` (store still loading) it paints a blank dark screen; if `!settings.token` it renders
only `LoginScreen`; otherwise it renders the current `Screen`.

### Screens

| Screen (component) | Purpose |
|--------------------|---------|
| `LoginScreen` | Sign in against **Supabase Auth** — email+password **or** a one-time "Quick sign-in" code/QR (mobile-link). On success stores `{serverUrl, token, refreshToken, tokenExpiresAt, user}` |
| `DeviceListScreen` (`home`) | The account's devices, one row per family (SATE/Plaud/Pendant), each tagged by `kind`. Empty/error states; "Add a device" opens `AddDeviceSheet`. This replaced the old `HomeScreen` god-component |
| `RecorderDetailScreen` (`recorderDetail`) | One SATE recorder up close: live status dot, the Record sheet, one-tap Sync (Wi-Fi command OR sync-over-BLE), recent sessions with processing state + in-app playback |
| `RecorderSettingsScreen` (`recorderSettings`) | Rename, live "About" panel (from `sate_devices`), Restart, Change Wi-Fi entry, Unlink & reset |
| `ProvisionScreen` (`provision`) | First-time BLE setup: find unprovisioned recorder → `WifiSteps` wizard → claim + register |
| `ChangeWifiScreen` (`changeWifi`) | Move an already-claimed recorder to a new network (keeps the account); arms an online unit into pairing mode, then `WifiSteps` |
| `PlaudConnectScreen` (`plaud`) | Connect + sync/record a **Plaud** recorder (⚠️ device-lock rules — see [08-plaud.md](08-plaud.md) / CLAUDE.md RULE #1) |
| `PlaudSettingsScreen` (`plaudSettings`) | The UNBIND button (ACK-before-forget recovery path) |
| `PendantConnectScreen` (`pendant`) | Connect + live-capture from a **SATE Pendant** (XIAO nRF52840) — see [09-pendant.md](09-pendant.md) |
| `ReportScreen` (`report`) | Native view of the processed `recordings` row: transcript, analysis, playback, first-open name/protocol review |
| `SettingsScreen` (`settings`) | Account info, the Auto-sync toggle, Sign out |
| `DevicePreviewScreen` (`preview`) | Hardware-free simulation of the recorder's on-screen UI for demos; no server, no BLE |

## Radio ownership model — `src/ble/radio.ts` + `src/ble/bleManager.ts`

Three BLE stacks fight over one physical radio: **SATE** (`BleLink`, ble-plx), **Pendant**
(`NativePendantLink`, also ble-plx), and **Plaud** (proprietary SDK, its own `CBCentralManager`
alive from app launch). This is the single most invariant-dense area of the app; see CLAUDE.md
RULE #2.

**Two physical stacks:**

- `bleplx` — the ONE shared `BleManager` in `bleManager.ts`, used by BOTH SATE and Pendant. It is
  created lazily by `getSharedBleManager()` and destroyed **only** by `destroySharedBleManager()`.
  Creating a second ble-plx manager, **or destroying one and immediately recreating it**, leaves
  the native iOS BLE stack broken — scans return **zero devices with no error**. (This is exactly
  what hid the pendant for days: the old SATE→Pendant handoff destroyed SATE's manager and the
  pendant built its own.)
- `plaud` — the Plaud SDK's `CBCentralManager`.

**Four logical owners** sit over the two physical stacks (finer-grained because auto-sync and a
foreground SATE setup both drive `bleplx` but must never run at once):

```ts
type RadioOwner = "autosync" | "sate-fg" | "pendant" | "plaud";
```

`acquireRadio(owner)` is the ONLY place the radio changes hands. Its rules:

- **SATE ↔ Pendant handoff = `stopBleScan()` only, NEVER destroy.** `autosync`, `sate-fg`, and
  `pendant` all drive the shared `bleplx` manager, so acquiring any of them just stops whatever
  scan was running (one scan per manager) and keeps the manager alive.
- **Plaud is the ONLY destroy path.** Acquiring `plaud` calls `stopBleScan()` **then**
  `destroyBle()` so the Plaud SDK gets the radio to itself; the shared manager is rebuilt lazily
  on the next SATE/Pendant use.
- Releasing the previous owner: leaving `plaud` calls `disconnectPlaud()`; leaving `pendant`
  calls `disconnectPendant()`.
- **Lock safety (RULE #1):** `disconnectPlaud` is wired in `App.tsx` to `plaud.disconnect()` —
  drops the BLE link, KEEPS the binding. `depair()` / `resetBinding` is never wired into the
  arbiter; it happens only via the user-initiated UNBIND button.

`registerRadio({stopBleScan, destroyBle, disconnectPlaud, disconnectPendant})` wires the arbiter
to the real stacks once, in an `App.tsx` effect. Auto-sync gates itself with `autoSyncAllowed()`
(true iff the owner is `null` or `"autosync"`) and re-reads it via `subscribeRadio(...)` — there
is **no screen-name allowlist** anymore; a screen that needs the radio simply acquires an owner.

**`acquireRadio` is called SYNCHRONOUSLY in the navigation handler, never in an effect.** The four
handlers in `App.tsx`:

- `goHome()` → `acquireRadio("autosync")` → `home`
- `openPlaud(targetSn?)` → `acquireRadio("plaud")` (destroys the shared manager) → `plaud`
- `openPendant(targetId?)` → `acquireRadio("pendant")` (stopScan only) → `pendant`
- `openSateFg(next)` → `acquireRadio("sate-fg")` (pauses auto-sync) → `provision` / `changeWifi` /
  `recorderSettings`

Why synchronous and not in an effect: a parent effect runs **after** the child's, so acquiring in
an effect would stop the scan the newly-mounted screen just started. `RecorderDetailScreen`,
`ReportScreen`, and `SettingsScreen` do **not** acquire — they run on `autosync`, so the
background bridge keeps working while they're open.

> **The sync-over-BLE borrow.** `RecorderDetailScreen.syncOverBle()` needs a foreground scan while
> the detail screen otherwise lives on `autosync`. It borrows the radio with
> `acquireRadio("sate-fg")` before scanning/connecting and hands it back with
> `acquireRadio("autosync")` in its `finally`. This is the one place a non-`sate-fg` screen takes
> the radio mid-life; it exists because the shared manager allows only one scan at a time.

## Auto-sync lifecycle — `src/sync/AutoSync.ts`

`useAutoSync(settingEnabled, link, api, signedIn)` is the background BLE bridge and the app's
**only** BLE scanner. While open (and `autoSync` on, radio available, signed in) it scans for SATE
recorders advertising "needs sync", connects, pulls each pending session, uploads it, and tells
the device to mark it synced.

Gating: `enabled = settingEnabled && radioOk`, where `radioOk` tracks `autoSyncAllowed()` through
`subscribeRadio`. The moment any screen acquires `pendant`/`plaud`/`sate-fg`, `radioOk` flips
false and the effect tears the scan down; back on `autosync` it restarts.

The scan callback (`onFound(d)`):

1. Always records presence: `bleSeen.current.set(d.name, Date.now())` regardless of sync need.
2. Skips work unless `!busy && d.needsSync && d.pending > 0`.
3. `link.stopScan()` → `connect` → `listSessions()` → for each: `pullSession` (with progress) →
   `api.uploadSession({device_serial: d.name, patient_id, session_number, sample_rate, wav_base64})`
   → **`link.markSynced(s.n)` only after the server confirmed** → `done++`.
4. `finally`: `link.disconnect()`, clear `busy`, and after a 3.5 s pause resume scanning.

**Presence / `nearby`.** A 2 s interval prunes `bleSeen` to serials heard in the last 10 s and
publishes the `Set<string>` as `nearby`. This is why detail/list screens can show
"Bluetooth · Nearby" for an off-Wi-Fi recorder **without** running their own scan — they read
`nearby` from here (one scan per manager). `SyncActivity` (`phase` scanning/connecting/pulling/
uploading/done/error, plus `deviceName`/`sessionLabel`/`progress`) is also returned, though the
current UI consumes only `nearby`.

> v0.1 auto-sync runs only while the app is **foregrounded**. True background BLE sync is a v0.2
> item (needs iOS background modes + care).

## Device registry — `src/devices/useManagedDevices.ts`

The account's devices come from three unrelated places and the UI shouldn't care:

- **SATE recorders** — the server (`api.listDevices()` → `GET /api/devices`), tagged
  `kind: "sate"`.
- **Plaud** — the iOS Keychain (`plaud.knownDevices()`), synthesized into passive rows
  (`kind: "plaud"`, `id: "plaud:<sn>"`, `online:false`).
- **Pendants** — AsyncStorage (`knownPendants` from `PendantStore`), synthesized
  (`kind: "pendant"`, `id: "pendant:<bleId>"`).

`refresh()` fetches the server list and appends the locally-known externals. On a server failure
it still surfaces the externals and sets `fetchFailed = true`, so a Plaud/pendant-only user never
hits an empty/error wall. It polls every **2 s** while `enabled` (signed in). This is the mobile
mirror of the web app's `deriveExternalDevices` (`DeviceProvider.tsx`); adding a device family is
a one-place change.

## State store — `src/store.tsx`

```ts
interface Settings {
  serverUrl: string;            // FORCED to DEVICE_API_URL (see below)
  token: string | null;         // Supabase access JWT (~1 h)
  refreshToken: string | null;  // Supabase refresh token (long-lived)
  tokenExpiresAt: number | null; // ms epoch
  user: User | null;            // { id, name, email }
  autoSync: boolean;            // default true
}
```

- **Persist key `sate-companion-settings-v3`** (the `v3` bump invalidated stale mock-server URLs
  saved under `v2`).
- **`serverUrl` is not user-editable and is force-overwritten to `DEVICE_API_URL` on every load
  and every login** — even if an older build persisted a custom value. So a provisioned recorder
  always registers/auto-claims to the production Supabase `device-api`. (The old "point `serverUrl`
  at the mock-server" story is no longer reachable from the UI.)
- `update(patch)` merges + persists; `signOut()` clears `token`, `refreshToken`,
  `tokenExpiresAt`, and `user` (keeps `serverUrl` + `autoSync`).

## API client & session lifecycle — `src/api/sateApi.ts`

Constants:

```ts
SUPABASE_URL      = "https://zlgdpivcbmaodgokkdvz.supabase.co"
SUPABASE_ANON_KEY = "<public anon JWT>"                 // sent as the `apikey` header on every call
DEVICE_API_URL    = `${SUPABASE_URL}/functions/v1/device-api`
```

`makeApi(serverUrl, token, onUnauthorized?)` returns an `HttpApi` (implements `SateApi`). Every
request goes through `req()`, which always sends `apikey` (Supabase gateway requirement) and, when
present, `Authorization: Bearer <token>`.

**Auth is against Supabase Auth, not device-api:**

- `login(email, pass)` → `POST /auth/v1/token?grant_type=password` → `{token, refreshToken, expiresAt, user}`.
  `expiresAt = Date.now() + expires_in*1000` (~1 h).
- `refreshSession(refreshToken)` (module-level, not a method) → `POST /auth/v1/token?grant_type=refresh_token`.
- `consumeMobileLink(code)` → `POST /functions/v1/mobile-link {action:"consume", code}` — the QR /
  one-time-code login. Returns the same shape as `login()`.

**Self-healing session (the reason logins persist for weeks like the web app):**

1. On any `401`, `req()` calls `onUnauthorized()` **once**, swaps in the fresh token, and replays
   the request. So an expired access token never reaches the UI.
2. `App.doRefresh` (the `RefreshHandler`) dedupes concurrent refreshes through a single in-flight
   promise (`refreshing` ref) so the proactive timer and a 401 retry don't race — important because
   Supabase **rotates** refresh tokens.
3. A `useEffect` timer in `Root` refreshes **proactively** when within 5 min of expiry (ticks every
   60 s), so most calls never even see a 401.
4. **`RefreshError.authInvalid`** distinguishes a genuinely dead refresh token (`invalid_grant` /
   `refresh_token_not_found` / `already_used` on a 400/401 → `signOut()`) from a transient
   network/server failure (→ keep the session, retry later). **A network blip must never log the
   user out.**

**REST surface** (device-api unless noted, prefix `/api`):

| Method | Path | Client method |
|--------|------|---------------|
| GET | `/api/devices` | `listDevices()` |
| POST | `/api/devices/claim-token` | `claimToken()` → one-time token bound to the account |
| PATCH | `/api/devices/:id` `{name}` | `renameDevice()` |
| DELETE | `/api/devices/:id` | `removeDevice()` (unlink) |
| POST | `/api/devices/:id/commands` `{op, patient?}` | `sendCommand()` |
| GET | `/api/patients` | `listPatients()` |
| GET | `/api/sessions[?device=<serial>]` | `listUploads()` → `UploadedSession[]` |
| GET | `/api/sessions/:id/audio` (URL + auth header) | `audioSource()` (fed to `expo-audio`) |
| POST | `/api/sessions` `{device_serial, patient_id, session_number, sample_rate, wav_base64, flags?}` | `uploadSession()` |

Two methods bypass device-api and read Supabase **REST** directly (RLS scopes rows to the owner —
the phone reads the exact same `recordings` rows the web app does):

- `getRecording(id)` → `GET /rest/v1/recordings?id=eq…&select=<RECORDING_COLS>` (explicit column
  list, kept narrow).
- `updateRecording(id, meta)` → `PATCH /rest/v1/recordings…` sets `recording_name`/`protocol`/
  `notes`, clears `needs_review`, stamps `updated_at`.

And one lives on a different edge function:

- `getPlaudToken()` → `POST /functions/v1/mint-plaud-token` — mints a short-lived (~24 h) per-user
  Plaud access token; partner secrets stay server-side. Mirrors `req()`'s single 401-refresh-retry.

## SATE recorder — provisioning, change-Wi-Fi, sync-over-BLE

### First-time provisioning (`ProvisionScreen` + `WifiSteps` + `BleLink.provision`)

1. **Phase "find":** scan for **unprovisioned** recorders (adv flag bit0) and list them.
2. Tap one → `link.connect(id)` (ble-plx, `requestMTU: 247`, discover services, subscribe to
   STATUS + DATA notify chars).
3. **Phase "wifi":** `WifiSteps` auto-runs `link.scanWifi()` (the recorder's radio is 2.4 GHz-only,
   so every returned SSID is already 2.4 GHz), user picks a network + types the password.
4. `provisionSubmit`: mint `api.claimToken()` (binds the recorder to this account) — routed through
   the shared self-healing `api` so a near-expiry token transparently refreshes instead of dead-
   ending. If claiming fails and the server is Supabase (`needsClaim`), surface a clear error and
   stop; do **not** push an empty claim token.
5. `link.provision({ssid, pass, server: settings.serverUrl, claim_token}, onProgress)` BLE-writes
   `{op:"provision", …}` and streams `ev:"state"` updates: `connecting → wifi_ok → registering →
   registered | error`. Resolves on `registered`/`error`; a **60 s** guard resolves to `error` so a
   mid-provision BLE drop can't wedge the UI.

> **Onboarding is BLE-only.** Wi-Fi creds are entered in the app and sent over BLE; the device does
> not scan Wi-Fi for setup, and a join failure surfaces in the app (the firmware sends a specific
> reason — "Wrong Wi-Fi password", "no response from router - is it 2.4 GHz?", etc. — which
> `WifiSteps` shows as the failure headline).

> **Fixed failure mode (kept as a warning):** an expired Supabase session with no refresh once made
> `claimToken()` fail silently, pushing an empty `claim_token` → device register `401`. Fixed by
> the refresh-token + self-heal architecture above. Do NOT re-implement auth locally in a screen
> (the old code built a handler-less `api` with no retry and dead-ended on any hiccup).

### Change Wi-Fi (`ChangeWifiScreen`)

Keeps the account and device key — no re-registration. If the unit is online it isn't advertising,
so the screen first `api.sendCommand(id, "wifi_change")` to arm it into pairing mode (~12 s poll
cadence → a longer 30 s scan window), then `findNearby(serial)` → `connect` → `WifiSteps` with
`link.changeWifi({ssid, pass}, …)` (op `change_wifi`, success state `wifi_saved`, **45 s** guard).
Backing out mid-flow (`close()` or unmount) sends `cancel_wifi` over BLE so the board leaves
pairing mode immediately instead of waiting for its ~3-min timeout.

### Detail screen commands & sync (`RecorderDetailScreen`)

- Live status derives from `dev.state` (`idle`/`recording`/`uploading`) + `online` + `nearby`.
  Polls `listDevices` + `listUploads(serial)` + `listPatients` every 2 s; shows the last 6 uploads
  with `statusOf()` = `failed` (`process_error`) / `ready` (`processed && recording_id`) /
  `processing`.
- **Record:** a patient sheet (pick from roster or type ID/name/type) → `sendCommand("record",
  {patient_id, name?, session_type?})`. Requires the recorder online.
- **Sync:** if online → `sendCommand("sync_now")`; if off Wi-Fi → `syncOverBle()` (borrows the
  radio as `sate-fg`, scans by serial, connects, prompts the user to bring the recorder close, hands
  the radio back).
- **Patients:** `sendCommand("reload_patients")`. Ready sessions open `ReportScreen`; play uses
  `expo-audio` + `api.audioSource(id)`.

`RemoteCommand` = `sync_now | reload_patients | reboot | wifi_change | record`. Point-to-point BLE
`BleCommand` = `reboot | factory_reset | cancel_wifi` (used when the recorder has no Wi-Fi).

### Recorder settings (`RecorderSettingsScreen`)

Rename (`renameDevice`); a live "About" panel polling `listDevices` every 4 s (fw/IP/last-seen/
online/pending straight from `sate_devices`, never the navigation snapshot); Restart (`reboot` over
Wi-Fi, else find-by-serial + BLE `reboot`); Change Wi-Fi entry; and **Unlink & reset** —
`removeDevice(id)` frees it server-side (online units pick up `{unclaimed:true}` on their next
heartbeat and wipe), and for an off-Wi-Fi unit it also pushes a BLE `factory_reset` if nearby so it
resets immediately.

## BLE link internals — `src/ble/SateBle.ts`

`makeLink()` returns a `BleLink` (implements `SateLink`). It reads the shared manager through a
getter (`getSharedBleManager()`), never holding its own.

- **Scan gating:** `startScan()` waits for the adapter to reach `PoweredOn` via
  `onStateChange(..., true)` before `startDeviceScan([SATE_SERVICE], …)` — on iOS the central
  reaches `PoweredOn` a moment after a screen mounts, and scanning early fails silently. Manufacturer
  data is parsed at offsets 0 and 2 (ble-plx prepends a 2-byte company id on Android): `[0]=0x5A`
  magic, `[1]` flags (bit0 unprovisioned, bit1 needs-sync), `[2]` pending count.
- **Framing (`FrameAssembler` / `frameChunks`):** every JSON/binary payload > one packet is split
  `[flag][payload]`, flag `0x01`=partial / `0x02`=final. Control writes use write-with-response;
  STATUS + DATA arrive as notifications reassembled per-characteristic.
- **`pullSession(n)` integrity check (critical, do not remove):** the device announces the exact
  byte count in `ev:"file"`; after the raw stream on CHAR_DATA finishes the assembled length is
  reconciled and **throws on mismatch**. BLE notifications are unacknowledged — a dropped data
  notify silently truncates the stream, and without this a short WAV would be uploaded and
  `markSynced`'d as a complete take, permanently losing the tail of the only copy.
- `teardown()` (wired to `destroyBle`) cancels the connection **and** destroys the shared manager —
  used ONLY on the Plaud handoff; the lazy getter rebuilds it on the next SATE/Pendant use.

Full wire format: [04-ble-protocol.md](04-ble-protocol.md). UUIDs live in `protocol.ts`
(`SATE_SERVICE 53415445-0001-…`, `CHAR_INFO …0010`, `CHAR_CONTROL …0020`, `CHAR_STATUS …0030`,
`CHAR_DATA …0040`).

## Plaud device family — `src/plaud/PlaudLink.ts` + screens

`makePlaudLink()` returns `NativePlaudLink` when the arm64 SDK is compiled in, else `MockPlaudLink`
(simulator/Android/Expo Go — a working mock so UI + the upload pipeline stay testable off-device).
Both implement `PlaudLink`.

**Device-lock safety is the whole game (CLAUDE.md RULE #1 / [08-plaud.md](08-plaud.md)):**

- Identity is **always** `plaudUserId(uid) = "sate_<uid>"` — the SAME string the `mint-plaud-token`
  edge function uses as the Plaud `user_id`, restored on login, so it survives reinstall. Never
  random, never per-install.
- Bindings live in the iOS **Keychain** (`plaud.bind.<sn>`), which outlives uninstall (AsyncStorage
  does not). `bindingOwner(sn)` gates connect: if a serial is bound to a **different** account,
  `PlaudConnectScreen` refuses rather than risk a lock.
- **No auto-depair, ever.** `resetBinding(sn)` (the only depair path) is user-initiated from
  `PlaudSettingsScreen`'s UNBIND button and is **ACK-before-forget**: `depair()` resolves only after
  the device confirms, then the Keychain record is deleted; any failure keeps the record.
  Unmount/teardown/logout only `disconnect()`.

`PlaudConnectScreen` flow: `getPlaudToken()` → `initSdk(token)` → wait ~2 s for the SDK's async RSA
key exchange (scanning before it lands finds nothing) → scan → connect with the stable identity →
`recordBinding` + `rememberDevice` → `listFiles`. Recording can be driven from the app or the
device button (`onRecordState`); flag taps stream live (`onMark`) into the shared flag pipeline.
Auto-upload (default on) pushes each finished recording immediately; `uploadOne` guards against
double-upload and, per file, `exportWav → api.uploadSession({device_serial:"plaud-<sn>", flags:
markOffsets}) → deleteFile` (delete only after the server confirmed). One account can pair multiple
Plauds (`knownDevices`, most-recent-first); `targetSn` reconnects a specific one.

## Pendant family — `src/pendant/PendantLink.ts` + `PendantConnectScreen`

`makePendantLink()` → `NativePendantLink`. Pure ble-plx on the **shared** manager — **no native
rebuild, no binding/lock concern** (unlike Plaud). GATT: audio service `19b10000-…`, notify char
`…10001` (244 B raw PCM = 122 int16 LE @ 16 kHz mono), write char `…10002` (1-byte cmd:
`0x00` stop / `0x01` start / `0x02` find-me), plus standard Battery Service (bit7 = charging).

- **Scan with NO service filter, `allowDuplicates:true`.** The pendant advertises the audio service
  UUID in the ADV packet but its NAME only in the SCAN RESPONSE; iOS delivers those as
  `serviceUUIDs` + `localName` across possibly-separate callbacks, and `dev.name` may be a STALE
  cached GAP name. Auto-match tests name OR localName (`/sate|pendant|nuna/i`) OR the advertised
  audio service. The screen also shows a live diagnostics list of every peripheral heard, with a
  manual-pick fallback.
- **Capture gating:** `capturing` is true only between `start()` and `stop()`; packets that arrive
  after `CMD_STOP` (in-flight) are dropped so they don't tack extra tenths onto the take. `start()`
  also clears the buffer so a stop-without-`takeWav` can't prefix the next take (cross-take
  contamination). Nap mode: a notification gap while connected is NORMAL (the pendant sleeps in
  silence), surfaced as "quiet", not a disconnect.
- **Gain:** the mic is very quiet, so `applyGain` peak-normalizes to ~97% full-scale (never
  attenuates, caps at `MAX_GAIN=40`) then applies a `LOUDNESS=2.6` drive with a `tanh` soft-clip.
  `takeWav()` wraps the accumulated PCM in a 44-byte WAV header (16 kHz/mono/16-bit).
- Upload path: `api.uploadSession({device_serial:"pendant-<bleId>", session_number: unix-seconds,
  …})`. Auto-upload on stop (default on), patient assignment optional (Standalone by default —
  don't force it at capture; tag later on the web report). Known pendants persist in AsyncStorage
  (`PendantStore`) and reconnect straight by BLE id (`targetId`). See [09-pendant.md](09-pendant.md).

## The upload pipeline (unified)

All three families converge on **one** server endpoint — `POST /api/sessions` via
`api.uploadSession(...)`:

| Family | `device_serial` | Capture → WAV | `session_number` | `flags` |
|--------|-----------------|---------------|------------------|---------|
| SATE recorder | the BLE `name` (= serial) | `pullSession` over BLE (byte-verified) | the device's session `n` | physical flag button → server-side |
| Plaud | `plaud-<sn>` | native `exportWav` | `f.sessionId` | `markOffsets` (device taps) |
| Pendant | `pendant-<bleId>` | `takeWav()` (PCM→WAV, gain) | `Math.floor(Date.now()/1000)` | — |

The server (`device-api`, `verify_jwt:false` — validates the token itself) writes a
`sate_device_sessions` row (auto-`queued`) and the async processor (a long-lived **Cloudflare
Container**, not an edge function — the AI call would exceed the ~150 s edge wall-clock) transcribes
and writes a `recordings` row. The app polls `UploadedSession.processed`/`recording_id`/
`process_error` to show Processing/Ready/Failed, and reads the finished `recordings` row directly
over Supabase REST. **Recorder uploads are never renumbered and audio isn't freed on the device
until the server verifies it** — the app's `pending_sessions` count and `nearby` badge reflect that
device-owns-the-only-copy reality. Details: [05-backend-supabase.md](05-backend-supabase.md),
[06-ai-pipeline.md](06-ai-pipeline.md). Flag markers are ONE shared pipeline
(ms offsets → `flags` column → `recordings.flags` → web-report seek-bar ticks); don't fork it.

## Demo / mock mode

- `makeLink()` returns the **real** `BleLink` only — there is no mock `SateLink` (the old doc's
  claim of one was wrong). SATE features simply require a dev build with a real recorder, or the
  hardware-free `DevicePreviewScreen` simulation for demos.
- `makePlaudLink()` returns `MockPlaudLink` off-device (fake scan/files/marks + a tiny silent WAV),
  so the Plaud UI and the full upload path stay testable in the simulator.
- `serverUrl` is forced to `DEVICE_API_URL`; pointing it at `mock-server/` is no longer reachable
  from the UI (it was a `v2`-era path — the `v3` store key invalidated it).

## Cross-references

- [01-architecture.md](01-architecture.md) — system overview
- [02-firmware.md](02-firmware.md) — recorder firmware (versions, resume, reclaim, renumber rules)
- [04-ble-protocol.md](04-ble-protocol.md) — full BLE wire format
- [05-backend-supabase.md](05-backend-supabase.md) — device-api routes, sessions, verify gate
- [06-ai-pipeline.md](06-ai-pipeline.md) — async processing / recordings
- [07-runbook.md](07-runbook.md) — operational recipes (OTA order, etc.)
- [08-plaud.md](08-plaud.md) — Plaud device-lock deep dive
- [09-pendant.md](09-pendant.md) — pendant firmware + integration
