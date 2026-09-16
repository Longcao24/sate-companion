// L816 link — connect to an L816 / "2837-family" handheld voice recorder over
// STANDARD BLE GATT, drive its record button remotely, pull the take off the
// device and push it through the SAME upload path as everything else
// (api.uploadSession -> device-api -> AI -> recordings), device_serial
// `l816-<mac>`.
//
// Like the pendant and unlike Plaud, this is plain react-native-ble-plx on the
// SHARED BleManager (see ble/bleManager.ts + RULE #2): no proprietary SDK, no
// binding, no device-lock concern. Handing the radio over to or from L816 is a
// stopScan(), never a destroy.
//
// What is NOT portable is the audio: the L816 sends ASC-VI frames, decodable
// only by the vendor's Android ARM binaries (see modules/sate-asc). That is why
// L816_ENABLED is android-only — everything in THIS file would run on iOS.
//
// Protocol reference: the L816 connection guide in the reference project
// (docs/L816-PROTOCOL.md), verified live on an L816 with a Pixel 9 / Android 16.

import { Buffer } from "buffer";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, Device, Subscription } from "react-native-ble-plx";
import { getSharedBleManager, hasSharedBleManager } from "../ble/bleManager";
import { decodeAscToWavFile } from "../../modules/sate-asc";

/**
 * The models in this family, lowercase, and the ONE list that decides what the
 * scan will match.
 *
 * They speak the same protocol and carry the same ASC-VI audio; the model only
 * changes what the unit is CALLED and what its serial says it is. Adding one is
 * this line plus its label below — and the two web tables named in
 * `l816Serial`, which cannot be reached from here.
 */
export const L816_MODELS = ["l816", "l815"] as const;
export type L816Model = (typeof L816_MODELS)[number];

/** The family's default, for a unit whose model we never learned: a device that
 *  advertises only `2837`, or a pairing remembered by a build older than L815
 *  support. It is what every existing unit already is, so an unknown model
 *  behaves exactly as it did before rather than becoming a new kind of thing. */
export const L816_DEFAULT_MODEL: L816Model = "l816";

/**
 * What the device is CALLED in the product, everywhere a user can read it.
 *
 * It is NOT what the hardware advertises — the radio says `L816` or `L815`, and
 * the scan matcher below looks for exactly those. Keeping the two apart is the
 * point: the advertised name is a fact about the peripheral, this is SATE's name
 * for it, and a paired unit is remembered under this one so Home reads the same
 * word as the connect screen.
 */
export function l816DisplayName(model?: L816Model | string | null): string {
  const m = (model ?? "").toLowerCase();
  return `SATE ${(L816_MODELS as readonly string[]).includes(m) ? m.toUpperCase() : "L816"}`;
}

/** The family's name, for anywhere that has no particular unit in hand. */
export const L816_DISPLAY_NAME = l816DisplayName(L816_DEFAULT_MODEL);

/** Which model is this, from what the peripheral advertises? A device that only
 *  says `2837` tells us nothing, and gets the family default. */
export function l816ModelOf(advertisedName?: string | null): L816Model {
  const n = (advertisedName ?? "").toLowerCase();
  return (L816_MODELS.find((m) => n.includes(m)) as L816Model) ?? L816_DEFAULT_MODEL;
}

// ---- GATT profile ------------------------------------------------------
// Lowercase to match react-native-ble-plx's normalized UUIDs.
const UUID_SUFFIX = "-2233-4455-6677-889912345678";
export const L816_SERVICE = `0011200a${UUID_SUFFIX}`;
const CHAR_RECORD = `0011201a${UUID_SUFFIX}`; // notify: also carries file data
const CHAR_TX = `0011202a${UUID_SUFFIX}`; // write w/o response: commands
const CHAR_CONTROL = `0011203a${UUID_SUFFIX}`; // notify: command responses
const CHAR_DATA = `0011204a${UUID_SUFFIX}`; // notify: transferred ASC bytes

// ---- opcodes -----------------------------------------------------------
const OP_TIME = 0x02;
const OP_START = 0x03;
const OP_STOP = 0x04;
const OP_LIST = 0x05;
const OP_LIST_END = 0x06;
const OP_DOWNLOAD = 0x07;
const OP_CANCEL = 0x08;
const OP_EOF = 0x09;
const OP_STATE = 0x0f;

const NAME_BYTES = 17; // "NN_yyyyMMddHHmmss"
const ASC_FRAME_BYTES = 82;
const MAX_TAKE_BYTES = 128 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 15000;

// This firmware's own timings, measured on hardware. A download requested
// immediately after Stop comes back as error opcode FD: the device is still
// flushing the take to its storage. Wait, re-list, match the exact name Stop
// returned, wait again, THEN download.
const FLUSH_BEFORE_LIST_MS = 1500;
const SETTLE_BEFORE_DOWNLOAD_MS = 600;

