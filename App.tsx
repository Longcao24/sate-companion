import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { makeApi, refreshSession, RefreshError, RefreshHandler } from "./src/api/sateApi";
import { makeLink } from "./src/ble/SateBle";
import { ManagedDevice, UploadedSession } from "./src/protocol";
import { DevicePreviewScreen } from "./src/screens/DevicePreviewScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
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
  | { name: "provision" }
  | { name: "changeWifi"; device: ManagedDevice }
  | { name: "recorderSettings"; device: ManagedDevice }
  | { name: "preview" }
  | { name: "report"; session: UploadedSession }
  | { name: "settings" };

function Root() {
  const { settings, ready, update, signOut } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  // Latest store handles + refresh token, read through a ref so `doRefresh` can
  // stay identity-stable (no churn of `api` / dependent effects every render).
  const storeRef = useRef({ update, signOut, refreshToken: settings.refreshToken });
  storeRef.current = { update, signOut, refreshToken: settings.refreshToken };
  // Single in-flight refresh, shared by the proactive timer and any 401 retry,
  // so parallel callers don't race (Supabase rotates refresh tokens).
  const refreshing = useRef<Promise<string | null> | null>(null);

  const doRefresh = useCallback<RefreshHandler>(() => {
    if (refreshing.current) return refreshing.current;
    const rt = storeRef.current.refreshToken;
    if (!rt) return Promise.resolve(null);
    refreshing.current = (async () => {
      try {
        const r = await refreshSession(rt);
        storeRef.current.update({
          token: r.token,
          refreshToken: r.refreshToken,
          tokenExpiresAt: r.expiresAt,
        });
        return r.token;
      } catch (e) {
        // Only sign out when the refresh token is genuinely dead. A network blip
        // must NOT log the user out — the session is kept and retried later.
        if (e instanceof RefreshError && e.authInvalid) storeRef.current.signOut();
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

  // Background BLE bridge runs while signed in + enabled, except where a screen
  // needs exclusive use of the radio (first-time setup or a recorder restart).
  const syncEnabled =
    settings.autoSync &&
    screen.name !== "provision" &&
    screen.name !== "changeWifi" &&
    screen.name !== "recorderSettings";
  // Kept mounted so the background BLE bridge keeps running across screens.
  useAutoSync(syncEnabled, link, api, !!settings.token);

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
        <HomeScreen
          api={api}
          link={link}
          onOpenSettings={() => setScreen({ name: "settings" })}
          onOpenPreview={() => setScreen({ name: "preview" })}
          onSetupNew={() => setScreen({ name: "provision" })}
          onOpenRecorderSettings={(device) =>
            setScreen({ name: "recorderSettings", device })
          }
          onOpenReport={(session) => setScreen({ name: "report", session })}
        />
      )}
      {screen.name === "report" && (
        <ReportScreen
          api={api}
          session={screen.session}
          onClose={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "recorderSettings" && (
        <RecorderSettingsScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={() => setScreen({ name: "home" })}
          onUnlinked={() => setScreen({ name: "home" })}
          onChangeWifi={(device) => setScreen({ name: "changeWifi", device })}
        />
      )}
      {screen.name === "provision" && (
        <ProvisionScreen
          api={api}
          link={link}
          onClose={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "changeWifi" && (
        <ChangeWifiScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={() => setScreen({ name: "recorderSettings", device: screen.device })}
        />
      )}
      {screen.name === "preview" && (
        <DevicePreviewScreen onClose={() => setScreen({ name: "home" })} />
      )}
      {screen.name === "settings" && (
        <SettingsScreen onClose={() => setScreen({ name: "home" })} />
      )}
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
