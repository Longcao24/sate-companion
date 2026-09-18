import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SateApi } from "../api/sateApi";
import { Button, Card, GlassBackground, Muted, Title } from "../components/ui";
import { PendantDeviceCard } from "../components/PendantDeviceCard";
import { Patient } from "../protocol";
import {
  PendantBattery,
  PendantFoundDevice,
  PendantLink,
  PendantSeenDevice,
} from "../pendant/PendantLink";
import { D } from "../theme";
import { useBottomInset } from "../ui/insets";

// Connect-with-Pendant: scan the SATE Pendant over BLE → connect → stream its
// live PCM audio → on stop, wrap it in a WAV and push it through the SAME upload
// path as a SATE recorder (api.uploadSession → device-api → AI → recordings),
// device_serial `pendant-<id>`.
type Phase = "init" | "scan" | "connecting" | "ready" | "uploading" | "done" | "error";

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export function PendantConnectScreen({
  api,
  pendant,
  onClose,
  onConnected,
  targetId,
}: {
  api: SateApi;
  pendant: PendantLink;
  onClose: () => void;
  /** Called once a pendant is connected, so Home can remember it and show it as
   *  a paired device on the next launch (no re-pairing). */
  onConnected?: (id: string, name: string) => void;
  /** A known pendant's BLE id — connect straight to it instead of scanning.
   *  Falls back to a scan if the direct connect fails (out of range / off). */
  targetId?: string;
}) {
  // Clears the system navigation bar — this build is edge-to-edge.
  const padBottom = useBottomInset(20);
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Record<string, PendantFoundDevice>>({});
  // Every BLE peripheral heard (diagnostics + manual pick when auto-match misses).
  const [seen, setSeen] = useState<Record<string, PendantSeenDevice>>({});
  // BLE adapter state, surfaced on screen (PoweredOn / Unauthorized / PoweredOff…).
  const [bleState, setBleState] = useState<string>("starting…");
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState("SATE Pendant");
  const [battery, setBattery] = useState<PendantBattery | null>(null);
  const [recording, setRecording] = useState(false);
  const [capturedMs, setCapturedMs] = useState(0);
  const [quiet, setQuiet] = useState(false);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<string | null>(null);
  // Auto-upload: when on, stopping a recording sends it to SATE automatically
  // (no separate "upload" tap), same as the Plaud flow.
  const [autoUpload, setAutoUpload] = useState(true);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);

  const scanning = useRef(false);
  const lastAudioAt = useRef(0);

  // 1. Permissions → scan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await pendant.requestPermissions();
        api.listPatients().then((p) => !cancelled && setPatients(p)).catch(() => {});
        if (cancelled) return;

        // Known pendant → connect straight to it, no scan. If it's out of range
        // or off, fall through to a normal scan so the user can still find it.
        if (targetId) {
          setPhase("connecting");
          try {
            await pendant.connect(targetId);
            if (cancelled) return;
            setConnectedId(targetId);
            onConnected?.(targetId, connectedName);
            setPhase("ready");
            return;
          } catch {
            if (cancelled) return;
            // couldn't reach it directly — scan instead
          }
        }

        setPhase("scan");
        scanning.current = true;
        pendant.startScan(
          (d) => setFound((prev) => ({ ...prev, [d.id]: d })),
          (sd) => setSeen((prev) => ({ ...prev, [sd.id]: sd })),
          (st) => setBleState(st)
        );
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "Could not start Bluetooth");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (scanning.current) pendant.stopScan();
      pendant.disconnect().catch(() => {});
    };
  }, [api, pendant, targetId]);

  // Battery + live audio (nap-aware: a gap while connected is normal, not error).
  useEffect(() => {
    const bs = pendant.onBattery(setBattery);
    const as = pendant.onAudio(() => {
      lastAudioAt.current = Date.now();
      setQuiet(false);
      setCapturedMs(pendant.capturedMs());
    });
    return () => {
      bs.remove();
      as.remove();
    };
  }, [pendant]);

  // While recording, tick the duration + flag "quiet" (pendant naps in silence).
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      setCapturedMs(pendant.capturedMs());
      setQuiet(Date.now() - lastAudioAt.current > 2500);
    }, 1000);
    return () => clearInterval(t);
  }, [recording, pendant]);

  const onPickDevice = useCallback(
    async (d: PendantFoundDevice) => {
      if (scanning.current) {
        pendant.stopScan();
        scanning.current = false;
      }
      setPhase("connecting");
      try {
        await pendant.connect(d.id);
        setConnectedId(d.id);
        setConnectedName(d.name);
        onConnected?.(d.id, d.name);
        setPhase("ready");
      } catch (e: any) {
        setError(e?.message ?? "Connection failed");
        setPhase("error");
      }
    },
    [pendant]
  );

  // Manual pick from the diagnostics list (auto-match missed it).
  const onPickSeen = useCallback(
    (sd: PendantSeenDevice) =>
      onPickDevice({ id: sd.id, name: sd.name ?? "SATE Pendant", rssi: sd.rssi }),
    [onPickDevice]
  );

  // Build the WAV from what's captured and push it through the SATE pipeline.
  // goDone=true finishes the screen (manual "Stop & upload"); goDone=false is the
  // silent auto-upload after a Stop — it stays on the recorder, just shows status.
  const uploadTake = useCallback(
    async (goDone: boolean) => {
      if (!connectedId) return;
      const take = pendant.takeWav();
      if (take.bytes <= 44) {
        if (goDone) {
          setError("No audio captured yet — record something first.");
          setPhase("error");
        }
        return;
      }
      if (goDone) setPhase("uploading");
      else setAutoStatus("Auto-uploading…");
      try {
        await api.uploadSession({
          device_serial: `pendant-${connectedId}`,
          patient_id: patientId || "Unassigned",
          session_number: Math.floor(Date.now() / 1000),
          sample_rate: take.sampleRate,
          wav_base64: take.wavBase64,
        });
        if (goDone) setPhase("done");
        else setAutoStatus("Uploaded to SATE ✓");
      } catch (e: any) {
        if (goDone) {
          setError(e?.message ?? "Upload failed");
          setPhase("error");
        } else {
          setAutoStatus("Auto-upload failed — tap “Stop & upload” to retry.");
        }
      }
    },
    [api, pendant, connectedId, patientId]
  );

  const onToggleRecord = useCallback(async () => {
    try {
      if (recording) {
        await pendant.stop();
        setRecording(false);
        // Auto-upload the take on stop (no separate tap needed).
        if (autoUpload) await uploadTake(false);
      } else {
        pendant.takeWav(); // clear any stale buffer
        setCapturedMs(0);
        setAutoStatus(null);
        lastAudioAt.current = Date.now();
        await pendant.start();
        setRecording(true);
      }
    } catch (e: any) {
      setError(e?.message ?? "Recording control failed");
      setPhase("error");
    }
  }, [pendant, recording, autoUpload, uploadTake]);

  // Manual finish: stop if needed → build WAV → upload → done screen.
  const onSync = useCallback(async () => {
    if (!connectedId) return;
    try {
      if (recording) {
        await pendant.stop();
        setRecording(false);
      }
      await uploadTake(true);
    } catch (e: any) {
      setError(e?.message ?? "Upload failed");
      setPhase("error");
    }
  }, [connectedId, recording, pendant, uploadTake]);

  const foundList = useMemo(() => Object.values(found), [found]);
  const seenList = useMemo(
    () => Object.values(seen).sort((a, b) => b.rssi - a.rssi),
    [seen]
  );

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={[s.container, { paddingBottom: padBottom }]}>
        <View style={s.header}>
          <Title>Connect with Pendant</Title>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={s.close}>Close</Text>
          </Pressable>
        </View>

        {phase === "init" && <Muted>Preparing Bluetooth…</Muted>}

        {phase === "scan" && (
          <Card>
            <Text style={s.sectionTitle}>Nearby pendants</Text>
            <Muted>Power on your SATE Pendant to pair.</Muted>
            {foundList.length === 0 ? (
              <Text style={s.dim}>Scanning…</Text>
            ) : (
              foundList.map((d) => (
                <Pressable key={d.id} onPress={() => onPickDevice(d)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{d.name}</Text>
                    <Text style={s.dim}>{d.rssi} dBm</Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {/* On-screen BLE diagnostics — no Metro console needed. Shows whether the
            phone is hearing ANY Bluetooth at all, and lets you tap the pendant
            manually if auto-match misses it. */}
        {phase === "scan" && (
          <Card>
            <Text style={s.sectionTitle}>Bluetooth diagnostics</Text>
            <Text style={s.dim}>Radio: {bleState}</Text>
            <Muted>
              {seenList.length} device{seenList.length === 1 ? "" : "s"} seen nearby.
            </Muted>
            {seenList.length === 0 && (
              <Text style={s.dim}>
                Hearing NO Bluetooth at all — the radio is blocked or permission
                is off. Fully quit the app (swipe it away) and reopen, then check
                iOS Settings → this app → Bluetooth.
              </Text>
            )}
            {seenList.length > 0 && foundList.length === 0 && (
              <Text style={[s.dim, { marginTop: 4 }]}>
                Pendant not auto-detected. Tap it below — look for “SATE Pendant”
                or a row marked “audio ✓”.
              </Text>
            )}
            {seenList.length > 0 &&
              foundList.length === 0 &&
              seenList.map((sd) => (
                <Pressable key={sd.id} onPress={() => onPickSeen(sd)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>
                      {sd.name ?? "(no name)"}
                      {sd.hasAudioService ? "  · audio ✓" : ""}
                    </Text>
                    <Text style={s.dim}>{sd.rssi} dBm</Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))}
          </Card>
        )}

        {phase === "connecting" && (
          <Card>
            <Text style={s.sectionTitle}>Connecting…</Text>
          </Card>
        )}

        {(phase === "ready" || phase === "uploading") && (
          <>
            <Card>
              <View style={s.rowBetween}>
                <Text style={s.sectionTitle}>{connectedName}</Text>
                {battery && (
                  <Text style={s.dim}>
                    🔋 {battery.percent}%{battery.charging ? " ⚡" : ""}
                  </Text>
                )}
              </View>
              <View style={{ alignItems: "center", marginVertical: 6 }}>
                <PendantDeviceCard width={130} />
              </View>

              <Muted>
                {recording
                  ? quiet
                    ? "Listening… (quiet — the pendant naps in silence, this is normal)"
                    : "Recording live audio from the pendant…"
                  : "Press record to start streaming the pendant's mic."}
              </Muted>

              <Text style={s.dur}>{fmtDur(capturedMs)}</Text>

              <Pressable
                onPress={onToggleRecord}
                accessibilityRole="button"
                style={({ pressed }) => [
                  s.recBtn,
                  { backgroundColor: recording ? D.red : D.sky, opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Text style={s.recTxt}>{recording ? "■  Stop" : "●  Start recording"}</Text>
              </Pressable>

              {/* Auto-upload: on = stopping a recording sends it to SATE with no
                  extra tap (same as the Plaud flow). */}
              <Pressable
                onPress={() => setAutoUpload((v) => !v)}
                accessibilityRole="switch"
                accessibilityState={{ checked: autoUpload }}
                style={s.autoRow}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName}>Auto-upload on stop</Text>
                  <Text style={s.dim}>
                    Send the take to SATE automatically when you stop recording.
                  </Text>
                </View>
                <View style={[s.toggle, autoUpload && s.toggleOn]}>
                  <View style={[s.knob, autoUpload && s.knobOn]} />
                </View>
              </Pressable>

              {autoStatus && <Text style={s.autoStatus}>{autoStatus}</Text>}

              <Pressable
                onPress={() => pendant.findMe().catch(() => {})}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={s.findMe}>Flash the pendant LED (find it) ›</Text>
              </Pressable>
            </Card>

            {/* Optional — assign a patient now, or leave it and tag the recording
                later on the web report (it uploads as Standalone until then). */}
            <Card>
              <Text style={s.sectionTitle}>Assign to patient (optional)</Text>
              <Muted>Leave blank to sort it out later — it saves as Standalone.</Muted>
              <FlatList
                data={patients}
                scrollEnabled={false}
                keyExtractor={(p) => p.patient_id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() =>
                      setPatientId((cur) => (cur === item.patient_id ? null : item.patient_id))
                    }
                    style={[s.patRow, patientId === item.patient_id && s.patRowOn]}
                  >
                    <Text style={s.rowName}>{item.patient_id}</Text>
                    <Text style={s.dim}>{item.name}</Text>
                  </Pressable>
                )}
                ListEmptyComponent={<Text style={s.dim}>No patients yet.</Text>}
              />
            </Card>

            <Button
              title={phase === "uploading" ? "Uploading…" : "Stop & upload to SATE"}
              onPress={onSync}
              disabled={phase === "uploading" || (capturedMs === 0 && !recording)}
            />
          </>
        )}

        {phase === "done" && (
          <Card>
            <Text style={s.sectionTitle}>Done</Text>
            <Muted>
              Recording uploaded. It'll appear on your home screen once processed.
            </Muted>
            <Button title="Back to home" onPress={onClose} />
          </Card>
        )}

        {phase === "error" && (
          <Card>
            <Text style={[s.sectionTitle, { color: D.red }]}>Something went wrong</Text>
            <Muted>{error}</Muted>
            <Button title="Close" onPress={onClose} />
          </Card>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { padding: 20, paddingTop: 64, gap: 16 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  close: { color: D.sub, fontSize: 15 },
  sectionTitle: { color: D.ink, fontSize: 16, fontWeight: "600", marginBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
  },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  patRow: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: D.line,
    marginTop: 8,
  },
  patRowOn: { borderColor: D.sky, backgroundColor: D.skyBg },
  rowName: { color: D.ink, fontSize: 15, fontWeight: "500" },
  dim: { color: D.sub, fontSize: 13, marginTop: 2 },
  chev: { color: D.sub, fontSize: 22 },
  dur: { color: D.ink, fontSize: 34, fontWeight: "800", textAlign: "center", marginVertical: 10 },
  recBtn: {
    marginTop: 4,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  recTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  findMe: { color: D.sub, fontSize: 14, textAlign: "center", paddingVertical: 12 },
  autoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
  },
  toggle: {
    width: 46,
    height: 28,
    borderRadius: 14,
    backgroundColor: D.line,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: D.sky },
  knob: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#FFFFFF" },
  knobOn: { alignSelf: "flex-end" },
  autoStatus: { color: D.sky, fontSize: 13, fontWeight: "600", marginTop: 10 },
});
