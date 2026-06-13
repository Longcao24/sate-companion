// SATE server API client. The companion app signs in with the SAME SLP
// account as the SATE web app; claimed devices are stored under that account.
//
// REST endpoints (Bearer <token> unless noted):
//   POST  /api/auth/login                { email, password } -> { token, user }
//   GET   /api/devices                   -> ManagedDevice[]
//   POST  /api/devices/claim-token      -> { token }   (binds to this account)
//   PATCH /api/devices/:id               { name }
//   DELETE /api/devices/:id
//   POST  /api/devices/:id/commands      { op: RemoteCommand }
//   GET   /api/patients                  -> Patient[]
//   POST  /api/sessions                  { device_serial, patient_id,
//                                          session_number, sample_rate,
//                                          wav_base64 } -> { id }

import {
  ManagedDevice,
  Patient,
  RemoteCommand,
  UploadedSession,
  User,
} from "../protocol";

export interface SateApi {
  login(email: string, password: string): Promise<{ token: string; user: User }>;
  listDevices(): Promise<ManagedDevice[]>;
  claimToken(): Promise<string>;
  renameDevice(id: string, name: string): Promise<void>;
  removeDevice(id: string): Promise<void>;
  sendCommand(id: string, op: RemoteCommand): Promise<void>;
  listPatients(): Promise<Patient[]>;
  /** Sessions uploaded to the account; pass a serial to filter to one device. */
  listUploads(deviceSerial?: string): Promise<UploadedSession[]>;
  /** Playable audio source (URL + auth header) for one uploaded session. */
  audioSource(sessionId: string): { uri: string; headers: Record<string, string> };
  uploadSession(args: {
    device_serial: string;
    patient_id: string;
    session_number: number;
    sample_rate: number;
    wav_base64: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------- real API

export class HttpApi implements SateApi {
  constructor(private baseUrl: string, private token: string | null) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body || res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : res.json();
  }

  login(email: string, password: string) {
    return this.req<{ token: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  }
  listDevices() {
    return this.req<ManagedDevice[]>("/api/devices");
  }
  async claimToken() {
    const r = await this.req<{ token: string }>("/api/devices/claim-token", {
      method: "POST",
    });
    return r.token;
  }
  async renameDevice(id: string, name: string) {
    await this.req(`/api/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
  }
  async removeDevice(id: string) {
    await this.req(`/api/devices/${id}`, { method: "DELETE" });
  }
  async sendCommand(id: string, op: RemoteCommand) {
    await this.req(`/api/devices/${id}/commands`, {
      method: "POST",
      body: JSON.stringify({ op }),
    });
  }
  listPatients() {
    return this.req<Patient[]>("/api/patients");
  }
  listUploads(deviceSerial?: string) {
    const q = deviceSerial ? `?device=${encodeURIComponent(deviceSerial)}` : "";
    return this.req<UploadedSession[]>(`/api/sessions${q}`);
  }
  audioSource(sessionId: string) {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return { uri: `${this.baseUrl}/api/sessions/${sessionId}/audio`, headers };
  }
  async uploadSession(args: {
    device_serial: string;
    patient_id: string;
    session_number: number;
    sample_rate: number;
    wav_base64: string;
  }) {
    await this.req("/api/sessions", {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}

export function makeApi(serverUrl: string, token: string | null): SateApi {
  return new HttpApi(serverUrl, token);
}
