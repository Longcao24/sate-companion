// Plaud device link: scan / connect / sync, mirroring the shape of SateLink.
// One interface, two implementations: real (the PlaudSate native module) and
// mock (simulator / Expo Go / Android, where the arm64-only SDK isn't present).
//
// A synced file comes back as base64 WAV + sample rate — exactly what
// api.uploadSession() wants — so Plaud audio rides the SAME pipeline as a SATE
// recorder: uploadSession → device-api → Supabase → AI → recordings.

import {
  addPlaudListener,
  isPlaudAvailable,
  PlaudSate,
  type PlaudFileMeta,
  type PlaudScanDevice,
} from "../../modules/plaud-sate";

// Plaud US server host (no scheme), per the SDK README.
const PLAUD_DOMAIN = "platform-us.plaud.ai";

// CRITICAL — device-lock safety.
//
// A Plaud device binds to a stable identity (deviceToken). Binding the SAME
// device to a DIFFERENT identity can permanently LOCK it. So:
//   1. The identity is ALWAYS derived from the SATE account, never random and
//      never regenerated — `sate_<supabaseUserId>`. It is the SAME string the
//      mint-plaud-token Edge Function uses as the Plaud user_id, and it is
//      restored on every login, so it survives app reinstall.
//   2. The binding record lives in the iOS Keychain (survives reinstall, unlike
//      AsyncStorage). Before connecting we check the Keychain: if the device is
//      already bound to THIS account we reconnect (never re-bind); if it's bound
//      to a DIFFERENT account we refuse rather than risk a lock.
//   3. We NEVER call depair automatically — only on an explicit user "forget".
export function plaudUserId(supabaseUserId: string): string {
  return `sate_${supabaseUserId}`;
}

// Keychain key holding the account a device serial is bound to.
const bindingKey = (sn: string) => `plaud.bind.${sn}`;

export interface PlaudFoundDevice {
  id: string;
  name: string;
  sn: string;
  rssi: number;
}

export interface PlaudFile {
  sessionId: number;
  name: string;
  durationSec: number;
  bytes: number;
  /** Flag markers the device captured for this take (0 = none registered). */
  penCount: number;
}

export interface PlaudSyncedFile {
  sessionId: number;
  wavBase64: string;
  sampleRate: number;
  bytes: number;
  /** Marks the Plaud device itself recorded (physical tap/gesture) — flows
   * into the SAME flag pipeline SATE hardware uses (seek-bar ticks on the
   * web report). See PlaudExportResult for the unit caveat. */
  markOffsets: number[];
}

export interface PlaudLink {
  /** True when the native SDK is compiled into this binary (arm64 device). */
  isAvailable(): boolean;
  /** Init the SDK with a freshly-minted per-user access token. */
  initSdk(userAccessToken: string): Promise<void>;
  /** Refresh the token without re-initialising (tokens last ~24h). */
  setToken(token: string): Promise<void>;
  startScan(onFound: (d: PlaudFoundDevice) => void): void;
  stopScan(): void;
  /**
   * plaudUserId = the account-derived stable identity from plaudUserId(). MUST
   * match what the token was minted for. Never pass a random/changing value.
   */
  connect(deviceId: string, plaudUserId: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Account this serial is already bound to (Keychain), or null if unbound. */
  bindingOwner(sn: string): string | null;
  /** Record (idempotently) that `account` owns this device's binding. */
  recordBinding(account: string, sn: string): void;
  /**
   * Remember a connected Plaud (sn + name) in the known-devices list (most-
   * recent first, deduped by sn), so on next app open the app can show ALL
   * paired Plauds and reconnect any of them without a manual Connect. One
   * account can pair multiple Plauds. Survives reinstall (Keychain).
   */
  rememberDevice(sn: string, name: string): void;
  /** Every Plaud this account has paired (most-recent first). */
  knownDevices(): { sn: string; name: string }[];
  /** The most-recently connected Plaud, or null. (= knownDevices()[0]) */
  lastDevice(): { sn: string; name: string } | null;
  /** Drop one Plaud from the known-devices list (local only). */
  forgetDevice(sn: string): void;
  /** Clear a binding record — ONLY for an explicit user "forget device". */
  forgetBinding(sn: string): void;
  /**
   * RECOVERY ONLY, user-initiated. Unbinds the currently-connected device
   * (Plaud depair) and clears its local record, so a device left bound to a
   * dead install (or another account) can be reclaimed. Must be connected.
   */
  resetBinding(sn: string): Promise<void>;
  listFiles(): Promise<PlaudFile[]>;
  /** Export one recording as WAV (base64) + delete the temp file. */
  exportWav(
    sessionId: number,
    onProgress?: (pct: number) => void
  ): Promise<PlaudSyncedFile>;
  /** Remove the recording from the Plaud device after a confirmed upload. */
  deleteFile(sessionId: number): Promise<void>;
  /** Drive recording on the connected Plaud device from the app. */
  startRecord(): void;
  stopRecord(): void;
  isRecording(): boolean;
  /** Subscribe to record-state changes ("recording"/"stopped"/…). */
  onRecordState(cb: (state: string, sessionId: number) => void): { remove(): void };
  /**
   * Subscribe to live flag markers. Fires as the user taps the mark button ON
   * the Plaud during a recording (polled from the device — the SDK has no
   * real-time mark push), so the app can show each flag as it happens. `count`
   * is the running total for that session; `offsets` are ms offsets.
   */
  onMark(cb: (sessionId: number, count: number, offsets: number[]) => void): { remove(): void };
  /** Re-fetch the device's recordings (after a recording finishes). */
  refreshFiles(): Promise<PlaudFile[]>;
}

// ------------------------------------------------------------------ real

class NativePlaudLink implements PlaudLink {
  private scanSub: { remove(): void } | null = null;

