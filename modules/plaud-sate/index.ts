import { requireNativeModule } from "expo-modules-core";

// The native module is an event emitter at runtime (addListener returns a
// subscription with .remove()); expo's exported EventEmitter type varies by
// SDK, so we type just the surface we use to keep this SDK-version-agnostic.
type NativeEvents = {
  addListener(event: string, cb: (payload: any) => void): { remove(): void };
};

// Raw handle to the Swift PlaudSateModule. On platforms/builds where the
// native module isn't present (Android, iOS simulator, Expo Go), requiring it
// throws — callers should guard with `isPlaudAvailable()`.
export interface PlaudScanDevice {
  id: string; // stable key (uuid or sn) used by connect()
  name: string;
  sn: string;
  rssi: number;
}

export interface PlaudFileMeta {
  sessionId: number;
  name: string;
  durationSec: number;
  bytes: number;
  /** Flag markers the DEVICE captured for this take (BleFile.penCollect).
   *  Authoritative count, independent of the getMarking offset pull. */
  penCount: number;
}

export interface PlaudExportResult {
  sessionId: number;
  wavBase64: string;
  sampleRate: number;
  bytes: number;
  /**
   * Marks pushed by the device (bleMarking) for this session — created by a
   * physical action ON the Plaud device (tap/gesture), never by SATE's app UI;
   * there is no SDK command to insert one remotely. UNVERIFIED unit: assumed
   * to be ms offsets into the recording (matches SATE's own flag format) but
   * not confirmed against Plaud docs — check on a real device before display.
   */
  markOffsets: number[];
}

interface PlaudSateNative {
  initSdk(userAccessToken: string, customDomain: string): void;
  setUserAccessToken(token: string): void;
  startScan(): void;
  stopScan(): void;
  connect(deviceId: string, userId: string): Promise<void>;
  disconnect(): Promise<void>;
  depair(): Promise<void>;
  listFiles(): Promise<PlaudFileMeta[]>;
  exportWav(sessionId: number): Promise<PlaudExportResult>;
  deleteFile(sessionId: number): Promise<void>;
  // Recording control (drive the Plaud device from the app).
  startRecord(): void;
  stopRecord(): void;
  pauseRecord(): void;
  resumeRecord(): void;
  isRecording(): boolean;
  currentSessionId(): number;
  refreshFiles(): Promise<PlaudFileMeta[]>;
  // Keychain-backed, survives app reinstall (see native module).
  keychainGet(key: string): string | null;
  keychainSet(key: string, value: string): void;
  keychainDelete(key: string): void;
}

let native: (PlaudSateNative & NativeEvents) | null = null;
try {
  native = requireNativeModule("PlaudSate");
} catch {
  native = null; // not built into this binary (simulator / Android / Expo Go)
}

export function isPlaudAvailable(): boolean {
  return native != null;
}

export const PlaudSate = native;

export type PlaudEvent =
  | { name: "onScanResult"; payload: { devices: PlaudScanDevice[] } }
  | { name: "onConnectState"; payload: { state: number } }
  | { name: "onExportProgress"; payload: { sessionId: number; progress: number } }
  | { name: "onRecordState"; payload: { state: string; sessionId: number } }
  // Flag markers for the live/most-recent take, pulled from the device as the
  // user taps the Plaud during recording. `count` grows with each new tap.
  | { name: "onMark"; payload: { sessionId: number; count: number; offsets: number[] } };

export function addPlaudListener<T extends PlaudEvent["name"]>(
  event: T,
  cb: (payload: Extract<PlaudEvent, { name: T }>["payload"]) => void
) {
  if (!native) return { remove() {} };
  return native.addListener(event, cb as any);
}
