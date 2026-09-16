import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, PermissionsAndroid, Platform } from "react-native";
import { SateApi } from "../api/sateApi";
import {
  L816File,
  L816FoundDevice,
  L816Link,
  L816Progress,
  L816SeenDevice,
  L816Model,
  L816_DEFAULT_MODEL,
  l816DisplayName,
  l816ModelOf,
  l816Serial,
  takeTimestamp,
} from "./L816Link";
import {
  loadUploaded,
  markUploaded,
  forgetL816,
  rememberL816,
  KnownL816,
} from "./L816Store";
import { radioOwner, setL816Held, subscribeRadio } from "../ble/radio";
import { deleteAsync } from "expo-file-system/legacy";
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
  /** Which model the connected (or last paired) unit is. */
  model: L816Model;
  /** Connect (or re-target) the session. `model` comes from what the peripheral
   *  advertised; omitted, the family default is used — see l816Serial for why
   *  that matters permanently. */
  connect: (deviceId: string, model?: L816Model) => Promise<void>;
  /** User-initiated: drop the link AND stop trying to get it back. The pairing
   *  survives, so the recorder reappears on the next explicit connect. */
  disconnect: () => void;
  /**
   * Forget the recorder entirely: drop the link, remove it from the paired list,
   * and stop the reconnect loop from bringing it back. Resolves with the new
   * paired list so the caller can update its own copy.
   */
  unpair: () => Promise<KnownL816[]>;
  /**
   * SATE L816s the phone can hear RIGHT NOW and has not paired.
   *
   * Published so the app's own screens can offer a recorder the moment it is in
   * range, instead of making the user guess that one is there and go looking for
   * it behind Add a device. Empty whenever something is connected.
   */
  nearby: L816FoundDevice[];
  /** Everything the radio hears, matched or not — the diagnostic behind
   *  "Can't find your recorder?". See the pairing screen for why it exists. */
  seen: L816SeenDevice[];
  bleState: string;
  /**
   * Scan CONTINUOUSLY while the returned function has not been called.
   *
   * Discovery is duty-cycled the rest of the time (see DISCOVERY_*): a
   * continuous BLE scan is a real battery cost to pay for a recorder that is
   * usually not there. A screen whose whole job is pairing calls this so it
   * scans properly for as long as the user is looking at it.
   */
  boostDiscovery: () => () => void;
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

// Presence scanning, so a recorder in range can be offered on the main screen.
//
// Duty-cycled, not continuous. A BLE scan costs real battery and most of the
// time there is no recorder to find, so scanning flat out to catch the rare
// moment one is switched on nearby would be paid for by every user, all day. A
// short burst every half minute finds it within one cycle of walking into the
// room, which is as good as instant for this purpose. A screen that exists to
// pair calls boostDiscovery() and gets a continuous scan while it is open.
const DISCOVERY_SCAN_MS = 8000;
const DISCOVERY_REST_MS = 22000;
// A recorder is forgotten only after it has been silent for more than two full
// cycles. Anything shorter and a device sitting on the desk flickers in and out
// of the offer as each burst ends.
const DISCOVERY_STALE_MS = 75000;