  isAvailable() {
    return isPlaudAvailable();
  }

  async initSdk(userAccessToken: string) {
    PlaudSate!.initSdk(userAccessToken, PLAUD_DOMAIN);
  }

  async setToken(token: string) {
    PlaudSate!.setUserAccessToken(token);
  }

  startScan(onFound: (d: PlaudFoundDevice) => void) {
    this.scanSub?.remove();
    this.scanSub = addPlaudListener("onScanResult", ({ devices }) => {
      (devices as PlaudScanDevice[]).forEach(onFound);
    });
    PlaudSate!.startScan();
  }

  stopScan() {
    PlaudSate!.stopScan();
    this.scanSub?.remove();
    this.scanSub = null;
  }

  connect(deviceId: string, userId: string) {
    return PlaudSate!.connect(deviceId, userId);
  }

  disconnect() {
    return PlaudSate!.disconnect();
  }

  async listFiles() {
    const files = (await PlaudSate!.listFiles()) as PlaudFileMeta[];
    return files.map((f) => ({
      sessionId: f.sessionId,
      name: f.name,
      durationSec: f.durationSec,
      bytes: f.bytes,
      penCount: f.penCount ?? 0,
    }));
  }

  async exportWav(sessionId: number, onProgress?: (pct: number) => void) {
    let sub: { remove(): void } | null = null;
    if (onProgress) {
      sub = addPlaudListener("onExportProgress", (p) => {
        if (p.sessionId === sessionId) onProgress(p.progress);
      });
    }
    try {
      const r = await PlaudSate!.exportWav(sessionId);
      return {
        sessionId: r.sessionId,
        wavBase64: r.wavBase64,
        sampleRate: r.sampleRate,
        bytes: r.bytes,
        markOffsets: r.markOffsets,
      };
    } finally {
      sub?.remove();
    }
  }

  deleteFile(sessionId: number) {
    return PlaudSate!.deleteFile(sessionId);
  }

  startRecord() {
    PlaudSate!.startRecord();
  }
  stopRecord() {
    PlaudSate!.stopRecord();
  }
  isRecording() {
    return PlaudSate!.isRecording();
  }
  onRecordState(cb: (state: string, sessionId: number) => void) {
    return addPlaudListener("onRecordState", (p) => cb(p.state, p.sessionId));
  }
  onMark(cb: (sessionId: number, count: number, offsets: number[]) => void) {
    return addPlaudListener("onMark", (p) => cb(p.sessionId, p.count, p.offsets));
  }
  async refreshFiles() {
    const files = (await PlaudSate!.refreshFiles()) as PlaudFileMeta[];
    return files.map((f) => ({
      sessionId: f.sessionId,
      name: f.name,
      durationSec: f.durationSec,
      bytes: f.bytes,
      penCount: f.penCount ?? 0,
    }));
  }

  bindingOwner(sn: string) {
    return PlaudSate!.keychainGet(bindingKey(sn));
  }
  recordBinding(account: string, sn: string) {
    PlaudSate!.keychainSet(bindingKey(sn), account);
  }
  knownDevices() {
    const v = PlaudSate!.keychainGet("plaud.known");
    if (!v) return [];
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? (a as { sn: string; name: string }[]) : [];
    } catch {
      return [];
    }
  }
  rememberDevice(sn: string, name: string) {
    const list = [{ sn, name }, ...this.knownDevices().filter((d) => d.sn !== sn)];
    PlaudSate!.keychainSet("plaud.known", JSON.stringify(list));
  }
  forgetDevice(sn: string) {
    const list = this.knownDevices().filter((d) => d.sn !== sn);
    PlaudSate!.keychainSet("plaud.known", JSON.stringify(list));
  }
  lastDevice() {
    return this.knownDevices()[0] ?? null;
  }
  forgetBinding(sn: string) {
    PlaudSate!.keychainDelete(bindingKey(sn));
  }
  async resetBinding(sn: string) {
    // ACK-before-forget: depair() resolves ONLY after the device confirms the
    // unbind (bleDepair callback; native layer refuses when disconnected and
    // times out instead of hanging). If it throws, the Keychain record is KEPT
    // — deleting local state before the device ACKs desyncs the binding and
    // can freeze the device.
    await PlaudSate!.depair();
    PlaudSate!.keychainDelete(bindingKey(sn));
    // Forget the remembered device too, so it won't auto-reconnect after unbind.
    this.forgetDevice(sn);
  }
}

