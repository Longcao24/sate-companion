// BLE link to a SATE Recorder: scanning, provisioning, and bridge sync.
// One interface (SateLink) with two implementations: real (react-native-ble-plx)
// and mock (demo mode, no hardware).

import { Buffer } from "buffer";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, Device, Subscription } from "react-native-ble-plx";
import {
  ADV_FLAG_NEEDS_SYNC,
  ADV_FLAG_UNPROVISIONED,
  ADV_MAGIC,
  BleCommand,
  CHAR_CONTROL,
  CHAR_DATA,
  CHAR_INFO,
  CHAR_STATUS,
  DeviceIdentity,
  FRAME_FINAL,
  FRAME_PARTIAL,
  Patient,
  PendingSession,
  ProvisionState,
  SATE_SERVICE,
  WifiNetwork,
} from "../protocol";

export interface FoundDevice {
  id: string; // BLE id
  name: string;
  rssi: number;
  unprovisioned: boolean;
  needsSync: boolean;
  pending: number;
}

export interface ProvisionProgress {
  state: ProvisionState;
  ip?: string;
  deviceId?: string;
  msg?: string;
}

export interface SateLink {
  requestPermissions(): Promise<boolean>;
  startScan(onFound: (d: FoundDevice) => void): void;
  stopScan(): void;
  connect(id: string): Promise<void>;
  disconnect(): Promise<void>;
  getInfo(): Promise<DeviceIdentity>;
  scanWifi(): Promise<WifiNetwork[]>;
  provision(
    args: { ssid: string; pass: string; server: string; claim_token: string },
    onProgress: (p: ProvisionProgress) => void
  ): Promise<ProvisionProgress>;
  /** Move an ALREADY-claimed recorder to a new Wi-Fi network. Keeps the account
   *  and device key — no re-registration. Resolves on "wifi_saved" or "error". */
  changeWifi(
    args: { ssid: string; pass: string },
    onProgress: (p: ProvisionProgress) => void
  ): Promise<ProvisionProgress>;
  listSessions(): Promise<PendingSession[]>;
  pullSession(
    n: number,
    onProgress: (received: number, total: number) => void
  ): Promise<{ wavBase64: string; meta: any }>;
  markSynced(n: number): Promise<void>;
  setPatients(patients: Patient[]): Promise<void>;
  /** Direct control while connected over BLE (device has no Wi-Fi). */
  sendCommand(op: BleCommand): Promise<void>;
  /** Fully release the Bluetooth radio: stop scanning, drop any connection,
   *  and DESTROY the underlying CBCentralManager (not just stopScan). Used
   *  before handing the radio to the Plaud SDK — two live central managers in
   *  one process starve each other. The manager is lazily recreated on next
   *  use, so SATE keeps working after returning. */
  teardown(): void;
}

// ------------------------------------------------------------ frame codec

/** Reassembles [flag][payload] packets into complete messages. */
class FrameAssembler {
  private parts: Buffer[] = [];
  /** Returns the full message when a FINAL frame arrives, else null. */
  push(packetB64: string): Buffer | null {
    const pkt = Buffer.from(packetB64, "base64");
    if (pkt.length < 1) return null;
    const flag = pkt[0];
    this.parts.push(pkt.subarray(1));
    if (flag === FRAME_FINAL) {
      const all = Buffer.concat(this.parts);
      this.parts = [];
      return all;
    }
    if (flag !== FRAME_PARTIAL) this.parts = []; // unknown flag: reset
    return null;
  }
  reset() {
    this.parts = [];
  }
}

function frameChunks(payload: Buffer, mtuPayload = 180): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < payload.length; off += mtuPayload) {
    const end = Math.min(off + mtuPayload, payload.length);
    const flag = end >= payload.length ? FRAME_FINAL : FRAME_PARTIAL;
    out.push(Buffer.concat([Buffer.from([flag]), payload.subarray(off, end)]));
  }
  return out.length ? out : [Buffer.from([FRAME_FINAL])];
}

// --------------------------------------------------------------- real BLE

export class BleLink implements SateLink {
  // Lazy: constructing BleManager outside a dev build (e.g. Expo Go, where
  // the native module is missing) throws - that must not crash the render.
  private manager_: BleManager | null = null;
  private get manager(): BleManager {
    if (!this.manager_) {
      try {
        this.manager_ = new BleManager();
      } catch {
        throw new Error(
          "Bluetooth needs a development build - Expo Go cannot load react-native-ble-plx. Run: npx expo run:ios (or run:android), or turn Demo mode ON."
        );
      }
    }
    return this.manager_;
  }
  private device: Device | null = null;
  private statusSub: Subscription | null = null;
  private dataSub: Subscription | null = null;
  private statusAsm = new FrameAssembler();
  private dataAsm = new FrameAssembler();
  private statusWaiters: ((msg: any) => boolean)[] = [];
  private dataHandler: ((buf: Buffer) => void) | null = null;
  private scanStateSub: Subscription | null = null;

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

