import { useCallback, useEffect, useState } from "react";
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
import { GlassBackground, Logo } from "../components/ui";
import { SateDeviceChip } from "./SateDeviceChip";
import { SateNearbyBanner } from "./SateNearbyBanner";
import { SateApi } from "../api/sateApi";
import { ManagedDevice, Recording } from "../protocol";
import { recordingLabel } from "./label";
import { L816Session } from "../l816/useL816Session";
import { D } from "../theme";

// The SATE app's home: the reports that ALREADY EXIST on the server.
//
// This app does not produce a report. The clinical pipeline transcribes and
// analyses every recording; everything here is read back from `recordings`. So
// an empty list means "the server has none yet", never "tap here to make one" —
// offering a button that cannot work is worse than an honest empty state.
//
// Devices are deliberately demoted to the small button in the top-left corner.
// In SATE Companion the device list IS the app because the job is managing
// hardware; here the job is reading what the hardware produced, and hardware
// setup is the rare errand.

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function duration(sec: number | null): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
}

export function SateHomeScreen({
  api,
  devices,
  onOpenReport,
  onOpenDevices,
  l816,
}: {
  api: SateApi;
  /** Paired devices, for the top-left chip (device + battery, or "Add device"). */
  devices: ManagedDevice[];
  onOpenReport: (r: Recording) => void;
  onOpenDevices: () => void;
  /** The live L816 session, for the "a recorder is nearby" offer. */
  l816?: L816Session;
}) {
  const [rows, setRows] = useState<Recording[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.listRecordings());
      setError(null);
    } catch (e: any) {
      // Keep whatever is already on screen: a reachable server a minute ago is
      // better than a blank page, and the reports have not gone anywhere.
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

  return (
    <View style={s.flex}>
      <GlassBackground />
      <StatusBar style="light" />

      {/* Top-left is "Add device", labelled. Hardware is the errand you do once;
          the reports are the app. A bare icon here made the one action a new
          user needs the least discoverable thing on the screen. */}
      <View style={s.top}>
        <SateDeviceChip devices={devices} onPress={onOpenDevices} />
        <Logo size={24} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={D.sub} />
        }
      >
        {l816 && <SateNearbyBanner session={l816} />}

        <Text style={s.title}>Reports</Text>
        <Text style={s.sub}>
          {rows === null
            ? "Loading…"
            : `${rows.length} recording${rows.length === 1 ? "" : "s"} analysed by SATE`}
        </Text>

        {error && (
          <View style={s.warn}>
            <Text style={s.warnTxt}>{error}</Text>
          </View>
        )}

        {rows === null && (
          <View style={s.center}>
            <ActivityIndicator color={D.sky} />
          </View>
        )}

        {rows !== null && rows.length === 0 && !error && (
          <View style={s.center}>
            <Text style={s.emptyTitle}>No reports yet</Text>
            <Text style={s.emptySub}>
              A report appears here once SATE has finished processing a recording. Nothing is
              generated on this phone.
            </Text>
          </View>
        )}

        {(rows ?? []).map((r) => (
          <Pressable
            key={r.id}
            onPress={() => onOpenReport(r)}
            accessibilityRole="button"
            style={({ pressed }) => [s.row, { opacity: pressed ? 0.85 : 1 }]}
          >
            <View style={s.rowIcon}>
              <Feather name="file-text" size={18} color={D.sky} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle} numberOfLines={1}>
                {recordingLabel(r)}
              </Text>
              <Text style={s.rowSub} numberOfLines={1}>
                {[when(r.created_at), duration(r.duration), r.patient_id || "Standalone"]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            </View>
            <Feather name="chevron-right" size={20} color={D.faint} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  top: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
  },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 8 },
  addTxt: { color: D.ink, fontSize: 16, fontWeight: "700" },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 18, paddingBottom: 48 },
  title: { color: D.ink, fontSize: 40, fontWeight: "800", letterSpacing: -0.5 },
  sub: { color: D.sub, fontSize: 13, marginTop: 4, marginBottom: 16 },
  warn: {
    backgroundColor: D.amberBg,
    borderRadius: 12,
    padding: 12,
    marginBottom: 14,
  },
  warnTxt: { color: D.amber, fontSize: 13 },
  center: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24 },
  emptyTitle: { color: D.ink, fontSize: 18, fontWeight: "700", marginBottom: 8 },
  emptySub: { color: D.sub, fontSize: 14, textAlign: "center", lineHeight: 20 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: D.panel,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginBottom: 10,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    backgroundColor: D.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  rowSub: { color: D.sub, fontSize: 12, marginTop: 3 },
});
