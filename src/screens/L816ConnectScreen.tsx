import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SateApi } from "../api/sateApi";
import { Button, Card, GlassBackground, Muted, ProgressBar, Title } from "../components/ui";
import { Patient } from "../protocol";
import {
  L816File,
  L816FoundDevice,
  L816Link,
  L816Progress,
  L816SeenDevice,
  L816Take,
  L816_DISPLAY_NAME,
  l816Serial,
  takeTimestamp,
} from "../l816/L816Link";
import {
  isBackgroundLinkSupported,
  notifyOnce,
  startBackgroundLink,
  stopBackgroundLink,
} from "../../modules/sate-fgservice";
import { D } from "../theme";

// Connect-with-SATE-L816: find the recorder over BLE -> connect -> drive its record
// button from the phone -> pull the finished take off the device -> decode the
// ASC-VI frames to a WAV -> push it through the SAME upload path as everything
// else (api.uploadSession -> device-api -> AI -> recordings), device_serial
// `l816-<mac>`.
//
// The shape deliberately matches PendantConnectScreen, but the DEVICE is a very
// different animal and the differences are the interesting part:
//
//   * The L816 records to its OWN storage, not to a live stream. Stopping is not
//     the end of the take — the transfer afterwards is, and it can take longer
//     than the recording did. So "Stop" and "uploaded" are separate states here.
//   * It keeps recording with the app closed or out of range, which is why
//     reconnecting can land straight in a recording state rather than idle.
//   * Everything already on the device is listed and downloadable, so a take
//     that failed to upload is never lost — it is still on the hardware.
//   * THE RECORD BUTTON ON THE DEVICE IS A FIRST-CLASS WAY TO RECORD. A take
//     started by the hardware button, phone in a pocket, is the one the user
//     cares about most — so the link watches for it (`onDeviceEvent`) and this
//     screen downloads and uploads it with no tap at all.
//   * AND THAT HAS TO KEEP WORKING WITH THE APP CLOSED, or it only works in the
//     one situation the user is least likely to be in — staring at the screen.
//     Android stops scheduling a backgrounded app, which kills the 3 s poll, so
//     while a device is connected we run an Android foreground service
//     (modules/sate-fgservice) purely to keep the process alive. That service's
//     ongoing notification is not decoration: Android requires it, and it is
//     also the user's only status readout while they are elsewhere.

type Phase = "init" | "scan" | "connecting" | "ready" | "busy" | "done" | "error";

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

/**
 * Android 13+ gates the ongoing notification behind runtime consent — and a
 * foreground service without a visible notification is not something Android
 * allows. Declining does not break recording; it costs the background link, so
 * ask once and carry on either way.
 */
async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS !== "android" || Platform.Version < 33) return true;
  try {
    const res = await PermissionsAndroid.request(
      "android.permission.POST_NOTIFICATIONS" as any
    );
    return res === "granted";
  } catch {
    return false;
  }
}

