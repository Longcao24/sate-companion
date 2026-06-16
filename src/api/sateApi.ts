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
  Recording,
  RecordingMeta,
  RemoteCommand,
  UploadedSession,
  User,
} from "../protocol";

// Columns the report viewer needs. Kept explicit so we don't pull big rows.
const RECORDING_COLS =
  "id,recording_name,protocol,notes,needs_review,patient_id,duration,file_name,created_at,transcript,analysis,error_counts";

// SATE production backend (Supabase). The companion app talks to the `device-api`
// Edge Function and authenticates with a real Supabase user session - the SAME
// account as the web app, so a recorder provisioned here is auto-claimed to it.
// The anon key is public by design (the web app ships it in its JS bundle).
export const SUPABASE_URL = "https://zlgdpivcbmaodgokkdvz.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpsZ2RwaXZjYm1hb2Rnb2trZHZ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk3NTY5NTgsImV4cCI6MjA2NTMzMjk1OH0.x58hiBi5EeRwbedrsrBzRkw7y2tFBw5ztIdmujZoPMQ";
export const DEVICE_API_URL = `${SUPABASE_URL}/functions/v1/device-api`;

export interface SateApi {
  login(
    email: string,
    password: string
  ): Promise<{ token: string; refreshToken: string | null; expiresAt: number; user: User }>;
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
  /** The processed report row (transcript + analysis) — the SAME record the web app shows. */
  getRecording(id: string): Promise<Recording>;
  /** First-open review: rename + set protocol/notes and clear needs_review. */
  updateRecording(id: string, meta: RecordingMeta): Promise<void>;
}

// ---------------------------------------------------------------- real API

// Called when an authed request comes back 401. It should refresh the Supabase
// session and resolve to a fresh access token (or null if it can't). The api
// then retries the request once with the new token — so an expired access token
// is invisible to the user, exactly like the web app's auto-refresh.
export type RefreshHandler = () => Promise<string | null>;

export class HttpApi implements SateApi {
  // token is mutable: after a 401 + refresh we swap in the fresh one and retry.
  constructor(
    private baseUrl: string,
    private token: string | null,
    private onUnauthorized?: RefreshHandler
  ) {}

  private async req<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
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
    // Expired/invalid session: refresh once and replay the request.
    if (res.status === 401 && !retried && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.token = fresh;
        return this.req<T>(path, init, true);
      }
    }
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
    return {
      token: j.access_token as string,
      refreshToken: (j.refresh_token as string) ?? null,
      // Supabase access tokens last ~1h; remember when to refresh.
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      user,
    };
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

  // ---- recordings: read the processed report straight from Supabase REST ----
  // The web app and the phone read the very same `recordings` rows; RLS scopes
  // them to the signed-in owner so no extra endpoint is needed.
  private async rest<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init?.headers || {}),
      },
    });
    if (res.status === 401 && !retried && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.token = fresh;
        return this.rest<T>(path, init, true);
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body || res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : res.json();
  }

  async getRecording(id: string) {
    const rows = await this.rest<Recording[]>(
      `/recordings?id=eq.${encodeURIComponent(id)}&select=${RECORDING_COLS}&limit=1`
    );
    if (!rows.length) throw new Error("Recording not found");
    return rows[0];
  }

  async updateRecording(id: string, meta: RecordingMeta) {
    await this.rest(`/recordings?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        recording_name: meta.recording_name,
        protocol: meta.protocol,
        notes: meta.notes ?? null,
        needs_review: false,
        updated_at: new Date().toISOString(),
      }),
    });
  }
}

export function makeApi(
  serverUrl: string,
  token: string | null,
  onUnauthorized?: RefreshHandler
): SateApi {
  return new HttpApi(serverUrl, token, onUnauthorized);
}

// Error from a refresh attempt. `authInvalid` distinguishes a genuinely dead
// refresh token (sign the user out) from a transient network/server failure
// (keep the session and try again later) — so we never log someone out just
// because their phone briefly lost signal.
export class RefreshError extends Error {
  constructor(message: string, public status: number, public authInvalid: boolean) {
    super(message);
    this.name = "RefreshError";
  }
}

// Exchange a Supabase refresh token for a fresh access token. Used to keep the
// session alive past the ~1h access-token expiry (otherwise claim-token minting
// and other authed calls silently 401). Supabase refresh tokens are long-lived,
// so a signed-in user stays signed in for weeks — like the web app.
export async function refreshSession(
  refreshToken: string
): Promise<{ token: string; refreshToken: string | null; expiresAt: number }> {
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
  } catch {
    // Network failure — transient, NOT an auth problem. Keep the session.
    throw new RefreshError("network error during refresh", 0, false);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400/401 with an invalid_grant-style body = the refresh token is dead.
    const authInvalid =
      (res.status === 400 || res.status === 401) &&
      /invalid_grant|refresh_token_not_found|invalid_token|already_used/i.test(body);
    throw new RefreshError(`refresh failed: ${res.status} ${body}`, res.status, authInvalid);
  }
  const j = await res.json();
  return {
    token: j.access_token as string,
    refreshToken: (j.refresh_token as string) ?? refreshToken,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
  };
}
