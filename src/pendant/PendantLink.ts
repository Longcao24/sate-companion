// SATE Pendant link — connect to the Sona/Nuna pendant (Seeed XIAO nRF52840
// Sense) over STANDARD BLE GATT and capture its live audio. Unlike Plaud (a
// proprietary arm64 SDK) the pendant is plain react-native-ble-plx — the same
// stack SATE recorders use — so there's no binding/lock concern.
//
// It streams raw 16-bit PCM (no codec): each notification is 244 bytes = 122
// int16 LE samples at 16 kHz mono. We accumulate a take, wrap it in a WAV
// header, and push it through the SAME upload path as everything else
// (api.uploadSession -> device-api -> AI -> recordings), device_serial
// `pendant-<id>`.
//
// See doc "Sona / Nuna Pendant — BLE Integration Guide".

import { Buffer } from "buffer";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, Device, Subscription } from "react-native-ble-plx";
import { getSharedBleManager, hasSharedBleManager } from "../ble/bleManager";

// ---- GATT profile (from the pendant firmware xiao_audio_ble.ino) ----
export const PENDANT_NAME = "SATE Pendant";
// Lowercase to match react-native-ble-plx's normalized UUIDs (see SATE_SERVICE).
const AUDIO_SERVICE = "19b10000-e8f2-537e-4f6c-d104768a1214";
const AUDIO_CHAR = "19b10001-e8f2-537e-4f6c-d104768a1214"; // notify: 244B PCM
const CONTROL_CHAR = "19b10002-e8f2-537e-4f6c-d104768a1214"; // write: 1 byte cmd
const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb";
const SAMPLE_RATE = 16000;

// Control commands.
const CMD_STOP = 0x00;
const CMD_START = 0x01;
const CMD_FIND_ME = 0x02;

export interface PendantFoundDevice {
  id: string;
  name: string;
  rssi: number;
}

// Every BLE peripheral the phone hears during a scan (diagnostics + manual pick).
export interface PendantSeenDevice {
  id: string;
  name: string | null; // best available name (localName ?? name)
  rssi: number;
  hasAudioService: boolean;
  matched: boolean; // passed the pendant auto-match
}

export interface PendantBattery {
  percent: number; // 0..100
  charging: boolean;
}

export interface PendantTake {
  wavBase64: string;
  sampleRate: number;
  bytes: number;
  durationMs: number;
}

export interface PendantLink {
  /** True when react-native-ble-plx is present (a dev build, not Expo Go). */
  isAvailable(): boolean;
  requestPermissions(): Promise<boolean>;
  /** Scan for pendants. `onFound` fires for auto-matched devices; the optional
   *  `onSeen` fires for EVERY peripheral heard (diagnostics + manual pick);
   *  `onState` reports the BLE adapter state (PoweredOn / Unauthorized / …). */
  startScan(
    onFound: (d: PendantFoundDevice) => void,
    onSeen?: (d: PendantSeenDevice) => void,
    onState?: (state: string) => void
  ): void;
  stopScan(): void;
  /** Connect, request MTU, subscribe to audio + battery notifications. */
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Fully release the BLE manager (hand the radio back to the SATE stack). */
  teardown(): void;
  /** Tell the pendant to begin streaming (0x01). Audio accumulates internally. */
  start(): Promise<void>;
  /** Stop streaming (0x00). */
  stop(): Promise<void>;
  /** Flash the pendant LED ~5s to locate it (0x02). */
  findMe(): Promise<void>;
  /** Bytes of PCM captured so far (for a live duration readout). */
  capturedMs(): number;
  /** Pull the accumulated take as a WAV and reset the buffer for the next one. */
  takeWav(): PendantTake;
  /** Subscribe to battery updates ({percent, charging}). */
  onBattery(cb: (b: PendantBattery) => void): { remove(): void };
  /** Subscribe to raw audio activity (bytes) — e.g. to show a live level/gap. */
  onAudio(cb: (bytes: number) => void): { remove(): void };
}

// The raw pendant mic is very quiet. Rather than a fixed gain (which is too
// little for a faint take and clips a loud one), PEAK-NORMALIZE: find the take's
// loudest sample and scale so it just reaches ~92% full-scale. This adapts to
// however quiet the recording is. Guards: never attenuate (gain ≥ 1), and cap
// the gain so a near-silent take doesn't amplify the noise floor to a roar. A
// tanh soft-clip on top keeps any residual peak inside int16 range cleanly.
const TARGET_PEAK = 0.97 * 32767;
const MAX_GAIN = 40; // ceiling so silence/noise isn't blown up to full scale
// Perceived-loudness drive ON TOP of peak-normalize: pushes the signal past the
// peak so tanh compresses the loud parts and lifts the quiet parts — the whole
// take sounds louder (like a limiter). Higher = louder + more compressed. If it
// starts sounding harsh/"rè", lower this toward 1.5.
const LOUDNESS = 2.6;