/** `01_20260915145726` -> `15 Sep, 14:57`. Thirteen digits is not a name. */
function fmtTakeName(name: string): string {
  const t = takeTimestamp(name);
  return new Date(t * 1000).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function L816ConnectScreen({
  api,
  l816,
  onClose,
  onConnected,
  targetId,
}: {
  api: SateApi;
  l816: L816Link;
  onClose: () => void;
  /** Called once connected, so Home can remember it and show it as a paired
   *  device on the next launch (no re-scanning). */
  onConnected?: (id: string, name: string) => void;
  /** A known L816's BLE id — connect straight to it instead of scanning. Falls
   *  back to a scan if the direct connect fails (out of range / off). */
  targetId?: string;
}) {
  const [phase, setPhase] = useState<Phase>("init");
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<Record<string, L816FoundDevice>>({});
  const [seen, setSeen] = useState<Record<string, L816SeenDevice>>({});
  const [bleState, setBleState] = useState<string>("starting…");

  const [connectedId, setConnectedId] = useState<string | null>(null);
  // The PRODUCT name, not the advertised one. The hardware calls itself `L816`;
  // in SATE it is a SATE L816, and that is what Home remembers it as.
  const [connectedName] = useState(L816_DISPLAY_NAME);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [files, setFiles] = useState<L816File[]>([]);
  const [progress, setProgress] = useState<L816Progress | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientId, setPatientId] = useState<string | null>(null);

  const scanning = useRef(false);
  // When the take started, by the phone's clock. The device does not report
  // elapsed time, and on a reconnect-into-a-running-take we genuinely do not
  // know when it began — the timer then counts from the reconnect, and says so.
  const startedAt = useRef<number | null>(null);
  const resumed = useRef(false);

  // ---- background link -----------------------------------------------------
  // Is the app currently out of sight? Only used to decide whether a finished
  // transfer deserves a notification: interrupting someone who is already
  // looking at the result is noise.
  const backgrounded = useRef(AppState.currentState !== "active");
  useEffect(() => {
    const sub = AppState.addEventListener("change", (st) => {
      backgrounded.current = st !== "active";
    });
    return () => sub.remove();
  }, []);

  // The ongoing notification is the ONLY status a user gets while elsewhere, so
  // keep it honest and current. Throttled: BLE delivers a download notification
  // every few milliseconds and re-rendering the notification that often is both
  // wasteful and visibly janky in the shade.
  // Read through refs: bgStatus is called from callbacks that must not be
  // re-created (and re-subscribed) every time a name or id changes.
  const connectedIdRef = useRef<string | null>(null);
  const connectedNameRef = useRef(L816_DISPLAY_NAME);

  const lastNotif = useRef(0);
  const bgStatus = useCallback(
    (text: string, percent?: number, force = false) => {
      if (!connectedIdRef.current) return;
      const now = Date.now();
      if (!force && now - lastNotif.current < 1000) return;
      lastNotif.current = now;
      startBackgroundLink(connectedNameRef.current, text, percent);
    },
    []
  );


  // 1. Permissions -> connect to a known unit, or scan.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await l816.requestPermissions();
        api.listPatients().then((p) => !cancelled && setPatients(p)).catch(() => {});
        if (cancelled) return;

        if (targetId) {
          setPhase("connecting");
          try {
            await l816.connect(targetId);
            if (cancelled) return;
            await afterConnect(targetId);
            return;
          } catch {
            if (cancelled) return;
            // Out of range or off — fall through to a scan.
          }
        }

        setPhase("scan");
        scanning.current = true;
        l816.startScan(
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
      if (scanning.current) l816.stopScan();
      l816.disconnect().catch(() => {});
      // Leaving the screen drops the link, so the notification must go with it —
      // one that outlives the connection it describes is a lie.
      connectedIdRef.current = null;
      stopBackgroundLink();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, l816, targetId]);

  // Tick the on-screen duration while a take runs.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      setElapsedMs(startedAt.current ? Date.now() - startedAt.current : 0);
    }, 500);
    return () => clearInterval(t);
  }, [recording]);

  const afterConnect = useCallback(
    async (id: string) => {
      setConnectedId(id);
      connectedIdRef.current = id;
      connectedNameRef.current = L816_DISPLAY_NAME;
      onConnected?.(id, L816_DISPLAY_NAME);
      // Keep the process alive from here on. Without this the 3 s poll — and so
      // the whole detect-a-take-started-on-the-device feature — stops the moment
      // the user leaves the screen.
      if (isBackgroundLinkSupported()) {
        await requestNotificationPermission();
        bgStatus("Connected · waiting for a recording", undefined, true);
      }
      // The device may have been recording all along — it does not stop because
      // the app went away. Pick the state up rather than assuming idle.
      const live = l816.isRecording();
      resumed.current = live;
      setRecording(live);
      if (live) bgStatus("Recording on the device", undefined, true);
      startedAt.current = live ? Date.now() : null;
      setElapsedMs(0);
      setPhase("ready");
      // Don't list while a take is running: the device refuses a list mid-record,
      // and the answer would be stale the moment it stops anyway. The list is
      // refreshed after Stop, and there's a Refresh button.
      if (live) {
        setFiles([]);
        return;
      }
      // Listing is best-effort: a device with recordings we cannot enumerate is
      // still usable for a NEW take, so don't fail the whole screen on it.
      try {
        setFiles(await l816.listFiles());
      } catch {
        setFiles([]);
      }
    },
    [l816, onConnected]
  );

  const onPickDevice = useCallback(
    async (d: L816FoundDevice) => {
      if (scanning.current) {
        l816.stopScan();
        scanning.current = false;
      }
      setPhase("connecting");
      try {
        await l816.connect(d.id);
        await afterConnect(d.id);
      } catch (e: any) {
        setError(e?.message ?? "Connection failed");
        setPhase("error");
      }
    },
    [l816, afterConnect]
  );

  const onPickSeen = useCallback(
    (sd: L816SeenDevice) => onPickDevice({ id: sd.id, name: sd.name ?? "L816", rssi: sd.rssi }),
    [onPickDevice]
  );

  // Push a decoded take to SATE. ONE implementation, shared by the manual button,
  // the file list and the device-initiated path — three call sites uploading with
  // three slightly different argument sets is how a take ends up filed under the
  // wrong patient.
  const pushTake = useCallback(
    async (take: L816Take) => {
      await api.uploadSession({
        device_serial: l816Serial(connectedId!),
        patient_id: patientId || "Unassigned",
        // The take's own timestamp, not the upload time: it is stable across a
        // retry, so re-uploading the same take dedups instead of duplicating.
        session_number: takeTimestamp(take.name),
        sample_rate: take.sampleRate,
        wav_base64: take.wavBase64,
      });
      setStatus(`Uploaded ${fmtTakeName(take.name)} · ${fmtDur(take.durationMs)} ✓`);
    },
    [api, connectedId, patientId]
  );

  // Download one take off the device, decode it, and upload it to SATE.
  const uploadTake = useCallback(
    async (file: L816File) => {
      if (!connectedId) return;
      setPhase("busy");
      setStatus(null);
      try {
        const take = await l816.fetchTake(file, setProgress);
        setProgress({ phase: "decoding", message: "Uploading to SATE…" });
        await pushTake(take);
        setPhase("ready");
      } catch (e: any) {
        // The recording is still ON the device — nothing has been lost, and the
        // list below is the way back to it. Say so; a bare error reads like the
        // take is gone.
        setError(
          `${e?.message ?? "Transfer failed"}\n\nThe recording is still on the SATE L816 — ` +
            `pick it from the list below to try again.`
        );
        setPhase("error");
      } finally {
        setProgress(null);
      }
    },
    [l816, connectedId, pushTake]
  );


  // The user pressed record/stop ON THE DEVICE. `files` is read through a ref so
  // this subscription does not tear down and re-subscribe on every list refresh —
  // resubscribing mid-take is how you miss the stop you were waiting for.
  const filesRef = useRef<L816File[]>([]);
  filesRef.current = files;
  const busyRef = useRef(false);

  useEffect(() => {
    const sub = l816.onDeviceEvent((ev) => {
      if (ev.type === "started") {
        resumed.current = false;
        startedAt.current = Date.now();
        setElapsedMs(0);
        setRecording(true);
        setStatus(null);
        setPhase((p) => (p === "error" ? "ready" : p));
        bgStatus("Recording on the device", undefined, true);
        return;
      }

      // Stopped on the device. Pull the take down and upload it with no tap.
      setRecording(false);
      startedAt.current = null;
      // A manual "Stop & upload" already owns this take — its own stopAndFetch is
      // mid-flight, and starting a second download would collide with it.
      if (busyRef.current) return;
      busyRef.current = true;
      (async () => {
        setPhase("busy");
        try {
          // The push path names the file; the poll path does not, and then the
          // only evidence is which entry is new since the last listing.
          const onProg = (pr: L816Progress) => {
            setProgress(pr);
            bgStatus(
              pr.message,
              pr.phase === "downloading" ? pr.percent : undefined
            );
          };
          const take = ev.file
            ? await (async () => {
                await new Promise((r) => setTimeout(r, 1500));
                return l816.fetchTake(ev.file!, onProg);
              })()
            : await l816.fetchNewSince(
                filesRef.current.map((f) => f.name),
                onProg
              );
          setProgress({ phase: "decoding", message: "Uploading to SATE…" });
          bgStatus("Uploading to SATE…", undefined, true);
          await pushTake(take);
          setFiles(await l816.listFiles().catch(() => filesRef.current));
          setPhase("ready");
          bgStatus("Connected · waiting for a recording", undefined, true);
          // The user was elsewhere the whole time. This dismissible notice is the
          // ONLY way they learn the take arrived without opening the app.
          if (backgrounded.current) {
            notifyOnce(
              takeTimestamp(take.name) & 0xff,
              "Recording saved to SATE",
              `${fmtTakeName(take.name)} · ${fmtDur(take.durationMs)}`
            );
          }
        } catch (e: any) {
          setError(
            `${e?.message ?? "Transfer failed"}\n\nYou recorded on the SATE L816 itself. ` +
              `The take is still on the device — pick it from the list below to upload it.`
          );
          setPhase("error");
          bgStatus("Transfer failed — open SATE to retry", undefined, true);
          // Silence here would be the worst outcome: the user believes a take is
          // safely uploaded when it is still only on the device.
          if (backgrounded.current) {
            notifyOnce(
              0xfe,
              "SATE L816 transfer failed",
              "The recording is still on the device. Open SATE to try again."
            );
          }
        } finally {
          busyRef.current = false;
          setProgress(null);
        }
      })();
    });
    return () => sub.remove();
  }, [l816, pushTake]);

  const onToggleRecord = useCallback(async () => {
    busyRef.current = true;
    try {
      if (recording) {
        setPhase("busy");
        setStatus(null);
        const take = await l816.stopAndFetch(setProgress);
        setRecording(false);
        startedAt.current = null;
        setProgress({ phase: "decoding", message: "Uploading to SATE…" });
        await pushTake(take);
        setFiles(await l816.listFiles().catch(() => files));
        setPhase("ready");
      } else {
        setStatus(null);
        await l816.startRecording();
        resumed.current = false;
        startedAt.current = Date.now();
        setElapsedMs(0);
        setRecording(true);
      }
    } catch (e: any) {
      setRecording(l816.isRecording());
      setError(e?.message ?? "Recording control failed");
      setPhase("error");
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
  }, [l816, recording, files, pushTake]);

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await l816.listFiles());
    } catch (e: any) {
      setStatus(e?.message ?? "Could not read the device's recordings");
    }
  }, [l816]);

  const foundList = useMemo(() => Object.values(found), [found]);
  const seenList = useMemo(() => Object.values(seen).sort((a, b) => b.rssi - a.rssi), [seen]);
  const busy = phase === "busy";

  return (
    <View style={{ flex: 1 }}>
      <GlassBackground />
      <ScrollView contentContainerStyle={s.container}>
        <View style={s.header}>
          <Title>Connect with SATE L816</Title>
          <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button">
            <Text style={s.close}>Close</Text>
          </Pressable>
        </View>

        {phase === "init" && <Muted>Preparing Bluetooth…</Muted>}

        {phase === "scan" && (
          <Card>
            <Text style={s.sectionTitle}>Nearby SATE L816 recorders</Text>
            <Muted>
              Turn the SATE L816 on and keep it close. If its own app is connected, close
              that first — the recorder only talks to one phone at a time.
            </Muted>
            {foundList.length === 0 ? (
              <Text style={s.dim}>Scanning…</Text>
            ) : (
              foundList.map((d) => (
                <Pressable key={d.id} onPress={() => onPickDevice(d)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>{d.name}</Text>
                    <Text style={s.dim}>
                      {d.id} · {d.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))
            )}
          </Card>
        )}

        {/* On-screen BLE diagnostics — the L816 does not always advertise its
            service UUID, and its name can be a stale cached one, so a manual pick
            is the difference between "not supported" and "tap the right row". */}
        {phase === "scan" && (
          <Card>
            <Text style={s.sectionTitle}>Bluetooth diagnostics</Text>
            <Text style={s.dim}>Radio: {bleState}</Text>
            <Muted>
              {seenList.length} device{seenList.length === 1 ? "" : "s"} seen nearby.
            </Muted>
            {seenList.length === 0 && (
              <Text style={s.dim}>
                Hearing NO Bluetooth at all — the radio is off or the Nearby devices
                permission was denied. Check Android Settings → Apps → SATE Companion →
                Permissions.
              </Text>
            )}
            {seenList.length > 0 && foundList.length === 0 && (
              <Text style={[s.dim, { marginTop: 4 }]}>
                No SATE L816 auto-detected. Tap yours below — look for a name starting
                “L816” (what the hardware advertises) or a row marked “L816 service ✓”.
              </Text>
            )}
            {seenList.length > 0 &&
              foundList.length === 0 &&
              seenList.map((sd) => (
                <Pressable key={sd.id} onPress={() => onPickSeen(sd)} style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowName}>
                      {sd.name ?? "(no name)"}
                      {sd.hasL816Service ? "  · L816 service ✓" : ""}
                    </Text>
                    <Text style={s.dim}>
                      {sd.id} · {sd.rssi} dBm
                    </Text>
                  </View>
                  <Text style={s.chev}>›</Text>
                </Pressable>
              ))}
          </Card>
        )}

        {phase === "connecting" && (
          <Card>
            <Text style={s.sectionTitle}>Connecting…</Text>
            <Muted>Setting up the recorder and syncing its clock.</Muted>
          </Card>
        )}

        {(phase === "ready" || busy) && (
          <>
            <Card>
              <Text style={s.sectionTitle}>{connectedName}</Text>
              <Muted>
                {recording
                  ? resumed.current
                    ? "This SATE L816 was already recording when we connected — it keeps " +
                      "going " +
                      "on its own. The timer below counts from now, not from the start."
                    : "Recording on the SATE L816. Audio is stored on the device and " +
                      "transferred " +
                      "when you stop."
                  : "Press record to start. The SATE L816 records on its own — the take is " +
                    "downloaded and uploaded to SATE when you stop."}
              </Muted>

              <Text style={s.dur}>{fmtDur(elapsedMs)}</Text>

              <Pressable
                onPress={onToggleRecord}
                disabled={busy}
                accessibilityRole="button"
                style={({ pressed }) => [
                  s.recBtn,
                  {
                    backgroundColor: recording ? D.red : D.sky,
                    opacity: busy ? 0.5 : pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Text style={s.recTxt}>
                  {recording ? "■  Stop & upload" : "●  Start recording"}
                </Text>
              </Pressable>

              {progress && (
                <View style={{ marginTop: 14 }}>
                  <Text style={s.progressTxt}>
                    {progress.message}
                    {progress.phase === "downloading" ? ` · ${progress.percent}%` : ""}
                  </Text>
                  {/* Only the download can be measured — one byte count against
                      another. Waiting, listing and decoding get the message and no
                      bar, rather than a bar creeping forward on a guess. */}
                  {progress.phase === "downloading" && (
                    <ProgressBar value={progress.percent / 100} />
                  )}
                </View>
              )}

              {status && <Text style={s.status}>{status}</Text>}
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

            {/* Everything still on the device. This is the recovery path: a take
                whose upload failed is not lost, it is right here. */}
            <Card>
              <View style={s.rowBetween}>
                <Text style={s.sectionTitle}>On the device</Text>
                <Pressable onPress={refreshFiles} hitSlop={8} accessibilityRole="button">
                  <Text style={s.link}>Refresh</Text>
                </Pressable>
              </View>
              {files.length === 0 ? (
                <Text style={s.dim}>No recordings on this SATE L816.</Text>
              ) : (
                files.map((f) => (
                  <Pressable
                    key={f.name}
                    onPress={() => uploadTake(f)}
                    disabled={busy || recording}
                    style={[s.row, (busy || recording) && { opacity: 0.4 }]}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowName}>{fmtTakeName(f.name)}</Text>
                      <Text style={s.dim}>{f.name}</Text>
                    </View>
                    <Text style={s.link}>Upload</Text>
                  </Pressable>
                ))
              )}
            </Card>

            <Button title="Done" onPress={onClose} disabled={busy} />
          </>
        )}

        {phase === "done" && (
          <Card>
            <Text style={s.sectionTitle}>Done</Text>
            <Muted>Recording uploaded. It'll appear on your home screen once processed.</Muted>
            <Button title="Back to home" onPress={onClose} />
          </Card>
        )}

        {phase === "error" && (
          <Card>
            <Text style={[s.sectionTitle, { color: D.red }]}>Something went wrong</Text>
            <Muted>{error}</Muted>
            <Button
              title={connectedId ? "Back to the recorder" : "Close"}
              onPress={() => (connectedId ? setPhase("ready") : onClose())}
            />
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
  link: { color: D.sky, fontSize: 14, fontWeight: "600" },
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
  progressTxt: { color: D.sub, fontSize: 13, marginBottom: 6 },
  status: { color: D.sky, fontSize: 13, fontWeight: "600", marginTop: 12 },
});
