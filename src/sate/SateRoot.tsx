import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { makeApi, refreshSession, RefreshError, RefreshHandler } from "../api/sateApi";
import { LoginScreen } from "../screens/LoginScreen";
import { DeviceListScreen } from "../screens/DeviceListScreen";
import { useManagedDevices } from "../devices/useManagedDevices";
import { makePlaudLink } from "../plaud/PlaudLink";
import { KnownL816, loadKnownL816s, rememberL816 } from "../l816/L816Store";
import { makeL816Link } from "../l816/L816Link";
import { useL816Session } from "../l816/useL816Session";
import { L816ConnectScreen } from "../screens/L816ConnectScreen";
import { L816_ENABLED } from "../features";
import { KnownPendant, loadKnownPendants } from "../pendant/PendantStore";
import { Recording } from "../protocol";
import { useStore } from "../store";
import { SateHomeScreen } from "./SateHomeScreen";
import { SateReportScreen } from "./SateReportScreen";
import { SateDashboardScreen } from "./SateDashboardScreen";
import { SateNavBar, SateTab } from "./SateNavBar";
import { SettingsScreen } from "../screens/SettingsScreen";
import { D } from "../theme";
import { useEffect, useRef } from "react";

// Root of the **SATE** app — the reading half of the product.
//
// Deliberately much smaller than SATE Companion's root. This build is for
// reading what the hardware produced: a list of reports, a report, and the
// device list tucked behind a corner button.
//
// It shares the store, the API client and the login screen, so the two apps sign
// in the same way against the same account.
//
// 🛑 IT DOES RUN ONE PIECE OF BLE: the SATE L816 session. That is not a
// contradiction of "the app does not create reports" — it creates none. It pulls
// a take the RECORDER made off the device and hands it to the same server
// pipeline every other recording goes through; the report still comes back from
// the server. Without it, an account whose only hardware is an L816 would open
// this app, see the recorder listed as paired, and watch nothing ever arrive:
// the takes sit on the device until someone opens the OTHER app. So the session
// is mounted here, at the root, exactly as it is in Companion — it starts on
// launch, reconnects by itself, quick-checks the device for takes recorded while
// the phone was away, and uploads them from whatever screen the user is on.

// A tab, or a screen pushed on top of one. The report and the device list are
// NOT tabs: they are places you go from a tab and come back from, and putting
// them in the bar would make "back" ambiguous.
type Screen =
  | { name: "tab"; tab: SateTab }
  | { name: "report"; recording: Recording }
  | { name: "devices" }
  | { name: "l816"; targetId?: string };

