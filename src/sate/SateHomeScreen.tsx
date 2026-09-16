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
import { SateApi } from "../api/sateApi";
import { Recording } from "../protocol";
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

/** `device_SATE-443EAC_s13.wav` is not a name a person would ever type. */
function label(r: Recording): string {
  const raw = (r.recording_name || "").trim();
  const m = raw.match(/^device_(SATE|pendant|plaud|l816)[^_]*_s(\d+)/i);
  if (!m) return raw || "Untitled recording";
  const prefix = { sate: "R", pendant: "P", plaud: "PL", l816: "L" }[m[1].toLowerCase()] ?? "R";
  const n = Number(m[2]);
  // The recorder numbers takes 1..99; every other family puts a UNIX timestamp
  // there, and thirteen digits is not a name.
  return n >= 1_000_000_000
    ? `${prefix}-${new Date(n * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`
    : `${prefix}-S${n}`;
}

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
  onOpenReport,
  onOpenDevices,
}: {
  api: SateApi;
  onOpenReport: (r: Recording) => void;
  onOpenDevices: () => void;
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

      <View style={s.top}>
        {/* Devices: a corner button, not a destination. */}
        <Pressable
          onPress={onOpenDevices}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Your devices"
          style={({ pressed }) => [s.devBtn, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Feather name="hard-drive" size={16} color={D.sub} />
        </Pressable>
        <View style={s.brandRow}>
          <Logo size={26} />
          <Text style={s.brand}>SATE</Text>
        </View>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={D.sub} />
        }
      >
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
                {label(r)}
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
  devBtn: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: D.tile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  brand: { color: D.ink, fontSize: 18, fontWeight: "800", letterSpacing: 3 },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingTop: 18, paddingBottom: 48 },
  title: { color: D.ink, fontSize: 28, fontWeight: "800", letterSpacing: 0.3 },
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
