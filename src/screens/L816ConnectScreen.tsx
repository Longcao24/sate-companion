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
import { loadUploaded, markUploaded } from "../l816/L816Store";
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
//   * A TAKE RECORDED WHILE THE PHONE WAS AWAY MUST STILL COME BACK BY ITSELF.
//     The device records with no phone at all — that is the whole point of it —
//     so most takes are made with nothing connected and produce no live event.
//     Listing them behind an Upload button meant they sat on the device forever
//     unless someone noticed and tapped each one. On connect we now diff the
//     device's file list against what has already been sent and upload the rest,
//     oldest first, with no tap.
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

  // Names already sent to SATE from this device, so a reconnect does not re-upload
  // the whole card. Loaded per device in afterConnect.
  const uploadedRef = useRef<Set<string>>(new Set());
  // Set when the screen is going away. The catch-up sweep is a long loop of BLE
  // transfers; without this it keeps running after the link has been dropped,
  // fails on a dead connection, and reports "transfer failed" for a screen the
  // user already left.
  const leaving = useRef(false);
  const [pendingCount, setPendingCount] = useState(0);

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
      leaving.current = true;
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





  // Push a decoded take to SATE. ONE implementation, shared by the manual button,
  // the file list and the device-initiated path — three call sites uploading with
  // three slightly different argument sets is how a take ends up filed under the
  // wrong patient.
  const pushTake = useCallback(
    async (take: L816Take) => {
      // The REF, not the state. `afterConnect` sets both and then immediately
      // runs the catch-up sweep — within the same render, so the `connectedId`
      // STATE is still null in every closure created before it. Using it here
      // meant `l816Serial(null)` and a "Cannot read property 'replace' of null"
      // that surfaced as a failed sync of the whole card. The `!` was a lie.
      const id = connectedIdRef.current;
      if (!id) throw new Error("Lost the connection to the SATE L816");
      await api.uploadSession({
        device_serial: l816Serial(id),
        patient_id: patientId || "Unassigned",
        // The take's own timestamp, not the upload time: it is stable across a
        // retry, so re-uploading the same take dedups instead of duplicating.
        session_number: takeTimestamp(take.name),
        sample_rate: take.sampleRate,
        wav_base64: take.wavBase64,
      });
      // Remember it here, in the ONE function every upload path goes through —
      // the manual button, the live device event and the catch-up sweep. Marking
      // it in each caller instead is how one path quietly forgets and re-uploads
      // the same take on every connect.
      uploadedRef.current.add(take.name);
      await markUploaded(id, take.name);
      setStatus(`Uploaded ${fmtTakeName(take.name)} · ${fmtDur(take.durationMs)} ✓`);
    },
    [api, patientId]
  );

  /**
   * Send everything on the device that SATE does not have yet, oldest first.
   *
   * This is the path that matters most: the L816 records with no phone present,
   * so the typical take generates no live event and would otherwise sit on the
   * device until someone noticed it in the list and tapped Upload.
   *
   * Sequential on purpose — one BLE link, one transfer at a time — and it stops
   * at the first failure rather than hammering a device that has gone out of
   * range. Whatever is left stays in the list and is retried on the next connect.
   */
  const syncPending = useCallback(
    async (all: L816File[]) => {
      const pending = all
        .filter((f) => !uploadedRef.current.has(f.name))
        .sort((a, b) => takeTimestamp(a.name) - takeTimestamp(b.name));
      setPendingCount(pending.length);
      if (pending.length === 0) return;

      // Claim the transfer lock for the WHOLE sweep. The device-event handler
      // checks this before starting its own download, and the link allows exactly
      // one at a time — without it, a stop pressed on the device mid-sweep starts
      // a second transfer and both fail with "a download is already running".
      if (busyRef.current) return;
      busyRef.current = true;
      setPhase("busy");
      try {
      for (let i = 0; i < pending.length; i++) {
        if (leaving.current) return;
        const file = pending[i];
        const label = `Recording ${i + 1} of ${pending.length}`;
        try {
          const take = await l816.fetchTake(file, (pr) => {
            setProgress({ ...pr, message: `${label} · ${pr.message}` });
            bgStatus(
              `${label} · ${pr.message}`,
              pr.phase === "downloading" ? pr.percent : undefined
            );
          });
          setProgress({ phase: "decoding", message: `${label} · Uploading to SATE…` });
          bgStatus(`${label} · Uploading to SATE…`, undefined, true);
          await pushTake(take);
          setPendingCount(pending.length - i - 1);
        } catch (e: any) {
          setError(
            `${e?.message ?? "Transfer failed"}\n\n${pending.length - i} recording(s) are ` +
              `still on the SATE L816 and were not uploaded. They stay in the list below — ` +
              `reconnect or tap Upload to try again.`
          );
          setPhase("error");
          setProgress(null);
          bgStatus("Sync failed — open SATE to retry", undefined, true);
          if (backgrounded.current) {
            notifyOnce(0xfd, "SATE L816 sync incomplete",
              `${pending.length - i} recording(s) still on the device.`);
          }
          return;
        }
      }
      setProgress(null);
      setPhase("ready");
      bgStatus("Connected · waiting for a recording", undefined, true);
      if (backgrounded.current) {
        notifyOnce(0xfc, "SATE L816 synced",
          `${pending.length} recording(s) uploaded to SATE.`);
      }
      } finally {
        busyRef.current = false;
      }
    },
    [l816, pushTake]
  );

  const afterConnect = useCallback(
    async (id: string) => {
      setConnectedId(id);
      // What this device has already sent, before anything is listed — the sweep
      // below is a diff against it, so loading it late would re-upload the card.
      uploadedRef.current = await loadUploaded(id);
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
      // and the answer would be stale the moment it stops anyway. The backlog is
      // NOT abandoned though — the stop handler sweeps once the take lands, or
      // there's the Refresh button. Returning here without that was a real hole:
      // connect while the device happens to be recording and every earlier take
      // stayed stranded until you next connected while it was idle.
      if (live) {
        setFiles([]);
        return;
      }
      // Listing is best-effort: a device with recordings we cannot enumerate is
      // still usable for a NEW take, so don't fail the whole screen on it.
      try {
        const list = await l816.listFiles();
        setFiles(list);
        // Anything here that SATE does not have was recorded while the phone was
        // away. Send it now rather than leaving it behind an Upload button that
        // nobody knows to press.
        await syncPending(list);
      } catch {
        setFiles([]);
      }
    },
    [l816, onConnected, syncPending]
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

  // Download one take off the device, decode it, and upload it to SATE.
  const uploadTake = useCallback(
    async (file: L816File) => {
      if (!connectedIdRef.current) return;
      // Claim the same lock every other path uses. The row is already disabled
      // while phase is 'busy', so today the UI alone would do — but one path
      // guarding on `phase` and three on `busyRef` is how a second transfer
      // eventually slips through and both fail.
      if (busyRef.current) return;
      busyRef.current = true;
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
        busyRef.current = false;
        setProgress(null);
      }
    },
    [l816, pushTake]
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
          const fresh = await l816.listFiles().catch(() => filesRef.current);
          setFiles(fresh);
          setPhase("ready");
          bgStatus("Connected · waiting for a recording", undefined, true);
          // Catch up anything still outstanding — e.g. we connected while the
          // device was mid-take, so afterConnect could not list or sweep.
          busyRef.current = false;
          await syncPending(fresh);
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
    // syncPending is in here because the stop handler calls it. It and pushTake
    // change together, so this never actually re-subscribes mid-take — but
    // leaving it out would silently capture a stale sweep the day that changes.
  }, [l816, pushTake, syncPending]);

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
              <Muted>
                {pendingCount > 0
                  ? `${pendingCount} recording${pendingCount === 1 ? "" : "s"} still to upload — ` +
                    `this happens on its own when the device connects.`
                  : "Everything here is already in SATE. Recordings made with the phone " +
                    "away upload themselves the next time you connect."}
              </Muted>
              {files.length === 0 ? (
                <Text style={s.dim}>No recordings on this SATE L816.</Text>
              ) : (
                files.map((f) => {
                  const done = uploadedRef.current.has(f.name);
                  return (
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
                      {/* Already-sent takes stay listed and stay tappable: the
                          device keeps them, and re-uploading one is a legitimate
                          thing to want after a delete on the SATE side. */}
                      <Text style={[s.link, done && { color: D.green }]}>
                        {done ? "In SATE ✓" : "Upload"}
                      </Text>
                    </Pressable>
                  );
                })
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
