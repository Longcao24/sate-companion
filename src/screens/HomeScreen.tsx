import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";
import { SateApi } from "../api/sateApi";
import { FoundDevice, SateLink } from "../ble/SateBle";
import { GlassBackground, Logo } from "../components/ui";
import { PlaudDeviceCard } from "../components/PlaudDeviceCard";
import { PendantDeviceCard } from "../components/PendantDeviceCard";
import { DeviceFrame } from "../components/DeviceFrame";
import { KnownPendant } from "../pendant/PendantStore";
import {
  ManagedDevice,
  Patient,
  RemoteCommand,
  UploadedSession,
} from "../protocol";
import { D } from "../theme";

// HomeScreen is the recorder's companion: it puts recording front and centre -
// status, one big Record button, today's sessions, and a one-tap Sync - so the
// app reads as the recorder's partner, not a fleet-management console. The
// hardware admin bits (serial, firmware, IP, restart, unlink) live one tap away
// in Recorder settings.

function timeAgo(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** Approx audio length from WAV byte count (16-bit mono assumed). */
function durationLabel(bytes: number, sampleRate = 16000): string {
  const pcm = Math.max(0, bytes - 44);
  const secs = Math.round(pcm / (sampleRate * 2));
  return `${secs}s`;
}

// Processing state of an uploaded session, derived the SAME way the web app's
// Device tab does (Received → Processing → Ready / Failed).
type SessionStatus = "processing" | "ready" | "failed";
function statusOf(u: UploadedSession): SessionStatus {
  if (u.process_error) return "failed";
  if (u.processed && u.recording_id) return "ready";
  return "processing";
}

export function HomeScreen({
  api,
  link,
  onOpenSettings,
  onOpenPreview,
  onSetupNew,
  onConnectPlaud,
  onConnectPendant,
  knownPlauds,
  knownPendants,
  onOpenRecorderSettings,
  onOpenReport,
}: {
  api: SateApi;
  link: SateLink;
  onOpenSettings: () => void;
  onOpenPreview: () => void;
  onSetupNew: () => void;
  /** Open the Plaud screen; pass a serial to reconnect that specific paired
   *  Plaud (one account can pair several). */
  onConnectPlaud: (targetSn?: string) => void;
  /** Open the SATE Pendant connect flow. Pass a known pendant's BLE id to
   *  reconnect straight to it (skip scanning). */
  onConnectPendant: (targetId?: string) => void;
  /** Every Plaud this account has paired (most-recent first). Home lists them
   *  so any can be opened/reconnected without hunting for Connect. */
  knownPlauds: { sn: string; name: string }[];
  /** Pendants this account has paired (persisted locally). Shown as device rows
   *  so a pendant owner sees "their device" on every launch. */
  knownPendants: KnownPendant[];
  onOpenRecorderSettings: (d: ManagedDevice) => void;
  onOpenReport: (session: UploadedSession) => void;
}) {
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  // Home is a device LIST; tapping a SATE recorder opens its detail (hero +
  // record/sync/sessions). null = list view. Plaud rows open their own screen.
  const [detailId, setDetailId] = useState<string | null>(null);
  const openRecorder = (id: string) => {
    setDetailId(id);
    setSelId(id); // drive status + session polling for the opened recorder
  };
  const [uploads, setUploads] = useState<UploadedSession[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [busyCmd, setBusyCmd] = useState<RemoteCommand | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // True when the LAST device fetch failed (auth/network). Lets us tell a
  // genuinely empty account apart from "couldn't reach the server", so we never
  // show "set up a recorder" to someone who already owns one over the internet.
  const [fetchFailed, setFetchFailed] = useState(false);
  // Serials we can currently SEE advertising over Bluetooth (i.e. the recorder is
  // physically nearby). Lets the UI show "Bluetooth · Nearby" vs "Wi-Fi · Online".
  const [nearby, setNearby] = useState<Set<string>>(new Set());
  const bleSeen = useRef<Map<string, number>>(new Map());
  const mounted = useRef(true);

  // Device picker: one "Add a device" button opens a sheet with the three device
  // types (SATE recorder / Plaud / Pendant) so the user chooses what to pair.
  const [pickerOpen, setPickerOpen] = useState(false);

  // "New recording" sheet: the SLP types who the session is for before it starts.
  const [formOpen, setFormOpen] = useState(false);
  const [pId, setPId] = useState("");
  const [pName, setPName] = useState("");
  const [pType, setPType] = useState("");

  const dev = devices.find((d) => d.id === selId) ?? devices[0] ?? null;

  // Hero ring spins while the recorder is busy; the dot pulses while recording.
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  const player = useAudioPlayer();
  const playerStatus = useAudioPlayerStatus(player);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (playerStatus?.didJustFinish) setPlayingId(null);
  }, [playerStatus?.didJustFinish]);

  const liveState = dev?.state ?? "idle";
  const recording = liveState === "recording";
  const uploading = liveState === "uploading";
  const busy = recording || uploading;
  const online = !!dev?.online;

  useEffect(() => {
    if (busy) {
      spin.setValue(0);
      spinLoop.current = Animated.loop(
        Animated.timing(spin, {
          toValue: 1,
          duration: 1100,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
      spinLoop.current.start();
    } else {
      spinLoop.current?.stop();
      Animated.timing(spin, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [busy]);

  useEffect(() => {
    if (recording) {
      pulseLoop.current = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1.3,
            duration: 550,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 1,
            duration: 550,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulseLoop.current.start();
    } else {
      pulseLoop.current?.stop();
      Animated.timing(pulse, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
    }
  }, [recording]);

  const togglePlay = (u: UploadedSession) => {
    if (playingId === u.id) {
      player.pause();
      setPlayingId(null);
      return;
    }
    try {
      player.replace(api.audioSource(u.id));
      player.seekTo(0);
      player.play();
      setPlayingId(u.id);
    } catch {
      setNote("Could not play this session");
    }
  };

  const refresh = async () => {
    try {
      const list = await api.listDevices();
      if (!mounted.current) return;
      setDevices(list);
      setLoaded(true);
      setFetchFailed(false);
      const current = list.find((d) => d.id === selId) ?? list[0];
      if (current) {
        const [ups, roster] = await Promise.all([
          api.listUploads(current.serial),
          api.listPatients().catch(() => patients),
        ]);
        if (mounted.current) {
          setUploads(ups.slice(0, 6));
          setPatients(roster);
        }
      } else {
        setUploads([]);
      }
    } catch {
      if (mounted.current) {
        setLoaded(true); // show empty/last-known, keep polling
        setFetchFailed(true);
      }
    }
  };

  useEffect(() => {
    mounted.current = true;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      mounted.current = false;
      clearInterval(t);
      link.stopScan();
      link.disconnect().catch(() => {});
    };
  }, [link, selId]);

  const setIf = (fn: () => void) => {
    if (mounted.current) fn();
  };

  // Background BLE presence scan: while no other Bluetooth op is running, keep a
  // passive scan going and mark any SATE serial we hear as "nearby" (seen in the
  // last 10 s). Paused during sync/connect so it never fights those scans.
  useEffect(() => {
    if (!link || busyCmd) return;
    let active = true;
    link.requestPermissions().then((ok) => {
      if (!ok || !active) return;
      try {
        link.startScan((d) => {
          bleSeen.current.set(d.name, Date.now());
        });
      } catch {
        /* Bluetooth off / unavailable - just won't show "nearby" */
      }
    });
    const tick = setInterval(() => {
      const now = Date.now();
      const fresh = new Set<string>();
      for (const [serial, t] of bleSeen.current) {
        if (now - t < 10000) fresh.add(serial);
      }
      setNearby(fresh);
    }, 2000);
    return () => {
      active = false;
      clearInterval(tick);
      link.stopScan();
    };
  }, [link, busyCmd]);

  // Wi-Fi path: command relayed through the server.
  const command = async (
    op: RemoteCommand,
    okMsg: string,
    patient?: Partial<Patient>
  ) => {
    if (!dev) return;
    setBusyCmd(op);
    setNote(null);
    try {
      await api.sendCommand(dev.id, op, patient);
      setIf(() => setNote(okMsg));
      refresh();
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Couldn't reach the recorder"));
    } finally {
      setIf(() => setBusyCmd(null));
    }
  };

  const openForm = () => {
    setPId("");
    setPName("");
    setPType("");
    setFormOpen(true);
  };

  const pickPatient = (p: Patient) => {
    setPId(p.patient_id);
    setPName(p.name ?? "");
    setPType(p.session_type ?? "");
  };

  const startRecording = () => {
    const patient_id = pId.trim();
    if (!patient_id) return;
    setFormOpen(false);
    command(
      "record",
      `Recording a session for ${patient_id}…`,
      {
        patient_id,
        name: pName.trim() || undefined,
        session_type: pType.trim() || undefined,
      }
    );
  };

  // BLE path: recorder is off Wi-Fi but nearby (used for Sync hand-off).
  const findNearby = (serial: string) =>
    new Promise<FoundDevice>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.stopScan();
        reject(new Error("Recorder not found nearby. Make sure it's powered on."));
      }, 12000);
      link.startScan((d) => {
        if (d.name === serial) {
          clearTimeout(timer);
          link.stopScan();
          resolve(d);
        }
      });
    });

  const syncOverBle = async () => {
    if (!dev) return;
    setBusyCmd("sync_now");
    setNote("Looking for your recorder over Bluetooth…");
    try {
      const ok = await link.requestPermissions();
      if (!ok) throw new Error("Bluetooth permission needed");
      const found = await findNearby(dev.serial);
      setIf(() => setNote("Connecting…"));
      await link.connect(found.id);
      setIf(() => setNote("Bring the recorder near your phone to finish syncing."));
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Bluetooth sync failed"));
    } finally {
      await link.disconnect().catch(() => {});
      setIf(() => setBusyCmd(null));
    }
  };

  const onSync = () => {
    if (!dev) return;
    if (online) command("sync_now", "Recorder is sending your sessions to SATE");
    else syncOverBle();
  };


  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  // Does the account have ANY device we can show (SATE recorder over the server,
  // or a locally-remembered Plaud / pendant)? If so we never show the "set up a
  // recorder" empty state — we show the device list, so a user who owns only a
  // Plaud or pendant still lands on their device, not a pairing wall.
  const hasLocal = knownPlauds.length > 0 || knownPendants.length > 0;
  const hasAny = devices.length > 0 || hasLocal;

  // Open a device type from the picker sheet.
  const pickSate = () => { setPickerOpen(false); onSetupNew(); };
  const pickPlaud = () => { setPickerOpen(false); onConnectPlaud(); };
  const pickPendant = () => { setPickerOpen(false); onConnectPendant(); };

  // The "add a device" sheet: three device types to choose from. Shared by the
  // empty state and the device list, so pairing always starts the same way.
  const renderPicker = () => (
    <Modal
      visible={pickerOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setPickerOpen(false)}
    >
      <View style={s.modalWrap}>
        <Pressable style={s.modalBackdrop} onPress={() => setPickerOpen(false)} />
        <View style={s.sheet}>
          <View style={s.sheetGrip} />
          <Text style={s.sheetTitle}>Add a device</Text>
          <Text style={s.sheetSub}>Which one are you connecting?</Text>

          <Pressable
            onPress={pickSate}
            accessibilityRole="button"
            style={({ pressed }) => [s.pickRow, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.pickGlyph}>
              <Feather name="cpu" size={24} color={D.sky} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.pickTitle}>SATE recorder</Text>
              <Text style={s.pickSub}>Wi-Fi recorder · pairs over Bluetooth</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>

          <Pressable
            onPress={pickPlaud}
            accessibilityRole="button"
            style={({ pressed }) => [s.pickRow, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.pickGlyph}>
              <PlaudDeviceCard width={40} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.pickTitle}>Plaud</Text>
              <Text style={s.pickSub}>Plaud recorder · syncs its sessions in</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>

          <Pressable
            onPress={pickPendant}
            accessibilityRole="button"
            style={({ pressed }) => [s.pickRow, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.pickGlyph}>
              <PendantDeviceCard width={40} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.pickTitle}>Pendant</Text>
              <Text style={s.pickSub}>Wearable · streams live audio over Bluetooth</Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.sub} />
          </Pressable>

          <Pressable
            onPress={() => setPickerOpen(false)}
            accessibilityRole="button"
            hitSlop={8}
            style={({ pressed }) => [s.cancel, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={s.cancelTxt}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );

  // ---- first load: hold a blank dark screen rather than flash fake data ----
  if (!loaded) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
      </View>
    );
  }

  // ---- couldn't reach the server: don't pretend the account has no recorder.
  // The device lives on the server and is controllable over the internet; we
  // just failed to load it (expired session / offline phone). Offer a retry. ----
  if (!hasAny && fetchFailed) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
        <View style={s.emptyTop}>
          <View style={s.brandRow}>
            <Logo size={32} />
            <Text style={s.brand}>SATE</Text>
          </View>
          <Pressable
            onPress={onOpenSettings}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={s.headerLink}>Settings</Text>
          </Pressable>
        </View>
        <View style={s.empty}>
          <View style={s.emptyRing}>
            <View style={s.ringTrack} />
            <View style={[s.recDotIdle, { backgroundColor: D.amber }]} />
          </View>
          <Text style={s.emptyTitle}>Can't reach SATE</Text>
          <Text style={s.emptySub}>
            We couldn't load your recorder from the server. Check your connection
            — your recorder stays online and keeps recording on its own.
          </Text>
          <Pressable
            onPress={refresh}
            accessibilityRole="button"
            style={({ pressed }) => [s.cta, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={s.ctaTxt}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ---- empty state: nothing paired anywhere yet → one button → device picker ----
  if (!hasAny) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <StatusBar style="light" />
        <View style={s.emptyTop}>
          <View style={s.brandRow}>
            <Logo size={32} />
            <Text style={s.brand}>SATE</Text>
          </View>
          <Pressable
            onPress={onOpenSettings}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={s.headerLink}>Settings</Text>
          </Pressable>
        </View>
        <View style={s.empty}>
          <View style={s.emptyRing}>
            <View style={s.ringTrack} />
            <View style={s.recDotIdle} />
          </View>
          <Text style={s.emptyTitle}>Connect your first device</Text>
          <Text style={s.emptySub}>
            SATE works with a recorder, a Plaud, or a pendant. Pick one to pair —
            it then records and uploads on its own, and this app is your window
            into it.
          </Text>
          <Pressable
            onPress={() => setPickerOpen(true)}
            accessibilityRole="button"
            style={({ pressed }) => [s.cta, { opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={s.ctaTxt}>Connect a device</Text>
          </Pressable>
          <Pressable onPress={onOpenPreview} hitSlop={8} accessibilityRole="button">
            <Text style={[s.headerLink, { marginTop: 18 }]}>
              See how it works ›
            </Text>
          </Pressable>
        </View>
        {renderPicker()}
      </View>
    );
  }

  // Reachability: online = the recorder is heartbeating to the server over
  // Wi-Fi (works from anywhere). nearbyBle = we can see it advertising over
  // Bluetooth right now (it's physically close, even with no Wi-Fi).
  const nearbyBle = dev ? nearby.has(dev.serial) : false;

  const dotColor = recording ? D.red : uploading ? D.sky : D.faint;
  const status = recording
    ? { text: "Recording", dot: D.red, fg: D.red }
    : uploading
    ? { text: "Uploading", dot: D.sky, fg: D.sky }
    : online
    ? { text: "Wi-Fi · Online", dot: D.green, fg: D.green }
    : nearbyBle
    ? { text: "Bluetooth · Nearby", dot: D.sky, fg: D.sky }
    : { text: "Off Wi-Fi · not nearby", dot: D.amber, fg: D.amber };

  const recordLabel = recording
    ? "Recording…"
    : uploading
    ? "Uploading…"
    : "Record a session";

  return (
    <View style={s.flex}>
      <GlassBackground />
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
        <StatusBar style="light" />

        {/* ---- header: who you're working with ---- */}
        <View style={s.header}>
          <View style={{ flex: 1 }}>
            <View style={s.brandRow}>
            <Logo size={32} />
            <Text style={s.brand}>SATE</Text>
          </View>
            {detailId && dev ? (
              <>
                <Pressable onPress={() => setDetailId(null)} hitSlop={6} accessibilityRole="button">
                  <Text style={s.backLink}>‹ Devices</Text>
                </Pressable>
                <Text style={s.recName} numberOfLines={1}>{dev.name}</Text>
                <View style={s.statusRow}>
                  <View style={[s.dot, { backgroundColor: status.dot }]} />
                  <Text style={[s.statusTxt, { color: status.fg }]}>
                    {status.text}
                  </Text>
                </View>
              </>
            ) : (
              <Text style={s.recName}>Your devices</Text>
            )}
          </View>
          <Pressable
            onPress={onOpenSettings}
            hitSlop={10}
            accessibilityRole="button"
            style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
          >
            <Text style={s.headerLink}>Settings</Text>
          </Pressable>
        </View>

        {/* ---- device list: SATE recorders + paired Plauds; tap → detail ---- */}
        {!detailId && (
          <>
            {devices.map((d) => (
              <Pressable
                key={d.id}
                onPress={() => openRecorder(d.id)}
                accessibilityRole="button"
                style={({ pressed }) => [s.plaudRow, { opacity: pressed ? 0.9 : 1 }]}
              >
                <View style={s.sateMini}>
                  <Feather
                    name={d.state === "recording" ? "radio" : d.online ? "wifi" : "wifi-off"}
                    size={20}
                    color={d.online ? D.sky : D.sub}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.plaudTitle}>{d.name}</Text>
                  <Text style={s.plaudSub}>
                    SATE recorder · {d.online ? "Online" : "Offline"}
                    {d.pending_sessions > 0 ? ` · ${d.pending_sessions} pending` : ""}
                  </Text>
                </View>
                <Feather name="chevron-right" size={20} color={D.sub} />
              </Pressable>
            ))}
            {knownPlauds.map((p) => (
              <Pressable
                key={p.sn}
                onPress={() => onConnectPlaud(p.sn)}
                accessibilityRole="button"
                style={({ pressed }) => [s.plaudRow, { opacity: pressed ? 0.9 : 1 }]}
              >
                <PlaudDeviceCard width={44} />
                <View style={{ flex: 1 }}>
                  <Text style={s.plaudTitle}>{p.name}</Text>
                  <Text style={s.plaudSub}>Paired Plaud · tap to open & sync</Text>
                </View>
                <Feather name="chevron-right" size={20} color={D.sub} />
              </Pressable>
            ))}
            {knownPendants.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => onConnectPendant(p.id)}
                accessibilityRole="button"
                style={({ pressed }) => [s.plaudRow, { opacity: pressed ? 0.9 : 1 }]}
              >
                <PendantDeviceCard width={44} />
                <View style={{ flex: 1 }}>
                  <Text style={s.plaudTitle}>{p.name}</Text>
                  <Text style={s.plaudSub}>Paired pendant · tap to connect & stream</Text>
                </View>
                <Feather name="chevron-right" size={20} color={D.sub} />
              </Pressable>
            ))}
            <Pressable
              onPress={() => setPickerOpen(true)}
              accessibilityRole="button"
              style={({ pressed }) => [s.addRow, { opacity: pressed ? 0.85 : 1 }]}
            >
              <Feather name="plus" size={18} color={D.sky} />
              <Text style={s.addTxt}>Add a device</Text>
            </Pressable>
          </>
        )}

        {/* ---- recorder detail: hero + record/sync + sessions ---- */}
        {detailId && dev && (
        <>
        {/* ---- hero: the recorder + the one thing you do most ---- */}
        <View style={s.hero}>
          <DeviceFrame width={156}>
            <Text style={s.screenBrand}>SATE</Text>
            <Animated.View
              style={[
                s.screenDot,
                { backgroundColor: dotColor, transform: [{ scale: pulse }] },
              ]}
            />
            <Text style={[s.screenStatus, { color: status.fg }]} numberOfLines={2}>
              {status.text}
            </Text>
          </DeviceFrame>
          <Text style={s.heroCaption}>
            {recording
              ? "Capturing audio on the recorder…"
              : uploading
              ? "Sending the session to SATE…"
              : online
              ? "Tap record and the recorder captures a session"
              : nearbyBle
              ? "Nearby over Bluetooth · tap Sync to bridge its sessions"
              : "Off Wi-Fi · bring it near your phone to sync over Bluetooth"}
          </Text>

          <Pressable
            onPress={openForm}
            disabled={!online || busy || busyCmd === "record"}
            accessibilityRole="button"
            style={({ pressed }) => [
              s.recordBtn,
              { opacity: !online || busy ? 0.5 : pressed ? 0.88 : 1 },
            ]}
          >
            {busyCmd === "record" || recording || uploading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={s.recordTxt}>
                <Feather name="mic" size={16} color="#FFFFFF" />
                {"  "}
                {recordLabel}
              </Text>
            )}
          </Pressable>
        </View>

        {/* ---- quick actions ---- */}
        <View style={s.actionRow}>
          <Pressable
            onPress={onSync}
            disabled={busyCmd === "sync_now"}
            accessibilityRole="button"
            style={({ pressed }) => [
              s.action,
              { opacity: busyCmd === "sync_now" ? 0.6 : pressed ? 0.85 : 1 },
            ]}
          >
            {busyCmd === "sync_now" ? (
              <ActivityIndicator color={D.sky} size="small" />
            ) : (
              <Feather name="upload" size={20} color={D.sky} />
            )}
            <Text style={s.actionLabel}>Sync</Text>
            <Text style={s.actionSub}>
              {dev && dev.pending_sessions > 0
                ? `${dev.pending_sessions} waiting`
                : "All sent"}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => command("reload_patients", "Patient list refreshed")}
            disabled={!online || busyCmd === "reload_patients"}
            accessibilityRole="button"
            style={({ pressed }) => [
              s.action,
              {
                opacity:
                  !online || busyCmd === "reload_patients"
                    ? 0.5
                    : pressed
                    ? 0.85
                    : 1,
              },
            ]}
          >
            {busyCmd === "reload_patients" ? (
              <ActivityIndicator color={D.sky} size="small" />
            ) : (
              <Feather name="refresh-cw" size={20} color={D.sky} />
            )}
            <Text style={s.actionLabel}>Patients</Text>
            <Text style={s.actionSub}>Refresh list</Text>
          </Pressable>
        </View>

        {note && <Text style={s.note}>{note}</Text>}

        {/* ---- sessions you've captured ----
             Each shows its processing state, exactly like the web app's Device
             tab: Received·Processing → Ready (tap to open the report) / Failed.
             No manual import — the server auto-runs the AI pipeline. */}
        <Text style={s.sectionHdr}>Recent sessions</Text>
        <Text style={s.sectionSub}>
          Uploaded to SATE and processed automatically — tap a ready one to open the report.
        </Text>
        <View style={s.panel}>
          {uploads.length === 0 ? (
            <Text style={s.emptyLine}>
              No sessions yet. Tap record above to capture your first one.
            </Text>
          ) : (
            uploads.map((u, i) => {
              const st = statusOf(u);
              const ready = st === "ready";
              const isPlaying = playingId === u.id;
              return (
                <Pressable
                  key={u.id}
                  onPress={ready ? () => onOpenReport(u) : undefined}
                  disabled={!ready}
                  accessibilityRole={ready ? "button" : undefined}
                  style={({ pressed }) => [
                    s.recRow,
                    i > 0 && s.recRowDivider,
                    { opacity: ready && pressed ? 0.7 : 1 },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.recName2}>
                      Session {u.session_number} · {u.patient_id || "Standalone"}
                    </Text>
                    <Text style={s.recSub}>
                      {durationLabel(u.bytes, u.sample_rate)} · {timeAgo(u.at)}
                    </Text>
                  </View>

                  {st === "processing" && (
                    <View style={[s.statusChip, { backgroundColor: D.amberBg }]}>
                      <ActivityIndicator color={D.amber} size="small" />
                      <Text style={[s.statusChipTxt, { color: D.amber }]}>Processing</Text>
                    </View>
                  )}
                  {st === "failed" && (
                    <View style={[s.statusChip, { backgroundColor: D.redBg }]}>
                      <Text style={[s.statusChipTxt, { color: D.red }]}>Failed</Text>
                    </View>
                  )}
                  {ready && (
                    <View style={s.readyGroup}>
                      <Pressable
                        onPress={() => togglePlay(u)}
                        accessibilityRole="button"
                        style={[s.playBtn, isPlaying && s.playBtnActive]}
                      >
                        <Feather
                          name={isPlaying ? "square" : "play"}
                          size={14}
                          color={isPlaying ? D.bg : D.sky}
                        />
                      </Pressable>
                      <Text style={s.viewChevron}>›</Text>
                    </View>
                  )}
                </Pressable>
              );
            })
          )}
        </View>

        {/* ---- one tap to the hardware admin, kept out of the way ---- */}
        {dev && (
          <Pressable
            onPress={() => onOpenRecorderSettings(dev)}
            accessibilityRole="button"
            style={({ pressed }) => [
              s.settingsRow,
              { opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={s.settingsTxt}>Recorder settings</Text>
            <Text style={s.settingsChevron}>›</Text>
          </Pressable>
        )}
        </>
        )}
      </ScrollView>

      {/* ---- type the patient, then start recording ---- */}
      <Modal
        visible={formOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setFormOpen(false)}
      >
        <KeyboardAvoidingView
          style={s.modalWrap}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <Pressable style={s.modalBackdrop} onPress={() => setFormOpen(false)} />
          <View style={s.sheet}>
            <View style={s.sheetGrip} />
            <Text style={s.sheetTitle}>New recording</Text>
            <Text style={s.sheetSub}>Who is this session for?</Text>

            {patients.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={s.chipRow}
                contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
                keyboardShouldPersistTaps="handled"
              >
                {patients.map((p) => {
                  const active = p.patient_id === pId;
                  return (
                    <Pressable
                      key={p.patient_id}
                      onPress={() => pickPatient(p)}
                      accessibilityRole="button"
                      style={[s.chip, active && s.chipActive]}
                    >
                      <Text style={[s.chipTxt, active && { color: "#FFFFFF" }]}>
                        {p.patient_id}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            <Text style={s.fieldLabel}>Patient ID *</Text>
            <TextInput
              style={s.input}
              value={pId}
              onChangeText={setPId}
              placeholder="e.g. PT-1004"
              placeholderTextColor={D.faint}
              autoCapitalize="characters"
              autoCorrect={false}
            />
            <Text style={s.fieldLabel}>Name</Text>
            <TextInput
              style={s.input}
              value={pName}
              onChangeText={setPName}
              placeholder="e.g. Jordan Lee"
              placeholderTextColor={D.faint}
              autoCapitalize="words"
            />
            <Text style={s.fieldLabel}>Session type</Text>
            <TextInput
              style={s.input}
              value={pType}
              onChangeText={setPType}
              placeholder="e.g. Articulation"
              placeholderTextColor={D.faint}
              autoCapitalize="sentences"
            />

            <Pressable
              onPress={startRecording}
              disabled={!pId.trim()}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.recordBtn,
                { marginTop: 8, opacity: !pId.trim() ? 0.5 : pressed ? 0.88 : 1 },
              ]}
            >
              <Text style={s.recordTxt}>
                <Feather name="mic" size={16} color="#FFFFFF" />
                {"  "}
                Start recording
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setFormOpen(false)}
              accessibilityRole="button"
              hitSlop={8}
              style={({ pressed }) => [s.cancel, { opacity: pressed ? 0.6 : 1 }]}
            >
              <Text style={s.cancelTxt}>Cancel</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {renderPicker()}
    </View>
  );
}

const RING = 132;

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 56, paddingBottom: 48 },

  header: { flexDirection: "row", alignItems: "flex-start", marginBottom: 18 },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 },
  brand: { color: D.sub, fontSize: 20, fontWeight: "800", letterSpacing: 3 },
  recName: {
    color: D.ink,
    fontSize: 26,
    fontWeight: "800",
    marginTop: 2,
    letterSpacing: 0.3,
  },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusTxt: { fontSize: 13, fontWeight: "700" },
  headerLink: { color: D.sky, fontSize: 15, fontWeight: "600" },

  plaudRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginBottom: 14,
  },
  plaudTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  plaudSub: { color: D.sub, fontSize: 12, marginTop: 2 },
  backLink: { color: D.sky, fontSize: 14, fontWeight: "600", marginTop: 2 },

  addRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "transparent",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    borderStyle: "dashed",
    paddingVertical: 14,
    marginTop: 2,
    marginBottom: 8,
  },
  addTxt: { color: D.sky, fontSize: 15, fontWeight: "700" },

  // device picker sheet
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: D.tile,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 12,
    marginTop: 12,
  },
  pickGlyph: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: D.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  pickTitle: { color: D.ink, fontSize: 16, fontWeight: "800" },
  pickSub: { color: D.sub, fontSize: 12, marginTop: 3 },
  sateMini: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: D.panel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    alignItems: "center",
    justifyContent: "center",
  },

  hero: {
    backgroundColor: D.panel,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: D.line,
    paddingVertical: 26,
    paddingHorizontal: 16,
    alignItems: "center",
    marginBottom: 14,
  },
  ringWrap: {
    width: RING,
    height: RING,
    alignItems: "center",
    justifyContent: "center",
  },
  ringTrack: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 9,
    borderColor: D.line,
  },
  ringAccent: {
    position: "absolute",
    width: RING,
    height: RING,
    borderRadius: RING / 2,
    borderWidth: 9,
    borderTopColor: D.sky,
    borderLeftColor: D.sky,
    borderRightColor: "transparent",
    borderBottomColor: "transparent",
  },
  recDot: { width: 34, height: 34, borderRadius: 17 },
  // On-screen content rendered inside the real device frame.
  screenBrand: {
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 2,
    color: "#9CA3AF",
    marginBottom: 8,
  },
  screenDot: { width: 26, height: 26, borderRadius: 13 },
  screenStatus: {
    marginTop: 8,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
  heroCaption: {
    color: D.sub,
    fontSize: 13,
    textAlign: "center",
    marginTop: 18,
    marginBottom: 18,
    lineHeight: 18,
  },
  recordBtn: {
    backgroundColor: D.sky,
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
  },
  recordTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },

  actionRow: { flexDirection: "row", gap: 12, marginBottom: 6 },
  action: {
    flex: 1,
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    paddingVertical: 16,
    paddingHorizontal: 14,
    alignItems: "flex-start",
  },
  actionGlyph: { color: D.sky, fontSize: 20, height: 24 },
  actionLabel: { color: D.ink, fontSize: 16, fontWeight: "700", marginTop: 10 },
  actionSub: { color: D.sub, fontSize: 12, marginTop: 2 },

  note: { color: D.sky, fontSize: 13, marginTop: 12 },

  sectionHdr: {
    color: D.ink,
    fontSize: 18,
    fontWeight: "800",
    marginTop: 22,
    marginBottom: 4,
  },
  sectionSub: { color: D.sub, fontSize: 12, lineHeight: 16, marginBottom: 12 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 10,
    marginLeft: 10,
  },
  statusChipTxt: { fontSize: 12, fontWeight: "700" },
  readyGroup: { flexDirection: "row", alignItems: "center", marginLeft: 10 },
  viewChevron: { color: D.faint, fontSize: 22, fontWeight: "600", marginLeft: 8 },
  panel: {
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 14,
    marginBottom: 18,
  },
  emptyLine: { color: D.sub, fontSize: 13, lineHeight: 18 },
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  recRowDivider: { borderTopWidth: 1, borderTopColor: D.line },
  recName2: { color: D.ink, fontSize: 14, fontWeight: "700" },
  recSub: { color: D.sub, fontSize: 12, marginTop: 3 },
  playBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: D.sky,
    marginLeft: 10,
  },
  playBtnActive: { backgroundColor: D.sky },
  playTxt: { color: D.sky, fontSize: 13, fontWeight: "700" },

  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: D.panel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: D.line,
    paddingVertical: 15,
    paddingHorizontal: 16,
  },
  settingsTxt: { color: D.ink, fontSize: 15, fontWeight: "600" },
  settingsChevron: { color: D.faint, fontSize: 22, fontWeight: "600" },

  // empty state
  emptyTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 56,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    paddingBottom: 60,
  },
  emptyRing: {
    width: RING,
    height: RING,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 26,
  },
  recDotIdle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: D.faint,
    opacity: 0.5,
  },
  emptyTitle: {
    color: D.ink,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    marginBottom: 10,
  },
  emptySub: {
    color: D.sub,
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 26,
  },
  cta: {
    backgroundColor: D.sky,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 40,
    alignSelf: "stretch",
    alignItems: "center",
  },
  ctaTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "800" },

  // new-recording sheet
  modalWrap: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  sheet: {
    backgroundColor: D.hero,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: D.line,
    padding: 20,
    paddingBottom: 34,
  },
  sheetGrip: {
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: D.line,
    alignSelf: "center",
    marginBottom: 14,
  },
  sheetTitle: { color: D.ink, fontSize: 20, fontWeight: "800" },
  sheetSub: { color: D.sub, fontSize: 14, marginTop: 4, marginBottom: 14 },
  chipRow: { marginBottom: 16 },
  chip: {
    backgroundColor: D.tile,
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: D.sky, borderColor: D.sky },
  chipTxt: { color: D.ink, fontSize: 13, fontWeight: "700" },
  fieldLabel: { color: D.sub, fontSize: 12, marginBottom: 5, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: D.ink,
    backgroundColor: D.tile,
    marginBottom: 10,
  },
  cancel: { paddingVertical: 12, alignItems: "center", marginTop: 4 },
  cancelTxt: { color: D.sub, fontSize: 15, fontWeight: "600" },
});
