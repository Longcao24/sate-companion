import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { SateApi } from "../api/sateApi";
import {
  L816File,
  L816Link,
  L816Progress,
  L816_DISPLAY_NAME,
  l816Serial,
  takeTimestamp,
} from "./L816Link";
import { loadUploaded, markUploaded, forgetL816, KnownL816 } from "./L816Store";
import { setL816Held } from "../ble/radio";
import {
  isBackgroundLinkSupported,
  notifyOnce,
  startBackgroundLink,
  stopBackgroundLink,
} from "../../modules/sate-fgservice";

// The SATE L816 session — the link, the device-event watch and the upload engine,
// hoisted OUT of the connect screen and mounted once for the whole app.
//
// 🛑 WHY THIS IS NOT IN THE SCREEN ANY MORE. All of this used to live inside
// L816ConnectScreen, and the screen's unmount cleanup called `l816.disconnect()`.
// So the entire feature — the 3 s state poll, the device-event subscription, the
// catch-up sweep, the uploads — existed only while that one screen was on top.
// Walk to Reports, or to Settings, and the recorder was no longer connected to
// anything: a take started on the device was not noticed, and nothing was
// uploaded. The device is designed to be used with the phone in a pocket, so
// "only while you are staring at the L816 screen" is the one situation the
// feature does not need to cover.
//
// Hoisting it here means the link now outlives navigation, and three things
// follow that the screen version never had to think about:
//
//   * A DROPPED LINK MUST BE NOTICED. Nothing watched for one before, because
//     the screen was the connection's lifetime. The poll swallows its own
//     failures (a missed tick is normal), so a dead link read as an idle one.
//     `l816.onDisconnected` now feeds the retry loop below.
//   * THE RADIO ARBITER MUST NOT TAKE THE LINK BACK. Leaving the screen used to
//     `acquireRadio('autosync')`, whose L816 release is `teardown()`. While this
//     session holds a device it sets `setL816Held(true)`, and the arbiter stops
//     the L816's SCAN instead of dropping its connection (see ble/radio.ts).
//     RULE #2 is unchanged: still ONE shared BleManager, still never destroyed
//     on this path — a held connection and auto-sync's scan coexist on it.
//   * IT RECONNECTS BY ITSELF, including at launch to the last paired unit.
//     Otherwise "keeps working in the background" lasts until the user walks out
//     of range once.
//
// The screen is now a VIEW over this: it still owns scanning and the device
// picker (both only meaningful while it is open) and calls `connect()`.

export type L816State = "idle" | "connecting" | "ready" | "busy" | "error";

export interface L816Session {
  state: L816State;
  connectedId: string | null;
  connectedName: string;
  recording: boolean;
  /** True when the device was ALREADY recording when we connected: the elapsed
   *  timer then counts from the reconnect, not from the real start. */
  resumed: boolean;
  elapsedMs: number;
  files: L816File[];
  progress: L816Progress | null;
  status: string | null;
  error: string | null;
  pendingCount: number;
  /** Take names already in SATE, so the file list can mark them. Kept as state
   *  (not just the ref the engine uses) so the list repaints as each one lands. */
  uploaded: Set<string>;
  patientId: string | null;
  setPatientId: (id: string | null) => void;
  /** Connect (or re-target) the session. Rejects on failure so the screen can
   *  fall back to a scan. */
  connect: (deviceId: string) => Promise<void>;
  /** User-initiated: drop the link AND stop trying to get it back. The pairing
   *  survives, so the recorder reappears on the next explicit connect. */
  disconnect: () => void;
  /**
   * Forget the recorder entirely: drop the link, remove it from the paired list,
   * and stop the reconnect loop from bringing it back. Resolves with the new
   * paired list so the caller can update its own copy.
   */
  unpair: () => Promise<KnownL816[]>;
  uploadTake: (file: L816File) => Promise<void>;
  toggleRecord: () => Promise<void>;
  refreshFiles: () => Promise<void>;
  clearError: () => void;
}

