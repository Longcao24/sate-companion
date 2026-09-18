import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { makeApi, refreshSession, RefreshError, RefreshHandler } from "../api/sateApi";
import { LoginScreen } from "../screens/LoginScreen";
import { DeviceListScreen } from "../screens/DeviceListScreen";
import { useManagedDevices } from "../devices/useManagedDevices";
import { makePlaudLink } from "../plaud/PlaudLink";
import { KnownL816, forgetL816, loadKnownL816s, rememberL816 } from "../l816/L816Store";
import { makeL816Link } from "../l816/L816Link";
import { useL816Session } from "../l816/useL816Session";
import { L816TransferModal } from "../l816/L816TransferModal";
import { L816ConnectScreen } from "../screens/L816ConnectScreen";
import { L816_ENABLED } from "../features";
import { KnownPendant, forgetPendant, loadKnownPendants } from "../pendant/PendantStore";
import { ManagedDevice, Recording } from "../protocol";
import { useStore } from "../store";
import { SateHomeScreen } from "./SateHomeScreen";
import { SateReportScreen } from "./SateReportScreen";
import { SateDashboardScreen } from "./SateDashboardScreen";
import { SateNavBar, SateTab } from "./SateNavBar";
import { SateSettingsScreen } from "./SateSettingsScreen";
import { SateDeviceScreen } from "./SateDeviceScreen";
import { FONT, R, S } from "../theme";
import {
  useFonts,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from "@expo-google-fonts/manrope";
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
  // `back` is carried because this page is reached from BOTH the dashboard
  // and the device list, and a Back that always lands on one of them takes
  // half the users somewhere they were not.
  | { name: "device"; device: ManagedDevice; back: Screen }
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

  // "View device" opens the DEVICE PAGE, for every family.
  //
  // This used to be `openL816`, which returns unless the row is an L816 — so the
  // dashboard card and the device row drew "View device →" on a SATE recorder, a
  // pendant and a Plaud and did nothing when tapped. The L81x handheld still gets
  // its own screen, but from a button on the page rather than instead of it.
  const openDevice = (d: ManagedDevice, back: Screen) =>
    setScreen({ name: "device", device: d, back });

  /**
   * How this device is forgotten — or `undefined` when this app must not be the
   * one to do it.
   *
   * A paired recorder that cannot be reached is exactly the one a user needs to
   * get rid of, and until now the only way out was buried inside the L81x
   * recorder screen (and did not exist at all for the pendant or a Wi-Fi
   * recorder). That is also the only cure for a pairing whose stored id is
   * wrong: it can never connect, so nothing in the app will ever repair it.
   */
  const removeHandler = (d: ManagedDevice): (() => Promise<void>) | undefined => {
    switch (d.kind) {
      case "l816":
        // Local only: the L81x has no binding and no server row (RULE #1 is
        // Plaud's alone). Drop the link first if this is the connected one, or
        // the reconnect loop brings back a device that is no longer paired.
        return async () => {
          if (l816Session.connectedId === d.serial) l816Session.disconnect();
          setKnownL816s(await forgetL816(d.serial));
        };
      case "pendant":
        return async () => setKnownPendants(await forgetPendant(d.serial));
      case "plaud":
        // See the comment at the call site. Deliberately no handler.
        return undefined;
      default:
        // A Wi-Fi recorder is a real row on the server, so removing it is a
        // server call — and it un-claims the hardware, which is what the
        // confirmation says.
        return async () => {
          await api.removeDevice(d.id);
          await refresh();
        };
    }
  };

  // Manrope is the redesign's voice, and the app is unreadable in the wrong one
  // for the frame or two before it lands — so hold the splash rather than flash
  // the system font. `error` is treated as loaded on purpose: a missing font
  // file must degrade to the fallback stack, never to a blank app.
  const [fontsReady, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  if (!ready || (!fontsReady && !fontError))
    return <View style={{ flex: 1, backgroundColor: S.bg }} />;
  if (!settings.token) {
    return (
      <>
        <StatusBar style="dark" />
        <LoginScreen />
      </>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {screen.name === "tab" && screen.tab === "dashboard" && (
        <SateDashboardScreen
          api={api}
          devices={devices}
          devicesLoaded={loaded}
          onOpenReports={() => setScreen({ name: "tab", tab: "reports" })}
          onOpenReport={(recording) => setScreen({ name: "report", recording })}
          onAddDevice={() => setScreen({ name: "devices" })}
          onOpenDevice={(d) => openDevice(d, { name: "tab", tab: "dashboard" })}
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
      {screen.name === "tab" && screen.tab === "settings" && (
        <SateSettingsScreen
          deviceCount={devices.length + knownL816s.length}
          onOpenDevices={() => setScreen({ name: "devices" })}
        />
      )}
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
            onOpenDevice={(d) => openDevice(d, { name: "devices" })}
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
      {screen.name === "device" && (
        <SateDeviceScreen
          api={api}
          device={screen.device}
          onClose={() => setScreen(screen.back)}
          onOpenReport={(recording) => setScreen({ name: "report", recording })}
          // Only a handheld this build can actually drive gets the action — the
          // decoder is Android-only, so on any other build the button would open
          // a screen that can download a take and never turn it into audio.
          onOpenRecorder={
            screen.device.kind === "l816" && L816_ENABLED
              ? () => setScreen({ name: "l816", targetId: screen.device.serial })
              : undefined
          }
          // 🛑 NOT offered for Plaud. Its binding is ACK-before-forget in the
          // Keychain and mishandling it can lock the hardware for the account
          // (CLAUDE.md RULE #1) — that unbind belongs to its own screen, which
          // waits for the device to acknowledge before forgetting anything. A
          // generic "remove" here would forget locally with no ACK at all.
          onRemove={removeHandler(screen.device)}
        />
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
      {/* The transfer sheet lives at the ROOT, over whatever the user is on.
          The link is app-level, so a take made with the phone in a pocket starts
          uploading while they are reading a report — and from there the app used
          to look completely idle. */}
      <L816TransferModal session={l816Session} />

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
    backgroundColor: S.card,
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: S.line,
    paddingHorizontal: 16,
    minHeight: 40,
    justifyContent: "center",
  },
  backTxt: { color: S.teal, fontSize: 15, fontFamily: FONT.extra },
});
