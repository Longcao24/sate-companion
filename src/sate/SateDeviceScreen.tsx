import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";
import { SateApi } from "../api/sateApi";
import { ManagedDevice, Recording } from "../protocol";
import { recordingLabel } from "./label";
import { Body, Button, Card, H1, H3, Meta, Pill, SectionLabel, Tile, Tone } from "./ui";
import { FONT, R, S } from "../theme";
import { useBottomInset } from "../ui/insets";

// "View device" — the page the dashboard card and the device row point at.
//
// 🛑 It exists because that affordance was a LIE. Both screens drew "View device →"
// and a chevron on every row, and the handler behind them was `openL816`, which
// begins `if (d.kind === "l816")` and returns. So four of five paired devices —
// the Wi-Fi recorder, the pendant, Plaud — offered a tap that did nothing at all,
// which reads as a broken app rather than as a screen that does not exist.
//
// It is deliberately READ-ONLY, and that is the whole design. SATE reads what the
// hardware produced; Companion sets hardware up. A device page here answers "is it
// working, and where are its recordings", not "change its Wi-Fi" — so it needs no
// BLE, no radio handover, and no provisioning surface. The one action is opening
// the L81x recorder screen, because driving that handheld genuinely IS this app's
// job (see doc/14-l816.md).

/**
 * Everything the app actually KNOWS about this device.
 *
 * Only a Wi-Fi recorder has any of it: it registers with the server and sends a
 * heartbeat, so battery, last-seen, queue depth and firmware are facts. A paired
 * handheld has no server row at all — it is a Bluetooth pairing this phone
 * remembers — so a "Last seen —" tile beside a "Type: SATE L815" tile that just
 * repeats the title is two boxes of nothing. Returns empty for those, and the
 * tile block is not drawn.
 */
function facts(d: ManagedDevice): Array<{ label: string; value: string }> {
  if (d.kind && d.kind !== "sate") return [];
  const out: Array<{ label: string; value: string }> = [];
  if (typeof d.battery_pct === "number") out.push({ label: "Battery", value: `${d.battery_pct}%` });
  out.push({ label: "Last seen", value: lastSeen(d) });
  out.push({ label: "Pending", value: `${d.pending_sessions}` });
  out.push({ label: "Firmware", value: d.fw || "—" });
  return out;
}