  startScan(onFound: (d: FoundDevice) => void): void {
    // ble-plx requires the adapter to be PoweredOn before scanning. On iOS the
    // central manager reaches PoweredOn a moment AFTER this screen mounts, so
    // calling startDeviceScan immediately fires a silent error and finds nothing.
    // Wait for PoweredOn (emitCurrentState=true fires now if it's already on).
    this.scanStateSub?.remove();
    this.scanStateSub = this.manager.onStateChange((state) => {
      if (state !== "PoweredOn") return;
      this.scanStateSub?.remove();
      this.scanStateSub = null;
      this.beginScan(onFound);
    }, true);
  }

  private beginScan(onFound: (d: FoundDevice) => void): void {
    this.manager.startDeviceScan([SATE_SERVICE], null, (error, dev) => {
      if (error || !dev) return;
      let unprovisioned = false;
      let needsSync = false;
      let pending = 0;
      if (dev.manufacturerData) {
        const m = Buffer.from(dev.manufacturerData, "base64");
        // ble-plx prepends the 2-byte company id on Android; scan both offsets
        for (const off of [0, 2]) {
          if (m.length >= off + 3 && m[off] === ADV_MAGIC) {
            unprovisioned = (m[off + 1] & ADV_FLAG_UNPROVISIONED) !== 0;
            needsSync = (m[off + 1] & ADV_FLAG_NEEDS_SYNC) !== 0;
            pending = m[off + 2];
            break;
          }
        }
      }
      onFound({
        id: dev.id,
        name: dev.name || "SATE Recorder",
        rssi: dev.rssi ?? -100,
        unprovisioned,
        needsSync,
        pending,
      });
    });
  }

  stopScan(): void {
    this.scanStateSub?.remove();
    this.scanStateSub = null;
    this.manager_?.stopDeviceScan();
  }

  async connect(id: string): Promise<void> {
    this.stopScan();
    const dev = await this.manager.connectToDevice(id, { requestMTU: 247 });
    await dev.discoverAllServicesAndCharacteristics();
    this.device = dev;
    this.statusAsm.reset();
    this.dataAsm.reset();

    this.statusSub = dev.monitorCharacteristicForService(
      SATE_SERVICE,
      CHAR_STATUS,
      (err, ch) => {
        if (err || !ch?.value) return;
        const full = this.statusAsm.push(ch.value);
        if (!full) return;
        let msg: any;
        try {
          msg = JSON.parse(full.toString("utf8"));
        } catch {
          return;
        }
        this.statusWaiters = this.statusWaiters.filter((w) => !w(msg));
      }
    );

    this.dataSub = dev.monitorCharacteristicForService(
      SATE_SERVICE,
      CHAR_DATA,
      (err, ch) => {
        if (err || !ch?.value) return;
        const full = this.dataAsm.push(ch.value);
        if (full && this.dataHandler) this.dataHandler(full);
      }
    );
  }

  async disconnect(): Promise<void> {
    this.statusSub?.remove();
    this.dataSub?.remove();
    this.statusSub = this.dataSub = null;
    if (this.device) {
      await this.device.cancelConnection().catch(() => {});
      this.device = null;
    }
  }

