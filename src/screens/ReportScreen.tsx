import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { StatusBar } from "expo-status-bar";
import { SateApi } from "../api/sateApi";
import { GlassBackground } from "../components/ui";
import { Recording, UploadedSession } from "../protocol";
import { D } from "../theme";

// ReportScreen — the phone's native view of a processed recording. It reads the
// SAME `recordings` row the web app shows (transcript + analysis), so a session
// captured on the device opens here exactly as it does on the web. On first open
// of a device recording (needs_review) it asks the SLP to name it + pick a
// protocol, mirroring the web app's popup.

const fmtTime = (s: number) => {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
};

const round = (n: number | undefined, d = 1) =>
  n == null || !isFinite(n) ? "—" : (Math.round(n * 10 ** d) / 10 ** d).toString();

// Human label for the AI error-count keys.
const ERR_LABEL: Record<string, string> = {
  pause: "Pauses",
  filler: "Fillers",
  morpheme: "Morphemes",
  revision: "Revisions",
  repetition: "Repetitions",
  "utterance-error": "Utterance errors",
  mispronunciation: "Mispronunciations",
  "morpheme-omission": "Morpheme omissions",
};

export function ReportScreen({
  api,
  session,
  onClose,
}: {
  api: SateApi;
  session: UploadedSession;
  onClose: () => void;
}) {
  const recId = session.recording_id!;
  const [rec, setRec] = useState<Recording | null>(null);
  const [error, setError] = useState<string | null>(null);

  // first-open review sheet
  const [reviewOpen, setReviewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rName, setRName] = useState("");
  const [rProtocol, setRProtocol] = useState("");
  const [rNote, setRNote] = useState("");

  const mounted = useRef(true);

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);
  useEffect(() => {
    if (status?.didJustFinish) setPlaying(false);
  }, [status?.didJustFinish]);

  useEffect(() => {
    mounted.current = true;
    api
      .getRecording(recId)
      .then((r) => {
        if (!mounted.current) return;
        setRec(r);
        if (r.needs_review) {
          setRName(r.recording_name ?? r.file_name ?? "");
          setRProtocol(r.protocol ?? "");
          setRNote(r.notes ?? "");
          setReviewOpen(true);
        }
      })
      .catch((e) => mounted.current && setError(e?.message ?? "Couldn't load report"));
    return () => {
      mounted.current = false;
      // useAudioPlayer auto-releases the native player on unmount; calling
      // pause() here can race that teardown and throw
      // (NativeSharedObjectNotFoundException), so guard it.
      try {
        player.pause();
      } catch {
        // player already released — nothing to do
      }
    };
  }, [recId]);

  const togglePlay = () => {
    if (playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    try {
      player.replace(api.audioSource(session.id));
      player.seekTo(0);
      player.play();
      setPlaying(true);
    } catch {
      setError("Could not play this session");
    }
  };

  const saveReview = async () => {
    if (!rName.trim() || !rProtocol.trim()) return;
    setSaving(true);
    try {
      await api.updateRecording(recId, {
        recording_name: rName.trim(),
        protocol: rProtocol.trim(),
        notes: rNote.trim() || undefined,
      });
      if (!mounted.current) return;
      setRec((p) =>
        p
          ? { ...p, recording_name: rName.trim(), protocol: rProtocol.trim(), notes: rNote.trim(), needs_review: false }
          : p
      );
      setReviewOpen(false);
    } catch (e: any) {
      setError(e?.message ?? "Couldn't save");
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const a = rec?.analysis ?? {};
  const errs = rec?.error_counts ?? {};
  const segs = rec?.transcript?.segments ?? [];
  const title = rec?.recording_name || rec?.file_name || `Session ${session.session_number}`;

  const metrics: { label: string; value: string }[] = [
    { label: "Total words", value: round(a.totalWords, 0) },
    { label: "Different words", value: round(a.ndw, 0) },
    { label: "MLU (words)", value: round(a.mluw) },
    { label: "Error rate", value: a.errorRate == null ? "—" : `${round(a.errorRate)}%` },
    { label: "Speaking rate", value: a.speakingRate == null ? "—" : `${round(a.speakingRate, 0)} wpm` },
    { label: "Pauses", value: round(a.numberOfPauses, 0) },
  ];

  return (
    <View style={s.flex}>
      <GlassBackground />
      <StatusBar style="light" />

      {/* header */}
      <View style={s.header}>
        <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}>
          <Text style={s.back}>‹ Back</Text>
        </Pressable>
        <Text style={s.brand}>REPORT</Text>
        <View style={{ width: 52 }} />
      </View>

      {!rec && !error && (
        <View style={s.center}>
          <ActivityIndicator color={D.sky} />
          <Text style={s.loadingTxt}>Loading the report…</Text>
        </View>
      )}
      {error && !rec && (
        <View style={s.center}>
          <Text style={s.errTxt}>{error}</Text>
        </View>
      )}

      {rec && (
        <ScrollView style={s.scroll} contentContainerStyle={s.content}>
          <Text style={s.title} numberOfLines={2}>
            {title}
          </Text>
          <View style={s.metaRow}>
            {!!rec.protocol && (
              <View style={s.tag}>
                <Text style={s.tagTxt}>{rec.protocol}</Text>
              </View>
            )}
            <Text style={s.metaSub}>
              {session.patient_id ? session.patient_id : "Standalone"} ·{" "}
              {fmtTime(rec.duration ?? 0)}
            </Text>
          </View>

          {/* audio */}
          <Pressable
            onPress={togglePlay}
            accessibilityRole="button"
            style={({ pressed }) => [s.playBar, { opacity: pressed ? 0.88 : 1 }]}
          >
            <Text style={s.playGlyph}>{playing ? "■" : "▶"}</Text>
            <Text style={s.playTxt}>{playing ? "Stop" : "Play recording"}</Text>
            {status?.duration ? (
              <Text style={s.playTime}>
                {fmtTime(status.currentTime ?? 0)} / {fmtTime(status.duration)}
              </Text>
            ) : null}
          </Pressable>

          {/* metrics grid */}
          <Text style={s.section}>Analysis</Text>
          <View style={s.grid}>
            {metrics.map((m) => (
              <View key={m.label} style={s.metric}>
                <Text style={s.metricVal}>{m.value}</Text>
                <Text style={s.metricLbl}>{m.label}</Text>
              </View>
            ))}
          </View>

          {/* error counts */}
          {Object.keys(errs).length > 0 && (
            <>
              <Text style={s.section}>Errors</Text>
              <View style={s.chipWrap}>
                {Object.entries(errs)
                  .filter(([, v]) => (v ?? 0) > 0)
                  .sort((x, y) => (y[1] ?? 0) - (x[1] ?? 0))
                  .map(([k, v]) => (
                    <View key={k} style={s.errChip}>
                      <Text style={s.errChipNum}>{v}</Text>
                      <Text style={s.errChipLbl}>{ERR_LABEL[k] ?? k}</Text>
                    </View>
                  ))}
                {Object.values(errs).every((v) => (v ?? 0) === 0) && (
                  <Text style={s.muted}>No errors detected.</Text>
                )}
              </View>
            </>
          )}

          {/* transcript */}
          <Text style={s.section}>Transcript</Text>
          <View style={s.panel}>
            {segs.length === 0 ? (
              <Text style={s.muted}>No transcript available.</Text>
            ) : (
              segs.map((seg, i) => (
                <View key={i} style={[s.segRow, i > 0 && s.segDivider]}>
                  <View style={s.segHead}>
                    <Text style={s.segSpeaker}>{seg.speaker ?? "Speaker"}</Text>
                    <Text style={s.segTime}>{fmtTime(seg.start)}</Text>
                  </View>
                  <Text style={s.segText}>{seg.text}</Text>
                </View>
              ))
            )}
          </View>

          {!!rec.notes && (
            <>
              <Text style={s.section}>Notes</Text>
              <View style={s.panel}>
                <Text style={s.noteTxt}>{rec.notes}</Text>
              </View>
            </>
          )}

          {error && <Text style={[s.errTxt, { marginTop: 12 }]}>{error}</Text>}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}

      {/* ---- first-open review: name + protocol (matches the web app popup) ---- */}
      <Modal visible={reviewOpen} transparent animationType="slide" onRequestClose={() => setReviewOpen(false)}>
        <KeyboardAvoidingView style={s.modalWrap} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={s.modalBackdrop} />
          <View style={s.sheet}>
            <View style={s.sheetGrip} />
            <Text style={s.sheetTitle}>Name this recording</Text>
            <Text style={s.sheetSub}>
              Captured on your recorder. Give it a name and protocol so it files like the rest.
            </Text>

            <Text style={s.fieldLabel}>Recording name *</Text>
            <TextInput
              style={s.input}
              value={rName}
              onChangeText={setRName}
              placeholder="e.g. Jordan — Narrative Sample"
              placeholderTextColor={D.faint}
              autoCapitalize="sentences"
            />
            <Text style={s.fieldLabel}>Protocol *</Text>
            <TextInput
              style={s.input}
              value={rProtocol}
              onChangeText={setRProtocol}
              placeholder="e.g. Narrative Sample, Conversation"
              placeholderTextColor={D.faint}
              autoCapitalize="sentences"
            />
            <Text style={s.fieldLabel}>Notes</Text>
            <TextInput
              style={[s.input, { height: 72, textAlignVertical: "top" }]}
              value={rNote}
              onChangeText={setRNote}
              placeholder="Optional"
              placeholderTextColor={D.faint}
              multiline
              autoCapitalize="sentences"
            />

            <Pressable
              onPress={saveReview}
              disabled={!rName.trim() || !rProtocol.trim() || saving}
              accessibilityRole="button"
              style={({ pressed }) => [
                s.saveBtn,
                { opacity: !rName.trim() || !rProtocol.trim() ? 0.5 : pressed ? 0.88 : 1 },
              ]}
            >
              {saving ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.saveTxt}>Save</Text>}
            </Pressable>
            <Pressable onPress={() => setReviewOpen(false)} hitSlop={8} style={s.skip}>
              <Text style={s.skipTxt}>Skip for now</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  flex: { flex: 1, backgroundColor: D.bg },
  scroll: { flex: 1, backgroundColor: "transparent" },
  content: { padding: 16, paddingBottom: 32 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 56,
    paddingBottom: 8,
  },
  back: { color: D.sky, fontSize: 16, fontWeight: "600", width: 52 },
  brand: { color: D.sub, fontSize: 13, fontWeight: "800", letterSpacing: 2 },

  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  loadingTxt: { color: D.sub, fontSize: 13 },
  errTxt: { color: D.red, fontSize: 13, textAlign: "center", paddingHorizontal: 24 },

  title: { color: D.ink, fontSize: 24, fontWeight: "800", letterSpacing: 0.2 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8, marginBottom: 16 },
  tag: { backgroundColor: D.skyBg, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 3 },
  tagTxt: { color: D.sky, fontSize: 12, fontWeight: "700" },
  metaSub: { color: D.sub, fontSize: 13 },

  playBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: D.panel,
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  playGlyph: { color: D.sky, fontSize: 16, fontWeight: "800" },
  playTxt: { color: D.ink, fontSize: 15, fontWeight: "700", flex: 1 },
  playTime: { color: D.sub, fontSize: 12, fontVariant: ["tabular-nums"] },

  section: { color: D.ink, fontSize: 16, fontWeight: "800", marginTop: 24, marginBottom: 12 },

  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metric: {
    width: "31.5%",
    backgroundColor: D.panel,
    borderWidth: 1,
    borderColor: D.line,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 10,
    alignItems: "flex-start",
  },
  metricVal: { color: D.ink, fontSize: 20, fontWeight: "800" },
  metricLbl: { color: D.sub, fontSize: 11, marginTop: 4 },

  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  errChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: D.amberBg,
    borderRadius: 11,
    paddingHorizontal: 11,
    paddingVertical: 7,
  },
  errChipNum: { color: D.amber, fontSize: 14, fontWeight: "800" },
  errChipLbl: { color: D.amber, fontSize: 12, fontWeight: "600" },

  panel: {
    backgroundColor: D.panel,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: D.line,
    padding: 14,
  },
  segRow: { paddingVertical: 10 },
  segDivider: { borderTopWidth: 1, borderTopColor: D.line },
  segHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  segSpeaker: { color: D.sky, fontSize: 12, fontWeight: "700" },
  segTime: { color: D.faint, fontSize: 11, fontVariant: ["tabular-nums"] },
  segText: { color: D.ink, fontSize: 14, lineHeight: 20 },
  noteTxt: { color: D.ink, fontSize: 14, lineHeight: 20 },
  muted: { color: D.sub, fontSize: 13 },

  // review sheet
  modalWrap: { flex: 1, justifyContent: "flex-end" },
  modalBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    backgroundColor: D.hero,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    borderColor: D.line,
    padding: 20,
    paddingBottom: 34,
  },
  sheetGrip: { width: 40, height: 5, borderRadius: 3, backgroundColor: D.line, alignSelf: "center", marginBottom: 14 },
  sheetTitle: { color: D.ink, fontSize: 20, fontWeight: "800" },
  sheetSub: { color: D.sub, fontSize: 13, marginTop: 4, marginBottom: 16, lineHeight: 18 },
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
  saveBtn: {
    backgroundColor: D.sky,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 8,
  },
  saveTxt: { color: "#FFFFFF", fontSize: 16, fontWeight: "800" },
  skip: { paddingVertical: 12, alignItems: "center", marginTop: 2 },
  skipTxt: { color: D.sub, fontSize: 14, fontWeight: "600" },
});
