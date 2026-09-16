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
import { ManagedDevice, Recording } from "../protocol";
import { SateDeviceChip } from "./SateDeviceChip";
import { SateNearbyBanner } from "./SateNearbyBanner";
import { SateApi } from "../api/sateApi";
import { recordingLabel } from "./label";
import { L816Session } from "../l816/useL816Session";
import { D } from "../theme";

// Dashboard: what the account has right now, in two numbers and a list.
//
// Everything is read from the server or from the paired-device store. Nothing
// here is computed on the phone, and nothing here can be acted on destructively:
// it answers "is my hardware fine and did my recordings arrive", which is the
// question a clinician actually opens the app with.

export function SateDashboardScreen({
  api,
  devices,
  devicesLoaded,
  onOpenReports,
  onOpenReport,
  onAddDevice,
  onOpenDevice,
  liveL816,
  l816,
}: {
  api: SateApi;
  devices: ManagedDevice[];
  devicesLoaded: boolean;
  onOpenReports: () => void;
  onOpenReport: (r: Recording) => void;
  onAddDevice: () => void;
  onOpenDevice?: (d: ManagedDevice) => void;
  /** The live L816 session, for the "a recorder is nearby" offer. */
  l816?: L816Session;
  /** What the L816 session is doing RIGHT NOW. A paired row that only ever says
   *  "paired over Bluetooth" cannot answer the one question the dashboard is
   *  for — is the recorder connected, and is anything still waiting to upload? */
  liveL816?: { connectedId: string | null; line: string; busy: boolean } | null;
}) {
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

  // "Recent" is the last 7 days. A total alone does not tell you whether today's
  // session made it in, which is the thing people actually check.
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const recent = (rows ?? []).filter(
    (r) => r.created_at && new Date(r.created_at).getTime() >= weekAgo
  ).length;

  return (
    <View style={s.flex}>
      <GlassBackground />
      <StatusBar style="light" />

      <View style={s.top}>
        <SateDeviceChip devices={devices} onPress={onAddDevice} />
        <Logo size={24} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={D.sub} />
        }
      >
        <Text style={s.title}>Dashboard</Text>

        {l816 && <SateNearbyBanner session={l816} />}

        {error && (
          <View style={s.warn}>
            <Text style={s.warnTxt}>{error}</Text>
          </View>
        )}

        <View style={s.grid}>
          <Pressable onPress={onOpenReports} style={s.card}>
            <Text style={s.big}>{rows === null ? "—" : rows.length}</Text>
            <Text style={s.cardLabel}>Reports</Text>
            <Text style={s.cardHint}>tap to see them all</Text>
          </Pressable>
          <View style={s.card}>
            <Text style={s.big}>{rows === null ? "—" : recent}</Text>
            <Text style={s.cardLabel}>This week</Text>
            <Text style={s.cardHint}>last 7 days</Text>
          </View>
        </View>

        <Text style={s.section}>Devices</Text>
        {!devicesLoaded ? (
          <ActivityIndicator color={D.sky} style={{ marginTop: 14 }} />
        ) : devices.length === 0 ? (
          <Pressable onPress={onAddDevice} style={s.emptyDev}>
            <Feather name="plus-circle" size={18} color={D.sky} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>No device paired</Text>
              <Text style={s.rowSub}>
                You can still read every report — a device is only needed to make new ones.
              </Text>
            </View>
          </Pressable>
        ) : (
          devices.map((d) => {
            const kind = d.kind ?? "sate";
            const external = kind !== "sate";
            // Live only for the L816 that is actually connected right now.
            const live =
              kind === "l816" && liveL816 && liveL816.connectedId === d.serial ? liveL816 : null;
            const dot = live
              ? live.busy
                ? D.amber
                : D.green
              : external
                ? D.sky
                : d.online
                  ? D.green
                  : D.faint;
            return (
              <Pressable
                key={d.id}
                onPress={() => onOpenDevice?.(d)}
                disabled={!onOpenDevice}
                style={({ pressed }) => [s.devRow, { opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={[s.dot, { backgroundColor: dot }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.rowTitle}>{d.name}</Text>
                  <Text style={s.rowSub}>
                    {live
                      ? live.line
                      : external
                        ? // A Plaud / Pendant / L816 has no Wi-Fi and no heartbeat, so
                          // "offline" would be wrong rather than merely unhelpful.
                          `${d.fw} · paired over Bluetooth`
                        : d.online
                          ? "Online"
                          : "Offline · it keeps recording on its own"}
                  </Text>
                </View>
                {onOpenDevice && <Feather name="chevron-right" size={18} color={D.faint} />}
              </Pressable>
            );
          })
        )}

        <Text style={s.section}>Latest</Text>
        {rows === null ? (
          <ActivityIndicator color={D.sky} style={{ marginTop: 14 }} />
        ) : rows.length === 0 ? (
          <Text style={s.rowSub}>No reports yet.</Text>
        ) : (
          rows.slice(0, 3).map((r) => (
            <Pressable key={r.id} onPress={() => onOpenReport(r)} style={s.devRow}>
              <Feather name="file-text" size={16} color={D.sky} />
              <View style={{ flex: 1 }}>
                <Text style={s.rowTitle} numberOfLines={1}>
                  {recordingLabel(r)}
                </Text>
                <Text style={s.rowSub}>
                  {r.created_at
                    ? new Date(r.created_at).toLocaleString([], {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : ""}
                </Text>
              </View>
              <Feather name="chevron-right" size={18} color={D.faint} />
            </Pressable>
          ))
        )}
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
  content: { padding: 16, paddingTop: 18, paddingBottom: 30 },
  title: { color: D.ink, fontSize: 40, fontWeight: "800", letterSpacing: -0.5, marginBottom: 16 },
  warn: { backgroundColor: D.amberBg, borderRadius: 12, padding: 12, marginBottom: 14 },
  warnTxt: { color: D.amber, fontSize: 13 },
  grid: { flexDirection: "row", gap: 10 },
  card: {
    flex: 1,
    backgroundColor: D.panel,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 16,
  },
  big: { color: D.ink, fontSize: 34, fontWeight: "800" },
  cardLabel: { color: D.ink, fontSize: 14, fontWeight: "700", marginTop: 2 },
  cardHint: { color: D.faint, fontSize: 11, marginTop: 2 },
  section: { color: D.ink, fontSize: 17, fontWeight: "700", marginTop: 22, marginBottom: 6 },
  devRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    backgroundColor: D.panel,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginTop: 8,
  },
  emptyDev: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: D.line,
    padding: 12,
    marginTop: 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  rowTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  rowSub: { color: D.sub, fontSize: 12, marginTop: 2 },
});