function applyGain(pcm: Buffer): Buffer {
  const n = pcm.length - (pcm.length % 2);
  let peak = 1;
  for (let i = 0; i + 1 < n; i += 2) {
    const a = Math.abs(pcm.readInt16LE(i));
    if (a > peak) peak = a;
  }
  const gain = Math.min(MAX_GAIN, Math.max(1, TARGET_PEAK / peak)) * LOUDNESS;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < n; i += 2) {
    const s = pcm.readInt16LE(i);
    const v = Math.round(32767 * Math.tanh((s * gain) / 32767));
    out.writeInt16LE(v, i);
  }
  return out;
}

// 16 kHz / mono / 16-bit PCM WAV header + samples.
function pcmToWavBase64(rawPcm: Buffer): string {
  const pcm = applyGain(rawPcm);
  const dataLen = pcm.length;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcm]).toString("base64");
}

// ------------------------------------------------------------------ real

class NativePendantLink implements PendantLink {
  // Shares the app-wide BleManager with SATE (see ble/bleManager.ts). Using a
  // SECOND ble-plx manager — or destroying/recreating one — makes iOS return an
  // empty scan, which is what stopped the pendant from ever being found.
  private get manager(): BleManager {
    return getSharedBleManager();
  }
  private device: Device | null = null;
  private audioSub: Subscription | null = null;
  private batterySub: Subscription | null = null;
  private scanStateSub: Subscription | null = null;
  private chunks: Buffer[] = [];
  private capturedBytes = 0;
  // True only between start() and stop(). BLE notifications keep arriving for a
  // moment after CMD_STOP (in-flight packets), which used to bump the duration to
  // 0:01/0:02 after the user stopped. Gating accumulation on this drops those.
  private capturing = false;
  private batteryCbs = new Set<(b: PendantBattery) => void>();
  private audioCbs = new Set<(bytes: number) => void>();
  private seenLog = new Set<string>(); // ids already logged this scan (diagnostics)

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

  startScan(
    onFound: (d: PendantFoundDevice) => void,
    onSeen?: (d: PendantSeenDevice) => void,
    onState?: (state: string) => void
  ): void {
    // Wait for the adapter to reach PoweredOn (fires now if already on).
    this.scanStateSub?.remove();
    this.seenLog.clear();
    // Clear any scan SATE/auto-sync may have left running on the shared manager —
    // ble-plx allows only one scan per manager, so a stale one would block ours.
    try {
      this.manager.stopDeviceScan();
    } catch {
      /* nothing scanning */
    }
    this.scanStateSub = this.manager.onStateChange((state) => {
      console.log("[Pendant] BLE state:", state);
      onState?.(state);
      if (state !== "PoweredOn") return;
      this.scanStateSub?.remove();
      this.scanStateSub = null;
      // Scan with NO service filter. This pendant (XIAO nRF52840) advertises the
      // audio SERVICE UUID in the adv packet but its NAME only in the SCAN
      // RESPONSE — iOS surfaces those as `serviceUUIDs` and `localName`, and can
      // deliver them across SEPARATE callbacks. allowDuplicates:true lets us see
      // every sighting so a name-only or service-only advert still matches.
      this.manager.startDeviceScan(
        null,
        { allowDuplicates: true },
        (error, dev) => {
          if (error) {
            console.log("[Pendant] scan error:", error.message);
            return;
          }
          if (!dev) return;
          const services = (dev.serviceUUIDs ?? []).map((u) => u.toLowerCase());
          const advertisesAudio = services.includes(AUDIO_SERVICE);
          // iOS may report a STALE cached GAP name in `dev.name` (e.g. an old
          // "Nuna-Necklace"/"friends") while the live scan-response name lands in
          // `localName`. Test BOTH so a cached name can't hide the pendant — and
          // the advertised audio service is the ground-truth fallback either way.
          const nameMatches =
            /sate|pendant|nuna/i.test(dev.name ?? "") ||
            /sate|pendant|nuna/i.test(dev.localName ?? "");
          const name = (dev.localName || dev.name || "").trim();

          // Log each peripheral once so we can see exactly what iOS reports.
          const matched = nameMatches || advertisesAudio;

          if (!this.seenLog.has(dev.id)) {
            this.seenLog.add(dev.id);
            console.log(
              `[Pendant] saw ${dev.id} name=${JSON.stringify(dev.name)} ` +
                `local=${JSON.stringify(dev.localName)} svc=[${services.join(",")}] ` +
                `rssi=${dev.rssi} match=${matched}`
            );
          }

          // Diagnostics / manual-pick: report EVERY peripheral heard.
          onSeen?.({
            id: dev.id,
            name: dev.localName || dev.name || null,
            rssi: dev.rssi ?? -100,
            hasAudioService: advertisesAudio,
            matched,
          });

          if (!matched) return;
          onFound({ id: dev.id, name: name || PENDANT_NAME, rssi: dev.rssi ?? -100 });
        }
      );
    }, true);
  }

