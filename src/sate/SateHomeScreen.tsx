import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SateDeviceChip } from "./SateDeviceChip";
import { SateNearbyBanner } from "./SateNearbyBanner";
import { Body, Card, H1, H3, Meta, Pill, SectionLabel, Tone } from "./ui";
import { SateApi } from "../api/sateApi";
import { L816Session } from "../l816/useL816Session";
import { ManagedDevice, Recording } from "../protocol";
import { recordingLabel } from "./label";
import { FONT, R, S } from "../theme";

// The SATE app's report list — the reports that ALREADY EXIST on the server.
//
// This app does not produce a report. The clinical pipeline transcribes and
// analyses every recording; everything here is read back from `recordings`. So
// an empty list means "the server has none yet", never "tap here to make one" —
// offering a button that cannot work is worse than an honest empty state.
//
// The 2026-09 redesign changed how this looks, not what it says: every row is
// still a real stored recording, named by the ONE naming rule (`recordingLabel`),
// dated and measured from its own row. No figure here is invented for the sake
// of filling a card.

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

/** The pill is DERIVED FROM THE ROW, never decorative. `needs_review` is a real
 *  column a clinician sets; everything else in this list has been processed. */
function statusOf(r: Recording): { tone: Tone; label: string } {
  return r.needs_review ? { tone: "warn", label: "Needs review" } : { tone: "ok", label: "Ready" };
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
      <StatusBar style="dark" />

      <View style={s.top}>
        <SateDeviceChip devices={devices} onPress={onOpenDevices} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.mute} />
        }
      >
        <H1>Reports</H1>
        <Meta style={{ marginTop: 4 }}>
          {rows === null
            ? "Loading…"
            : `${rows.length} recording${rows.length === 1 ? "" : "s"} analysed by SATE`}
        </Meta>

        {l816 && (
          <View style={{ marginTop: 16 }}>
            <SateNearbyBanner session={l816} />
          </View>
        )}

        {error && (
          <View style={s.warn}>
            <Text style={s.warnTxt}>{error}</Text>
          </View>
        )}

        {rows === null && (
          <View style={s.center}>
            <ActivityIndicator color={S.teal} />
          </View>
        )}

        {rows !== null && rows.length === 0 && !error && (
          <View style={s.empty}>
            <H3>No reports yet</H3>
            <Body style={{ textAlign: "center", marginTop: 6 }}>
              A report appears here once SATE has finished processing a recording. Nothing is
              generated on this phone.
            </Body>
          </View>
        )}

        {rows !== null && rows.length > 0 && (
          <SectionLabel style={{ marginTop: 24, marginBottom: 10 }}>ALL SESSIONS</SectionLabel>
        )}

        <View style={{ gap: 11 }}>
          {(rows ?? []).map((r) => {
            const st = statusOf(r);
            return (
              <Card key={r.id} onPress={() => onOpenReport(r)} style={s.row}>
                <View style={s.rowTop}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <H3 numberOfLines={1}>{recordingLabel(r)}</H3>
                    <Meta style={{ marginTop: 3 }} numberOfLines={1}>
                      {[when(r.created_at), duration(r.duration), r.patient_id || "Standalone"]
                        .filter(Boolean)
                        .join(" · ")}
                    </Meta>
                  </View>
                  <Pill tone={st.tone}>{st.label}</Pill>
                </View>
              </Card>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: S.bg },
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 56 },
  scroll: { flex: 1 },
  content: { padding: 20, paddingTop: 14, paddingBottom: 40 },
  warn: {
    backgroundColor: S.warnBg,
    borderWidth: 1,
    borderColor: S.warnLine,
    borderRadius: R.panel,
    padding: 14,
    marginTop: 16,
  },
  warnTxt: { fontFamily: FONT.medium, fontSize: 13.5, lineHeight: 20, color: S.warnInk },
  center: { alignItems: "center", paddingVertical: 48 },
  empty: {
    marginTop: 20,
    backgroundColor: S.card,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: S.dash,
    borderRadius: R.panel,
    padding: 28,
    alignItems: "center",
  },
  row: { padding: 16, borderRadius: R.panel },
  rowTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
});
