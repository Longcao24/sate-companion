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
//   POST  /api/sessions/chunk?offset&final&total&...   raw bytes -> { id } on final
//         (device-api >=v26 accepts a user JWT here, not just a device key —
//          a long take cannot go through the base64 JSON body above)

import {
  ManagedDevice,
  Patient,
  Recording,
  RecordingMeta,
  RemoteCommand,
  UploadedSession,
  User,
  TranscriptSegment,
} from "../protocol";
import { Buffer } from "buffer";
import { uploadAsync, FileSystemUploadType } from "expo-file-system/legacy";

// Columns the report viewer needs. Kept explicit so we don't pull big rows.
const RECORDING_COLS =
  "id,recording_name,protocol,notes,needs_review,patient_id,duration,file_name,created_at,transcript,analysis,error_counts,version,file_path";

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
    wav_base64?: string;
    /** Ms offsets into the recording — same seek-bar-tick pipeline as the
     * SATE hardware's physical flag button. */
    flags?: number[];
    /** Progress of the upload itself, 0..1. A long take spends longer being
     *  handed to SATE than it did coming off the device, and a screen that says
     *  only "Uploading…" for two minutes cannot be told apart from a stall. */
    onProgress?: (fraction: number) => void;
    /** The WAV ON DISK, instead of `wav_base64`. Preferred for anything long:
     *  the audio never enters the JS heap and the upload streams from the file. */
    wav_path?: string;
    /** Size of that file, so nothing has to read it to find out. */
    wav_bytes?: number;
  }): Promise<void>;
  /**
   * Register a device the phone paired over Bluetooth (Plaud / Pendant / L816) so
   * it appears in Connected Recorders on the web, alongside the SATE recorders.
   *
   * These devices can never register themselves the way a recorder does — they
   * have no Wi-Fi and no device key — so the phone vouches for them. Best-effort
   * by design: pairing must still work with the server unreachable, and the
   * server backfills a row from the device's sessions anyway.
   */
  registerExternalDevice(serial: string, name: string): Promise<void>;
  /** The processed report row (transcript + analysis) — the SAME record the web app shows. */
  getRecording(id: string): Promise<Recording>;
  /**
   * Reports that already exist on the server, newest first.
   *
   * The app never derives or generates one: a report is produced by the clinical
   * pipeline and this only reads it. The list is deliberately the LIGHT columns —
   * a transcript is large and the list shows none of it.
   */
  listRecordings(limit?: number): Promise<Recording[]>;
  /**
   * A short-lived signed URL for a recording's audio, so the phone can play the
   * same file the web player uses. `recordings` is a PRIVATE bucket — there is
   * no public URL, and there must not be: this is patient audio.
   */
  getRecordingAudioUrl(filePath: string): Promise<string | null>;
  /** First-open review: rename + set protocol/notes and clear needs_review. */
  updateRecording(id: string, meta: RecordingMeta): Promise<void>;
  /**
   * Save an edited transcript — for naming speakers, today.
   *
   * Goes through the `save_transcript` RPC, never a direct table UPDATE, for the
   * same reason the web app does: it keeps the previous transcript in
   * `recording_versions` and compare-and-swaps on `version`, so two people
   * editing one transcript cannot silently overwrite each other. Pass the
   * version that was loaded; a `PT409` means the row moved on and the caller
   * must reload before saving again.
   *
   * Throws `TranscriptConflict` on PT409 so the caller can tell "someone else
   * saved" apart from "the network is down" — they need very different words.
   */
  saveTranscript(
    id: string,
    transcript: { segments?: TranscriptSegment[] } & Record<string, unknown>,
    expectedVersion: number | null
  ): Promise<void>;
  /**
   * Mint a short-lived (~24h) Plaud "User Access Token" for the Connect-with-
   * Plaud flow. Partner secrets stay server-side in the mint-plaud-token Edge
   * Function; the app only ever sees the per-user token.
   */
  getPlaudToken(): Promise<{ token: string; expiresAt: number }>;
}

// ---------------------------------------------------------------- real API

// Called when an authed request comes back 401. It should refresh the Supabase
// session and resolve to a fresh access token (or null if it can't). The api
// then retries the request once with the new token — so an expired access token
// is invisible to the user, exactly like the web app's auto-refresh.
export type RefreshHandler = () => Promise<string | null>;

/**
 * Above this many bytes the upload is chunked instead of sent as one JSON body.
 *
 * 4 MB is comfortably under the edge function's limits with the ~33% base64
 * overhead on top, and comfortably above every take the pendant or a short
 * handheld recording produces — so the common case stays one round trip.
 */