// How often to ask the device "are you recording?" while we are connected and
// otherwise idle.
//
// This exists because the take the user cares about most is the one they started
// by pressing the button ON THE DEVICE, with the phone in a pocket. Two things
// could tell us about that, and only one of them is guaranteed:
//
//   * an UNSOLICITED opcode 03/04 pushed by the device. We handle it (see
//     onPacket -> onDeviceEvent) and it is instant when it happens — but NO
//     capture from the reference hardware shows the device ever sending one, so
//     it cannot be relied on.
//   * this poll, which is just the same read-only state query the connect
//     handshake already sends. It always works, at the cost of a few seconds of
//     latency and one tiny write every 3 s.
//
// So the poll is the floor and the push is the bonus. The poll NEVER runs while a
// command, a listing or a transfer is in flight — interleaving a query into a
// download is how you corrupt one.
const STATE_POLL_MS = 3000;

// How long to wait for the device to answer a connect.
//
// ble-plx's connectToDevice NEVER gives up on its own. With the connect driven
// by a screen that was fine — the user sees "Connecting…" and walks away — but
// the session now reconnects on a timer, and one attempt against a recorder that
// is simply switched off would hang forever, leave the "connecting" latch set,
// and stop every later retry. The feature would then be dead for the rest of the
// process with nothing in the log after the first line.
const CONNECT_TIMEOUT_MS = 15000;

export interface L816FoundDevice {
  id: string;
  name: string;
  rssi: number;
  /** Which model the advertised name says this is. The family default when it
   *  advertises only `2837` — see l816ModelOf. */
  model: L816Model;
}

// Every peripheral heard during a scan (diagnostics + manual pick), mirroring
// the pendant screen — a device that is on but not auto-matched is still findable.
export interface L816SeenDevice {
  id: string;
  name: string | null;
  rssi: number;
  hasL816Service: boolean;
  matched: boolean;
}

/** One recording as the DEVICE lists it. `size` is the list size, which is NOT
 *  the number of bytes a download transfers — only the opcode-07 ack says that. */
export interface L816File {
  name: string;
  size: number;
}

export interface L816Take {
  /** The device's own file name, `NN_yyyyMMddHHmmss`. */
  name: string;
  /**
   * The decoded WAV, ON DISK — never in the JS heap.
   *
   * 🛑 This used to be `wavBase64`, the whole recording as a string, and a real
   * take killed the app with it: `OutOfMemoryError: Failed to allocate a
   * 183468512 byte allocation ... growth limit 268435456`. Android's heap ceiling
   * is 256 MB and the decode path held four or five live copies of audio that is
   * already ~7.8x the ASC it came from. A path costs nothing to carry and the
   * upload streams straight from the file.
   */
  wavPath: string;
  /** `file://…` form of the same file, for APIs that want a URI. */
  wavUri: string;
  sampleRate: number;
  bytes: number; // WAV bytes (header included)
  durationMs: number;
}

/**
 * Something the DEVICE did on its own, with no app command behind it: the user
 * pressed record or stop on the hardware itself.
 *
 * `name` is present only when the device volunteered it (the opcode 03/04 push
 * carries one). The poll cannot know it — it only sees the state flip — so a
 * `stopped` event with no `file` means "a take just ended, go find out which".
 */
export type L816DeviceEvent =
  | { type: "started"; name?: string }
  | { type: "stopped"; file?: L816File };

export type L816Progress =
  | { phase: "waiting"; message: string }
  | { phase: "listing"; message: string }
  | { phase: "downloading"; message: string; percent: number }
  | { phase: "decoding"; message: string };

