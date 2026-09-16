import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { makeApi, refreshSession, RefreshError, RefreshHandler } from "../api/sateApi";
import { LoginScreen } from "../screens/LoginScreen";
import { DeviceListScreen } from "../screens/DeviceListScreen";
import { useManagedDevices } from "../devices/useManagedDevices";
import { makePlaudLink } from "../plaud/PlaudLink";
import { Recording } from "../protocol";
import { useStore } from "../store";
import { SateHomeScreen } from "./SateHomeScreen";
import { SateReportScreen } from "./SateReportScreen";
import { D } from "../theme";
import { useEffect, useRef } from "react";

// Root of the **SATE** app — the reading half of the product.
//
// Deliberately much smaller than SATE Companion's root. This build is for
// reading what the hardware produced: a list of reports, a report, and the
// device list tucked behind a corner button. It runs no BLE of its own, so it
// never touches the radio arbiter, and pairing hardware stays in Companion.
//
// It shares the store, the API client and the login screen, so the two apps sign
// in the same way against the same account.

type Screen =
  | { name: "home" }
  | { name: "report"; recording: Recording }
  | { name: "devices" };

export function SateRoot() {
  const { settings, ready, update, signOut } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const storeRef = useRef({ update, signOut, refreshToken: settings.refreshToken });
  storeRef.current = { update, signOut, refreshToken: settings.refreshToken };
  const refreshing = useRef<Promise<string | null> | null>(null);
  // Same rotation-safe refresh as Companion: Supabase kills a refresh token the
  // moment it is used, and re-spending one signs the user out.
  const liveRefreshToken = useRef<string | null>(settings.refreshToken);
  const seenFromStore = useRef<string | null>(settings.refreshToken);
  const lastRefreshOk = useRef(0);
  const tokenRef = useRef<string | null>(settings.token);
  if (settings.refreshToken !== seenFromStore.current) {
    seenFromStore.current = settings.refreshToken;
    liveRefreshToken.current = settings.refreshToken;
    tokenRef.current = settings.token;
    lastRefreshOk.current = 0;
  }

  const doRefresh = useCallback<RefreshHandler>(() => {
    if (refreshing.current) return refreshing.current;
    if (Date.now() - lastRefreshOk.current < 15000) {
      return Promise.resolve(storeRef.current.refreshToken ? tokenRef.current : null);
    }
    const rt = liveRefreshToken.current ?? storeRef.current.refreshToken;
    if (!rt) return Promise.resolve(null);
    refreshing.current = (async () => {
      try {
        const r = await refreshSession(rt);
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
        const authInvalid = e instanceof RefreshError && e.authInvalid;
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

  const api = useMemo(
    () => makeApi(settings.serverUrl, settings.token, doRefresh),
    [settings.serverUrl, settings.token, doRefresh]
  );

  useEffect(() => {
    if (!settings.token || !settings.refreshToken) return;
    const tick = () => {
      if (Date.now() < (settings.tokenExpiresAt ?? 0) - 5 * 60 * 1000) return;
      doRefresh();
    };
    tick();
    const t = setInterval(tick, 60 * 1000);
    return () => clearInterval(t);
  }, [settings.token, settings.refreshToken, settings.tokenExpiresAt, doRefresh]);

  // The device list is reused as-is from Companion. This build pairs nothing, so
  // it is shown read-only: no "Add a device" entry points are passed.
  const plaud = useMemo(() => makePlaudLink(), []);
  const { devices, loaded, fetchFailed, refresh } = useManagedDevices(
    api,
    plaud,
    [],
    [],
    !!settings.token && screen.name === "devices"
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
        <SateHomeScreen
          api={api}
          onOpenReport={(recording) => setScreen({ name: "report", recording })}
          onOpenDevices={() => setScreen({ name: "devices" })}
        />
      )}
      {screen.name === "report" && (
        <SateReportScreen
          api={api}
          recording={screen.recording}
          onClose={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "devices" && (
        <DeviceListScreen
          devices={devices}
          loaded={loaded}
          fetchFailed={fetchFailed}
          nearby={new Set()}
          onRefresh={refresh}
          onOpenDevice={() => {}}
          onOpenSettings={() => setScreen({ name: "home" })}
          onOpenPreview={() => setScreen({ name: "home" })}
          // No pairing here: this build has no BLE. Passing nothing hides every
          // "add a device" route rather than offering one that cannot finish.
          onAddSate={() => setScreen({ name: "home" })}
        />
      )}
    </>
  );
}
