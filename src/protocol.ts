// SATE Recorder <-> Companion app BLE protocol (provisioning + bridge sync).
// The same constants are mirrored by the ESP32 firmware (NimBLE) side.
//
// Connectivity model:
//   - The recorder works INDEPENDENTLY: with Wi-Fi it uploads sessions
//     straight to the SATE server and polls for remote commands.
//   - With no Wi-Fi it advertises BLE "needs sync"; the app auto-connects
//     and bridges sessions to the server over the phone's connection.
//   - BLE is also used once for first-time setup (Wi-Fi provisioning +
//     claiming the device to the signed-in SLP account).

export const SATE_SERVICE = "53415445-0001-4a7e-8c5e-000000000001";

// Read: one-shot device identity JSON: { model, fw, serial, provisioned }
export const CHAR_INFO = "53415445-0001-4a7e-8c5e-000000000010";

// Write (JSON commands from app, chunk-framed if large):
//   { op: "scan_wifi" }
//   { op: "provision", ssid, pass, server, claim_token }   // first-time setup
//   { op: "change_wifi", ssid, pass }   // move an ALREADY-claimed unit to a new
//                                       // network; keeps the account (no re-register)
//   { op: "list_sessions" }
//   { op: "send_session", n }
//   { op: "mark_synced", n }
//   { op: "set_patients", patients: Patient[] }
//   { op: "identify" }   // beep + flash so the SLP can find the unit
//   { op: "reboot" }     // device acks { ev:"ok", op:"reboot" } then restarts
export const CHAR_CONTROL = "53415445-0001-4a7e-8c5e-000000000020";

// Notify (JSON events from device, chunk-framed):
//   { ev: "scan",  networks: [{ ssid, rssi, sec }] }
//   { ev: "state", state, ip?, device_id?, msg? }        // provisioning
//   { ev: "sessions", items: [{ n, patient_id, bytes }] } // pending only
//   { ev: "file", n, bytes, meta }   // then raw bytes arrive on CHAR_DATA
//   { ev: "file_done", n }
//   { ev: "ok", op }  |  { ev: "err", op, msg }
export const CHAR_STATUS = "53415445-0001-4a7e-8c5e-000000000030";

// Notify: raw WAV bytes for the session announced by ev:"file",
// chunk-framed with the same flag byte.
export const CHAR_DATA = "53415445-0001-4a7e-8c5e-000000000040";

// ---- chunk framing -----------------------------------------------------
// Any payload (JSON or binary) larger than one packet is split:
//   [ flag: 1 byte ][ payload bytes ]
// flag 0x01 = partial (more follow), 0x02 = final packet of the message.
export const FRAME_PARTIAL = 0x01;
export const FRAME_FINAL = 0x02;

// ---- BLE advertising ---------------------------------------------------
// The recorder advertises SATE_SERVICE plus 4 bytes of manufacturer data:
//   [0] 0x5A magic   [1] flags   [2] pending sessions (0-255)   [3] rsvd
// flags bit0 = unprovisioned (needs setup)
// flags bit1 = needs sync    (has pending sessions, no Wi-Fi)
export const ADV_MAGIC = 0x5a;
export const ADV_FLAG_UNPROVISIONED = 0x01;
export const ADV_FLAG_NEEDS_SYNC = 0x02;

// ---- shared types ------------------------------------------------------

export interface DeviceIdentity {
  model: string;
  fw: string;
  serial: string;
  provisioned: boolean;
}

export interface WifiNetwork {
  ssid: string;
  rssi: number;
  sec: "open" | "wpa";
}

export type ProvisionState =
  | "connecting"
  | "wifi_ok"
  | "registering"
  | "registered"
  | "wifi_saved" // change_wifi finished: new network joined, account kept
  | "error";

export interface PendingSession {
  n: number;
  patient_id: string;
  bytes: number;
}

export interface Patient {
  patient_id: string;
  name: string;
  age: string;
  session_type: string;
  clinician: string;
}

// A claimed device as the SERVER sees it (GET /api/devices).
export interface ManagedDevice {
  id: string;
  name: string;
  serial: string;
  fw: string;
  online: boolean; // true = device is reachable over Wi-Fi right now
  ip?: string;
  last_seen: string; // ISO timestamp
  pending_sessions: number;
  state?: DeviceLiveState; // live activity, reported in the recorder's heartbeat
  slp?: string; // clinician the recorder is assigned to (set at registration)
  slp_id?: string;
  // Which device family this is. Defaults to 'sate' (a SATE recorder from the
  // server); 'plaud'/'pendant'/'l816' are synthesized locally from paired-device
  // stores, because none of them has a server-side row of its own.
  kind?: "sate" | "plaud" | "pendant" | "l816";
}

// Live activity the recorder reports in its heartbeat so the app can show what
// it is doing right now (default "idle" when nothing else is going on).
export type DeviceLiveState = "idle" | "recording" | "uploading";

// A session the recorder uploaded to the server (GET /api/sessions).
// The server auto-runs the SAME AI pipeline as a web upload and writes a
// `recordings` row, so each session carries its processing state + the
// resulting recording id (mirrors the web app's Device tab).
export interface UploadedSession {
  id: string;
  device_serial: string;
  patient_id: string;
  session_number: number;
  sample_rate?: number;
  bytes: number;
  at: string; // ISO timestamp the server stored it
  // Processing state of the auto AI/recordings bridge.
  processed?: boolean;
  processed_at?: string | null;
  // recordings.id once processing finishes (null while pending).
  recording_id?: string | null;
  // Set if processing failed.
  process_error?: string | null;
}

// ---- recordings (the processed report, same shape the web app reads) -------
// Pulled straight from Supabase REST (`/rest/v1/recordings`) so the phone shows
// the exact record the web app does. RLS lets the owner SELECT their own rows.

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  text_clean?: string;
  speaker?: string;
  words?: TranscriptWord[];
}

export interface RecordingAnalysis {
  totalWords?: number;
  ndw?: number; // number of different words
  ntw?: number; // number of total words
  mluw?: number; // mean length of utterance (words)
  mlum?: number; // mean length of utterance (morphemes)
  errorRate?: number;
  speakingRate?: number;
  numberOfPauses?: number;
  segmentCount?: number;
  speakerCount?: number;
  totalDuration?: number;
  availableErrorTypes?: string[];
  errorCounts?: Record<string, number>;
}

// One processed recording (device session OR web upload — identical shape).
export interface Recording {
  id: string;
  recording_name: string | null;
  protocol: string | null;
  notes: string | null;
  needs_review?: boolean | null;
  patient_id: string | null;
  duration: number | null;
  file_name: string | null;
  created_at: string | null;
  transcript: { filename?: string; segments?: TranscriptSegment[] } | null;
  analysis: RecordingAnalysis | null;
  error_counts: Record<string, number> | null;
}

// Metadata the first-open review sheet collects (matches the web app form).
export interface RecordingMeta {
  recording_name: string;
  protocol: string;
  notes?: string;
}

export type RemoteCommand =
  | "sync_now"
  | "reload_patients"
  | "reboot"
  | "wifi_change" // drop to BLE + advertise so the app can push new Wi-Fi creds
  | "record"; // start a recording now + upload it (device must be online)

// Commands the app can also deliver directly over BLE when the recorder
// has no Wi-Fi (subset of RemoteCommand that makes sense point-to-point).
// `factory_reset` wipes Wi-Fi + account and reboots to first-time setup — used
// when unlinking an off-Wi-Fi recorder the server can't reach.
export type BleCommand = "reboot" | "factory_reset" | "cancel_wifi";

export interface User {
  id: string;
  name: string;
  email: string;
}
