import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { Feather } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { GlassBackground } from "../components/ui";
import { SateApi, TranscriptConflict } from "../api/sateApi";
import { Recording, TranscriptSegment } from "../protocol";
import { checkName, renameSpeaker, SpeakerRow, speakersOf } from "./speakers";
import { recordingLabel } from "./label";
import { D } from "../theme";

// One report, read from the server, laid out as the web app lays it out:
// Overview / Transcript / Analysis / Language / Issues.
//
// 🛑 THE ONLY EDIT IS RENAMING A SPEAKER. Every number on this screen was
// computed by the clinical pipeline and is displayed, never recomputed — if the
// phone derived its own MLU it would eventually disagree with the web app over
// the same recording, and there would be no way to tell which was right.

type Tab = "overview" | "transcript" | "analysis" | "language" | "issues";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "transcript", label: "Transcript" },
  { id: "analysis", label: "Analysis" },
  { id: "language", label: "Language" },
  { id: "issues", label: "Issues" },
];

const stamp = (sec: number) => {
  const s = Math.max(0, Math.floor(sec || 0));
  // `(100 + n).slice(1)` rather than padStart: on the device this rendered "0:2"
  // where Node gives "0:02" from the identical expression. Rather than ship a
  // clock that drops a digit, use the arithmetic form, which cannot.
  const ss = String(100 + (s % 60)).slice(1);
  return `${Math.floor(s / 60)}:${ss}`;
};

const num = (v: unknown, digits = 2): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits).replace(/\.00$/, "") : "—";

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <View style={s.metric}>
      <Text style={s.metricVal}>{value}</Text>
      <Text style={s.metricLabel}>{label}</Text>
      {hint ? <Text style={s.metricHint}>{hint}</Text> : null}
    </View>
  );
}

