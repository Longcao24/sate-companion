import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SateApi } from "../api/sateApi";
import { Button, Card, GlassBackground, Muted, ProgressBar, Title } from "../components/ui";
import { PlaudDeviceCard } from "../components/PlaudDeviceCard";
import { Patient } from "../protocol";
import { PlaudFile, PlaudFoundDevice, PlaudLink, plaudUserId } from "../plaud/PlaudLink";
import { useStore } from "../store";
import { D } from "../theme";

// Connect-with-Plaud: mint a token → scan/connect a Plaud device over BLE →
// list its recordings → pull each as WAV and push it through the SAME upload
// path as a SATE recorder (api.uploadSession → device-api → AI → recordings).
type Phase = "init" | "scan" | "connecting" | "files" | "syncing" | "done" | "error";

// Flag offset (ms into the take) → "m:ss". UNVERIFIED unit — see PlaudLink.
function fmtOffset(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export function PlaudConnectScreen({
  api,
  plaud,
  targetSn,
  onClose,
  onOpenSettings,
}: {
  api: SateApi;
  plaud: PlaudLink;
  /** When set, auto-reconnect this specific paired Plaud (multi-device). When
   *  absent, show the scan list to pair/pick a device. */
  targetSn?: string;
  onClose: () => void;
  onOpenSettings: (sn: string, deviceName: string) => void;
}) {
  const { settings } = useStore();
  const userId = settings.user?.id ?? "";

  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Record<string, PlaudFoundDevice>>({});
  const [connectedSn, setConnectedSn] = useState<string | null>(null);
  const [connectedName, setConnectedName] = useState<string>("Plaud device");
  const [files, setFiles] = useState<PlaudFile[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState("");
  const [recording, setRecording] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Flag markers for the current take, streamed live as the user taps the Plaud.
  const [liveMarks, setLiveMarks] = useState<number[]>([]);
  // The specific paired Plaud we were asked to reconnect (multi-device): show
  // its design + auto-connect on entry instead of a scan list. Null when opened
  // to pair/pick a new one. `manualScan` falls back to the picker.
  const [known] = useState<{ sn: string; name: string } | null>(() =>
    targetSn ? plaud.knownDevices().find((d) => d.sn === targetSn) ?? null : null
  );
  const [manualScan, setManualScan] = useState(false);
  // Auto-upload: push each recording to SATE the instant it finishes (device
  // button OR app), no manual "Sync" tap. Default on.
  const [autoUpload, setAutoUpload] = useState(true);
  const [autoStatus, setAutoStatus] = useState<string | null>(null);

  const scanning = useRef(false);
  // Latest values the record-state callback needs without re-subscribing.
  const patientIdRef = useRef<string | null>(null);
  const connectedSnRef = useRef<string | null>(null);
  const autoUploadRef = useRef(true);
  // Guards a session from being uploaded twice (auto + manual racing).
  const uploadingRef = useRef<Set<number>>(new Set());
  // Set when navigating to Plaud settings: the unbind there NEEDS the live
  // connection (depair requires a connected device), so unmount must not drop it.
  const keepConnection = useRef(false);
  // Auto-connect: fire once, to the first scanned device already bound to this
  // account. pickRef lets the scan callback reach the latest onPickDevice.
  const autoTried = useRef(false);
  const pickRef = useRef<(d: PlaudFoundDevice) => void>(() => {});

  // 1. Mint the Plaud token + init the SDK, then start scanning.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { token } = await api.getPlaudToken();
        if (cancelled) return;
        await plaud.initSdk(token);
        api.listPatients().then((p) => !cancelled && setPatients(p)).catch(() => {});
        if (cancelled) return;
        setPhase("scan");
        // Plaud's own template waits ~2s here too (SceneDelegate's
        // sceneDidBecomeActive comment: "BLE power-on time") — initSdk's RSA
        // key exchange is async; calling startScan before it lands, as we
        // were doing, fires before the SDK is actually ready and finds
        // nothing. Confirmed on-device: our startScan() log printed BEFORE
        // "RSA key pair obtained and stored".
        await new Promise((r) => setTimeout(r, 2000));
        if (cancelled) return;
        scanning.current = true;
        plaud.startScan((d) => {
          setFound((prev) => ({ ...prev, [d.id]: d }));
          // Auto-connect only to the SPECIFIC device we were asked to reconnect
          // (multi-device: Home passes its serial). Still gated on this account
          // owning the binding. With no target (pair/pick flow) we never
          // auto-connect — the user chooses from the scan list.
          if (
            !autoTried.current &&
            d.sn &&
            targetSn &&
            d.sn === targetSn &&
            plaud.bindingOwner(d.sn) === userId
          ) {
            autoTried.current = true;
            pickRef.current(d);
          }
        });
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "Could not start Plaud");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (scanning.current) plaud.stopScan();
      // Keep the link alive when heading to Plaud settings — unbind needs it.
      if (!keepConnection.current) plaud.disconnect().catch(() => {});
    };
  }, [api, plaud]);

  const onPickDevice = useCallback(
    async (d: PlaudFoundDevice) => {
      // Device-lock guard: never bind a device that is already bound to another
      // SATE account — re-binding under a new identity can permanently lock it.
      const owner = plaud.bindingOwner(d.sn);
      if (owner && owner !== userId) {
        setError(
          `This Plaud (SN ${d.sn}) is already linked to another SATE account. ` +
            `Unlink it there first — re-binding it here could lock the device.`
        );
        setPhase("error");
        return;
      }
      if (scanning.current) {
        plaud.stopScan();
        scanning.current = false;
      }
      setPhase("connecting");
      setStatusLine(`Connecting to ${d.name}…`);
      try {
        // Always the account-derived stable identity — matches the minted token
        // and is restored on login, so a reinstall reconnects (never re-binds).
        await plaud.connect(d.id, plaudUserId(userId));
        plaud.recordBinding(userId, d.sn); // idempotent; persisted to Keychain
        plaud.rememberDevice(d.sn, d.name); // show + auto-reconnect next open
        setConnectedSn(d.sn);
        setConnectedName(d.name);
        setStatusLine("Reading recordings…");
        const list = await plaud.listFiles();
        setFiles(list);
        setPhase("files");
      } catch (e: any) {
        setError(e?.message ?? "Connection failed");
        setPhase("error");
      }
    },
    [plaud, userId]
  );
  // Keep the scan-callback's auto-connect pointing at the latest handler.
  pickRef.current = onPickDevice;
  // Mirror latest state into refs the record-state callback reads.
  patientIdRef.current = patientId;
  connectedSnRef.current = connectedSn;
  autoUploadRef.current = autoUpload;

  // Upload one recording: export → uploadSession → delete from device. Guarded
  // so the same session can't be sent twice (auto-upload vs a manual Sync tap).
  // Shared by both paths so patient tag + flags stay identical.
  const uploadOne = useCallback(
    async (f: PlaudFile, onProgress?: (p: number) => void) => {
      const sn = connectedSnRef.current;
      if (!sn || uploadingRef.current.has(f.sessionId)) return;
      uploadingRef.current.add(f.sessionId);
      try {
        const wav = await plaud.exportWav(f.sessionId, onProgress);
        await api.uploadSession({
          device_serial: `plaud-${sn}`,
          // Auto-upload may fire before a patient is chosen — tag "Unassigned"
          // so the audio still reaches SATE; reassign later on the web report.
          patient_id: patientIdRef.current || "Unassigned",
          session_number: f.sessionId,
          sample_rate: wav.sampleRate,
          wav_base64: wav.wavBase64,
          flags: wav.markOffsets.length ? wav.markOffsets : undefined,
        });
        await plaud.deleteFile(f.sessionId); // only after the server confirmed
        setFiles((prev) => prev.filter((x) => x.sessionId !== f.sessionId));
      } finally {
        uploadingRef.current.delete(f.sessionId);
      }
    },
    [api, plaud]
  );

  // 2. Manual "Sync all": pull every recording → upload → delete from device.
  const onSync = useCallback(async () => {
    if (!connectedSn || files.length === 0) return;
    const batch = [...files];
    setPhase("syncing");
    try {
      for (let i = 0; i < batch.length; i++) {
        setStatusLine(`Recording ${i + 1} of ${batch.length}`);
        setProgress(0);
        await uploadOne(batch[i], (p) => setProgress(p / 100));
      }
      setPhase("done");
    } catch (e: any) {
      setError(e?.message ?? "Sync failed");
      setPhase("error");
    }
  }, [uploadOne, files, connectedSn]);

  // Track record state from the device (works whether recording is started
  // from the app OR the device's own button). When a recording stops, refresh
  // the file list and — if auto-upload is on — push the new recording(s) to
  // SATE immediately, no manual Sync tap.
  useEffect(() => {
    const sub = plaud.onRecordState((state) => {
      setRecording(state === "recording" || state === "resumed");
      if (state === "recording") setLiveMarks([]); // fresh take
      if (state === "stopped") {
        // Give the device a moment to finalize the file, then refetch + upload.
        setTimeout(async () => {
          try {
            const list = await plaud.refreshFiles();
            setFiles(list);
            if (!autoUploadRef.current) return;
            for (const f of list) {
              setAutoStatus(`Uploading ${f.name}…`);
              await uploadOne(f);
            }
            setAutoStatus("Uploaded to SATE ✓");
            setTimeout(() => setAutoStatus(null), 2500);
          } catch {
            setAutoStatus(null);
          }
        }, 1500);
      }
    });
    return () => sub.remove();
  }, [plaud, uploadOne]);

  // Live flag markers: fires as the user taps the mark button ON the Plaud
  // during a recording (polled natively — no real-time push in the SDK).
  useEffect(() => {
    const sub = plaud.onMark((_sid, _count, offsets) => setLiveMarks(offsets));
    return () => sub.remove();
  }, [plaud]);

  const onToggleRecord = useCallback(() => {
    if (recording) {
      plaud.stopRecord();
      setRecording(false);
    } else {
      setLiveMarks([]);
      plaud.startRecord();
      setRecording(true);
    }
  }, [plaud, recording]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      setFiles(await plaud.refreshFiles());
    } catch {
      /* leave existing list */
    } finally {
      setRefreshing(false);
    }
  }, [plaud]);

  const foundList = useMemo(() => Object.values(found), [found]);

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.header}>
          <Title>Connect with Plaud</Title>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={s.close}>Close</Text>
          </Pressable>
        </View>

        {phase === "init" && <Muted>Preparing Plaud…</Muted>}

        {phase === "scan" && known && !manualScan && (
          <Card>
            <View style={s.reconnectBox}>
              <PlaudDeviceCard width={168} />
              <Text style={s.sectionTitle}>Reconnecting to {known.name}…</Text>
              <Muted>Your paired Plaud connects automatically — no need to tap Connect.</Muted>
              <Pressable onPress={() => setManualScan(true)} hitSlop={8} accessibilityRole="button">
                <Text style={s.headerLink}>Pair a different Plaud</Text>
              </Pressable>
            </View>
          </Card>
        )}

        {phase === "scan" && (!known || manualScan) && (
          <Card>
            <Text style={s.sectionTitle}>Nearby Plaud devices</Text>
            <Muted>Power on your Plaud NotePin S or NotePro to pair.</Muted>
            {foundList.length === 0 ? (
              <Text style={s.dim}>Scanning…</Text>
            ) : (
              foundList.map((d) => (
                <Pressable key={d.id} onPress={() => onPickDevice(d)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{d.name}</Text>
                    <Text style={s.dim}>SN {d.sn} · {d.rssi} dBm</Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {phase === "connecting" && (
          <Card>
            <View style={s.reconnectBox}>
              <PlaudDeviceCard width={148} />
              <Text style={s.sectionTitle}>{statusLine}</Text>
            </View>
          </Card>
        )}

        {phase === "files" && (
          <>
            {/* Record control: drive the Plaud from the app, OR just use the
                device's own button — either way the recording lands here. */}
            <Card>
              <Text style={s.sectionTitle}>
                {recording ? "Recording on device…" : "Record"}
              </Text>
              <Muted>
                Start/stop from here, or press the button on the Plaud itself.
                Tap the Plaud while recording to flag a moment — it becomes a
                tick on the report, same as the SATE recorder's flag button.
                New recordings upload automatically when finished.
              </Muted>
              <Pressable
                onPress={onToggleRecord}
                accessibilityRole="button"
                style={({ pressed }) => [
                  s.recBtn,
                  { backgroundColor: recording ? D.red : D.sky, opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Text style={s.recTxt}>{recording ? "■  Stop recording" : "●  Start recording"}</Text>
              </Pressable>

              {/* Auto-upload: when on, every finished recording is pushed to
                  SATE immediately — no manual Sync tap. */}
              <Pressable
                onPress={() => setAutoUpload((v) => !v)}
                accessibilityRole="switch"
                accessibilityState={{ checked: autoUpload }}
                style={s.autoRow}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowName}>Auto-upload to SATE</Text>
                  <Text style={s.dim}>
                    {autoUpload
                      ? "New recordings upload the moment they finish"
                      : "Off — use “Sync” below to upload manually"}
                  </Text>
                </View>
                <View style={[s.toggle, autoUpload && s.toggleOn]}>
                  <View style={[s.knob, autoUpload && s.knobOn]} />
                </View>
              </Pressable>
              {autoStatus && <Text style={[s.dim, { color: D.sky, marginTop: 8 }]}>{autoStatus}</Text>}

              {/* Live flags: each tap on the Plaud during the take shows here. */}
              {(recording || liveMarks.length > 0) && (
                <View style={s.flagBox}>
                  <View style={s.rowBetween}>
                    <Text style={s.flagTitle}>
                      🚩 {liveMarks.length} flag{liveMarks.length === 1 ? "" : "s"}
                    </Text>
                    {recording && <Text style={s.dim}>tap the Plaud to flag</Text>}
                  </View>
                  {liveMarks.length > 0 && (
                    <View style={s.flagChips}>
                      {liveMarks.map((ms, i) => (
                        <Text key={`${ms}-${i}`} style={s.flagChip}>{fmtOffset(ms)}</Text>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </Card>

            <Card>
              <View style={s.rowBetween}>
                <Text style={s.sectionTitle}>
                  {files.length} recording{files.length === 1 ? "" : "s"} on device
                </Text>
                <Pressable onPress={onRefresh} hitSlop={8} accessibilityRole="button">
                  <Text style={s.headerLink}>{refreshing ? "Refreshing…" : "Refresh"}</Text>
                </Pressable>
              </View>
              {files.length === 0 ? (
                <Muted>No recordings yet. Record above, then Refresh.</Muted>
              ) : (
                files.map((f) => (
                  <View key={f.sessionId} style={s.fileRow}>
                    <Text style={s.rowName}>{f.name}</Text>
                    <Text style={s.dim}>
                      {f.penCount > 0 ? `🚩 ${f.penCount} · ` : ""}{Math.round(f.durationSec)}s
                    </Text>
                  </View>
                ))
              )}
            </Card>
            <Card>
              <Text style={s.sectionTitle}>Assign to patient</Text>
              <FlatList
                data={patients}
                horizontal={false}
                scrollEnabled={false}
                keyExtractor={(p) => p.patient_id}
                renderItem={({ item }) => (
                  <Pressable
                    onPress={() => setPatientId(item.patient_id)}
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
              title={files.length ? `Sync ${files.length} to SATE now` : "Nothing to sync"}
              onPress={onSync}
              disabled={files.length === 0}
            />
            <Pressable
              onPress={() => {
                if (!connectedSn) return;
                keepConnection.current = true; // settings' unbind needs the link
                onOpenSettings(connectedSn, connectedName);
              }}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={s.settingsLink}>Device settings (unbind) ›</Text>
            </Pressable>
          </>
        )}

        {phase === "syncing" && (
          <Card>
            <Text style={s.sectionTitle}>{statusLine}</Text>
            <ProgressBar value={progress} />
            <Muted>Uploading to SATE — transcription runs automatically.</Muted>
          </Card>
        )}

        {phase === "done" && (
          <Card>
            <Text style={s.sectionTitle}>Done</Text>
            <Muted>
              {files.length} recording{files.length === 1 ? "" : "s"} uploaded. They'll
              appear on your home screen once processed.
            </Muted>
            <Button title="Back to home" onPress={onClose} />
          </Card>
        )}

        {phase === "error" && (
          <Card>
            <Text style={[s.sectionTitle, { color: D.red }]}>
              Something went wrong
            </Text>
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
  fileRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
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
  settingsLink: { color: D.sub, fontSize: 15, textAlign: "center", paddingVertical: 8 },
  headerLink: { color: D.sky, fontSize: 14, fontWeight: "600" },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  recBtn: {
    marginTop: 12,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  recTxt: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  autoRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
  },
  toggle: {
    width: 48,
    height: 28,
    borderRadius: 14,
    backgroundColor: D.line,
    padding: 3,
    justifyContent: "center",
  },
  toggleOn: { backgroundColor: D.sky },
  knob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#FFFFFF",
  },
  knobOn: { alignSelf: "flex-end" },
  flagBox: {
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: D.line,
  },
  reconnectBox: { alignItems: "center", gap: 10, paddingVertical: 8 },
  flagTitle: { color: D.ink, fontSize: 15, fontWeight: "700" },
  flagChips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  flagChip: {
    color: D.ink,
    fontSize: 13,
    fontWeight: "600",
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: D.line,
    overflow: "hidden",
  },
});