export function useL816Session(
  api: SateApi,
  l816: L816Link,
  enabled: boolean,
  /** Paired units, so the session can come back by itself after a drop or a
   *  cold start without the user opening the L816 screen at all. */
  known: KnownL816[],
  /** Called with the new paired list whenever the session pairs or unpairs. */
  onKnown?: (list: KnownL816[]) => void
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
  // The connected unit's model. A ref as well as state because pushTake reads it
  // to build the SERIAL, and that must never be a render behind — a take filed
  // under the wrong model's serial cannot be moved afterwards.
  const [model, setModel] = useState<L816Model>(L816_DEFAULT_MODEL);
  const modelRef = useRef<L816Model>(L816_DEFAULT_MODEL);

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
  const onKnownRef = useRef(onKnown);
  onKnownRef.current = onKnown;
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
    startBackgroundLink(l816DisplayName(modelRef.current), text, percent);
  }, []);

  // Tick the on-screen duration while a take runs.
  //
  // Zeroed when it stops, not left at the last take's length: a big "0:10" over
  // a button that says "Start recording" reads as a take still going, and it is
  // the first thing the eye lands on.
  useEffect(() => {
    if (!recording) {
      setElapsedMs(0);
      return;
    }
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
    async (take: {
      name: string;
      wavPath: string;
      sampleRate: number;
      bytes: number;
      durationMs: number;
    }) => {
      const id = connectedIdRef.current;
      if (!id) throw new Error("Not connected");
      // A big take goes straight into Storage in one PUT, which reports nothing
      // until it finishes. So say the SIZE rather than invent a percentage: it is
      // a fact, and it is the answer to "why is this taking so long" — a bar
      // creeping forward on a guess would only turn that question into a promise.
      const mb = take.bytes / 1e6;
      if (mb > 4) {
        setProgress({
          phase: "decoding",
          message: `Uploading ${mb.toFixed(0)} MB to SATE…`,
        });
      }
      await api.uploadSession({
        wav_path: take.wavPath,
        wav_bytes: take.bytes,
        device_serial: l816Serial(id, modelRef.current),
        patient_id: patientRef.current || "Unassigned",
        // The take's own timestamp, not the upload time: it is stable across a
        // retry, so re-uploading the same take dedups instead of duplicating.
        session_number: takeTimestamp(take.name),
        sample_rate: take.sampleRate,
      });
      // The decoded WAV lives in the cache only until it is safely in SATE. It
      // can be hundreds of MB; leaving it there fills the phone one take at a
      // time, and nothing else knows to collect it.
      deleteAsync(take.wavPath, { idempotent: true }).catch(() => {});
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
              `still on the ${l816DisplayName(modelRef.current)} and were not uploaded. They ` +
              `stay in the list below — ` +
              `reconnect or tap Upload to try again.`
          );
          setState("error");
          setProgress(null);
          bgStatus("Sync failed — open SATE to retry", undefined, true);
          if (backgrounded.current) {
            notifyOnce(
              0xfd,
              `${l816DisplayName(modelRef.current)} sync incomplete`,
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
        notifyOnce(
          0xfc,
          `${l816DisplayName(modelRef.current)} synced`,
          `${pending.length} recording(s) uploaded to SATE.`
        );
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
      // 🛑 REMEMBER THE PAIRING HERE, in the session, because the session is what
      // connects. It used to be done by the connect screen's `onConnected`, so a
      // device paired any other way — the "nearby" offer on the dashboard, most
      // obviously — connected fine and was never written down: nothing to
      // reconnect to on the next launch, and the device chip stayed on "Add
      // device" while a recorder sat connected.
      rememberL816(id, l816DisplayName(modelRef.current), modelRef.current)
        .then((list) => onKnownRef.current?.(list))
        .catch(() => {});
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
    async (deviceId: string, m?: L816Model) => {
      if (m) {
        modelRef.current = m;
        setModel(m);
      }
      // Already going for this device: wait for THAT attempt and inherit its
      // result, rather than starting a second one or silently doing nothing.
      const cur = inflight.current;
      if (cur) {
        if (cur.id === deviceId) return cur.p;
        throw new Error(`Already connecting to another ${l816DisplayName(modelRef.current)}`);
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
      setStatus(`The ${l816DisplayName(modelRef.current)} went out of range. Reconnecting…`);
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
      const paired = known.find((k) => k.id === wantId.current) ?? known[0];
      const target = wantId.current ?? paired?.id ?? null;
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
        await connect(target, paired?.model ? l816ModelOf(paired.model) : undefined);
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

  // ------------------------------------------------------------ discovery
  //
  // 🛑 ONE SCANNER. This is the only place the L816 scan is started, and the
  // pairing screen renders what it publishes rather than running its own. Two
  // scans on one BleManager is the thing RULE #2 forbids, and a screen that
  // scans independently of a session that also scans is exactly how you get
  // there. See ble/radio.ts.
  // What the radio has heard, and WHEN. Kept in refs, not state, on purpose.
  //
  // The scan runs with `allowDuplicates: true`, so every advertisement from
  // every device in the room arrives as a callback — many per second. Writing
  // that straight into React state re-rendered the whole screen on each packet,
  // which is a jank and battery cost paid by someone who is only reading a
  // report. State is now updated only when the ANSWER changes: a recorder
  // appears, or one goes away.
  const foundRef = useRef<Record<string, { d: L816FoundDevice; at: number }>>({});
  const seenRef = useRef<Record<string, L816SeenDevice>>({});
  const [foundMap, setFoundMap] = useState<Record<string, L816FoundDevice>>({});
  const [seenMap, setSeenMap] = useState<Record<string, L816SeenDevice>>({});
  const [bleState, setBleState] = useState("starting…");
  const [boost, setBoost] = useState(0);
  const boostRef = useRef(0);
  boostRef.current = boost;

  const publishFound = useCallback(() => {
    const out: Record<string, L816FoundDevice> = {};
    for (const [id, v] of Object.entries(foundRef.current)) out[id] = v.d;
    setFoundMap(out);
  }, []);

  // 🛑 Discovery is only allowed to scan when NOTHING ELSE owns the radio.
  //
  // In the SATE app nothing ever calls acquireRadio, so the owner is null and
  // discovery runs — which is the whole point, since that app has no other way
  // to notice a recorder. In SATE COMPANION the owner is 'autosync' on the home
  // screen, and auto-sync is the ONE background scanner there (RULE #2): a
  // presence scan started here would call the shared manager's global
  // stopDeviceScan() and silently stop SATE recorders being discovered. So in
  // Companion discovery only runs on the L816 screen, which owns the radio as
  // 'l816' — and Companion's home is the device list, which already offers Add
  // a device, so nothing is lost there.
  const [radio, setRadio] = useState(radioOwner);
  useEffect(() => subscribeRadio(() => setRadio(radioOwner())), []);
  const mayScan = radio === null || radio === "l816";

  const boostDiscovery = useCallback(() => {
    setBoost((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setBoost((n) => Math.max(0, n - 1));
    };
  }, []);

  useEffect(() => {
    // Nothing to discover once we are on a device, and the radio is needed for
    // the link.
    if (!enabled || connectedId || !mayScan) {
      l816.stopScan();
      foundRef.current = {};
      seenRef.current = {};
      setFoundMap({});
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let seenPublish = 0;

    const begin = async () => {
      if (stopped) return;
      // Never PROMPT from here: discovery is something the app does on its own.
      if (!(await l816.hasPermissions()) || stopped) {
        timer = setTimeout(begin, DISCOVERY_REST_MS);
        return;
      }
      if (inflight.current || l816.isConnected()) {
        timer = setTimeout(begin, DISCOVERY_REST_MS);
        return;
      }
      l816.startScan(
        (d) => {
          const fresh = !foundRef.current[d.id];
          foundRef.current[d.id] = { d, at: Date.now() };
          // Only a NEW recorder is news. Re-rendering on every advertisement
          // from one we are already showing changes nothing on screen.
          if (fresh) publishFound();
        },
        (sd) => {
          seenRef.current[sd.id] = sd;
          // The raw list is only rendered behind "Can't find your recorder?",
          // so it is published at most once a second and only while a screen is
          // actually asking for it.
          if (boostRef.current > 0 && Date.now() - seenPublish > 1000) {
            seenPublish = Date.now();
            setSeenMap({ ...seenRef.current });
          }
        },
        (st) => setBleState(st)
      );
      if (boostRef.current > 0) return; // a pairing screen is open: keep scanning
      timer = setTimeout(() => {
        if (stopped) return;
        l816.stopScan();
        // Drop only what has been SILENT for more than a couple of cycles.
        //
        // This used to clear everything at the end of each burst, which meant a
        // recorder sitting on the desk was offered for 8 seconds and withdrawn
        // for 22, over and over — a banner that blinks is one people learn to
        // distrust, and it is unclickable half the time. A device carried out of
        // the room still stops being offered; it just takes a cycle to be sure,
        // which is the right way round: a stale row costs one failed tap, a
        // blinking one costs the feature.
        const cut = Date.now() - DISCOVERY_STALE_MS;
        let dropped = false;
        for (const [id, v] of Object.entries(foundRef.current)) {
          if (v.at < cut) {
            delete foundRef.current[id];
            dropped = true;
          }
        }
        if (dropped) publishFound();
        timer = setTimeout(begin, DISCOVERY_REST_MS);
      }, DISCOVERY_SCAN_MS);
    };
    begin();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      l816.stopScan();
    };
  }, [enabled, connectedId, l816, boost, mayScan, publishFound]);

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
          `${e?.message ?? "Transfer failed"}\n\nThe recording is still on the ` +
            `${l816DisplayName(modelRef.current)} — ` +
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
            `${e?.message ?? "Transfer failed"}\n\nYou recorded on the ` +
              `${l816DisplayName(modelRef.current)} itself. ` +
              `The take is still on the device — pick it from the list below to upload it.`
          );
          setState("error");
          bgStatus("Transfer failed — open SATE to retry", undefined, true);
          // Silence here would be the worst outcome: the user believes a take is
          // safely uploaded when it is still only on the device.
          if (backgrounded.current) {
            notifyOnce(
              0xfe,
              `${l816DisplayName(modelRef.current)} transfer failed`,
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
      connectedName: l816DisplayName(model),
      model,
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
      nearby: Object.values(foundMap),
      seen: Object.values(seenMap).sort((a, b) => b.rssi - a.rssi),
      bleState,
      boostDiscovery,
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
      model,
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
      foundMap,
      seenMap,
      bleState,
      boostDiscovery,
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
