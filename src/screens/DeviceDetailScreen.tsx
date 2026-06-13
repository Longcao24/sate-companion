import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
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
import { SateApi } from "../api/sateApi";
import { Glass, GlassBackground } from "../components/ui";
import { FoundDevice, SateLink } from "../ble/SateBle";
import {
  BleCommand,
  ManagedDevice,
  RemoteCommand,
  UploadedSession,
} from "../protocol";
import { D, radius } from "../theme";

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
  const pcm = Math.max(0, bytes - 44); // drop the WAV header
  const secs = Math.round(pcm / (sampleRate * 2));
  return `${secs}s`;
}

export function DeviceDetailScreen({
  api,
  link,
  device,
  onClose,
}: {
  api: SateApi;
  link: SateLink;
  device: ManagedDevice;
  onClose: () => void;
}) {
  const [name, setName] = useState(device.name);
  const [busyCmd, setBusyCmd] = useState<RemoteCommand | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Live view of this recorder + its uploads, refreshed while the screen is open
  // so "Record" -> capture -> upload is visible without leaving the screen.
  const [dev, setDev] = useState<ManagedDevice>(device);
  const [uploads, setUploads] = useState<UploadedSession[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const mounted = useRef(true);

  // Hero ring spins while the recorder is busy; red dot pulses while recording.
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;
  const spinLoop = useRef<Animated.CompositeAnimation | null>(null);
  const pulseLoop = useRef<Animated.CompositeAnimation | null>(null);

  // One audio player for the screen; we swap its source per recording tapped.
  const player = useAudioPlayer();
  const playerStatus = useAudioPlayerStatus(player);

  // Let playback be heard even with the ringer switch on silent.
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  // Clear the "playing" highlight when a clip finishes on its own.
  useEffect(() => {
    if (playerStatus?.didJustFinish) setPlayingId(null);
  }, [playerStatus?.didJustFinish]);

  const liveState = dev.state ?? "idle";
  const busy = liveState === "recording" || liveState === "uploading";

  // Spin the hero ring while the recorder is recording or uploading.
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

  // Pulse the center dot while actively recording.
  useEffect(() => {
    if (liveState === "recording") {
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
  }, [liveState]);

  const togglePlay = (u: UploadedSession) => {
    if (playingId === u.id) {
      player.pause();
      setPlayingId(null);
      return;
    }
    try {
      player.replace(api.audioSource(u.id)); // remote WAV + auth header
      player.seekTo(0);
      player.play();
      setPlayingId(u.id);
    } catch {
      setNote("Could not play this recording");
    }
  };

  const refresh = async () => {
    try {
      const [devices, ups] = await Promise.all([
        api.listDevices(),
        api.listUploads(device.serial),
      ]);
      if (!mounted.current) return;
      const fresh = devices.find((d) => d.id === device.id);
      if (fresh) setDev(fresh);
      setUploads(ups.slice(0, 5));
    } catch {
      /* keep last known; next tick retries */
    }
  };

  useEffect(() => {
    mounted.current = true;
    refresh();
    const t = setInterval(refresh, 2000); // snappy live status while open
    return () => {
      mounted.current = false;
      clearInterval(t);
      link.stopScan();
      link.disconnect().catch(() => {});
    };
  }, [link]);

  const setIf = (fn: () => void) => {
    if (mounted.current) fn();
  };

  // ---- Wi-Fi path: command goes through the server -----------------------
  const command = async (op: RemoteCommand, okMsg: string) => {
    setBusyCmd(op);
    setNote(null);
    try {
      await api.sendCommand(device.id, op);
      setIf(() => setNote(okMsg));
      refresh(); // pick up the new state/pending count quickly
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Command failed"));
    } finally {
      setIf(() => setBusyCmd(null));
    }
  };

  // ---- BLE path: device is off Wi-Fi but nearby ---------------------------
  const findNearby = () =>
    new Promise<FoundDevice>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.stopScan();
        reject(
          new Error(
            "Recorder not found nearby. Make sure it is powered on and within Bluetooth range."
          )
        );
      }, 12000);
      link.startScan((d) => {
        if (d.name === device.serial) {
          clearTimeout(timer);
          link.stopScan();
          resolve(d);
        }
      });
    });

  const bleCommand = async (op: BleCommand, okMsg: string) => {
    setBusyCmd(op);
    setNote("Searching for the recorder over Bluetooth...");
    try {
      const ok = await link.requestPermissions();
      if (!ok) throw new Error("Bluetooth permission needed");
      const found = await findNearby();
      setIf(() => setNote("Connecting..."));
      await link.connect(found.id);
      await link.sendCommand(op);
      setIf(() => setNote(`${okMsg} (sent over Bluetooth)`));
    } catch (e: any) {
      setIf(() => setNote(e?.message ?? "Bluetooth command failed"));
    } finally {
      await link.disconnect().catch(() => {});
      setIf(() => setBusyCmd(null));
    }
  };

  const rename = async () => {
    try {
      await api.renameDevice(device.id, name.trim());
      setNote("Name saved");
    } catch (e: any) {
      setNote(e?.message ?? "Rename failed");
    }
  };

  const remove = () => {
    Alert.alert(
      "Remove recorder",
      `Remove "${dev.name}" from your account? Recordings already on the SATE dashboard are kept.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            await api.removeDevice(device.id).catch(() => {});
            onClose();
          },
        },
      ]
    );
  };

  const online = dev.online;
  const recording = liveState === "recording";
  const uploading = liveState === "uploading";

  const status = recording
    ? { text: "RECORDING", dot: D.red, bg: D.redBg, fg: D.red }
    : uploading
    ? { text: "UPLOADING", dot: D.sky, bg: "rgba(59,158,255,0.15)", fg: D.sky }
    : online
    ? { text: "Online", dot: D.green, bg: D.greenBg, fg: D.green }
    : { text: "Offline", dot: D.amber, bg: D.amberBg, fg: D.amber };

  const rotate = spin.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });
  const dotColor = recording ? D.red : uploading ? D.sky : D.faint;

  const latest = uploads[0];

  return (
    <View style={s.flex}>
      <GlassBackground />
      <ScrollView style={s.scroll} contentContainerStyle={s.content}>
      <StatusBar style="light" />
      {/* ---- top bar: name + live status, Back ---- */}
      <View style={s.topbar}>
        <View style={{ flex: 1 }}>
          <Text style={s.devName} numberOfLines={1}>
            {dev.name}
          </Text>
          <View style={s.statusRow}>
            <View style={[s.dot, { backgroundColor: status.dot }]} />
            <Text style={[s.statusTxt, { color: status.fg }]}>
              {status.text}
            </Text>
          </View>
        </View>
        <Pressable onPress={onClose} hitSlop={10}>
          <Text style={s.close}>Back</Text>
        </Pressable>
      </View>

      {/* ---- hero: device ring + floating chips ---- */}
      <Glass style={s.hero} contentStyle={s.heroInner} r={22} intensity={36}>
        <View style={[s.chip, s.chipTL]}>
          <Text style={s.chipTxt}>
            {recording
              ? "● REC"
              : uploading
              ? "⇡ Sync"
              : online
              ? "Wi-Fi"
              : "BLE"}
          </Text>
        </View>
        <View style={[s.chip, s.chipBR]}>
          <Text style={s.chipTxt}>
            ⤢ {dev.pending_sessions} pending
          </Text>
        </View>

        <View style={s.ringWrap}>
          <View style={s.ringTrack} />
          <Animated.View style={[s.ringAccent, { transform: [{ rotate }] }]} />
          <Animated.View
            style={[
              s.recDot,
              { backgroundColor: dotColor, transform: [{ scale: pulse }] },
            ]}
          />
        </View>
        <Text style={s.heroCaption}>
          {recording
            ? "Capturing audio…"
            : uploading
            ? "Uploading over Wi-Fi…"
            : online
            ? "Ready to record"
            : "Off Wi-Fi · reachable over Bluetooth"}
        </Text>
      </Glass>

      {/* ---- latest recording job card ---- */}
      <Pressable
        style={s.jobCard}
        disabled={!latest}
        onPress={() => latest && togglePlay(latest)}
      >
        <View style={s.jobThumb}>
          <Text style={s.jobThumbGlyph}>
            {latest && playingId === latest.id ? "❚❚" : "▶"}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          {latest ? (
            <>
              <Text style={s.jobTitle} numberOfLines={1}>
                Session {latest.session_number} · {latest.patient_id}
              </Text>
              <View style={s.jobMetaRow}>
                <Text style={s.jobPct}>
                  {durationLabel(latest.bytes, latest.sample_rate)}
                </Text>
                <Text style={s.jobOk}>Uploaded ✓</Text>
              </View>
              <View style={s.jobBar}>
                <View style={s.jobBarFill} />
              </View>
            </>
          ) : (
            <>
              <Text style={s.jobTitle}>No recordings yet</Text>
              <Text style={s.jobSub}>
                Hit Record below to capture the first sample.
              </Text>
            </>
          )}
        </View>
      </Pressable>

      {/* ---- Device Control tiles ---- */}
      <Text style={s.sectionHdr}>Device Control</Text>
      <View style={s.grid}>
        <Tile
          label="Record"
          value={recording ? "Recording…" : uploading ? "Uploading…" : "Tap to start"}
          glyph="⏺"
          accent
          loading={busyCmd === "record" || recording || uploading}
          disabled={!online || busy}
          onPress={() =>
            command("record", "Recorder is capturing a sample, then uploading it")
          }
        />
        <Tile
          label="Sync"
          value={`${dev.pending_sessions} pending`}
          glyph="⇡"
          loading={busyCmd === "sync_now"}
          disabled={!online}
          onPress={() => command("sync_now", "Recorder is syncing now")}
        />
        <Tile
          label="Patients"
          value="Reload list"
          glyph="↻"
          loading={busyCmd === "reload_patients"}
          disabled={!online}
          onPress={() => command("reload_patients", "Patient list refreshed")}
        />
        <Tile
          label="Power"
          value="Restart"
          glyph="⏻"
          loading={busyCmd === "reboot"}
          onPress={() =>
            online
              ? command("reboot", "Recorder is restarting")
              : bleCommand("reboot", "Recorder is restarting")
          }
        />
      </View>
      {note && <Text style={s.note}>{note}</Text>}
      {!online && (
        <Text style={s.warn}>
          Recorder is off Wi-Fi. Auto-sync picks it up over Bluetooth when
          nearby; Restart also reaches it directly over Bluetooth.
        </Text>
      )}

      {/* ---- recent recordings ---- */}
      <Text style={s.sectionHdr}>Recent recordings</Text>
      <Glass style={s.panel} contentStyle={s.panelPad}>
        {uploads.length === 0 ? (
          <Text style={s.jobSub}>No recordings from this recorder yet.</Text>
        ) : (
          uploads.map((u, i) => {
            const isPlaying = playingId === u.id;
            return (
              <View
                key={u.id}
                style={[s.recRow, i > 0 && s.recRowDivider]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.recName}>
                    Session {u.session_number} · {u.patient_id}
                  </Text>
                  <Text style={s.recSub}>
                    {durationLabel(u.bytes, u.sample_rate)} · {timeAgo(u.at)}
                  </Text>
                </View>
                <Pressable
                  onPress={() => togglePlay(u)}
                  style={[s.playBtn, isPlaying && s.playBtnActive]}
                >
                  <Text
                    style={[s.playTxt, isPlaying && { color: "#0B0E13" }]}
                  >
                    {isPlaying ? "■ Stop" : "▶ Play"}
                  </Text>
                </Pressable>
              </View>
            );
          })
        )}
      </Glass>

      {/* ---- connection details ---- */}
      <Text style={s.sectionHdr}>Details</Text>
      <Glass style={s.panel} contentStyle={s.panelPad}>
        <Detail k="Serial" v={dev.serial} />
        <Detail k="Firmware" v={dev.fw} />
        {dev.ip ? <Detail k="IP address" v={dev.ip} /> : null}
        <Detail k="Last seen" v={timeAgo(dev.last_seen)} />
        <Detail k="Waiting to sync" v={`${dev.pending_sessions} session(s)`} />
      </Glass>

      {/* ---- name ---- */}
      <Text style={s.sectionHdr}>Name</Text>
      <Glass style={s.panel} contentStyle={s.panelPad}>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          autoCapitalize="sentences"
          autoCorrect={false}
          placeholder="Recorder name"
          placeholderTextColor={D.faint}
        />
        <Pressable style={s.saveBtn} onPress={rename}>
          <Text style={s.saveTxt}>Save name</Text>
        </Pressable>
      </Glass>

      <Pressable style={s.removeBtn} onPress={remove}>
        <Text style={s.removeTxt}>Remove from my account</Text>
      </Pressable>
      </ScrollView>
    </View>
  );
}

function Tile({
  label,
  value,
  glyph,
  accent,
  loading,
  disabled,
  onPress,
}: {
  label: string;
  value: string;
  glyph: string;
  accent?: boolean;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        s.tile,
        accent && s.tileAccent,
        { opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
      ]}
    >
      <View style={s.tileTop}>
        <Text style={[s.tileLabel, accent && { color: D.sky }]}>{label}</Text>
        {loading ? (
          <ActivityIndicator color={accent ? D.sky : D.sub} size="small" />
        ) : (
          <Text style={[s.tileGlyph, accent && { color: D.sky }]}>{glyph}</Text>
        )}
      </View>
      <Text style={s.tileValue}>{value}</Text>
    </Pressable>
  );
}

function Detail({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.detailRow}>
      <Text style={s.detailK}>{k}</Text>
      <Text style={s.detailV}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 56, paddingBottom: 48 },

  topbar: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  devName: { fontSize: 24, fontWeight: "800", color: D.ink, letterSpacing: 0.3 },
  statusRow: { flexDirection: "row", alignItems: "center", marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statusTxt: { fontSize: 13, fontWeight: "700" },
  close: { color: D.sky, fontSize: 15, fontWeight: "600" },

  hero: { marginBottom: 14 },
  heroInner: { paddingVertical: 28, alignItems: "center" },
  chip: {
    position: "absolute",
    backgroundColor: D.chip,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: D.line,
    zIndex: 2,
  },
  chipTL: { top: 16, left: 16 },
  chipBR: { bottom: 16, right: 16 },
  chipTxt: { color: D.ink, fontSize: 13, fontWeight: "700" },

  ringWrap: {
    width: 132,
    height: 132,
    alignItems: "center",
    justifyContent: "center",
  },
  ringTrack: {
    position: "absolute",
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 9,
    borderColor: D.line,
  },
  ringAccent: {
    position: "absolute",
    width: 132,
    height: 132,
    borderRadius: 66,
    borderWidth: 9,
    borderTopColor: D.sky,
    borderLeftColor: D.sky,
    borderRightColor: "transparent",
    borderBottomColor: "transparent",
  },
  recDot: { width: 34, height: 34, borderRadius: 17 },
  heroCaption: { color: D.sub, fontSize: 13, marginTop: 18 },

  jobCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 12,
    marginBottom: 22,
    overflow: "hidden",
  },
  jobThumb: {
    width: 60,
    height: 60,
    borderRadius: 12,
    backgroundColor: D.tile,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  jobThumbGlyph: { color: D.sky, fontSize: 22 },
  jobTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  jobSub: { color: D.sub, fontSize: 13, marginTop: 4 },
  jobMetaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
    marginBottom: 6,
  },
  jobPct: { color: D.ink, fontSize: 16, fontWeight: "800" },
  jobOk: { color: D.green, fontSize: 14, fontWeight: "800" },
  jobBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: D.tile,
    overflow: "hidden",
  },
  jobBarFill: { height: 6, borderRadius: 3, width: "100%", backgroundColor: D.green },

  sectionHdr: {
    color: D.ink,
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 12,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  tile: {
    width: "47.5%",
    flexGrow: 1,
    backgroundColor: D.tile,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: D.line,
    padding: 14,
    minHeight: 92,
    justifyContent: "space-between",
    overflow: "hidden",
  },
  tileAccent: {
    backgroundColor: D.skyBg,
    borderColor: "rgba(59,158,255,0.45)",
  },
  tileTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  tileLabel: { color: D.sub, fontSize: 14, fontWeight: "700" },
  tileGlyph: { color: D.sub, fontSize: 18 },
  tileValue: { color: D.ink, fontSize: 16, fontWeight: "700", marginTop: 14 },

  note: { color: D.sky, fontSize: 13, marginTop: 12 },
  warn: { color: D.amber, fontSize: 13, marginTop: 10, lineHeight: 18 },

  panel: { borderRadius: 16, marginBottom: 22, marginTop: 12 },
  panelPad: { padding: 14 },
  recRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
  },
  recRowDivider: { borderTopWidth: 1, borderTopColor: D.line },
  recName: { color: D.ink, fontSize: 14, fontWeight: "700" },
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

  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  detailK: { color: D.sub, fontSize: 14 },
  detailV: { color: D.ink, fontSize: 14, fontWeight: "700" },

  input: {
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    fontSize: 15,
    color: D.ink,
    backgroundColor: D.tile,
    marginBottom: 12,
  },
  saveBtn: {
    backgroundColor: D.tile,
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
  },
  saveTxt: { color: D.ink, fontSize: 15, fontWeight: "700" },

  removeBtn: {
    backgroundColor: D.redBg,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  removeTxt: { color: D.red, fontSize: 15, fontWeight: "700" },
});
