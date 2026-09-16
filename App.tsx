import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { makeApi, refreshSession, RefreshError, RefreshHandler } from "./src/api/sateApi";
import { makeLink } from "./src/ble/SateBle";
import { makePlaudLink } from "./src/plaud/PlaudLink";
import { PlaudConnectScreen } from "./src/screens/PlaudConnectScreen";
import { PlaudSettingsScreen } from "./src/screens/PlaudSettingsScreen";
import { makePendantLink } from "./src/pendant/PendantLink";
import { KnownPendant, loadKnownPendants, rememberPendant } from "./src/pendant/PendantStore";
import { PendantConnectScreen } from "./src/screens/PendantConnectScreen";
import { makeL816Link } from "./src/l816/L816Link";
import { KnownL816, loadKnownL816s, rememberL816 } from "./src/l816/L816Store";
import { L816ConnectScreen } from "./src/screens/L816ConnectScreen";
import { PLAUD_ENABLED, PENDANT_ENABLED, L816_ENABLED } from "./src/features";
import { acquireRadio, registerRadio } from "./src/ble/radio";
import { useManagedDevices } from "./src/devices/useManagedDevices";
import { ManagedDevice, UploadedSession } from "./src/protocol";
import { DevicePreviewScreen } from "./src/screens/DevicePreviewScreen";
import { DeviceListScreen } from "./src/screens/DeviceListScreen";
import { RecorderDetailScreen } from "./src/screens/RecorderDetailScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ProvisionScreen } from "./src/screens/ProvisionScreen";
import { ChangeWifiScreen } from "./src/screens/ChangeWifiScreen";
import { RecorderSettingsScreen } from "./src/screens/RecorderSettingsScreen";
import { ReportScreen } from "./src/screens/ReportScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { StoreProvider, useStore } from "./src/store";
import { useAutoSync } from "./src/sync/AutoSync";
import { D } from "./src/theme";

type Screen =
  | { name: "home" }
  | { name: "recorderDetail"; device: ManagedDevice }
  | { name: "provision" }
  | { name: "changeWifi"; device: ManagedDevice }
  | { name: "recorderSettings"; device: ManagedDevice }
  | { name: "preview" }
  | { name: "plaud"; targetSn?: string }
  | { name: "plaudSettings"; sn: string; deviceName: string }
  | { name: "pendant"; targetId?: string }
  | { name: "l816"; targetId?: string }
  | { name: "report"; session: UploadedSession }
  | { name: "settings" };