export interface L816Link {
  /** True when react-native-ble-plx is present (a dev build, not Expo Go). */
  isAvailable(): boolean;
  requestPermissions(): Promise<boolean>;
  /** Already granted? Asks nothing. The background reconnect uses this: popping
   *  a permission dialog out of nowhere at app launch is not acceptable, and a
   *  silent no simply means the link waits for the user to open the screen. */
  hasPermissions(): Promise<boolean>;
  startScan(
    onFound: (d: L816FoundDevice) => void,
    onSeen?: (d: L816SeenDevice) => void,
    onState?: (state: string) => void
  ): void;
  stopScan(): void;
  /** Connect + run the full setup handshake (MTU, 3 CCCDs in order, state query,
   *  clock sync). Resolves once the device is ready to take commands. */
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Release the radio without destroying the SHARED manager (RULE #2). */
  teardown(): void;
  /** True when the device was already recording when we connected — it keeps
   *  recording with the app closed, so this is a normal state, not an error. */
  isRecording(): boolean;
  /** True while a connection is actually held. */
  isConnected(): boolean;
  /**
   * The link DROPPED on its own — out of range, device off, radio reset.
   *
   * Nothing used to notice. The 3 s poll swallows its own failures (a missed
   * tick is normal), so a dead link looked exactly like an idle one: the screen
   * still said Connected, the notification still claimed a live connection, and
   * every take made after that point was invisible. Anything holding the link
   * across screens MUST subscribe and reconnect, or "keep it connected" is only
   * true until the user walks out of the room once.
   */
  onDisconnected(cb: () => void): { remove(): void };
  /** Start a recording on the device. Resolves with the file name it allocated. */
  startRecording(): Promise<string>;
  /** Stop recording. Resolves with the finished file and its listed size. */
  stopRecording(): Promise<L816File>;
  listFiles(): Promise<L816File[]>;
  /** Download one recording and decode it to a WAV, reporting progress. */
  fetchTake(file: L816File, onProgress?: (p: L816Progress) => void): Promise<L816Take>;
  /** Stop -> wait for the flush -> re-list -> match -> download -> decode. */
  stopAndFetch(onProgress?: (p: L816Progress) => void): Promise<L816Take>;
  /** Abort an in-flight transfer (the device stops sending). */
  cancelTransfer(): void;
  /**
   * Subscribe to record/stop the USER performed on the device itself. This is
   * what makes a take started by the hardware button reach SATE at all — without
   * it, such a take sits on the device until someone opens the file list.
   */
  onDeviceEvent(cb: (e: L816DeviceEvent) => void): { remove(): void };
  /**
   * Download + decode the take that appeared since `knownNames` was captured.
   * Used after a device-initiated stop, where nothing told us the file name.
   */
  fetchNewSince(
    knownNames: string[],
    onProgress?: (p: L816Progress) => void
  ): Promise<L816Take>;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `01_20260915145726` -> unix seconds. The device's clock is the one we set in
 *  connect(), so this is the phone's idea of when the take was made. */
export function takeTimestamp(name: string): number {
  const now = Math.floor(Date.now() / 1000);
  const m = name.match(/^\d{2}_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return now;
  const [, y, mo, d, h, mi, s] = m;
  const t = new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  if (!Number.isFinite(t)) return now;
  const secs = Math.floor(t / 1000);
  // These clocks lie. The reference unit really does list `01_20821119193921`
  // (year 2082) alongside takes from 2022 — a device whose clock was never set.
  // That value becomes `session_number`, and 3.5e9 does not fit in a 32-bit
  // integer column, so an otherwise fine recording would fail to upload on a
  // detail nobody would think to look at. Anything outside a sane window falls
  // back to now; the device's own file name is still shown next to the take.
  const FLOOR = 946_684_800; // 2000-01-01
  const CEILING = now + 86_400; // a day's clock skew
  return secs < FLOOR || secs > CEILING ? now : secs;
}

/**
 * `84:70:D0:0F:66:0E` -> `l816-8470D00F660E`. The serial ends up in a storage
 * key (`<user>/<serial>/<id>.wav`), so the colons come out here rather than in
 * an object path.
 *
 * 🛑 THE PREFIX IS THE MODEL, and it is permanent. It is written into the
 * storage path of every recording that unit ever makes, so calling an L815
 * `l816-…` is a false statement about the hardware that cannot be corrected
 * afterwards without moving objects. The MAC already makes the serial unique —
 * the prefix's only job is to say what the thing is, so it has to be right.
 *
 * The default is the family default, so every existing L816 keeps the exact
 * serial it has always had and nothing re-uploads or re-labels.
 *
 * ⚠️ Two tables on the WEB split on this prefix and must be kept in step, or a
 * unit uploads recordings that look fine while its hardware never appears in
 * Connected Recorders: `services/recordingName.ts` (which labels the take) and
 * `contexts/DeviceProvider.tsx` (`FAMILIES`, which synthesizes the device row).
 */
export function l816Serial(deviceId: string, model: L816Model = L816_DEFAULT_MODEL): string {
  return `${model}-${deviceId.replace(/[^0-9a-zA-Z]/g, "").toUpperCase()}`;
}

// ------------------------------------------------------------------ real

type Waiter = {
  op: number;
  resolve: (payload: Buffer) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

class NativeL816Link implements L816Link {
  private get manager(): BleManager {
    return getSharedBleManager();
  }
  private device: Device | null = null;
  private subs: Subscription[] = [];
  private scanStateSub: Subscription | null = null;
  private seenLog = new Set<string>();

  // Command-response reassembly. A BLE notification is NOT necessarily one whole
  // packet, and may carry more than one — buffer and re-scan on every arrival.
  private rxBuffer: Buffer = Buffer.alloc(0);
  private waiters: Waiter[] = [];

  private recording = false;
  private listing: L816File[] | null = null;

  // In-flight download. `expected` comes from the opcode-07 ack, never from the
  // list size — the two differ by design (list 204332 -> 26158 bytes transferred).
  private dl: {
    name: string;
    expected: number;
    bytes: number;
    chunks: Buffer[];
    onProgress?: (p: L816Progress) => void;
    resolve: (b: Buffer) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    eof: boolean;
  } | null = null;

  // The name Stop handed back, awaiting its download.
  private lastStopped: L816File | null = null;
  private deviceCbs = new Set<(e: L816DeviceEvent) => void>();
  private dropCbs = new Set<() => void>();
  private dropSub: { remove(): void } | null = null;
  // Set by disconnect()/teardown() so a drop WE caused does not look like the
  // device walking away — a reconnect loop would otherwise fight the user
  // closing the link.
  private closing = false;
  // Is OUR scan the one running on the shared manager?
  //
  // `stopScan()` reaches the SHARED BleManager's `stopDeviceScan()`, which is
  // global — it stops whoever is scanning, not just us. connect() used to call
  // it unconditionally, which was harmless while the only way to connect was
  // from the L816 screen (that screen had already taken the radio). Now the
  // session reconnects on its own while AUTO-SYNC owns the radio and is the only
  // background scanner, and stopping its scan from under it would quietly stop
  // SATE recorders being discovered — with nothing failing anywhere.
  private scanActive = false;
  private poll: ReturnType<typeof setInterval> | null = null;

  isAvailable() {
    return true;
  }

  async requestPermissions(): Promise<boolean> {
    if (Platform.OS !== "android") return true;
    const wanted =
      Platform.Version >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const res = await PermissionsAndroid.requestMultiple(wanted);
    return Object.values(res).every((v) => v === "granted");
  }

  async hasPermissions(): Promise<boolean> {
    if (Platform.OS !== "android") return true;
    const wanted =
      Platform.Version >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const got = await Promise.all(wanted.map((p) => PermissionsAndroid.check(p)));
    return got.every(Boolean);
  }

  // ---------------------------------------------------------------- scan

  startScan(
    onFound: (d: L816FoundDevice) => void,
    onSeen?: (d: L816SeenDevice) => void,
    onState?: (state: string) => void
  ): void {
    this.scanStateSub?.remove();
    this.seenLog.clear();
    this.scanActive = true;
    // One scan per manager: clear whatever auto-sync/SATE left running.
    try {
      this.manager.stopDeviceScan();
    } catch {
      /* nothing scanning */
    }
    this.scanStateSub = this.manager.onStateChange((state) => {
      console.log("[L816] BLE state:", state);
      onState?.(state);
      if (state !== "PoweredOn") return;
      this.scanStateSub?.remove();
      this.scanStateSub = null;
      // No service filter: the L816 does not reliably advertise its service UUID,
      // and the name can arrive in the scan response rather than the adv packet.
      // Match on either, and surface everything else for a manual pick.
      this.manager.startDeviceScan(null, { allowDuplicates: true }, (error, dev) => {
        if (error) {
          console.log("[L816] scan error:", error.message);
          return;
        }
        if (!dev) return;
        const services = (dev.serviceUUIDs ?? []).map((u) => u.toLowerCase());
        const hasService = services.includes(L816_SERVICE);
        const name = (dev.localName || dev.name || "").trim();
        const model = l816ModelOf(name);
        const nameMatches =
          (L816_MODELS as readonly string[]).some((m) => name.toLowerCase().includes(m)) ||
          /2837/i.test(name);
        const matched = nameMatches || hasService;

        if (!this.seenLog.has(dev.id)) {
          this.seenLog.add(dev.id);
          console.log(
            `[L816] saw ${dev.id} name=${JSON.stringify(dev.name)} ` +
              `local=${JSON.stringify(dev.localName)} svc=[${services.join(",")}] ` +
              `rssi=${dev.rssi} match=${matched}`
          );
        }

        onSeen?.({
          id: dev.id,
          name: name || null,
          rssi: dev.rssi ?? -100,
          hasL816Service: hasService,
          matched,
        });
        // The RAW advertised name, not the display name: the scan list is
        // diagnostics, and "what my phone actually hears" is the thing that tells
        // a user whether they are looking at their recorder.
        if (matched)
          onFound({ id: dev.id, name: name || "L816", rssi: dev.rssi ?? -100, model });
      });
    }, true);
  }

  stopScan(): void {
    this.scanStateSub?.remove();
    this.scanStateSub = null;
    // Only stop the radio if the scan running on it is ours — see scanActive.
    if (this.scanActive && hasSharedBleManager()) getSharedBleManager().stopDeviceScan();
    this.scanActive = false;
  }

  // ------------------------------------------------------------- connect

  async connect(deviceId: string): Promise<void> {
    this.stopScan();
    this.closing = false;
    const dev = await this.manager.connectToDevice(deviceId, {
      requestMTU: 247,
      timeout: CONNECT_TIMEOUT_MS,
    });
    await dev.discoverAllServicesAndCharacteristics();
    this.device = dev;
    this.rxBuffer = Buffer.alloc(0);

    // Tell anyone holding this link when it goes away by itself. Registered
    // BEFORE the handshake: a device that drops mid-setup is exactly the case
    // that used to leave a half-connected link nothing ever cleaned up.
    this.dropSub?.remove();
    this.dropSub = dev.onDisconnected(() => {
      if (this.closing) return;
      console.log("[L816] link dropped");
      this.stopPolling();
      this.cancelTransfer();
      this.failAll(new Error("The SATE L816 disconnected"));
      this.subs.forEach((s) => s.remove());
      this.subs = [];
      this.reset();
      this.dropCbs.forEach((cb) => cb());
    });

    // CCCD order is 1203a -> 1204a -> 1201a and it MATTERS: with only the first
    // two enabled, transfers stalled on this firmware. ble-plx serialises GATT
    // operations per connection, so issuing the subscriptions in this order is
    // enough; the short settle below covers the last descriptor write landing
    // before we start talking.
    this.subs.push(
      dev.monitorCharacteristicForService(L816_SERVICE, CHAR_CONTROL, (e, ch) => {
        if (e || !ch?.value) return;
        this.onControl(Buffer.from(ch.value, "base64"));
      })
    );
    this.subs.push(
      dev.monitorCharacteristicForService(L816_SERVICE, CHAR_DATA, (e, ch) => {
        if (e || !ch?.value) return;
        this.onData(Buffer.from(ch.value, "base64"));
      })
    );
    this.subs.push(
      dev.monitorCharacteristicForService(L816_SERVICE, CHAR_RECORD, (e, ch) => {
        if (e || !ch?.value) return;
        // 1201a carries file bytes too on this firmware, not just record events.
        this.onData(Buffer.from(ch.value, "base64"));
      })
    );
    await delay(400);

    // Is it already recording? It keeps going with the app closed, so this is a
    // normal state to come back to — payload 02 is the verified "idle" value.
    const state = await this.request(OP_STATE, Buffer.alloc(0), OP_STATE);
    this.recording = (state[0] ?? 2) !== 2;

    // Only sync the clock when idle: the file name the device allocates carries a
    // timestamp, and moving its clock mid-take is not worth finding out about.
    if (!this.recording) {
      const stamp = fmtDeviceTime(new Date());
      await this.request(OP_TIME, Buffer.from(stamp, "ascii"), OP_TIME);
    }

    this.startPolling();
  }

  // ------------------------------------------------- device-initiated takes

  /**
   * Watch for the user pressing record/stop ON THE DEVICE.
   *
   * See STATE_POLL_MS for why this exists alongside the unsolicited-packet path.
   * The guards are the important part: a state query written into the middle of a
   * download would be interleaved with audio notifications, and `waiters.length`
   * covers any command already awaiting its own reply.
   */
  private startPolling(): void {
    this.stopPolling();
    this.poll = setInterval(() => {
      if (!this.device) return;
      if (this.dl || this.listing || this.waiters.length > 0) return;
      const before = this.recording;
      this.request(OP_STATE, Buffer.alloc(0), OP_STATE)
        .then((state) => {
          const now = (state[0] ?? 2) !== 2;
          if (now === before) return;
          this.recording = now;
          // The poll only sees the state FLIP — it never learns a file name, so
          // `stopped` goes out without one and the screen diffs the file list to
          // work out which take is new.
          this.emitDeviceEvent(now ? { type: "started" } : { type: "stopped" });
        })
        .catch(() => {
          /* a missed poll is not an error; the next tick retries */
        });
    }, STATE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.dropSub?.remove();
    this.dropSub = null;
    this.stopPolling();
    this.cancelTransfer();
    this.failAll(new Error("Disconnected"));
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    try {
      if (this.device) await this.manager.cancelDeviceConnection(this.device.id);
    } catch {
      /* already gone */
    }
    this.reset();
  }

  teardown(): void {
    // Never destroys the shared manager — see RULE #2.
    this.closing = true;
    this.dropSub?.remove();
    this.dropSub = null;
    this.stopPolling();
    this.stopScan();
    this.cancelTransfer();
    this.failAll(new Error("Bluetooth released"));
    this.subs.forEach((s) => s.remove());
    this.subs = [];
    if (this.device && hasSharedBleManager()) {
      getSharedBleManager().cancelDeviceConnection(this.device.id).catch(() => {});
    }
    this.reset();
  }

  private reset(): void {
    this.device = null;
    this.recording = false;
    this.listing = null;
    this.lastStopped = null;
    this.rxBuffer = Buffer.alloc(0);
  }

  isRecording(): boolean {
    return this.recording;
  }

  isConnected(): boolean {
    return this.device !== null;
  }

  onDisconnected(cb: () => void) {
    this.dropCbs.add(cb);
    return { remove: () => this.dropCbs.delete(cb) };
  }

  // ------------------------------------------------------------ commands

  private async send(opcode: number, payload: Buffer): Promise<void> {
    if (!this.device) throw new Error("L816 is not connected");
    // The length byte is a legacy field: opcode 07 always declares 0x13 (19)
    // although it carries 21 bytes. Mirroring the device's own quirk is what
    // makes it accept the request at all.
    const len = opcode === OP_DOWNLOAD ? 19 : payload.length + 1;
    const packet = Buffer.concat([
      Buffer.from([0x55, 0xaa, len & 0xff, opcode & 0xff]),
      payload,
    ]);
    await this.device.writeCharacteristicWithoutResponseForService(
      L816_SERVICE,
      CHAR_TX,
      packet.toString("base64")
    );
  }

  /** Send and wait for one specific response opcode. */
  private request(opcode: number, payload: Buffer, expect: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`L816 did not answer opcode ${opcode} within 15 s`));
      }, RESPONSE_TIMEOUT_MS);
      this.waiters.push({ op: expect, resolve, reject, timer });
      this.send(opcode, payload).catch((e) => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(e);
      });
    });
  }

  /**
   * Hand a response to whoever asked for it. Returns FALSE when nobody did —
   * which is the whole signal for "the user pressed a button on the device", so
   * this must stay a boolean and callers must not ignore it.
   */
  private settle(op: number, payload: Buffer): boolean {
    const i = this.waiters.findIndex((w) => w.op === op);
    if (i < 0) return false;
    const [w] = this.waiters.splice(i, 1);
    clearTimeout(w.timer);
    w.resolve(payload);
    return true;
  }

  private emitDeviceEvent(e: L816DeviceEvent): void {
    console.log("[L816] device event:", JSON.stringify(e));
    this.deviceCbs.forEach((cb) => cb(e));
  }

  onDeviceEvent(cb: (e: L816DeviceEvent) => void) {
    this.deviceCbs.add(cb);
    return { remove: () => this.deviceCbs.delete(cb) };
  }

  private failAll(e: Error): void {
    const list = this.waiters;
    this.waiters = [];
    list.forEach((w) => {
      clearTimeout(w.timer);
      w.reject(e);
    });
  }

  // --------------------------------------------------- response decoding

  private onControl(chunk: Buffer): void {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);
    const buf = this.rxBuffer;
    let pos = 0;
    while (buf.length - pos >= 4) {
      if (buf[pos] !== 0xaa || buf[pos + 1] !== 0x55) {
        pos++;
        continue;
      }
      const len = buf[pos + 2];
      if (len < 1) {
        pos++;
        continue;
      }
      const op = buf[pos + 3];
      // Legacy length quirk: 03 declares 0x0F but carries a 17-byte name, and
      // 04/05/07 declare 0x13 but carry a name AND a 4-byte size. Each is three
      // bytes longer than length+3. Miss this and the parser loses every
      // following packet, which looks like a dead device.
      const extra =
        (len === 15 && op === OP_START) ||
        (len === 19 && (op === OP_STOP || op === OP_LIST || op === OP_DOWNLOAD))
          ? 3
          : 0;
      const total = len + 3 + extra;
      if (buf.length - pos < total) break;
      this.onPacket(op, sub(buf, pos + 4, pos + total));
      pos += total;
    }
    this.rxBuffer = sub(buf, pos);
  }

  private onPacket(op: number, payload: Buffer): void {
    switch (op) {
      case OP_STATE:
      case OP_TIME:
        this.settle(op, payload);
        return;

      case OP_START: {
        const wasRecording = this.recording;
        this.recording = true;
        // Nobody waiting for a start ack => the device started on its own, i.e.
        // the user pressed record on the hardware.
        if (!this.settle(op, payload) && !wasRecording) {
          const name =
            payload.length >= NAME_BYTES
              ? stripNuls(sub(payload, 0, NAME_BYTES).toString("ascii"))
              : undefined;
          this.emitDeviceEvent({ type: "started", name });
        }
        return;
      }

      case OP_STOP: {
        const wasRecording = this.recording;
        this.recording = false;
        if (payload.length >= NAME_BYTES + 4) {
          this.lastStopped = {
            name: stripNuls(sub(payload, 0, NAME_BYTES).toString("ascii")),
            size: payload.readUInt32BE(NAME_BYTES),
          };
        }
        // Nobody waiting for a stop ack => the user stopped on the hardware.
        // `lastStopped` is already set above, so the take is identified and the
        // screen can pull it straight down.
        if (!this.settle(op, payload) && wasRecording) {
          this.emitDeviceEvent({ type: "stopped", file: this.lastStopped ?? undefined });
        }
        return;
      }

      case OP_LIST:
        if (this.listing && payload.length >= 5) {
          this.listing.push({
            // The trailing four bytes are the size; everything before is the
            // name (NUL-padded on some entries).
            name: stripNuls(sub(payload, 0, payload.length - 4).toString("utf8")),
            size: payload.readUInt32BE(payload.length - 4),
          });
        }
        return;

      case OP_LIST_END:
        this.settle(OP_LIST_END, payload);
        return;

      case OP_DOWNLOAD:
        this.onDownloadAck(payload);
        return;

      case OP_EOF:
        if (this.dl) {
          this.dl.eof = true;
          this.maybeFinishDownload();
        }
        return;

      default:
        // 0xFB..0xFF are device errors. The one seen in practice is FD, returned
        // when a download is requested before the take has finished flushing.
        if (op >= 0xfb) {
          const e = new Error(
            `L816 returned error opcode 0x${op.toString(16).toUpperCase()}`
          );
          this.failDownload(e);
          this.failAll(e);
        }
    }
  }

  private onData(chunk: Buffer): void {
    const dl = this.dl;
    if (!dl) {
      // Bytes on 1201a/1204a with NO transfer running. The reference app drops
      // these on the floor — but 1201a is literally named "Record Notify" in the
      // vendor's own documentation, so if this device ever announces a
      // button-press, this is the most likely place it does it and nobody has
      // ever looked. Log it rather than discard it: one line here is the
      // difference between finding that channel and never knowing it existed.
      console.log(`[L816] notify outside transfer (${chunk.length}B): ${chunk.toString("hex")}`);
      return;
    }
    // Audio can arrive BEFORE the opcode-07 acknowledgment, and that is normal.
    // The ack comes in on 1203a while the audio comes in on 1204a/1201a, and
    // ble-plx gives each characteristic its own subscription — so JS sees no
    // ordering guarantee BETWEEN them, even though the device sent the ack first.
    // Treating early audio as an error (as the reference Android client does,
    // where a single callback queue hides the race) failed real transfers with
    // "sent audio before acknowledging the download". Keep the bytes; validate
    // them the moment the ack lands.
    dl.chunks.push(chunk);
    dl.bytes += chunk.length;
    if (dl.expected >= 0 && dl.bytes > dl.expected) {
      this.failDownload(new Error("L816 sent more audio than it said it would"));
      return;
    }
    this.armDownloadTimeout();
    if (dl.expected > 0) {
      dl.onProgress?.({
        phase: "downloading",
        message: "Downloading from L816",
        percent: Math.round((dl.bytes / dl.expected) * 100),
      });
    }
    this.maybeFinishDownload();
  }

  // ------------------------------------------------------------ recording

  async startRecording(): Promise<string> {
    if (this.recording) throw new Error("L816 is already recording");
    const ack = await this.request(OP_START, Buffer.alloc(0), OP_START);
    return stripNuls(sub(ack, 0, NAME_BYTES).toString("ascii"));
  }

  async stopRecording(): Promise<L816File> {
    if (!this.recording) throw new Error("L816 is not recording");
    const ack = await this.request(OP_STOP, Buffer.alloc(0), OP_STOP);
    if (ack.length < NAME_BYTES + 4) throw new Error("L816 did not name the recording");
    const file = {
      name: stripNuls(sub(ack, 0, NAME_BYTES).toString("ascii")),
      size: ack.readUInt32BE(NAME_BYTES),
    };
    this.lastStopped = file;
    return file;
  }

  async listFiles(): Promise<L816File[]> {
    this.listing = [];
    try {
      await this.request(OP_LIST, Buffer.alloc(0), OP_LIST_END);
    } catch (e) {
      // Leaving `listing` set would make the NEXT list append to this one, so a
      // timed-out listing must not poison the retry.
      this.listing = null;
      throw e;
    }
    const files = this.listing ?? [];
    this.listing = null;
    return files;
  }

  // ------------------------------------------------------------ download

  private armDownloadTimeout(): void {
    const dl = this.dl;
    if (!dl) return;
    clearTimeout(dl.timer);
    dl.timer = setTimeout(
      () => this.failDownload(new Error("L816 stopped sending audio (15 s of silence)")),
      RESPONSE_TIMEOUT_MS
    );
  }

  private onDownloadAck(payload: Buffer): void {
    const dl = this.dl;
    if (!dl || payload.length < NAME_BYTES + 4) return;
    const name = stripNuls(sub(payload, 0, NAME_BYTES).toString("utf8"));
    if (name !== dl.name) {
      this.failDownload(new Error(`L816 acknowledged a different file (${name})`));
      return;
    }
    const expected = payload.readUInt32BE(NAME_BYTES);
    // The ack size — NOT the list size — is the number of bytes that will arrive.
    // A take that is not whole 82-byte frames cannot be decoded, so refuse it now
    // rather than after a minute of transfer.
    if (expected <= 0 || expected > MAX_TAKE_BYTES || expected % ASC_FRAME_BYTES !== 0) {
      this.failDownload(new Error(`L816 reported an unusable size (${expected} bytes)`));
      return;
    }
    dl.expected = expected;
    // Bytes that beat the ack are already buffered — validate them now.
    if (dl.bytes > expected) {
      this.failDownload(new Error("L816 sent more audio than it said it would"));
      return;
    }
    this.armDownloadTimeout();
    this.maybeFinishDownload();
  }

  private maybeFinishDownload(): void {
    const dl = this.dl;
    if (!dl) return;
    if (!dl.eof || dl.expected < 0 || dl.bytes !== dl.expected) return;
    // Complete ONLY on EOF **and** an exact byte match. A take that merely
    // stopped arriving is a truncated recording, and a truncated recording that
    // uploads successfully is indistinguishable from a real one.
    clearTimeout(dl.timer);
    this.dl = null;
    dl.resolve(Buffer.concat(dl.chunks));
  }

  private failDownload(e: Error): void {
    const dl = this.dl;
    if (!dl) return;
    clearTimeout(dl.timer);
    this.dl = null;
    dl.reject(e);
  }

  cancelTransfer(): void {
    if (!this.dl) return;
    this.send(OP_CANCEL, Buffer.alloc(0)).catch(() => {});
    this.failDownload(new Error("Download cancelled"));
  }

  private downloadAsc(
    file: L816File,
    onProgress?: (p: L816Progress) => void
  ): Promise<Buffer> {
    if (!/^\d{2}_\d{14}$/.test(file.name)) {
      return Promise.reject(
        new Error(`Unexpected L816 file name "${file.name}" — expected NN_yyyyMMddHHmmss`)
      );
    }
    if (this.dl) return Promise.reject(new Error("A download is already running"));

    return new Promise<Buffer>((resolve, reject) => {
      this.dl = {
        name: file.name,
        expected: -1,
        bytes: 0,
        chunks: [],
        onProgress,
        resolve,
        reject,
        eof: false,
        timer: setTimeout(
          () => this.failDownload(new Error("L816 did not start the download")),
          RESPONSE_TIMEOUT_MS
        ),
      };
      // `<name17><offset BE32>` — offset 0: resume is not supported by this
      // firmware path, a failed transfer is simply repeated from the start.
      const payload = Buffer.alloc(NAME_BYTES + 4);
      payload.write(file.name, 0, NAME_BYTES, "ascii");
      payload.writeUInt32BE(0, NAME_BYTES);
      onProgress?.({ phase: "downloading", message: "Asking L816 for the take", percent: 0 });
      this.send(OP_DOWNLOAD, payload).catch((e) => this.failDownload(e));
    });
  }

  async fetchTake(file: L816File, onProgress?: (p: L816Progress) => void): Promise<L816Take> {
    const asc = await this.downloadAsc(file, onProgress);
    onProgress?.({ phase: "decoding", message: "Converting the recording…" });
    // Decoded straight to a file: the byte count comes back with it, so nothing
    // has to materialise the audio just to measure it.
    const wav = await decodeAscToWavFile(asc.toString("base64"));
    return {
      name: file.name,
      wavPath: wav.path,
      wavUri: wav.uri,
      sampleRate: wav.sampleRate || 16000,
      bytes: wav.bytes,
      durationMs: Math.round(((wav.bytes - 44) / (16000 * 2)) * 1000),
    };
  }

  /**
   * Pull the take that appeared since `knownNames` was captured.
   *
   * Used after a device-initiated stop that carried no file name (the poll can
   * only see the state flip). Diffing the list is the only evidence available —
   * and it is better evidence than "the last entry", because these devices do not
   * list in a guaranteed order and a second take would silently win.
   */
  async fetchNewSince(
    knownNames: string[],
    onProgress?: (p: L816Progress) => void
  ): Promise<L816Take> {
    onProgress?.({ phase: "waiting", message: "Saving the recording on the device…" });
    await delay(FLUSH_BEFORE_LIST_MS);

    onProgress?.({ phase: "listing", message: "Looking for the new recording…" });
    const files = await this.listFiles();
    const known = new Set(knownNames);
    const fresh = files.filter((f) => !known.has(f.name));
    if (fresh.length === 0) {
      throw new Error("The device did not list a new recording");
    }
    // More than one new entry means we missed a take (the app was closed for a
    // while). Take the most recent by the timestamp in its own name — and leave
    // the rest in the list, where the user can still reach them.
    fresh.sort((a, b) => takeTimestamp(b.name) - takeTimestamp(a.name));

    await delay(SETTLE_BEFORE_DOWNLOAD_MS);
    const take = await this.fetchTake(fresh[0], onProgress);
    this.lastStopped = null;
    return take;
  }

  async stopAndFetch(onProgress?: (p: L816Progress) => void): Promise<L816Take> {
    const stopped = this.recording ? await this.stopRecording() : this.lastStopped;
    if (!stopped) throw new Error("There is no finished recording to download");

    // The device is still writing the take to its own storage. Asking now comes
    // back as error opcode FD, so wait, re-list, and match the EXACT name Stop
    // returned — never "the last entry in the list", which is a different take
    // the moment anything else is on the device.
    onProgress?.({ phase: "waiting", message: "Saving the recording on the device…" });
    await delay(FLUSH_BEFORE_LIST_MS);

    onProgress?.({ phase: "listing", message: "Looking for the new recording…" });
    const files = await this.listFiles();
    const match = files.find((f) => f.name === stopped.name);
    if (!match) throw new Error(`L816 did not list the new recording (${stopped.name})`);

    await delay(SETTLE_BEFORE_DOWNLOAD_MS);
    const take = await this.fetchTake(match, onProgress);
    this.lastStopped = null;
    return take;
  }
}