/** `01_20260915145726` -> `15 Sep, 14:57`. Thirteen digits is not a name. */
export function fmtTakeName(name: string): string {
  const t = takeTimestamp(name);
  return new Date(t * 1000).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDur(ms: number): string {
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
    const res = await PermissionsAndroid.request("android.permission.POST_NOTIFICATIONS" as any);
    return res === "granted";
  } catch {
    return false;
  }
}

/** How long to wait before trying a dropped link again. The device may simply be
 *  out of the room; retrying every second would drain the phone to no purpose. */
const RETRY_MS = 20000;

export function useL816Session(
  api: SateApi,
  l816: L816Link,
  enabled: boolean,
  /** Paired units, so the session can come back by itself after a drop or a
   *  cold start without the user opening the L816 screen at all. */
  known: KnownL816[]
): L816Session {
  const [state, setState] = useState<L816State>("idle");
  const [connectedId, setConnectedId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [files, setFiles] = useState<L816File[]>([]);
  const [progress, setProgress] = useState<L816Progress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [uploadedNames, setUploadedNames] = useState<string[]>([]);
  const [patientId, setPatientId] = useState<string | null>(null);

  // Names already sent to SATE from this device, so a reconnect does not
  // re-upload the whole card. Loaded per device on connect.
  const uploadedRef = useRef<Set<string>>(new Set());
  // The transfer lock. One BLE link means one download at a time, so every path
  // that fetches a take — the sweep, the device-event handler, the manual Upload
  // row and Stop & upload — claims this one ref.
  const busyRef = useRef(false);
  // "Something arrived while the lock was held." A blocked caller sets it rather
  // than dropping the work; whoever owns the lock drains it in syncPending's
  // loop. Without this, recording while the app was mid-upload left the take on
  // the device with nothing scheduled to come back for it.
  const resweep = useRef(false);
  const startedAt = useRef<number | null>(null);
  const resumedRef = useRef(false);
  const [resumed, setResumed] = useState(false);
  const filesRef = useRef<L816File[]>([]);
  filesRef.current = files;
  const patientRef = useRef<string | null>(null);
  patientRef.current = patientId;

  // The id we are supposed to be holding. Distinct from `connectedId` (which
  // reflects reality): after a drop these disagree, and that difference is
  // exactly what the retry loop acts on. Null means "the user let it go" — a
  // deliberate disconnect must not be undone by the reconnector.
  const wantId = useRef<string | null>(null);
  const connectedIdRef = useRef<string | null>(null);
  // The connect currently in flight, so a second caller JOINS it instead of
  // being turned away. A plain boolean latch here was a real bug: the screen
  // opened while the background retry was mid-attempt, `connect()` returned
  // immediately WITHOUT connecting and without throwing, so the screen believed
  // it had succeeded, never fell back to a scan, and sat on "Preparing
  // Bluetooth…" for ever.
  const inflight = useRef<{ id: string; p: Promise<void> } | null>(null);
  // Unpaired in THIS session. The reconnect loop falls back to the first paired
  // unit when `wantId` is null, and the parent's copy of that list updates a
  // render later — long enough for a tick to reconnect the device the user just
  // unpaired. Cleared by an explicit connect(), which is the only way back.
  const unpaired = useRef(false);

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
  const lastNotif = useRef(0);
  const bgStatus = useCallback((text: string, percent?: number, force = false) => {
    if (!connectedIdRef.current) return;
    const now = Date.now();
    if (!force && now - lastNotif.current < 1000) return;
    lastNotif.current = now;
    startBackgroundLink(L816_DISPLAY_NAME, text, percent);
  }, []);

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
    async (take: { name: string; wavBase64: string; sampleRate: number; durationMs: number }) => {
      const id = connectedIdRef.current;
      if (!id) throw new Error("Not connected");
      await api.uploadSession({
        device_serial: l816Serial(id),
        patient_id: patientRef.current || "Unassigned",
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
      setUploadedNames([...uploadedRef.current]);
      await markUploaded(id, take.name);
      setStatus(`Uploaded ${fmtTakeName(take.name)} · ${fmtDur(take.durationMs)} ✓`);
    },
    [api]
  );

  /**
   * ONE pass: send everything in `all` that SATE does not have yet, oldest first.
   *
   * Sequential on purpose — one BLE link, one transfer at a time — and it stops
   * at the first failure rather than hammering a device that has gone out of
   * range. Whatever is left stays in the list and is retried on the next connect.
   *
   * Returns false when it gave up, so the caller does not go round again on a
   * link that is already failing.
   */
  const sweepOnce = useCallback(
    async (all: L816File[]): Promise<boolean> => {
      const pending = all
        .filter((f) => !uploadedRef.current.has(f.name))
        .sort((a, b) => takeTimestamp(a.name) - takeTimestamp(b.name));
      setPendingCount(pending.length);
      if (pending.length === 0) return true;

      for (let i = 0; i < pending.length; i++) {
        if (!connectedIdRef.current) return false;
        const file = pending[i];
        const label = `Recording ${i + 1} of ${pending.length}`;
        try {
          const take = await l816.fetchTake(file, (pr) => {
            setProgress({ ...pr, message: `${label} · ${pr.message}` });
            bgStatus(`${label} · ${pr.message}`, pr.phase === "downloading" ? pr.percent : undefined);
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
          setState("error");
          setProgress(null);
          bgStatus("Sync failed — open SATE to retry", undefined, true);
          if (backgrounded.current) {
            notifyOnce(
              0xfd,
              "SATE L816 sync incomplete",
              `${pending.length - i} recording(s) still on the device.`
            );
          }
          return false;
        }
      }
      setProgress(null);
      setState("ready");
      bgStatus("Connected · waiting for a recording", undefined, true);
      if (backgrounded.current) {
        notifyOnce(0xfc, "SATE L816 synced", `${pending.length} recording(s) uploaded to SATE.`);
      }
      return true;
    },
    [l816, pushTake, bgStatus]
  );

  /**
   * Send everything the device is holding — then LOOK AGAIN before letting go.
   *
   * This is the path that matters most: the L816 records with no phone present,
   * so the typical take generates no live event and would otherwise sit on the
   * device until someone noticed it in the list and tapped Upload.
   *
   * 🛑 The re-list at the end of every round is not an optimisation — it is the
   * only thing that catches a take that FINISHED WHILE WE WERE TRANSFERRING, and
   * neither of the two ways that happens reaches the event handler:
   *
   *   * a stop that lands mid-transfer arrives with the lock held, and every
   *     caller guards `if (busyRef.current) return` — the event was simply
   *     dropped, and nothing ever came back for it;
   *   * a take that both STARTS and ENDS inside one transfer emits no event at
   *     all, because the 3 s state poll is suspended for the duration (it must
   *     be — a state query interleaved into a download corrupts it) and only
   *     ever sees the state FLIP, never the round trip.
   *
   * So "record something while the app is busy uploading" used to mean the take
   * sat on the device until the next connect — the exact case this whole feature
   * exists to cover. `resweep` closes the last gap: a caller that finds the lock
   * taken leaves a note instead of giving up, and the holder drains it here.
   *
   * It terminates because a round only repeats while a FRESH listing still shows
   * something unsent (or a note was left), and every successful round sends one.
   */
  const syncPending = useCallback(
    async (all: L816File[]) => {
      // Nothing to do — and with no transfer there is no busy window for a take
      // to be lost in, so there is nothing to re-list for either.
      if (all.every((f) => uploadedRef.current.has(f.name))) {
        setPendingCount(0);
        return;
      }
      // One transfer at a time on one BLE link.
      if (busyRef.current) {
        resweep.current = true;
        return;
      }
      busyRef.current = true;
      setState("busy");
      try {
        let list = all;
        // A ceiling, not the exit condition: the loop ends when a fresh listing
        // holds nothing new. The bound only stops a device that somehow always
        // has one more take from owning the link forever.
        for (let round = 0; round < 12; round++) {
          resweep.current = false;
          if (!(await sweepOnce(list))) return;
          if (!connectedIdRef.current) return;
          // A listing is refused mid-record, and the stop that ends that take
          // sweeps on its own — so stop here rather than failing the round.
          if (l816.isRecording()) return;
          const fresh = await l816.listFiles().catch(() => null);
          if (!fresh) return;
          setFiles(fresh);
          list = fresh;
          const unsent = fresh.some((f) => !uploadedRef.current.has(f.name));
          // `resweep` covers the narrow race where the stop landed DURING the
          // listing above: nothing looks pending, but an event was dropped.
          if (!unsent && !resweep.current) return;
        }
      } finally {
        busyRef.current = false;
      }
    },
    [l816, sweepOnce]
  );

  const afterConnect = useCallback(
    async (id: string) => {
      // What this device has already sent, before anything is listed — the sweep
      // below is a diff against it, so loading it late would re-upload the card.
      uploadedRef.current = await loadUploaded(id);
      setUploadedNames([...uploadedRef.current]);
      connectedIdRef.current = id;
      wantId.current = id;
      setConnectedId(id);
      setError(null);
      // Tell the arbiter this link must survive a handoff — leaving the L816
      // screen acquires 'autosync', whose L816 release is teardown().
      setL816Held(true);
      // Keep the process alive from here on. Without this the 3 s poll — and so
      // the whole detect-a-take-started-on-the-device feature — stops the moment
      // the user leaves the app.
      if (isBackgroundLinkSupported()) {
        await requestNotificationPermission();
        bgStatus("Connected · waiting for a recording", undefined, true);
      }
      // The device may have been recording all along — it does not stop because
      // the app went away. Pick the state up rather than assuming idle.
      const live = l816.isRecording();
      resumedRef.current = live;
      setResumed(live);
      setRecording(live);
      if (live) bgStatus("Recording on the device", undefined, true);
      startedAt.current = live ? Date.now() : null;
      setElapsedMs(0);
      setState("ready");
      // Don't list while a take is running: the device refuses a list mid-record,
      // and the answer would be stale the moment it stops anyway. The backlog is
      // NOT abandoned though — the stop handler sweeps once the take lands, or
      // there's the Refresh button.
      if (live) {
        setFiles([]);
        return;
      }
      // Listing is best-effort: a device with recordings we cannot enumerate is
      // still usable for a NEW take, so don't fail the whole session on it.
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
    [l816, bgStatus, syncPending]
  );

  const connect = useCallback(
    async (deviceId: string) => {
      // Already going for this device: wait for THAT attempt and inherit its
      // result, rather than starting a second one or silently doing nothing.
      const cur = inflight.current;
      if (cur) {
        if (cur.id === deviceId) return cur.p;
        throw new Error("Already connecting to another SATE L816");
      }
      unpaired.current = false;
      setState("connecting");
      setError(null);
      const p = (async () => {
        try {
          await l816.connect(deviceId);
          await afterConnect(deviceId);
        } catch (e: any) {
          // Leave nothing half-open: a connect that got a link and then failed
          // the handshake would otherwise keep the peripheral bound to us, and
          // the device only talks to one phone at a time.
          l816.disconnect().catch(() => {});
          setState((st) => (st === "connecting" ? "idle" : st));
          throw e;
        } finally {
          inflight.current = null;
        }
      })();
      inflight.current = { id: deviceId, p };
      return p;
    },
    [l816, afterConnect]
  );

  const disconnect = useCallback(() => {
    // Clearing `wantId` FIRST is what makes this different from a drop: the
    // retry loop reads it, so leaving it set would reconnect the device the user
    // just let go of.
    wantId.current = null;
    connectedIdRef.current = null;
    setL816Held(false);
    setConnectedId(null);
    setRecording(false);
    setFiles([]);
    setState("idle");
    stopBackgroundLink();
    l816.disconnect().catch(() => {});
  }, [l816]);

  const unpair = useCallback(async () => {
    const id = connectedIdRef.current ?? wantId.current ?? (known.length ? known[0].id : null);
    unpaired.current = true;
    disconnect();
    setStatus(null);
    setFiles([]);
    setPendingCount(0);
    // The uploaded ledger is deliberately KEPT. It is keyed by device id, so
    // pairing the same unit again does not re-download and re-upload everything
    // it is holding — and this hardware never deletes a take, so that could be
    // thousands of them over BLE. Unpairing is about the pairing, not about
    // making SATE forget what it already has.
    return id ? forgetL816(id) : known;
  }, [disconnect, known]);

  // The link went away on its own. Clear the connected state so nothing claims a
  // connection that is gone — and leave `wantId` alone, which is what tells the
  // retry loop below to bring it back.
  useEffect(() => {
    const sub = l816.onDisconnected(() => {
      connectedIdRef.current = null;
      busyRef.current = false;
      setL816Held(false);
      setConnectedId(null);
      setRecording(false);
      setProgress(null);
      setState("idle");
      setStatus("The SATE L816 went out of range. Reconnecting…");
      stopBackgroundLink();
    });
    return () => sub.remove();
  }, [l816]);

  // Bring the link back: after a drop, and at launch for a unit already paired.
  // Without this the "works from any screen" promise lasts exactly until the
  // user walks out of range once, or closes the app.
  useEffect(() => {
    if (!enabled) return;
    let stop = false;
    const tick = async () => {
      if (stop || inflight.current || l816.isConnected()) return;
      // A user-initiated disconnect clears `wantId`; only fall back to a paired
      // unit when nothing has been let go of deliberately.
      if (unpaired.current) return;
      const target = wantId.current ?? (known.length > 0 ? known[0].id : null);
      if (!target) {
        console.log(`[L816] autoconnect: nothing to connect to (known=${known.length})`);
        return;
      }
      try {
        // Never PROMPT from here — see L816Link.hasPermissions.
        if (!(await l816.hasPermissions())) {
          console.log("[L816] autoconnect: Bluetooth permission not granted yet — waiting");
          return;
        }
        console.log(`[L816] autoconnect: connecting to ${target}`);
        await connect(target);
        console.log("[L816] autoconnect: connected — checking for new recordings");
      } catch (e: any) {
        // Out of range, off, or its own app holds the link. Say which, once per
        // attempt: "nothing happened" is the failure mode this whole loop exists
        // to avoid, and a silent catch reproduces it in the logs. ble-plx reports
        // its own connect timeout as "Operation was cancelled", which reads like
        // a bug in us rather than a recorder that is simply switched off.
        const msg = e?.message ?? String(e);
        console.log(
          `[L816] autoconnect failed: ${
            /cancell?ed/i.test(msg)
              ? "not reachable — switched off, out of range, or its own app has the link"
              : msg
          } (retrying in ${RETRY_MS / 1000}s)`
        );
      }
    };
    tick();
    const t = setInterval(tick, RETRY_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [enabled, l816, known, connect]);

  // Download one take off the device, decode it, and upload it to SATE.
  const uploadTake = useCallback(
    async (file: L816File) => {
      if (!connectedIdRef.current) return;
      // Claim the same lock every other path uses. The row is already disabled
      // while the state is 'busy', so today the UI alone would do — but one path
      // guarding on the state and three on `busyRef` is how a second transfer
      // eventually slips through and both fail.
      if (busyRef.current) {
        resweep.current = true;
        return;
      }
      busyRef.current = true;
      setState("busy");
      setStatus(null);
      try {
        const take = await l816.fetchTake(file, setProgress);
        setProgress({ phase: "decoding", message: "Uploading to SATE…" });
        await pushTake(take);
        setState("ready");
        // Same rule as every other holder of the lock: look again before letting
        // go. A take recorded during this transfer produced no usable event.
        const fresh = await l816.listFiles().catch(() => null);
        if (fresh) {
          setFiles(fresh);
          busyRef.current = false;
          await syncPending(fresh);
        }
      } catch (e: any) {
        // The recording is still ON the device — nothing has been lost, and the
        // list below is the way back to it. Say so; a bare error reads like the
        // take is gone.
        setError(
          `${e?.message ?? "Transfer failed"}\n\nThe recording is still on the SATE L816 — ` +
            `pick it from the list below to try again.`
        );
        setState("error");
      } finally {
        busyRef.current = false;
        setProgress(null);
      }
    },
    [l816, pushTake, syncPending]
  );

  // The user pressed record/stop ON THE DEVICE. `files` is read through a ref so
  // this subscription does not tear down and re-subscribe on every list refresh —
  // resubscribing mid-take is how you miss the stop you were waiting for.
  useEffect(() => {
    const sub = l816.onDeviceEvent((ev) => {
      if (ev.type === "started") {
        resumedRef.current = false;
        setResumed(false);
        startedAt.current = Date.now();
        setElapsedMs(0);
        setRecording(true);
        setStatus(null);
        setState((p) => (p === "error" ? "ready" : p));
        bgStatus("Recording on the device", undefined, true);
        return;
      }

      // Stopped on the device. Pull the take down and upload it with no tap.
      setRecording(false);
      startedAt.current = null;
      // Something else already owns the link — a manual "Stop & upload" whose
      // stopAndFetch is mid-flight, or a sweep. Starting a second download would
      // collide with it, so leave a note: the holder re-lists on its way out and
      // this take goes up there. Returning bare here is what made a recording
      // finished during a transfer sit on the device until the next connect.
      if (busyRef.current) {
        resweep.current = true;
        return;
      }
      busyRef.current = true;
      (async () => {
        setState("busy");
        try {
          // The push path names the file; the poll path does not, and then the
          // only evidence is which entry is new since the last listing.
          const onProg = (pr: L816Progress) => {
            setProgress(pr);
            bgStatus(pr.message, pr.phase === "downloading" ? pr.percent : undefined);
          };
          const take = ev.file
            ? await (async () => {
                await new Promise((r) => setTimeout(r, 1500));
                return l816.fetchTake(ev.file!, onProg);
              })()
            : await l816.fetchNewSince(filesRef.current.map((f) => f.name), onProg);
          setProgress({ phase: "decoding", message: "Uploading to SATE…" });
          bgStatus("Uploading to SATE…", undefined, true);
          await pushTake(take);
          const fresh = await l816.listFiles().catch(() => filesRef.current);
          setFiles(fresh);
          setState("ready");
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
          setState("error");
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
  }, [l816, pushTake, syncPending, bgStatus]);

  const toggleRecord = useCallback(async () => {
    busyRef.current = true;
    try {
      if (recording) {
        setState("busy");
        setStatus(null);
        const take = await l816.stopAndFetch(setProgress);
        setRecording(false);
        startedAt.current = null;
        setProgress({ phase: "decoding", message: "Uploading to SATE…" });
        await pushTake(take);
        const fresh = await l816.listFiles().catch(() => null);
        setFiles(fresh ?? filesRef.current);
        setState("ready");
        if (fresh) {
          busyRef.current = false;
          await syncPending(fresh);
        }
      } else {
        setStatus(null);
        await l816.startRecording();
        resumedRef.current = false;
        setResumed(false);
        startedAt.current = Date.now();
        setElapsedMs(0);
        setRecording(true);
      }
    } catch (e: any) {
      setRecording(l816.isRecording());
      setError(e?.message ?? "Recording control failed");
      setState("error");
    } finally {
      busyRef.current = false;
      setProgress(null);
    }
  }, [l816, recording, pushTake, syncPending]);

  const refreshFiles = useCallback(async () => {
    try {
      const list = await l816.listFiles();
      setFiles(list);
      await syncPending(list);
    } catch (e: any) {
      setStatus(e?.message ?? "Could not read the device's recordings");
    }
  }, [l816, syncPending]);

  const clearError = useCallback(() => {
    setError(null);
    setState((s) => (s === "error" ? (connectedIdRef.current ? "ready" : "idle") : s));
  }, []);

  return useMemo(
    () => ({
      state,
      connectedId,
      connectedName: L816_DISPLAY_NAME,
      recording,
      resumed,
      elapsedMs,
      files,
      progress,
      status,
      error,
      pendingCount,
      uploaded: new Set(uploadedNames),
      patientId,
      setPatientId,
      connect,
      disconnect,
      unpair,
      uploadTake,
      toggleRecord,
      refreshFiles,
      clearError,
    }),
    [
      state,
      connectedId,
      recording,
      resumed,
      elapsedMs,
      files,
      progress,
      status,
      error,
      pendingCount,
      uploadedNames,
      patientId,
      connect,
      disconnect,
      unpair,
      uploadTake,
      toggleRecord,
      refreshFiles,
      clearError,
    ]
  );
}