  /** Resolves with the first status message `match` accepts. */
  private waitStatus<T = any>(match: (m: any) => boolean, timeoutMs = 30000) {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        reject(new Error("Device did not respond in time"));
      }, timeoutMs);
      const waiter = (m: any) => {
        if (!match(m)) return false;
        clearTimeout(timer);
        resolve(m as T);
        return true;
      };
      this.statusWaiters.push(waiter);
    });
  }

  private async writeControl(obj: any): Promise<void> {
    if (!this.device) throw new Error("Not connected");
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    for (const pkt of frameChunks(payload)) {
      await this.device.writeCharacteristicWithResponseForService(
        SATE_SERVICE,
        CHAR_CONTROL,
        pkt.toString("base64")
      );
    }
  }

  async getInfo(): Promise<DeviceIdentity> {
    if (!this.device) throw new Error("Not connected");
    const ch = await this.device.readCharacteristicForService(
      SATE_SERVICE,
      CHAR_INFO
    );
    return JSON.parse(Buffer.from(ch.value || "", "base64").toString("utf8"));
  }

  async scanWifi(): Promise<WifiNetwork[]> {
    const wait = this.waitStatus<{ networks: WifiNetwork[] }>(
      (m) => m.ev === "scan",
      25000
    );
    await this.writeControl({ op: "scan_wifi" });
    return (await wait).networks || [];
  }

  async provision(
    args: { ssid: string; pass: string; server: string; claim_token: string },
    onProgress: (p: ProvisionProgress) => void
  ): Promise<ProvisionProgress> {
    return new Promise(async (resolve, reject) => {
      // Firmware worst case (fw 1.2.15): ~28 s Wi-Fi connect window (re-issues the
      // join every ~8 s, modem-sleep off) + ~8 s server register. Guard well past
      // that so a mid-provision BLE drop can't wedge the UI forever.
      const guard = setTimeout(() => {
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        resolve({
          state: "error",
          msg: "Setup timed out - the recorder did not finish connecting",
        });
      }, 60000);
      const waiter = (m: any) => {
        if (m.ev !== "state") return false;
        const p: ProvisionProgress = {
          state: m.state,
          ip: m.ip,
          deviceId: m.device_id,
          msg: m.msg,
        };
        onProgress(p);
        if (m.state === "registered" || m.state === "error") {
          clearTimeout(guard);
          resolve(p);
          return true; // remove waiter
        }
        return false; // keep listening for further states
      };
      this.statusWaiters.push(waiter);
      try {
        await this.writeControl({ op: "provision", ...args });
      } catch (e) {
        clearTimeout(guard);
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        reject(e);
      }
    });
  }

  async changeWifi(
    args: { ssid: string; pass: string },
    onProgress: (p: ProvisionProgress) => void
  ): Promise<ProvisionProgress> {
    return new Promise(async (resolve, reject) => {
      // Worst case ~28 s Wi-Fi connect window (fw 1.2.15 re-issues the join every
      // ~8 s, modem-sleep off). No server register step, so a tighter guard than
      // provision() is fine.
      const guard = setTimeout(() => {
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        resolve({
          state: "error",
          msg: "Timed out — the recorder did not join the new network",
        });
      }, 45000);
      const waiter = (m: any) => {
        if (m.ev !== "state") return false;
        const p: ProvisionProgress = {
          state: m.state,
          ip: m.ip,
          deviceId: m.device_id,
          msg: m.msg,
        };
        onProgress(p);
        if (m.state === "wifi_saved" || m.state === "error") {
          clearTimeout(guard);
          resolve(p);
          return true;
        }
        return false;
      };
      this.statusWaiters.push(waiter);
      try {
        await this.writeControl({ op: "change_wifi", ...args });
      } catch (e) {
        clearTimeout(guard);
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter);
        reject(e);
      }
    });
  }

  async listSessions(): Promise<PendingSession[]> {
    const wait = this.waitStatus<{ items: PendingSession[] }>(
      (m) => m.ev === "sessions"
    );
    await this.writeControl({ op: "list_sessions" });
    return (await wait).items || [];
  }

  async pullSession(
    n: number,
    onProgress: (received: number, total: number) => void
  ): Promise<{ wavBase64: string; meta: any }> {
    const header = this.waitStatus<{ n: number; bytes: number; meta: any }>(
      (m) => m.ev === "file" && m.n === n
    );
    const done = this.waitStatus((m) => m.ev === "file_done" && m.n === n, 120000);

    const chunks: Buffer[] = [];
    let total = 0;
    this.dataHandler = (buf) => {
      chunks.push(buf);
      const received = chunks.reduce((s, b) => s + b.length, 0);
      onProgress(received, total);
    };

    await this.writeControl({ op: "send_session", n });
    const head = await header;
    total = head.bytes;
    await done;
    this.dataHandler = null;

    return {
      wavBase64: Buffer.concat(chunks).toString("base64"),
      meta: head.meta,
    };
  }

  async markSynced(n: number): Promise<void> {
    const wait = this.waitStatus((m) => m.ev === "ok" && m.op === "mark_synced");
    await this.writeControl({ op: "mark_synced", n });
    await wait;
  }

  async setPatients(patients: Patient[]): Promise<void> {
    const wait = this.waitStatus((m) => m.ev === "ok" && m.op === "set_patients");
    await this.writeControl({ op: "set_patients", patients });
    await wait;
  }

  async sendCommand(op: BleCommand): Promise<void> {
    const wait = this.waitStatus((m) => m.ev === "ok" && m.op === op, 10000);
    await this.writeControl({ op });
    await wait;
  }

  teardown(): void {
    this.stopScan();
    if (this.device) {
      this.manager_?.cancelDeviceConnection(this.device.id).catch(() => {});
      this.device = null;
    }
    // destroy() releases the native CBCentralManager entirely, freeing the
    // radio for the Plaud SDK. The lazy getter rebuilds it on next access.
    try {
      this.manager_?.destroy();
    } catch {
      /* already gone */
    }
    this.manager_ = null;
  }
}

export function makeLink(): SateLink {
  return new BleLink();
}