  stopScan(): void {
    this.scanStateSub?.remove();
    this.scanStateSub = null;
    if (hasSharedBleManager()) getSharedBleManager().stopDeviceScan();
  }

  async connect(deviceId: string): Promise<void> {
    this.stopScan();
    const dev = await this.manager.connectToDevice(deviceId, { requestMTU: 247 });
    await dev.discoverAllServicesAndCharacteristics();
    this.device = dev;

    // Audio notifications: 244B raw PCM per packet → accumulate.
    this.audioSub = dev.monitorCharacteristicForService(
      AUDIO_SERVICE,
      AUDIO_CHAR,
      (error, ch) => {
        if (error || !ch?.value) return;
        if (!this.capturing) return; // drop packets arriving after stop()
        const buf = Buffer.from(ch.value, "base64");
        this.chunks.push(buf);
        this.capturedBytes += buf.length;
        this.audioCbs.forEach((cb) => cb(buf.length));
      }
    );

    // Battery: byte where bit7 = charging, low 7 bits = percent.
    try {
      this.batterySub = dev.monitorCharacteristicForService(
        BATTERY_SERVICE,
        BATTERY_CHAR,
        (error, ch) => {
          if (error || !ch?.value) return;
          const raw = Buffer.from(ch.value, "base64")[0] ?? 0;
          const b = { percent: raw & 0x7f, charging: (raw & 0x80) !== 0 };
          this.batteryCbs.forEach((cb) => cb(b));
        }
      );
    } catch {
      /* battery is optional */
    }
  }

  private async writeControl(cmd: number): Promise<void> {
    if (!this.device) throw new Error("Pendant not connected");
    await this.device.writeCharacteristicWithResponseForService(
      AUDIO_SERVICE,
      CONTROL_CHAR,
      Buffer.from([cmd]).toString("base64")
    );
  }

  start(): Promise<void> {
    // Clear any leftover PCM before a new take. Only takeWav()/teardown() reset
    // these, so a start that follows a stop-without-takeWav (e.g. an upload error
    // dropped the link, or a reconnect) would otherwise PREFIX the new recording
    // with the previous take's audio and inflate capturedMs — cross-take
    // contamination. Reset here so every start() begins from an empty buffer.
    this.chunks = [];
    this.capturedBytes = 0;
    this.capturing = true;
    return this.writeControl(CMD_START);
  }
  stop(): Promise<void> {
    // Stop accumulating FIRST so in-flight packets during the CMD_STOP round-trip
    // don't tack extra tenths onto the take (the 0:01/0:02-after-stop bug).
    this.capturing = false;
    return this.writeControl(CMD_STOP);
  }
  findMe(): Promise<void> {
    return this.writeControl(CMD_FIND_ME);
  }

  capturedMs(): number {
    // 16-bit mono @ 16 kHz → 2 bytes/sample.
    return Math.round((this.capturedBytes / (SAMPLE_RATE * 2)) * 1000);
  }

  takeWav(): PendantTake {
    const pcm = Buffer.concat(this.chunks);
    const durationMs = this.capturedMs();
    const wavBase64 = pcmToWavBase64(pcm);
    const bytes = pcm.length + 44;
    this.chunks = [];
    this.capturedBytes = 0;
    return { wavBase64, sampleRate: SAMPLE_RATE, bytes, durationMs };
  }

  onBattery(cb: (b: PendantBattery) => void) {
    this.batteryCbs.add(cb);
    return { remove: () => this.batteryCbs.delete(cb) };
  }
  onAudio(cb: (bytes: number) => void) {
    this.audioCbs.add(cb);
    return { remove: () => this.audioCbs.delete(cb) };
  }

  async disconnect(): Promise<void> {
    this.audioSub?.remove();
    this.batterySub?.remove();
    this.audioSub = null;
    this.batterySub = null;
    try {
      await this.stop().catch(() => {});
      if (this.device) await this.manager.cancelDeviceConnection(this.device.id);
    } catch {
      /* ignore */
    }
    this.device = null;
    // Drop any un-taken PCM so it can't leak into the next connection's take.
    this.chunks = [];
    this.capturedBytes = 0;
  }

  teardown(): void {
    // NOTE: does NOT destroy the manager — it's SHARED with SATE. Destroying it
    // here (and letting SATE recreate it) is exactly what broke scanning. We just
    // stop scanning and drop our connection; SATE keeps using the same manager.
    this.stopScan();
    this.audioSub?.remove();
    this.batterySub?.remove();
    if (this.device && hasSharedBleManager()) {
      getSharedBleManager().cancelDeviceConnection(this.device.id).catch(() => {});
    }
    this.device = null;
    this.chunks = [];
    this.capturedBytes = 0;
  }
}

// The BleManager is built lazily on first use (same as SATE's BleLink), so this
// never throws at construction — a dev build is required to actually scan.
export function makePendantLink(): PendantLink {
  return new NativePendantLink();
}
