// SATE server API client. The companion app signs in with the SAME SLP
// account as the SATE web app; claimed devices are stored under that account.
//
// REST endpoints (Bearer <token> unless noted):
//   POST  /api/auth/login                { email, password } -> { token, user }
//   GET   /api/devices                   -> ManagedDevice[]
//   POST  /api/devices/claim-token      -> { token }   (binds to this account)
//   PATCH /api/devices/:id               { name }
//   DELETE /api/devices/:id
//   POST  /api/devices/:id/commands      { op: RemoteCommand, patient? }
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

// SATE production backend (Supabase). The companion app talks to the `device-api`
// Edge Function and authenticates with a real Supabase user session - the SAME
// account as the web app, so a recorder provisioned here is auto-claimed to it.
// The anon key is public by design (the web app ships it in its JS bundle).
export const SUPABASE_URL = "https://zlgdpivcbmaodgokkdvz.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0.x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ";
export const DEVICE_API_URL = `${SUPABASE_URL}/functions/v1/device-api`;

export interface SateApi {
  login(email: string, password: string): Promise<{ token: string; user: User }>;
  listDevices(): Promise<ManagedDevice[]>;
  claimToken(): Promise<string>;
  renameDevice(id: string, name: string): Promise<void>;
  removeDevice(id: string): Promise<void>;
  /**
   * Queue a command for the recorder. For "record" you can pass the patient the
   * SLP typed in so the captured session is tagged to them (the server also adds
   * the patient to the roster if they're new).
   */
  sendCommand(
    id: string,
    op: RemoteCommand,
    patient?: Partial<Patient>
  ): Promise<void>;
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
        // Supabase Edge Functions gateway requires the apikey header.
        apikey: SUPABASE_ANON_KEY,
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

  // Sign in against Supabase Auth (not device-api): returns a real user JWT that
  // device-api validates, so every claimed device is bound to this account.
  async login(email: string, password: string) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
        body: JSON.stringify({ email, password }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body || res.statusText}`);
    }
    const j = await res.json();
    const u = j.user || {};
    const user: User = {
      id: u.id,
      email: u.email,
      name: u.user_metadata?.full_name || u.user_metadata?.name || u.email,
    };
    return { token: j.access_token as string, user };
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
  async sendCommand(id: string, op: RemoteCommand, patient?: Partial<Patient>) {
    await this.req(`/api/devices/${id}/commands`, {
      method: "POST",
      body: JSON.stringify(patient ? { op, patient } : { op }),
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
    const headers: Record<string, string> = { apikey: SUPABASE_ANON_KEY };
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