export function SateReportScreen({
  api,
  recording,
  onClose,
}: {
  api: SateApi;
  recording: Recording;
  onClose: () => void;
}) {
  // The list row carries only the light columns, so the full row — transcript
  // included — is fetched here.
  const [rec, setRec] = useState<Recording | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SpeakerRow | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // A signed URL for the audio. `recordings` is a PRIVATE bucket — patient
  // audio must never have a public URL — so one is minted per open and expires.
  const [audioUrl, setAudioUrl] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRec(await api.getRecording(recording.id));
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? "Could not load this report");
    }
  }, [api, recording.id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const path = rec?.file_path;
    if (!path) return;
    let cancelled = false;
    api
      .getRecordingAudioUrl(path)
      // Playback is a bonus, not the point of the screen: a failure here must
      // leave the transcript and the figures perfectly usable.
      .then((u: string | null) => !cancelled && setAudioUrl(u))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, rec?.file_path]);

  const player = useAudioPlayer(audioUrl ? { uri: audioUrl } : null);
  const status = useAudioPlayerStatus(player);

  const segments: TranscriptSegment[] = useMemo(
    () => rec?.transcript?.segments ?? [],
    [rec]
  );
  const speakers = useMemo(() => speakersOf(segments), [segments]);
  const a = rec?.analysis ?? {};
  const errs = rec?.error_counts ?? {};

  const commitRename = useCallback(async () => {
    if (!rec || !editing) return;
    const check = checkName(draft, editing.id, speakers);
    if (!check.ok) {
      setNotice(check.why);
      return;
    }
    setSaving(true);
    try {
      const { transcript, changed } = renameSpeaker(rec, editing.id, check.name);
      // The version that was LOADED. The server refuses the save if the row has
      // moved on since, so a colleague's edit on the web cannot be overwritten.
      await api.saveTranscript(rec.id, transcript, rec.version ?? null);
      setEditing(null);
      setNotice(`Renamed across ${changed} segment${changed === 1 ? "" : "s"}.`);
      await load(); // re-read: the version has advanced
    } catch (e: any) {
      setNotice(
        e instanceof TranscriptConflict
          ? e.message
          : `Could not save: ${e?.message ?? "unknown error"}`
      );
    } finally {
      setSaving(false);
    }
  }, [rec, editing, draft, speakers, api, load]);

  if (error && !rec) {
    return (
      <View style={s.flex}>
        <GlassBackground />
        <View style={s.center}>
          <Text style={s.emptyTitle}>Could not open this report</Text>
          <Text style={s.emptySub}>{error}</Text>
          <Pressable onPress={onClose} style={s.cta}>
            <Text style={s.ctaTxt}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={s.flex}>
      <GlassBackground />
      <StatusBar style="light" />

      <View style={s.head}>
        <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button">
          <Text style={s.back}>‹ Reports</Text>
        </Pressable>
        <Text style={s.headTitle} numberOfLines={1}>
          {recordingLabel(rec ?? recording)}
        </Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabsWrap}>
        {TABS.map((t) => (
          <Pressable
            key={t.id}
            onPress={() => setTab(t.id)}
            style={[s.tab, tab === t.id && s.tabOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
          >
            <Text style={[s.tabTxt, tab === t.id && s.tabTxtOn]}>{t.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* The same audio the web player uses. Listening is how a clinician checks
          a transcript, so it belongs on every tab, not buried in one. */}
      {rec && audioUrl && (
        <View style={s.player}>
          <Pressable
            onPress={() => (status?.playing ? player.pause() : player.play())}
            accessibilityRole="button"
            accessibilityLabel={status?.playing ? "Pause" : "Play"}
            style={s.playBtn}
          >
            <Feather name={status?.playing ? "pause" : "play"} size={18} color="#fff" />
          </Pressable>
          <View style={s.barTrack}>
            <View
              style={[
                s.barFill,
                {
                  width: `${
                    status?.duration
                      ? Math.min(100, ((status.currentTime ?? 0) / status.duration) * 100)
                      : 0
                  }%`,
                },
              ]}
            />
          </View>
          <Text style={s.playTime}>
            {stamp(status?.currentTime ?? 0)} / {stamp(status?.duration ?? rec.duration ?? 0)}
          </Text>
        </View>
      )}

      {!rec ? (
        <View style={s.center}>
          <ActivityIndicator color={D.sky} />
        </View>
      ) : (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}>
          {notice && (
            <Pressable onPress={() => setNotice(null)} style={s.notice}>
              <Text style={s.noticeTxt}>{notice}</Text>
            </Pressable>
          )}

          {tab === "overview" && (
            <>
              <View style={s.grid}>
                <Metric label="Duration" value={stamp(Number(a.totalDuration ?? rec.duration ?? 0))} />
                <Metric label="Speakers" value={String(a.speakerCount ?? (speakers.length || "—"))} />
                <Metric label="Utterances" value={String(a.segmentCount ?? (segments.length || "—"))} />
                <Metric label="Total words" value={String(a.ntw ?? a.totalWords ?? "—")} />
              </View>
              <Text style={s.section}>Who is in this recording</Text>
              <Text style={s.hint}>
                Tap a speaker to give them a name. That name is saved on the recording, so the
                web app and the SATE report show it too.
              </Text>
              {speakers.length === 0 ? (
                <Text style={s.dim}>This transcript has no speaker labels.</Text>
              ) : (
                speakers.map((sp) => (
                  <Pressable
                    key={sp.id}
                    onPress={() => {
                      setEditing(sp);
                      setDraft(sp.id);
                      setNotice(null);
                    }}
                    style={s.spRow}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.spName}>{sp.id}</Text>
                      <Text style={s.dim}>
                        {sp.segments} utterance{sp.segments === 1 ? "" : "s"} · {stamp(sp.seconds)}
                      </Text>
                    </View>
                    <Text style={s.link}>Rename</Text>
                  </Pressable>
                ))
              )}
            </>
          )}

          {tab === "transcript" && (
            <>
              {segments.length === 0 ? (
                <Text style={s.dim}>This recording has no transcript.</Text>
              ) : (
                segments.map((seg, i) => (
                  <View key={i} style={s.seg}>
                    <View style={s.segHead}>
                      <Text style={s.segWho}>{seg.speaker || "—"}</Text>
                      <Text style={s.segAt}>{stamp(Number(seg.start) || 0)}</Text>
                    </View>
                    <Text style={s.segText}>{seg.text}</Text>
                  </View>
                ))
              )}
            </>
          )}

          {tab === "analysis" && (
            <>
              <View style={s.grid}>
                <Metric label="MLUm" value={num(a.mlum)} hint="morphemes / utterance" />
                <Metric label="MLUw" value={num(a.mluw)} hint="words / utterance" />
                <Metric label="TNW" value={String(a.ntw ?? "—")} hint="total words" />
                <Metric label="NDW" value={String(a.ndw ?? "—")} hint="different words" />
              </View>
              <View style={s.grid}>
                <Metric label="Speaking rate" value={num(a.speakingRate, 1)} hint="words / min" />
                <Metric label="Pauses" value={String(a.numberOfPauses ?? "—")} />
              </View>
              <Text style={s.hint}>
                Every figure here was computed by SATE when the recording was processed. The app
                displays them; it does not calculate any of them.
              </Text>
            </>
          )}

          {tab === "language" && (
            <>
              <View style={s.grid}>
                <Metric label="NDW" value={String(a.ndw ?? "—")} hint="different words" />
                <Metric label="TNW" value={String(a.ntw ?? a.totalWords ?? "—")} hint="total words" />
              </View>
              <Text style={s.section}>Type–token ratio</Text>
              <Text style={s.big}>
                {typeof a.ndw === "number" && typeof a.ntw === "number" && a.ntw > 0
                  ? (a.ndw / a.ntw).toFixed(3)
                  : "—"}
              </Text>
              <Text style={s.hint}>
                Reference values against CHILDES are on the web report — they need a child's age,
                which is entered there.
              </Text>
            </>
          )}

          {tab === "issues" && (
            <>
              <View style={s.grid}>
                <Metric
                  label="Error rate"
                  value={typeof a.errorRate === "number" ? `${(a.errorRate * 100).toFixed(1)}%` : "—"}
                />
                <Metric
                  label="Marked issues"
                  value={String(Object.values(errs).reduce((n, v) => n + (Number(v) || 0), 0) || "—")}
                />
              </View>
              {Object.keys(errs).length === 0 ? (
                <Text style={s.dim}>No issues were marked on this recording.</Text>
              ) : (
                Object.entries(errs)
                  .filter(([, v]) => Number(v) > 0)
                  .sort((x, y) => Number(y[1]) - Number(x[1]))
                  .map(([k, v]) => (
                    <View key={k} style={s.issueRow}>
                      <Text style={s.issueName}>{k}</Text>
                      <Text style={s.issueCount}>{String(v)}</Text>
                    </View>
                  ))
              )}
            </>
          )}
        </ScrollView>
      )}

      <Modal visible={!!editing} transparent animationType="fade" onRequestClose={() => setEditing(null)}>
        <View style={s.mWrap}>
          <Pressable style={s.mBack} onPress={() => setEditing(null)} />
          <View style={s.mCard}>
            <Text style={s.mTitle}>Name this speaker</Text>
            <Text style={s.dim}>
              Replaces “{editing?.id}” everywhere in this transcript — {editing?.segments} utterance
              {editing?.segments === 1 ? "" : "s"}.
            </Text>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              autoFocus
              placeholder="e.g. Clinician, or the child's name"
              placeholderTextColor={D.faint}
              style={s.input}
            />
            <View style={s.mRow}>
              <Pressable onPress={() => setEditing(null)} style={[s.mBtn, s.mGhost]}>
                <Text style={s.mGhostTxt}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={commitRename}
                disabled={saving}
                style={[s.mBtn, s.mGo, saving && { opacity: 0.6 }]}
              >
                <Text style={s.mGoTxt}>{saving ? "Saving…" : "Save"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  head: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 6 },
  back: { color: D.sky, fontSize: 15, fontWeight: "600" },
  headTitle: { color: D.ink, fontSize: 20, fontWeight: "800", marginTop: 6 },
  tabsWrap: { flexGrow: 0, paddingHorizontal: 12, paddingVertical: 8 },
  tab: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, marginHorizontal: 4 },
  tabOn: { backgroundColor: D.skyBg },
  tabTxt: { color: D.sub, fontSize: 14, fontWeight: "600" },
  tabTxtOn: { color: D.sky },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingBottom: 56 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginBottom: 10 },
  metric: {
    flexGrow: 1,
    minWidth: "45%",
    backgroundColor: D.panel,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 14,
  },
  metricVal: { color: D.ink, fontSize: 22, fontWeight: "800" },
  metricLabel: { color: D.sub, fontSize: 12, marginTop: 4, fontWeight: "600" },
  metricHint: { color: D.faint, fontSize: 11, marginTop: 2 },
  section: { color: D.ink, fontSize: 16, fontWeight: "700", marginTop: 16, marginBottom: 4 },
  hint: { color: D.faint, fontSize: 12, lineHeight: 17, marginTop: 10 },
  big: { color: D.ink, fontSize: 30, fontWeight: "800", marginTop: 4 },
  dim: { color: D.sub, fontSize: 13, marginTop: 6 },
  link: { color: D.sky, fontSize: 14, fontWeight: "600" },
  spRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: D.panel,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginTop: 8,
  },
  spName: { color: D.ink, fontSize: 15, fontWeight: "700" },
  seg: {
    backgroundColor: D.panel,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
    padding: 12,
    marginBottom: 8,
  },
  segHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  segWho: { color: D.sky, fontSize: 12, fontWeight: "700" },
  segAt: { color: D.faint, fontSize: 12 },
  segText: { color: D.ink, fontSize: 15, lineHeight: 21 },
  issueRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: D.line,
  },
  issueName: { color: D.ink, fontSize: 14 },
  issueCount: { color: D.amber, fontSize: 14, fontWeight: "700" },
  player: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    backgroundColor: D.panel,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: D.line,
  },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: D.sky,
    alignItems: "center",
    justifyContent: "center",
  },
  barTrack: { flex: 1, height: 5, borderRadius: 3, backgroundColor: D.tile, overflow: "hidden" },
  barFill: { height: 5, borderRadius: 3, backgroundColor: D.sky },
  // Fixed width and no shrinking: the progress bar is flex:1 and was squeezing
  // the total duration off the end, so the player read "0:04 /" — a clock with
  // nothing to measure against.
  playTime: {
    color: D.sub,
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    minWidth: 86,
    flexShrink: 0,
    textAlign: "right",
  },
  notice: { backgroundColor: D.skyBg, borderRadius: 10, padding: 11, marginBottom: 12 },
  noticeTxt: { color: D.sky, fontSize: 13 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  emptyTitle: { color: D.ink, fontSize: 18, fontWeight: "700", marginBottom: 8 },
  emptySub: { color: D.sub, fontSize: 14, textAlign: "center", lineHeight: 20 },
  cta: { marginTop: 20, backgroundColor: D.sky, borderRadius: 12, paddingVertical: 13, paddingHorizontal: 30 },
  ctaTxt: { color: "#fff", fontWeight: "700" },
  mWrap: { flex: 1, justifyContent: "center", padding: 22 },
  mBack: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  mCard: {
    backgroundColor: D.hero,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: D.line,
    padding: 18,
  },
  mTitle: { color: D.ink, fontSize: 18, fontWeight: "800", marginBottom: 6 },
  input: {
    backgroundColor: D.tile,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: D.line,
    color: D.ink,
    fontSize: 16,
    padding: 13,
    marginTop: 14,
  },
  mRow: { flexDirection: "row", gap: 10, marginTop: 16 },
  mBtn: { flex: 1, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  mGhost: { backgroundColor: D.tile },
  mGhostTxt: { color: D.sub, fontWeight: "700" },
  mGo: { backgroundColor: D.sky },
  mGoTxt: { color: "#fff", fontWeight: "700" },
});