export function SateRoot() {
  const { settings, ready, update, signOut } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "tab", tab: "dashboard" });

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
        // Say WHY on the login screen. A session can be ended by something the
        // phone never sees, and landing on a login form with no explanation
        // reads as the app losing your session at random.
        if (authInvalid)
          storeRef.current.signOut(
            "You were signed out because this session was ended somewhere else — signing out of the SATE web app, or changing your password, ends it on every device. Sign in again to carry on."
          );
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

  // Devices the account has already paired, read from the SAME local stores
  // Companion writes. Passing empty arrays here was a real bug: a paired L816
  // was forgotten every launch, so the devices screen only ever offered "connect
  // your first device" no matter how many were set up.
  const plaud = useMemo(() => makePlaudLink(), []);
  const l816 = useMemo(() => makeL816Link(), []);
  const [knownL816s, setKnownL816s] = useState<KnownL816[]>([]);
  const [knownPendants, setKnownPendants] = useState<KnownPendant[]>([]);
  useEffect(() => {
    loadKnownL816s().then(setKnownL816s).catch(() => {});
    loadKnownPendants().then(setKnownPendants).catch(() => {});
  }, []);

  // Polled only while the devices screen is open. Reports are the app; a device
  // list refreshing behind them every two seconds is work nobody asked for.
  const { devices, loaded, fetchFailed, refresh } = useManagedDevices(
    api,
    plaud,
    knownPendants,
    knownL816s,
    // The chip in both headers shows a paired device and its battery, so the
    // registry has to be live on the tabs too — not only on the device screen.
    !!settings.token
  );

  // The L816 session. Mounted at the root so it outlives every screen: a take
  // started on the recorder has to reach SATE whether the user is reading a
  // report, on the dashboard, or not looking at the phone at all.
  const l816Session = useL816Session(api, l816, L816_ENABLED && !!settings.token, knownL816s, setKnownL816s);

  // One sentence describing what the recorder is doing, for the dashboard row.
  // Ordered by what a user most needs to know first: a take in progress beats a
  // backlog, and a backlog beats "idle".
  const l816Line = l816Session.recording
    ? "Recording on the device now"
    : l816Session.state === "connecting"
      ? "Connecting…"
      : l816Session.state === "busy"
        ? l816Session.progress?.message ?? "Uploading to SATE…"
        : l816Session.pendingCount > 0
          ? `${l816Session.pendingCount} recording${
              l816Session.pendingCount === 1 ? "" : "s"
            } waiting to upload`
          : "Connected · new recordings upload themselves";
  const liveL816 = l816Session.connectedId
    ? {
        connectedId: l816Session.connectedId,
        line: l816Line,
        busy: l816Session.state === "busy" || l816Session.recording,
      }
    : null;

  const openL816 = (d: { kind?: string | null; serial: string }) => {
    if (d.kind === "l816" && L816_ENABLED) setScreen({ name: "l816", targetId: d.serial });
  };

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
      {screen.name === "tab" && screen.tab === "dashboard" && (
        <SateDashboardScreen
          api={api}
          devices={devices}
          devicesLoaded={loaded}
          onOpenReports={() => setScreen({ name: "tab", tab: "reports" })}
          onOpenReport={(recording) => setScreen({ name: "report", recording })}
          onAddDevice={() => setScreen({ name: "devices" })}
          onOpenDevice={openL816}
          liveL816={liveL816}
          l816={l816Session}
        />
      )}
      {screen.name === "tab" && screen.tab === "reports" && (
        <SateHomeScreen
          api={api}
          devices={devices}
          onOpenReport={(recording) => setScreen({ name: "report", recording })}
          onOpenDevices={() => setScreen({ name: "devices" })}
          l816={l816Session}
        />
      )}
      {screen.name === "tab" && screen.tab === "settings" && <SettingsScreen onClose={() => {}} />}
      {screen.name === "report" && (
        <SateReportScreen
          api={api}
          recording={screen.recording}
          onClose={() => setScreen({ name: "tab", tab: "reports" })}
        />
      )}
      {screen.name === "devices" && (
        // A real back bar. Companion's device screen has no "back" — it IS that
        // app's home — so its only exits are labelled Settings and Preview.
        // Wiring "return to reports" onto a button that says Settings is a lie
        // about where the tap goes, so the way back is drawn here instead.
        <View style={s.devWrap}>
          <DeviceListScreen
            devices={devices}
            loaded={loaded}
            fetchFailed={fetchFailed}
            nearby={new Set()}
            onRefresh={refresh}
            // Tapping a paired L816 opens its screen. This used to be a
            // no-op, so the one row on the page did nothing when tapped —
            // which reads as a broken app, not as "there is nothing here".
            onOpenDevice={openL816}
            onOpenSettings={() => setScreen({ name: "tab", tab: "settings" })}
            onOpenPreview={() => setScreen({ name: "tab", tab: "dashboard" })}
            // Pairing a SATE L816 is something THIS app can do — it holds the
            // link and uploads the takes (see useL816Session). Leaving it out of
            // the sheet meant the only hardware the app actually drives was the
            // one device you could not add.
            onAddL816={L816_ENABLED ? () => setScreen({ name: "l816" }) : undefined}
            // A Wi-Fi recorder is NOT something this app can set up: provisioning
            // is a BLE handshake plus Wi-Fi credentials, and that flow lives in
            // Companion. Say so, rather than bouncing the user back to the
            // dashboard as if the tap had worked.
            onAddSate={() =>
              Alert.alert(
                "Set up a recorder in SATE Companion",
                "A SATE recorder joins your account over Bluetooth and needs Wi-Fi " +
                  "details, which is done in the SATE Companion app. Once it is set up, " +
                  "its recordings appear here automatically."
              )
            }
          />
          <View style={s.devBack} pointerEvents="box-none">
            <Pressable
              onPress={() => setScreen({ name: "tab", tab: "dashboard" })}
              hitSlop={12}
              accessibilityRole="button"
              style={({ pressed }) => [s.backPill, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={s.backTxt}>‹ Reports</Text>
            </Pressable>
          </View>
        </View>
      )}
      {screen.name === "l816" && (
        <L816ConnectScreen
          api={api}
          l816={l816}
          session={l816Session}
          targetId={screen.targetId}
          onConnected={(id, name, model) =>
            rememberL816(id, name, model).then(setKnownL816s)
          }
          onUnpaired={setKnownL816s}
          // Closing goes back to the device list, and — unlike Companion's old
          // behaviour — leaves the recorder CONNECTED.
          onClose={() => setScreen({ name: "devices" })}
        />
      )}
      {/* Only on tabs. A bar under a report would offer to jump away mid-read
          with no way back to where you were. */}
      {screen.name === "tab" && (
        <SateNavBar
          active={screen.tab}
          onSelect={(tab) => setScreen({ name: "tab", tab })}
        />
      )}
    </>
  );
}

const s = StyleSheet.create({
  devWrap: { flex: 1 },
  // Floated over the reused screen rather than inside it: SATE must not change
  // how that screen behaves for Companion, which still ships it as its home.
  devBack: { position: "absolute", top: 54, left: 12, right: 0 },
  backPill: {
    alignSelf: "flex-start",
    backgroundColor: D.chip,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  backTxt: { color: D.sky, fontSize: 15, fontWeight: "700" },
});