// ------------------------------------------------------------------ mock

// A tiny 16 kHz mono WAV (silence) so the upload path can be exercised without
// hardware. Header only + a few samples; enough to travel end-to-end in dev.
function silentWavBase64(): string {
  const sampleRate = 16000;
  const samples = 1600; // ~0.1s
  const dataLen = samples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + dataLen, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, dataLen, true);
  // Base64-encode without Buffer (works in RN/Hermes).
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return globalThis.btoa ? globalThis.btoa(bin) : "";
}

class MockPlaudLink implements PlaudLink {
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  isAvailable() {
    return true; // pretend, so the UI flow is testable in the simulator
  }
  async initSdk() {}
  async setToken() {}

  startScan(onFound: (d: PlaudFoundDevice) => void) {
    let n = 0;
    this.scanTimer = setInterval(() => {
      n++;
      onFound({ id: "mock-note-pro", name: "Plaud NotePro", sn: "8810001", rssi: -50 - n });
    }, 1200);
  }
  stopScan() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }
  async connect() {}
  async disconnect() {}
  async listFiles(): Promise<PlaudFile[]> {
    return [
      { sessionId: 1710000000, name: "Rec 001", durationSec: 42, bytes: 1344000, penCount: 2 },
      { sessionId: 1710000600, name: "Rec 002", durationSec: 88, bytes: 2816000, penCount: 0 },
    ];
  }
  async exportWav(sessionId: number, onProgress?: (p: number) => void) {
    for (let p = 0; p <= 100; p += 50) onProgress?.(p);
    return {
      sessionId,
      wavBase64: silentWavBase64(),
      sampleRate: 16000,
      bytes: 3244,
      markOffsets: [3000, 15000], // fake marks so the flag UI is exercisable in dev
    };
  }
  async deleteFile() {}

  private recording = false;
  // Dev simulation of live marks: emit a flag every 3s while "recording".
  private markCb: ((sessionId: number, count: number, offsets: number[]) => void) | null = null;
  private markTimer: ReturnType<typeof setInterval> | null = null;
  private mockMarks: number[] = [];
  startRecord() {
    this.recording = true;
    this.mockMarks = [];
    const sid = 1710000000;
    this.markTimer = setInterval(() => {
      const last = this.mockMarks[this.mockMarks.length - 1] ?? 0;
      this.mockMarks.push(last + 3000);
      this.markCb?.(sid, this.mockMarks.length, [...this.mockMarks]);
    }, 3000);
  }
  stopRecord() {
    this.recording = false;
    if (this.markTimer) clearInterval(this.markTimer);
    this.markTimer = null;
  }
  isRecording() {
    return this.recording;
  }
  onRecordState() {
    return { remove() {} };
  }
  onMark(cb: (sessionId: number, count: number, offsets: number[]) => void) {
    this.markCb = cb;
    return { remove: () => { this.markCb = null; } };
  }
  async refreshFiles(): Promise<PlaudFile[]> {
    return this.listFiles();
  }

  private bindings = new Map<string, string>();
  private known: { sn: string; name: string }[] = [];
  bindingOwner(sn: string) {
    return this.bindings.get(sn) ?? null;
  }
  recordBinding(account: string, sn: string) {
    this.bindings.set(sn, account);
  }
  rememberDevice(sn: string, name: string) {
    this.known = [{ sn, name }, ...this.known.filter((d) => d.sn !== sn)];
  }
  knownDevices() {
    return this.known;
  }
  forgetDevice(sn: string) {
    this.known = this.known.filter((d) => d.sn !== sn);
  }
  lastDevice() {
    return this.known[0] ?? null;
  }
  forgetBinding(sn: string) {
    this.bindings.delete(sn);
  }
  async resetBinding(sn: string) {
    this.bindings.delete(sn);
    this.forgetDevice(sn);
  }
}

// Real link when the native SDK is present, otherwise the mock so UI dev + the
// upload pipeline stay testable off-device.
export function makePlaudLink(): PlaudLink {
  return isPlaudAvailable() ? new NativePlaudLink() : new MockPlaudLink();
}