const SINGLE_SHOT_MAX = 4 * 1024 * 1024;


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
  /**
   * Hand a finished take to SATE.
   *
   * 🛑 A LONG RECORDING MUST NOT GO THROUGH THE EDGE FUNCTION AT ALL.
   *
   * The single-shot POST carries the whole WAV as base64 inside one JSON body,
   * and that is where long takes died: HTTP 546 `WORKER_RESOURCE_LIMIT`, part-way
   * through, on a recording that had already come off the hardware perfectly.
   * Streaming the body server-side raised that to about an hour — and then the
   * wall moved somewhere no server code can reach, a 502 at the gateway.
   *
   * So above the threshold the bytes skip the function entirely: ask for a signed
   * Storage URL, PUT the audio straight into Storage (which is built for this),
   * then register the object. Measured end to end at 8 hours / 922 MB. The
   * remaining limit is the bucket's, which is a setting rather than code.
   *
   * Short takes keep the single POST: one round trip instead of three, and no
   * object left behind if the phone dies mid-upload.
   */
  async uploadSession(args: {
    device_serial: string;
    patient_id: string;
    session_number: number;
    sample_rate: number;
    wav_base64?: string;
    wav_path?: string;
    wav_bytes?: number;
    flags?: number[];
    onProgress?: (fraction: number) => void;
  }) {
    const { wav_base64, wav_path, wav_bytes, onProgress, ...meta } = args;

    // A take on DISK never touches the JS heap. This is the path the L816 uses,
    // and it is the only one whose cost does not grow with the recording.
    if (wav_path) {
      const slot = await this.req<{
        session_id: string;
        storage_path: string;
        signed_url: string;
      }>("/api/sessions/upload-url", {
        method: "POST",
        body: JSON.stringify({ device_serial: meta.device_serial }),
      });

      // BINARY_CONTENT streams the file as the request body straight from disk —
      // no base64, no Buffer, nothing proportional to the take in memory.
      //
      // Retried on a transient status, because the caller cannot: the L816 sweep
      // stops at the first failure, so a single 502 from the Storage gateway
      // stranded every take queued behind this one. The PUT is an upsert to a
      // path this session already owns, so repeating it is safe — worst case it
      // overwrites its own half-written object.
      let res: Awaited<ReturnType<typeof uploadAsync>> | null = null;
      for (let attempt = 0; attempt < UPLOAD_RETRY_MS.length; attempt++) {
        if (UPLOAD_RETRY_MS[attempt] > 0) {
          await new Promise((r) => setTimeout(r, UPLOAD_RETRY_MS[attempt]));
        }
        try {
          res = await uploadAsync(slot.signed_url, wav_path, {
            httpMethod: "PUT",
            uploadType: FileSystemUploadType.BINARY_CONTENT,
            headers: { "Content-Type": "audio/wav", "x-upsert": "true" },
          });
        } catch (e: any) {
          // A dropped socket is weather too. Out of attempts, rethrow as-is.
          if (attempt === UPLOAD_RETRY_MS.length - 1) throw e;
          continue;
        }
        if (res.status >= 200 && res.status < 300) break;
        if (!isTransientStatus(res.status) || attempt === UPLOAD_RETRY_MS.length - 1) {
          // The take is still on the device and still unmarked, so this is a
          // retry, not a loss — say which half failed so the log is worth
          // reading, and strip the gateway's HTML so the user sees a sentence.
          throw new Error(
            `SATE could not store the audio (HTTP ${res.status}). ` +
              `The recording is still on the recorder. ${briefBody(res.body)}`.trim()
          );
        }
      }
      onProgress?.(1);

      // Registering only AFTER the object is really in Storage is what keeps a
      // failed upload from leaving a row pointing at nothing — the ghost that
      // strands a recording on the device for ever.
      await this.req("/api/sessions/register", {
        method: "POST",
        body: JSON.stringify({
          session_id: slot.session_id,
          storage_path: slot.storage_path,
          ...meta,
        }),
      });
      return;
    }

    if (!wav_base64) throw new Error("uploadSession needs either wav_path or wav_base64");

    // In-memory callers (the pendant streams PCM and is always short).
    const bytes = Buffer.from(wav_base64, "base64");
    if (bytes.length <= SINGLE_SHOT_MAX) {
      await this.req("/api/sessions", {
        method: "POST",
        body: JSON.stringify({ ...meta, wav_base64 }),
      });
      return;
    }

    const slot = await this.req<{
      session_id: string;
      storage_path: string;
      signed_url: string;
    }>("/api/sessions/upload-url", {
      method: "POST",
      body: JSON.stringify({ device_serial: meta.device_serial }),
    });
    const put = await fetch(slot.signed_url, {
      method: "PUT",
      headers: { "Content-Type": "audio/wav", "x-upsert": "true" },
      body: bytes as unknown as BodyInit,
    });
    if (!put.ok) {
      throw new Error(
        `SATE could not store the audio (HTTP ${put.status}). ` +
          briefBody(await put.text().catch(() => ""))
      );
    }
    onProgress?.(1);
    await this.req("/api/sessions/register", {
      method: "POST",
      body: JSON.stringify({
        session_id: slot.session_id,
        storage_path: slot.storage_path,
        ...meta,
      }),
    });
  }

  async registerExternalDevice(serial: string, name: string) {
    await this.req("/api/devices/external", {
      method: "POST",
      body: JSON.stringify({ serial, name }),
    });
  }
  async saveTranscript(
    id: string,
    transcript: { segments?: TranscriptSegment[] } & Record<string, unknown>,
    expectedVersion: number | null
  ) {
    const res = await this.restRaw("/rpc/save_transcript", {
      method: "POST",
      body: JSON.stringify({
        p_recording_id: id,
        p_expected_version: expectedVersion,
        p_transcript: transcript,
        // The mobile editor only ever renames a speaker: the words, the timings
        // and the error marks are untouched, so it must NOT recompute analysis
        // or error counts from a partial view and overwrite the real ones.
        p_error_counts: null,
        p_analysis: null,
        p_segments_edited: true,
      }),
    });
    if (res.status === 409 || (await res.clone().text()).includes("PT409")) {
      throw new TranscriptConflict();
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
    }
  }
  async getPlaudToken() {
    // Lives on a different Edge Function than baseUrl (device-api), so call it
    // directly; mirror req()'s single 401-refresh-and-retry.
    const call = async (tok: string | null) =>
      fetch(`${SUPABASE_URL}/functions/v1/mint-plaud-token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        },
      });
    let res = await call(this.token);
    if (res.status === 401 && this.onUnauthorized) {
      const fresh = await this.onUnauthorized();
      if (fresh) {
        this.token = fresh;
        res = await call(fresh);
      }
    }
    if (!res.ok) {
      throw new Error(`${res.status} ${(await res.text().catch(() => "")) || res.statusText}`);
    }
    return res.json() as Promise<{ token: string; expiresAt: number }>;
  }

  // ---- recordings: read the processed report straight from Supabase REST ----
  // The web app and the phone read the very same `recordings` rows; RLS scopes
  // them to the signed-in owner so no extra endpoint is needed.
  /**
   * PostgREST call that hands back the raw Response, with the SAME auth and
   * single 401-refresh-and-replay as `rest`. Needed where the STATUS and BODY
   * carry meaning the caller must act on — `save_transcript` answers PT409 for
   * a lost compare-and-swap, and collapsing that into a generic Error would
   * turn "someone else edited this" into "something went wrong".
   */
  private async restRaw(path: string, init?: RequestInit, retried = false): Promise<Response> {
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
        return this.restRaw(path, init, true);
      }
    }
    return res;
  }

  private async rest<T>(path: string, init?: RequestInit, retried = false): Promise<T> {
    const res = await this.restRaw(path, init, retried);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${body || res.statusText}`);
    }
    return res.status === 204 ? (undefined as T) : res.json();
  }

  async getRecordingAudioUrl(filePath: string) {
    if (!filePath) return null;
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/recordings/${filePath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        // An hour is plenty to listen to a take and is short enough that a URL
        // which leaks out of a log stops working on its own.
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    const rel = j?.signedURL ?? j?.signedUrl;
    return rel ? `${SUPABASE_URL}/storage/v1${rel}` : null;
  }

  async listRecordings(limit = 100) {
    return this.rest<Recording[]>(
      `/recordings?select=id,recording_name,protocol,patient_id,duration,file_name,created_at,analysis,error_counts` +
        `&order=created_at.desc&limit=${limit}`
    );
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


/**
 * Is this the kind of upload failure that WILL work on the next try?
 *
 * 🛑 The distinction decides whether a whole sync survives. Supabase's Storage
 * gateway answers a `502 Bad Gateway` now and then — seen live on a 6-second
 * take, with the service healthy before and after — and the L816 sweep stops at
 * the first failure, so one hiccup left three good recordings on the device
 * behind a red "Something went wrong". A 4xx is our fault and retrying it is
 * just three ways to fail; a 5xx, a 408, a 429 or a dropped socket is the
 * server's weather.
 */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** 0 s, 1.5 s, 4 s — long enough for a gateway blip, short enough to still feel live. */
const UPLOAD_RETRY_MS = [0, 1500, 4000];

/** A short, readable version of a gateway's HTML error page. */
function briefBody(body: string | null | undefined): string {
  const s = (body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return s.slice(0, 120);
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
/** The recording moved on while this editor held it — reload before saving. */
export class TranscriptConflict extends Error {
  constructor() {
    super(
      "Someone else saved changes to this transcript while you were editing. " +
        "Reload the recording before saving again."
    );
    this.name = "TranscriptConflict";
  }
}

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

// "Sign in on phone": exchange a one-time code (typed or scanned from the web
// app's QR) for a real Supabase session via the `mobile-link` Edge Function.
// Returns the SAME shape as login(), so the caller stores + auto-refreshes it
// identically — the only difference is no password was entered on the phone.
export async function consumeMobileLink(
  code: string
): Promise<{ token: string; refreshToken: string | null; expiresAt: number; user: User }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/mobile-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ action: "consume", code: code.trim() }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(j?.error || `Sign-in failed (${res.status})`);
  }
  const u = j.user || {};
  return {
    token: j.access_token as string,
    refreshToken: (j.refresh_token as string) ?? null,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    user: { id: u.id, email: u.email, name: u.name || u.email },
  };
}