function Root() {
  const { settings, ready, update, signOut } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  // Latest store handles + refresh token, read through a ref so `doRefresh` can
  // stay identity-stable (no churn of `api` / dependent effects every render).
  const storeRef = useRef({ update, signOut, refreshToken: settings.refreshToken });
  storeRef.current = { update, signOut, refreshToken: settings.refreshToken };

  // THE NEWEST refresh token, written the instant a refresh returns one.
  //
  // Supabase ROTATES refresh tokens: the moment one is used it is dead, and
  // re-using it comes back `invalid_grant` / `already_used` — which this app
  // classifies as authInvalid and signs the user out.
  //
  // React state lands a render LATER than the network call returns, and this app
  // polls `listDevices` every 2 s with auto-sync alongside, so there is always
  // traffic in that gap. A request that 401'd on the OLD access token would read
  // the OLD refresh token out of `storeRef` and spend it a second time — and the
  // user gets thrown back to the login screen seconds after signing in, with
  // nothing logged to say why. A ref is written synchronously and closes the gap.
  const liveRefreshToken = useRef<string | null>(settings.refreshToken);
  const seenFromStore = useRef<string | null>(settings.refreshToken);
  // The freshest ACCESS token, for the same reason as liveRefreshToken.
  const tokenRef = useRef<string | null>(settings.token);
  // When the last refresh SUCCEEDED. A burst of requests that all 401'd on the
  // pre-refresh access token must not each trigger another refresh; they simply
  // need the token we already have.
  const lastRefreshOk = useRef(0);
  if (settings.refreshToken !== seenFromStore.current) {
    // The store changed underneath us — a fresh sign-in, or the refresh we just
    // did committing. Either way the store is now authoritative.
    seenFromStore.current = settings.refreshToken;
    liveRefreshToken.current = settings.refreshToken;
    tokenRef.current = settings.token;
    // A brand-new sign-in must not inherit the previous session's cooldown.
    lastRefreshOk.current = 0;
  }

  // Single in-flight refresh, shared by the proactive timer and any 401 retry,
  // so parallel callers don't race (Supabase rotates refresh tokens).
  const refreshing = useRef<Promise<string | null> | null>(null);

  const doRefresh = useCallback<RefreshHandler>(() => {
    if (refreshing.current) return refreshing.current;
    // Refreshed a moment ago? Then this 401 came from a request that was already
    // in flight with the previous access token. Hand back the current one rather
    // than spending the rotated refresh token again.
    if (Date.now() - lastRefreshOk.current < 15000) {
      return Promise.resolve(storeRef.current.refreshToken ? tokenRef.current : null);
    }
    const rt = liveRefreshToken.current ?? storeRef.current.refreshToken;
    if (!rt) return Promise.resolve(null);
    refreshing.current = (async () => {
      try {
        const r = await refreshSession(rt);
        // Synchronously, BEFORE React re-renders: anything that 401s in the gap
        // must see the rotated token, not the one we just spent.
        liveRefreshToken.current = r.refreshToken;
        seenFromStore.current = r.refreshToken;
        tokenRef.current = r.token;
        lastRefreshOk.current = Date.now();
        storeRef.current.update({
          token: r.token,
          refreshToken: r.refreshToken,
          tokenExpiresAt: r.expiresAt,
        });
        return r.token;
      } catch (e) {
        // Only sign out when the refresh token is genuinely dead. A network blip
        // must NOT log the user out — the session is kept and retried later.
        const authInvalid = e instanceof RefreshError && e.authInvalid;
        // Being signed out is the most disruptive thing this app can do to
        // someone, and it used to happen with NOTHING written anywhere. Say so.
        console.log(
          `[auth] refresh failed: ${(e as Error).message} — ` +
            (authInvalid ? "signing out (refresh token is dead)" : "keeping the session")
        );
        if (authInvalid) storeRef.current.signOut();
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, []);

  // The api self-heals: on a 401 it calls doRefresh, swaps in the fresh token,
  // and replays the request — so an expired access token never reaches the UI.
  const api = useMemo(
    () => makeApi(settings.serverUrl, settings.token, doRefresh),
    [settings.serverUrl, settings.token, doRefresh]
  );
  const link = useMemo(() => makeLink(), []);
  const plaud = useMemo(() => makePlaudLink(), []);
  const pendant = useMemo(() => makePendantLink(), []);
  const l816 = useMemo(() => makeL816Link(), []);

  // Pendants the account has paired (persisted locally — no lock concern, unlike
  // Plaud). Loaded once so Home can show them as device rows on every launch.
  const [knownPendants, setKnownPendants] = useState<KnownPendant[]>([]);
  useEffect(() => {
    if (!PENDANT_ENABLED) return;   // recorder-only build: nothing to list
    loadKnownPendants().then(setKnownPendants);
  }, []);

  // L816s the account has paired. Same store shape and same reasoning as the
  // pendant's — plain BLE, no binding, so AsyncStorage is enough.
  const [knownL816s, setKnownL816s] = useState<KnownL816[]>([]);
  useEffect(() => {
    if (!L816_ENABLED) return;   // no ASC decoder in this build: nothing to list
    loadKnownL816s().then(setKnownL816s);
  }, []);

  // Belt-and-suspenders: also refresh proactively just before expiry, so most
  // calls never even see a 401. Together with the 401 retry above, a signed-in
  // user stays signed in for as long as the refresh token lives (weeks) — the
  // session persists like the web app's, no surprise re-logins.
  useEffect(() => {
    if (!settings.token || !settings.refreshToken) return;
    const tick = () => {
      const exp = settings.tokenExpiresAt ?? 0;
      // refresh when within 5 min of expiry (or already past)
      if (Date.now() < exp - 5 * 60 * 1000) return;
      doRefresh();
    };
    tick();
    const t = setInterval(tick, 60 * 1000);
    return () => clearInterval(t);
  }, [settings.token, settings.refreshToken, settings.tokenExpiresAt, doRefresh]);

  // Wire the radio arbiter to the real BLE stacks, once. It is now the ONLY place
  // that decides who owns the radio — screens acquire, auto-sync backs off. See
  // CLAUDE.md RULE #2: SATE and the Pendant share one ble-plx manager (stopScan
  // between them, NEVER destroy); only the Plaud handoff destroys it.
  useEffect(() => {
    registerRadio({
      stopBleScan: () => link.stopScan(),
      destroyBle: () => link.teardown(), // -> destroySharedBleManager()
      // Lock-safe (RULE #1): drops the BLE link, KEEPS the binding. Never depair.
      disconnectPlaud: () => {
        plaud.disconnect().catch(() => {});
      },
      disconnectPendant: () => pendant.teardown(), // stops scan + drops connection
      disconnectL816: () => l816.teardown(), // same: stops scan + drops connection
    });
  }, [link, plaud, pendant, l816]);

  // Navigation helpers. The radio is acquired SYNCHRONOUSLY here, before the new
  // screen renders — never in an effect (a parent effect runs after the child's,
  // so it would stop the scan the new screen just started).
  const goHome = useCallback(() => {
    acquireRadio("autosync");
    setScreen({ name: "home" });
  }, []);
  const openPlaud = useCallback((targetSn?: string) => {
    acquireRadio("plaud"); // destroys the shared ble-plx manager; Plaud SDK gets the radio
    setScreen({ name: "plaud", targetSn });
  }, []);
  const openPendant = useCallback((targetId?: string) => {
    acquireRadio("pendant"); // shares SATE's manager — stopScan only, no destroy
    setScreen({ name: "pendant", targetId });
  }, []);
  const openL816 = useCallback((targetId?: string) => {
    acquireRadio("l816"); // shares SATE's manager — stopScan only, no destroy
    setScreen({ name: "l816", targetId });
  }, []);
  const openSateFg = useCallback((next: Screen) => {
    acquireRadio("sate-fg"); // setup/restart needs the radio alone: pauses auto-sync
    setScreen(next);
  }, []);

  // Kept mounted so the background BLE bridge keeps running across screens. It
  // gates itself on the arbiter — no screen-name allowlist. It is also the ONLY
  // BLE scanner, and publishes which recorders are `nearby` (one scan per manager).
  const { nearby } = useAutoSync(settings.autoSync, link, api, !!settings.token);

  // One registry: SATE recorders (server) + Plaud (Keychain) + pendants and
  // L816s (storage).
  const { devices, loaded, fetchFailed, refresh } = useManagedDevices(
    api,
    plaud,
    knownPendants,
    knownL816s,
    !!settings.token
  );

  if (!ready) return <View style={{ flex: 1, backgroundColor: D.bg }} />;
  if (!settings.token) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      {screen.name === "home" && (
        <DeviceListScreen
          devices={devices}
          loaded={loaded}
          fetchFailed={fetchFailed}
          nearby={nearby}
          onRefresh={refresh}
          onOpenDevice={(d) => {
            // Route by family: a recorder has a detail screen; Plaud/pendant open
            // their own connect flow (reconnecting straight to that serial/id).
            const kind = d.kind ?? "sate";
            // A recorder-only build should never have listed a Plaud/pendant row,
            // but route defensively: opening a screen whose link is a mock would
            // scan forever and look like broken hardware.
            if (kind === "plaud") { if (PLAUD_ENABLED) openPlaud(d.serial); }
            else if (kind === "pendant") { if (PENDANT_ENABLED) openPendant(d.serial); }
            else if (kind === "l816") { if (L816_ENABLED) openL816(d.serial); }
            else setScreen({ name: "recorderDetail", device: d });
          }}
          onOpenSettings={() => setScreen({ name: "settings" })}
          onOpenPreview={() => setScreen({ name: "preview" })}
          onAddSate={() => openSateFg({ name: "provision" })}
          onAddPlaud={PLAUD_ENABLED ? () => openPlaud() : undefined}
          onAddPendant={PENDANT_ENABLED ? () => openPendant() : undefined}
          onAddL816={L816_ENABLED ? () => openL816() : undefined}
        />
      )}
      {screen.name === "recorderDetail" && (
        <RecorderDetailScreen
          api={api}
          link={link}
          device={screen.device}
          nearby={nearby}
          onClose={goHome}
          onOpenRecorderSettings={(device) =>
            openSateFg({ name: "recorderSettings", device })
          }
          onOpenReport={(session) => setScreen({ name: "report", session })}
        />
      )}
      {screen.name === "report" && (
        <ReportScreen api={api} session={screen.session} onClose={goHome} />
      )}
      {screen.name === "recorderSettings" && (
        <RecorderSettingsScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={goHome}
          onUnlinked={goHome}
          onChangeWifi={(device) => openSateFg({ name: "changeWifi", device })}
        />
      )}
      {screen.name === "provision" && (
        <ProvisionScreen api={api} link={link} onClose={goHome} />
      )}
      {screen.name === "changeWifi" && (
        <ChangeWifiScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={() => openSateFg({ name: "recorderSettings", device: screen.device })}
        />
      )}
      {screen.name === "preview" && <DevicePreviewScreen onClose={goHome} />}
      {screen.name === "plaud" && (
        <PlaudConnectScreen
          api={api}
          plaud={plaud}
          targetSn={screen.targetSn}
          onClose={goHome}
          onOpenSettings={(sn, deviceName) =>
            setScreen({ name: "plaudSettings", sn, deviceName })
          }
        />
      )}
      {screen.name === "pendant" && (
        <PendantConnectScreen
          api={api}
          pendant={pendant}
          targetId={screen.targetId}
          onConnected={(id, name) => rememberPendant(id, name).then(setKnownPendants)}
          // goHome acquires 'autosync', which releases the pendant (teardown:
          // stopScan + drop connection) WITHOUT destroying the shared manager.
          onClose={goHome}
        />
      )}
      {screen.name === "l816" && (
        <L816ConnectScreen
          api={api}
          l816={l816}
          targetId={screen.targetId}
          // No server-side registration call: the web derives an L816 device row
          // from its uploaded sessions client-side (DeviceProvider), so
          // POST /devices/external is not needed — and calling an endpoint that
          // is not deployed just 404s on every pair and buries real errors.
          onConnected={(id, name) => rememberL816(id, name).then(setKnownL816s)}
          // goHome acquires 'autosync', which releases the L816 (teardown:
          // stopScan + drop connection) WITHOUT destroying the shared manager.
          onClose={goHome}
        />
      )}
      {screen.name === "plaudSettings" && (
        <PlaudSettingsScreen
          plaud={plaud}
          sn={screen.sn}
          deviceName={screen.deviceName}
          // Stays inside the Plaud flow — the radio owner remains 'plaud'.
          onClose={() => setScreen({ name: "plaud" })}
          // After a successful UNBIND, goHome hands the radio back (disconnect
          // only — the depair already happened, user-initiated, in resetBinding).
          onUnbound={goHome}
        />
      )}
      {screen.name === "settings" && <SettingsScreen onClose={goHome} />}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  );
}
