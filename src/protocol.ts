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
//   { op: "provision", ssid, pass, server, claim_token }
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
  slp?: string; // clinician the recorder is assigned to (set at registration)
  slp_id?: string;
}

export type RemoteCommand = "sync_now" | "reload_patients" | "identify" | "reboot";

// Commands the app can also deliver directly over BLE when the recorder
// has no Wi-Fi (subset of RemoteCommand that makes sense point-to-point).
export type BleCommand = "identify" | "reboot";

export interface User {
  id: string;
  name: string;
  email: string;
}