function lastSeen(d: ManagedDevice): string {
  if (d.online) return "Now";
  if (!d.last_seen) return "—";
  const t = new Date(d.last_seen).getTime();
  if (Number.isNaN(t)) return "—";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function status(d: ManagedDevice): { tone: Tone; label: string } {
  if (d.state === "recording") return { tone: "warn", label: "Recording" };
  if (d.online) return { tone: "ok", label: "Online" };
  // A paired handheld is never "offline" in the Wi-Fi sense — it has no radio to
  // be offline on, so saying so would describe a fault that does not exist.
  if (d.kind && d.kind !== "sate") return { tone: "idle", label: "Paired" };
  return { tone: "idle", label: "Offline" };
}

/**
 * Does this recording's file name name THIS device?
 *
 * Uploads are named `device_<serial>_s<n>.wav`, but the serial in the file is not
 * always the serial on the row: an L81x pairs by MAC (`19:40:9D:91:AB:AF`) and
 * uploads as `l815-19409D91ABAF`, and the pendant and Plaud each punctuate their
 * ids their own way. Comparing the ALPHANUMERIC CORE of both sides is what makes
 * one rule work for every family — and matching loosely here is safe, because the
 * worst case is a row appearing under a device it did belong to all along.
 */
function core(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function belongsTo(r: Recording, d: ManagedDevice): boolean {
  const key = core(d.serial);
  if (key.length < 4) return false;
  return core(r.file_name ?? r.recording_name ?? "").includes(key);
}

function when(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function duration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  return `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

export function SateDeviceScreen({
  api,
  device,
  onClose,
  onOpenReport,
  onOpenRecorder,
}: {
  api: SateApi;
  device: ManagedDevice;
  onClose: () => void;
  onOpenReport: (r: Recording) => void;
  /** Present only for a handheld this build can actually drive. */
  onOpenRecorder?: () => void;
}) {
  // Clears the system navigation bar — this build is edge-to-edge.
  const padBottom = useBottomInset(40);
  const [rows, setRows] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.listRecordings());
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not reach SATE");
    }
  }, [api]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const mine = useMemo(
    () => (rows ?? []).filter((r) => belongsTo(r, device)),
    [rows, device]
  );

  const st = status(device);

  return (
    <View style={s.flex}>
      <StatusBar style="dark" />

      <View style={s.head}>
        <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button">
          <Text style={s.back}>‹ Back</Text>
        </Pressable>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.content, { paddingBottom: padBottom }]}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.mute} />
        }
      >
        <View style={s.titleRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <H1 numberOfLines={1}>{device.name}</H1>
            {/* A Wi-Fi recorder is NAMED by its serial, so printing both put the
                same string on two lines. A handheld's line is its MAC, which is
                the only way to tell two identical units apart. */}
            {core(device.serial) !== core(device.name) && (
              <Meta style={{ marginTop: 4 }} numberOfLines={1}>
                {device.serial}
              </Meta>
            )}
          </View>
          <Pill tone={st.tone}>{st.label}</Pill>
        </View>

        {facts(device).length > 0 && (
          <View style={s.tiles}>
            {facts(device).map((f) => (
              <View key={f.label} style={s.tileBox}>
                <Tile label={f.label}>
                  <Text style={s.tileVal} numberOfLines={1}>
                    {f.value}
                  </Text>
                </Tile>
              </View>
            ))}
          </View>
        )}

        {/* The one thing this page DOES. Everything above is a fact being read
            back; this is the handheld's own screen, where a take is started,
            stopped and pulled off the device. */}
        {!!onOpenRecorder && (
          <Button
            title="Open recorder"
            onPress={onOpenRecorder}
            style={{ marginTop: 18 }}
          />
        )}

        {/* Say plainly what this app will not do, rather than leaving a page that
            looks like it is missing something. */}
        {!onOpenRecorder && (
          <Card style={{ marginTop: 18 }}>
            <View style={s.noteRow}>
              <View style={s.noteIcon}>
                <Feather name="info" size={15} color={S.teal} />
              </View>
              <Body style={{ flex: 1, color: S.sub }}>
                {device.kind === "sate" || device.kind == null
                  ? "This recorder uploads to SATE by itself over Wi-Fi. Setting it up, " +
                    "changing its network or updating its firmware is done in the SATE " +
                    "Companion app."
                  : "This device is paired to your account. Connecting to it and syncing " +
                    "its recordings is done in the SATE Companion app; its finished " +
                    "reports appear here."}
              </Body>
            </View>
          </Card>
        )}

        {!!error && (
          <View style={s.warn}>
            <Text style={s.warnTxt}>{error}</Text>
          </View>
        )}

        <SectionLabel style={{ marginTop: 26, marginBottom: 10 }}>
          RECORDINGS FROM THIS DEVICE
        </SectionLabel>

        {rows === null && (
          <View style={s.center}>
            <ActivityIndicator color={S.teal} />
          </View>
        )}

        {rows !== null && mine.length === 0 && (
          <Card>
            <H3>Nothing from this device yet</H3>
            <Body style={{ marginTop: 6, color: S.sub }}>
              A recording appears here once it has reached SATE and been processed.
              Nothing is analysed on this phone.
            </Body>
          </Card>
        )}

        <View style={{ gap: 11 }}>
          {mine.map((r) => (
            <Card key={r.id} onPress={() => onOpenReport(r)}>
              <View style={s.rowTop}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <H3 numberOfLines={1}>{recordingLabel(r)}</H3>
                  <Meta style={{ marginTop: 3 }} numberOfLines={1}>
                    {[when(r.created_at), duration(r.duration), r.patient_id || "Standalone"]
                      .filter(Boolean)
                      .join(" · ")}
                  </Meta>
                </View>
                <Feather name="chevron-right" size={18} color={S.ghost} />
              </View>
            </Card>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: S.bg },
  head: { paddingHorizontal: 20, paddingTop: 56, paddingBottom: 2 },
  back: { color: S.teal, fontFamily: FONT.extra, fontSize: 15, minWidth: 64 },
  scroll: { flex: 1 },
  content: { padding: 20, paddingTop: 10, paddingBottom: 40 },

  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },

  tiles: { flexDirection: "row", flexWrap: "wrap", marginTop: 18, gap: 11 },
  // Two per row at phone width, and they reflow rather than squeezing.
  tileBox: { flexGrow: 1, flexBasis: "46%" },
  tileVal: { fontFamily: FONT.bold, fontSize: 20, color: S.ink },

  noteRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  noteIcon: {
    width: 28,
    height: 28,
    borderRadius: R.chip,
    backgroundColor: S.tealTint,
    alignItems: "center",
    justifyContent: "center",
  },

  rowTop: { flexDirection: "row", alignItems: "center", gap: 12 },

  warn: {
    backgroundColor: S.warnBg,
    borderWidth: 1,
    borderColor: S.warnLine,
    borderRadius: R.panel,
    padding: 14,
    marginTop: 16,
  },
  warnTxt: { color: S.warnInk, fontFamily: FONT.medium, fontSize: 13.5, lineHeight: 19 },

  center: { paddingVertical: 28, alignItems: "center" },
});
