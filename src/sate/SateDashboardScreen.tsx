import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SateDeviceChip } from "./SateDeviceChip";
import { SateNearbyBanner } from "./SateNearbyBanner";
import { Body, Card, H1, H2, H3, Meta, Pill, SectionLabel, Stat, Tile, Tone } from "./ui";
import { SateApi } from "../api/sateApi";
import { L816Session } from "../l816/useL816Session";
import { ManagedDevice, Recording } from "../protocol";
import { recordingLabel } from "./label";
import { FONT, R, S } from "../theme";

// The SATE app's home.
//
// The redesign's shape — a greeting, one device card, then the most recent work
// — with this app's own numbers. Every figure is counted from rows the server
// returned: the report total, the last seven days, and the live state of the
// recorder. Nothing is illustrative.

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

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
  /** What the L816 session is doing RIGHT NOW. A paired row that only ever says
   *  "paired over Bluetooth" cannot answer the one question the dashboard is
   *  for — is the recorder connected, and is anything still waiting to upload? */
  liveL816?: { connectedId: string | null; line: string; busy: boolean } | null;
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
  const latest = (rows ?? []).slice(0, 3);

  return (
    <View style={s.flex}>
      <StatusBar style="dark" />

      <View style={s.top}>
        <SateDeviceChip devices={devices} onPress={onAddDevice} />
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={S.mute} />
        }
      >
        <Meta style={{ fontFamily: FONT.bold, color: S.sub }}>{greeting()}</Meta>
        <H1 style={{ marginTop: 3 }}>
          {rows === null
            ? "Loading your reports…"
            : rows.length === 0
              ? "No reports yet"
              : recent > 0
                ? `${recent} new report${recent === 1 ? "" : "s"} this week`
                : "Everything is up to date"}
        </H1>

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

        {/* Two counts, both real: everything stored, and what landed this week. */}
        <View style={s.statRow}>
          <Card onPress={onOpenReports} style={s.statCard}>
            <Stat>{rows === null ? "—" : rows.length}</Stat>
            <Meta style={s.statLabel}>Reports</Meta>
            <Meta style={s.statHint}>tap to see them all</Meta>
          </Card>
          <Card style={s.statCard}>
            <Stat>{rows === null ? "—" : recent}</Stat>
            <Meta style={s.statLabel}>This week</Meta>
            <Meta style={s.statHint}>last 7 days</Meta>
          </Card>
        </View>

        <SectionLabel style={{ marginTop: 26, marginBottom: 10 }}>YOUR RECORDER</SectionLabel>

        {!devicesLoaded ? (
          <ActivityIndicator color={S.teal} style={{ marginTop: 14 }} />
        ) : devices.length === 0 ? (
          <Card onPress={onAddDevice} style={s.emptyDev}>
            <H3>No device paired</H3>
            <Body style={{ marginTop: 5 }}>
              You can still read every report — a device is only needed to make new ones.
            </Body>
            <Meta style={{ color: S.teal, fontFamily: FONT.extra, marginTop: 12 }}>
              Add a device →
            </Meta>
          </Card>
        ) : (
          <View style={{ gap: 11 }}>
            {devices.map((d) => {
              const kind = d.kind ?? "sate";
              const external = kind !== "sate";
              const live =
                kind === "l816" && liveL816 && liveL816.connectedId === d.serial ? liveL816 : null;
              const tone: Tone = live
                ? live.busy
                  ? "go"
                  : "ok"
                : external
                  ? "idle"
                  : d.online
                    ? "ok"
                    : "idle";
              const label = live
                ? live.busy
                  ? "Working"
                  : "Connected"
                : external
                  ? "Paired"
                  : d.online
                    ? "Online"
                    : "Offline";
              return (
                <Card key={d.id} onPress={() => onOpenDevice?.(d)}>
                  <View style={s.devTop}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <H2 numberOfLines={1}>{d.name}</H2>
                      <Meta style={{ marginTop: 2 }} numberOfLines={2}>
                        {live
                          ? live.line
                          : external
                            ? `${d.fw} · paired over Bluetooth`
                            : d.online
                              ? "Online"
                              : "Offline · it keeps recording on its own"}
                      </Meta>
                    </View>
                    <Pill tone={tone}>{label}</Pill>
                  </View>

                  {/* 🛑 The battery tile is drawn ONLY when the battery is known.
                      It arrives in the SATE recorder's Wi-Fi heartbeat; an L816,
                      a pendant and a Plaud have no Wi-Fi and send none. A guessed
                      bar would say "flat" about a device that may be full, and a
                      clinician deciding whether to take it to a session would act
                      on that. */}
                  {typeof d.battery_pct === "number" && (
                    <View style={s.tileRow}>
                      <Tile label="Battery">
                        <Text style={s.tileVal}>{Math.round(d.battery_pct)}%</Text>
                      </Tile>
                      <Tile label="Status">
                        <Text style={s.tileVal}>{d.online ? "Online" : "Offline"}</Text>
                      </Tile>
                    </View>
                  )}

                  {onOpenDevice && (
                    <View style={s.devMore}>
                      <Text style={s.devMoreTxt}>View device →</Text>
                    </View>
                  )}
                </Card>
              );
            })}
          </View>
        )}

        <View style={s.latestHead}>
          <SectionLabel>RECENT SESSIONS</SectionLabel>
          <Pressable onPress={onOpenReports} hitSlop={10} accessibilityRole="button">
            <Text style={s.seeAll}>See all</Text>
          </Pressable>
        </View>

        {rows === null ? (
          <ActivityIndicator color={S.teal} style={{ marginTop: 14 }} />
        ) : latest.length === 0 ? (
          <Card style={s.emptyDev}>
            <H3>Nothing recorded yet</H3>
            <Body style={{ marginTop: 5 }}>
              Your completed sessions appear here once SATE has processed one.
            </Body>
          </Card>
        ) : (
          <View style={{ gap: 11 }}>
            {latest.map((r) => (
              <Card key={r.id} onPress={() => onOpenReport(r)} style={s.row}>
                <View style={s.devTop}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <H3 numberOfLines={1}>{recordingLabel(r)}</H3>
                    <Meta style={{ marginTop: 3 }}>{when(r.created_at)}</Meta>
                  </View>
                  <Pill tone={r.needs_review ? "warn" : "ok"}>
                    {r.needs_review ? "Needs review" : "Ready"}
                  </Pill>
                </View>
              </Card>
            ))}
          </View>
        )}
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
  statRow: { flexDirection: "row", gap: 11, marginTop: 20 },
  statCard: { flex: 1, padding: 16, borderRadius: R.panel },
  statLabel: { fontFamily: FONT.extra, fontSize: 14, color: S.ink, marginTop: 2 },
  statHint: { fontSize: 12, color: S.mute, marginTop: 1 },
  emptyDev: { borderStyle: "dashed", borderColor: S.dash },
  devTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  tileRow: { flexDirection: "row", gap: 9, marginTop: 16 },
  tileVal: { fontFamily: FONT.extra, fontSize: 14, color: S.ink },
  devMore: { flexDirection: "row", justifyContent: "flex-end", marginTop: 14 },
  devMoreTxt: { fontFamily: FONT.extra, fontSize: 13.5, color: S.teal },
  latestHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginTop: 26,
    marginBottom: 10,
  },
  seeAll: { fontFamily: FONT.extra, fontSize: 13.5, color: S.teal, minWidth: 60, textAlign: "right" },
  row: { padding: 16, borderRadius: R.panel },
});
