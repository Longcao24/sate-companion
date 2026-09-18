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
import { FONT, R, S } from "../theme";

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

/** A metric the server did not store. Named, not hidden: a missing figure the
 *  user can see is missing is very different from one silently dropped. */
function Absent({ label, hint }: { label: string; hint: string }) {
  return (
    <View style={s.metRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.mLabel}>{label}</Text>
        <Text style={s.mHint}>{hint}</Text>
      </View>
      <Text style={s.mAbsent}>not stored</Text>
    </View>
  );
}

/** One metric row: code, full name, value — the shape the web sidebar uses. */
function Row({ code, name, value }: { code: string; name: string; value: string }) {
  return (
    <View style={s.metRow}>
      <View style={{ flex: 1 }}>
        <Text style={s.mLabel}>{code}</Text>
        <Text style={s.mHint}>{name}</Text>
      </View>
      <Text style={s.mValue}>{value}</Text>
    </View>
  );
}

function Group({ title }: { title: string }) {
  return <Text style={s.group}>{title}</Text>;
}

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
          <ActivityIndicator color={S.teal} />
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
                segments.map((seg, i) => {
                  // The utterance under the playhead. Checked against start/end
                  // rather than "nearest", so a gap between utterances highlights
                  // nothing — better than lighting up a line nobody is speaking.
                  const t = status?.currentTime ?? -1;
                  const live =
                    !!status?.playing &&
                    t >= (Number(seg.start) || 0) &&
                    t < (Number(seg.end) || 0);
                  const who = (seg.speaker ?? "").trim();
                  return (
                    <View key={i} style={[s.seg, live && s.segLive]}>
                      <View style={s.segHead}>
                        {/* Renaming is reachable from the transcript too: this is
                            where you realise who a speaker actually is. */}
                        <Pressable
                          onPress={() => {
                            const row = speakers.find((sp) => sp.id === who);
                            if (!row) return;
                            setEditing(row);
                            setDraft(row.id);
                            setNotice(null);
                          }}
                          disabled={!who}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={who ? `Rename ${who}` : undefined}
                        >
                          <Text style={[s.segWho, who && s.segWhoTap]}>
                            {who || "—"}
                            {who ? "  ✎" : ""}
                          </Text>
                        </Pressable>
                        <Text style={s.segAt}>{stamp(Number(seg.start) || 0)}</Text>
                      </View>
                      <Text style={s.segText}>{seg.text}</Text>
                    </View>
                  );
                })
              )}
            </>
          )}

          {tab === "analysis" && (
            <>
              <Group title="PRIORITY METRICS" />
              <Row code="TNU" name="Total Utterances" value={String(a.segmentCount ?? "—")} />
              <Row code="TNW" name="Total Words" value={String(a.ntw ?? a.totalWords ?? "—")} />
              <Row code="NDW" name="Different Words" value={String(a.ndw ?? "—")} />
              <Row code="MLUm" name="Mean Length (Morphemes)" value={num(a.mlum)} />
              <Row
                code="Pause Rate"
                name="Pauses per words"
                value={
                  typeof a.numberOfPauses === "number" && typeof a.ntw === "number" && a.ntw > 0
                    ? (a.numberOfPauses / a.ntw).toFixed(3)
                    : "—"
                }
              />

              <Group title="SYNTAX / MORPHOLOGY" />
              <Row code="MLUw" name="Mean Length (Words)" value={num(a.mluw)} />

              {/* SEMANTICS sits between syntax and fluency on the web, and the
                  order is the grouping — a clinician reading the two screens
                  side by side should find the same figure in the same place. */}
              <Group title="SEMANTICS" />
              <Row
                code="TTR"
                name="Type-Token Ratio"
                value={
                  typeof a.ndw === "number" && typeof a.ntw === "number" && a.ntw > 0
                    ? (a.ndw / a.ntw).toFixed(3)
                    : "—"
                }
              />
              {/* TTR is NDW/TNW — arithmetic on two stored figures, not a second
                  implementation of an algorithm. The three below ARE algorithms
                  (a sliding window, and a curve fit over random samples), and a
                  second implementation is exactly what must not exist here. */}
              <Absent
                label="Moving-Avg NTW / NDW / TTR"
                hint="windowed averages — computed by the web from the transcript"
              />
              <Absent
                label="VOCO-D"
                hint="vocabulary diversity — a curve fit the web runs on the transcript"
              />

              <Group title="VERBAL FLUENCY" />
              <Row code="Speech Rate" name="Words per minute" value={num(a.speakingRate, 1)} />
              <Row code="Pauses" name="Number of pauses" value={String(a.numberOfPauses ?? "—")} />
              <Absent
                label="Maze Rate"
                hint="maze words / total words — needs maze marks the app does not receive"
              />
              <Absent
                label="Avg Pause per Utterance"
                hint="derived from pause timings, which are not in the stored analysis"
              />

              <Text style={s.hint}>
                Every figure here was computed by SATE when the recording was processed. The app
                displays them and never recalculates one — a figure derived on the phone would
                eventually disagree with the web over the same recording, and nothing would say
                which was right.
              </Text>
            </>
          )}

          {tab === "language" && (
            <>
              {/* On the web this tab is ONE thing: the list of word roots. The
                  semantics figures live in Analysis, so repeating them here
                  would be a second place to read the same number — and the two
                  would eventually disagree. */}
              <Group title="LIST OF WORD ROOTS (LEMMA)" />
              <Absent
                label="Word roots"
                hint="lemmas are derived from the transcript's morpheme data, which the server does not store with the analysis"
              />
              <Row code="NDW" name="Different words counted" value={String(a.ndw ?? "—")} />
              <Text style={s.hint}>
                SATE stored how MANY different words this sample used, but not which ones — the
                list itself is built on the web from the transcript. Reference values against
                CHILDES also sit on the web report: they need the child's age, which is entered
                there.
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
              placeholderTextColor={S.mute}
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
  flex: { flex: 1, backgroundColor: S.bg },
  head: { paddingTop: 56, paddingHorizontal: 20, paddingBottom: 6 },
  back: { color: S.teal, fontSize: 15, fontFamily: FONT.bold, minWidth: 90 },
  headTitle: { color: S.ink, fontSize: 22, fontFamily: FONT.extra, letterSpacing: -0.4, marginTop: 6 },

  // Five tabs will not fit a segmented control at phone width, so they stay a
  // horizontal scroller — dressed as the design's control: a sunken track with
  // the active chip lifted out of it in white.
  tabsWrap: { flexGrow: 0, paddingHorizontal: 16, paddingVertical: 10 },
  tab: {
    minHeight: 40,
    paddingHorizontal: 15,
    justifyContent: "center",
    borderRadius: 11,
    marginRight: 6,
    backgroundColor: S.sunken,
  },
  tabOn: {
    backgroundColor: S.card,
    shadowColor: "#12211F",
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  tabTxt: { color: S.mute, fontSize: 13.5, fontFamily: FONT.extra },
  tabTxtOn: { color: S.ink },

  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 20, paddingBottom: 56 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 9, marginBottom: 10 },
  metric: {
    flexGrow: 1,
    minWidth: "45%",
    backgroundColor: S.tile,
    borderRadius: R.tile,
    padding: 13,
  },
  metricVal: { color: S.ink, fontSize: 24, fontFamily: FONT.extra, letterSpacing: -0.6 },
  metricLabel: { color: S.mute, fontSize: 12, marginTop: 4, fontFamily: FONT.bold },
  metricHint: { color: S.faint, fontSize: 11, marginTop: 2, fontFamily: FONT.regular },

  section: { color: S.ink, fontSize: 17.5, fontFamily: FONT.extra, marginTop: 20, marginBottom: 6 },
  hint: { color: S.mute, fontSize: 12.5, lineHeight: 19, marginTop: 12, fontFamily: FONT.regular },
  big: { color: S.ink, fontSize: 30, fontFamily: FONT.extra, letterSpacing: -1, marginTop: 4 },
  dim: { color: S.sub, fontSize: 13, marginTop: 6, fontFamily: FONT.regular },
  link: { color: S.teal, fontSize: 14, fontFamily: FONT.extra },

  spRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: S.card,
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: S.line,
    padding: 14,
    marginTop: 9,
  },
  spName: { color: S.ink, fontSize: 15, fontFamily: FONT.extra },

  // One utterance. `segLive` is the line under the playhead.
  seg: {
    backgroundColor: S.card,
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: S.line,
    padding: 14,
    marginBottom: 9,
  },
  segLive: { borderColor: S.teal, backgroundColor: S.tealTint },
  segHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 5 },
  segWhoTap: { textDecorationLine: "underline" },
  segWho: { color: S.teal, fontSize: 11.5, fontFamily: FONT.extra, letterSpacing: 0.4 },
  segAt: { color: S.ghost, fontSize: 11.5, fontFamily: FONT.regular },
  segText: { color: S.ink, fontSize: 14.5, lineHeight: 22, fontFamily: FONT.regular },

  issueRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: S.hair,
  },
  issueName: { color: S.sub, fontSize: 14, fontFamily: FONT.regular },
  issueCount: { color: S.warnInk, fontSize: 14, fontFamily: FONT.extra },

  player: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginHorizontal: 20,
    marginBottom: 8,
    padding: 11,
    backgroundColor: S.card,
    borderRadius: R.tile,
    borderWidth: 1,
    borderColor: S.line,
  },
  playBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: S.teal,
    alignItems: "center",
    justifyContent: "center",
  },
  barTrack: { flex: 1, height: 7, borderRadius: 99, backgroundColor: S.sunken, overflow: "hidden" },
  barFill: { height: 7, borderRadius: 99, backgroundColor: S.teal },
  // Fixed width and no shrinking: the progress bar is flex:1 and was squeezing
  // the total duration off the end, so the player read "0:04 /" — a clock with
  // nothing to measure against.
  playTime: {
    color: S.sub,
    fontSize: 12,
    fontFamily: FONT.bold,
    fontVariant: ["tabular-nums"],
    minWidth: 86,
    flexShrink: 0,
    textAlign: "right",
  },

  group: {
    color: S.mute,
    fontSize: 12,
    fontFamily: FONT.extra,
    letterSpacing: 0.9,
    marginTop: 22,
    marginBottom: 4,
  },
  metRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: S.hair,
  },
  mLabel: { color: S.ink, fontSize: 15, fontFamily: FONT.extra },
  mHint: { color: S.mute, fontSize: 11.5, marginTop: 2, fontFamily: FONT.regular },
  mValue: { color: S.ink, fontSize: 18, fontFamily: FONT.extra, fontVariant: ["tabular-nums"] },
  // Deliberately quiet: absent is information, not an error.
  mAbsent: { color: S.faint, fontSize: 12, fontStyle: "italic", fontFamily: FONT.regular },

  notice: {
    backgroundColor: S.goBg,
    borderRadius: R.tile,
    padding: 13,
    marginBottom: 12,
  },
  noticeTxt: { color: S.goInk, fontSize: 13, lineHeight: 19, fontFamily: FONT.medium },

  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  emptyTitle: { color: S.ink, fontSize: 18, fontFamily: FONT.extra, marginBottom: 8 },
  emptySub: { color: S.sub, fontSize: 14, textAlign: "center", lineHeight: 21, fontFamily: FONT.regular },
  cta: {
    marginTop: 20,
    backgroundColor: S.teal,
    borderRadius: R.button,
    paddingVertical: 14,
    paddingHorizontal: 30,
  },
  ctaTxt: { color: "#FFFFFF", fontFamily: FONT.bold, fontSize: 15.5 },

  // The rename sheet. Bottom-anchored like the design's confirm sheet.
  mWrap: { flex: 1, justifyContent: "flex-end", padding: 16 },
  mBack: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(18,33,31,0.42)" },
  mCard: {
    backgroundColor: S.card,
    borderRadius: R.card,
    padding: 20,
  },
  mTitle: { color: S.ink, fontSize: 18, fontFamily: FONT.extra, marginBottom: 6 },
  input: {
    backgroundColor: "#FBFCFC",
    borderRadius: R.button,
    borderWidth: 1.5,
    borderColor: "#E3E9E8",
    color: S.ink,
    fontSize: 16,
    fontFamily: FONT.medium,
    padding: 15,
    marginTop: 14,
  },
  mRow: { flexDirection: "row", gap: 10, marginTop: 18 },
  mBtn: { flex: 1, minHeight: 50, borderRadius: R.button, alignItems: "center", justifyContent: "center" },
  mGhost: { backgroundColor: S.card, borderWidth: 1.5, borderColor: "#DDE5E4" },
  mGhostTxt: { color: S.ink, fontFamily: FONT.bold, fontSize: 15.5 },
  mGo: { backgroundColor: S.teal },
  mGoTxt: { color: "#FFFFFF", fontFamily: FONT.bold, fontSize: 15.5 },
});
