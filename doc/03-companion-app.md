# 03 — Companion app

Expo SDK 54 / React Native iOS app. Does first-time device setup, claims devices to the
signed-in SLP, bridges offline sessions over BLE, and sends remote commands. Source: `src/`.

> Requires a **dev build** (`expo run:ios`) — `react-native-ble-plx` is a native module, so
> Expo Go cannot load it. JS changes hot-reload via Metro; native changes need a rebuild.

## Stack

- Expo SDK 54, React Native, TypeScript
- `react-native-ble-plx` — BLE central
- `@react-native-async-storage/async-storage` — persisted session/settings
- Backend: Supabase Auth + the `device-api` Edge Function (no separate app server)

## Source map

| Path | Role |
|------|------|
| `src/protocol.ts` | BLE UUIDs, advertising constants, framing flags, shared TS types ([04](04-ble-protocol.md)) |
| `src/ble/SateBle.ts` | `BleLink` — scan, connect, provision, pull sessions, commands |
| `src/api/sateApi.ts` | `HttpApi` — Supabase Auth login/refresh + `device-api` REST client |
| `src/store.tsx` | `StoreProvider` / `useStore` — settings + session, persisted to AsyncStorage |
| `src/screens/` | UI screens (below) |
| `src/sync/` | Offline-bridge upload helpers |
| `src/components/`, `src/theme.ts` | UI kit + dark theme tokens |

## Screens

| Screen | Purpose |
|--------|---------|
| `LoginScreen` | Sign in against Supabase Auth (password **or** QR/mobile-link code); stores `{token, refreshToken, tokenExpiresAt, user}` |
| `HomeScreen` | Claimed devices (SATE + Plaud + Pendant), online/pending status, entry to actions |
| `ProvisionScreen` / `ChangeWifi` | BLE onboarding: scan → connect → Wi-Fi creds → claim + register; Wi-Fi change keeps the account |
| `RecorderDetailScreen` / `RecorderSettingsScreen` | Per-device view + settings, rename, remote commands, sync-over-BLE |
| `PlaudConnectScreen` / `PlaudSettingsScreen` | Connect + manage a **Plaud** recorder (⚠️ device-lock rules — see `plaud-integration.md` / RULE #1) |
| `PendantConnectScreen` | Connect + live-capture from a **SATE Pendant** (XIAO nRF52840) — see [09-pendant.md](09-pendant.md) |
| `ReportScreen` | Per-recording report: transcript, analysis, playback, flag markers, name/protocol review |
| `SettingsScreen` | App settings, server URL, sign out |

> **Multi-device (iOS-only):** SATE recorder, Plaud, and Pendant all feed the **same** upload
> pipeline (`uploadSession`, `device_serial` = `SATE-…` / `plaud-<sn>` / `pendant-<id>`). One shared
> `BleManager` for SATE + Pendant; Plaud uses its own SDK (see CLAUDE.md RULE #2). Plaud + Pendant
> need a native rebuild (Plaud SDK / expo-camera for QR); pure JS won't add them.

## Store (`src/store.tsx`)

```ts
interface Settings {
  serverUrl: string;           // default DEVICE_API_URL (Supabase device-api)
  token: string | null;        // Supabase access JWT
  refreshToken: string | null; // Supabase refresh token
  tokenExpiresAt: number | null;
  user: User | null;
  autoSync: boolean;
}
```

- Persist key: `sate-companion-settings-v3` (the `v3` bump invalidates stale mock-server URLs).
- `signOut()` clears token/refresh/expiry/user.
- Default `serverUrl` is the Supabase `device-api` URL, so a provisioned recorder registers and
  auto-claims to the signed-in account.

## API client (`src/api/sateApi.ts`)

Constants:

```ts
SUPABASE_URL      = "https://zlgdpivcbmaodgokkdvz.supabase.co"
SUPABASE_ANON_KEY = "<public anon key>"          // sent as the apikey header
DEVICE_API_URL    = `${SUPABASE_URL}/functions/v1/device-api`
```

- `login(email, pass)` → `POST /auth/v1/token?grant_type=password`; returns
  `{ token, refreshToken, expiresAt, user }`. Access tokens last ~1 h.
- `refreshSession(refreshToken)` → `POST /auth/v1/token?grant_type=refresh_token`; keeps the
  session alive so authed calls don't silently 401.
- `req()` always sends the `apikey` header (Supabase gateway requirement) and, when present,
  `Authorization: Bearer <token>`.
- REST surface (all under `device-api`, prefix `/api`): `GET /devices`,
  `POST /devices/claim-token`, `PATCH/DELETE /devices/:id`, `POST /devices/:id/commands`,
  `GET /patients`, `GET /sessions`, `GET /sessions/:id/audio`, `POST /sessions`.

## Provisioning

`ProvisionScreen` + `BleLink.provision()`:

1. Refresh the Supabase session if near expiry (else `claimToken()` 401s).
2. `claimToken()` → `POST /api/devices/claim-token` mints a one-time token bound to the account.
3. BLE write `{op:provision, ssid, pass, server, claim_token}` to the recorder.
4. Stream `ev:state` updates: `connecting → wifi_ok → registering → registered | error`.
5. On `registered`, the device is claimed to this SLP and operates over Wi-Fi.

**Onboarding is BLE-only.** Wi-Fi credentials are entered in the app and sent to the device; the
device does **not** scan Wi-Fi for setup. If the device fails to join the network the app sent,
the failure surfaces in the app (not on the device).

> Past failure mode (fixed): an expired Supabase session with no refresh made `claimToken()`
> fail silently, pushing an empty `claim_token` → device register returned 401. Fixed by storing
> the refresh token and refreshing before minting the claim token. The device-api register route
> also now accepts both `/register` and `/devices/register`.

## BLE link

See [04-ble-protocol.md](04-ble-protocol.md) for the full wire format. Notable detail:
`startScan()` waits for the adapter to reach `PoweredOn` (`onStateChange`) before calling
`startDeviceScan` — on iOS the central manager reaches `PoweredOn` a moment after the screen
mounts, and scanning early fails silently and finds nothing.

## Demo / mock mode

`makeLink()` returns the real `BleLink`. A mock implementation of `SateLink` exists for demo
mode (no hardware), and `serverUrl` can point at the `mock-server/` for backend-free local dev.