/**
 * A Buffer slice that is STILL a Buffer. Never call `.subarray()` on a Buffer in
 * this file — use this.
 *
 * The `buffer` polyfill React Native ships (v6.0.3) patches `Buffer.prototype.
 * slice` and explicitly re-sets the result's prototype back to `Buffer`. It does
 * NOT patch `subarray`, so under Hermes that falls through to
 * `Uint8Array.prototype.subarray` and hands back a plain Uint8Array. Which
 * breaks in two ways, and the quiet one is the dangerous one:
 *
 *   - `readUInt32BE` is simply missing -> "TypeError: undefined is not a
 *     function" the first time a file entry is parsed. This crashed the app on
 *     connect, because listing runs as part of the connect handshake.
 *   - `toString("utf8")` still EXISTS on a Uint8Array. It ignores the encoding
 *     argument and returns `"48,49,95,50,48..."` — a recording named as
 *     comma-separated digits, with no error anywhere.
 *
 * None of this reproduces off-device: Node's V8 honours `Symbol.species` and
 * returns a real Buffer from `subarray`, so a unit test on the laptop passes
 * while the phone crashes.
 */
function sub(b: Buffer, start: number, end?: number): Buffer {
  return b.slice(start, end);
}

/** Some entries are NUL-padded to the fixed 17-byte name field. */
function stripNuls(s: string): string {
  return s.split("\0").join("").trim();
}

/** The device's clock format: 14 ASCII digits, `yyyyMMddHHmmss`, phone-local. */
function fmtDeviceTime(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function makeL816Link(): L816Link {
  return new NativeL816Link();
}
