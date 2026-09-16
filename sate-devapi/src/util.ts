// Shared primitives: env typing, JSON/error responses, ids, hashing, WAV probing.

export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  // `any` here rather than DurableObjectNamespace<DevProcessor>: typing it precisely would
  // make util.ts import container.ts, which imports Env back out of util.ts.
  PROCESSOR: DurableObjectNamespace<any>;
  EMAIL?: { send(msg: unknown): Promise<void> };

  PORTAL_HOST: string;
  API_HOST: string;
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  OPERATOR_EMAIL: string;
  MAX_UPLOAD_MB: string;
  JOB_RETENTION_DAYS: string;
  AUDIO_RETENTION_HOURS: string;
  MAX_ATTEMPTS: string;
  STUCK_MINUTES: string;
  BOOTSTRAP_ADMIN_EMAIL: string;
  // Base URL of the text-analysis service (c-unit / maze / morpheme). A plain host, not a
  // secret — the /v1/cunit|maze|morpheme routes proxy short synchronous calls to it.
  SATE_TEXT_API_URL?: string;

  // Secrets
  INTERNAL_SECRET: string;
  TICK_SECRET: string;
  AI_PROCESS_URL?: string;
  CLINICAL_PROBE_URL?: string;
  CLINICAL_PROBE_KEY?: string;
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-sate-key',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

/**
 * Every API failure has a stable machine-readable `code`. Developers build retry logic
 * on these, so treat a code as part of the public contract — add new ones, never
 * repurpose an existing one.
 */
export function apiError(
  code: string,
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
) {
  return json({ error: { code, message, ...extra } }, status);
}

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();

const HEX = '0123456789abcdef';
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  let out = '';
  for (const b of new Uint8Array(buf)) out += HEX[b >> 4] + HEX[b & 15];
  return out;
}

/** Constant-time string compare — used for shared secrets, never `===`. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Token with ~165 bits of entropy from the CSPRNG. Used for API keys and cookies. */
export function randomToken(len = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return s;
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Duration of a WAV from its header, or null if the bytes aren't a WAV we understand.
 *
 * Used for the quota pre-check, so it must never throw on a malformed upload — an
 * unparseable file is simply metered by its real duration after the AI returns.
 */
export function wavSeconds(buf: ArrayBuffer): number | null {
  try {
    const dv = new DataView(buf);
    if (dv.byteLength < 44) return null;
    const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= dv.byteLength) {
      const id = tag(offset);
      const size = dv.getUint32(offset + 4, true);
      if (id === 'fmt ' && offset + 8 + 16 <= dv.byteLength) {
        byteRate = dv.getUint32(offset + 16, true);
      } else if (id === 'data') {
        if (!byteRate) return null;
        // A streamed WAV can carry a bogus 0/0xFFFFFFFF data size; fall back to what's there.
        const declared = size;
        const actual = dv.byteLength - (offset + 8);
        const bytes = declared > 0 && declared <= actual ? declared : actual;
        return bytes / byteRate;
      }
      offset += 8 + size + (size % 2); // chunks are word-aligned
    }
    return null;
  } catch {
    return null;
  }
}

/** First day of the current UTC month, ISO. */
export function monthStart(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

/**
 * The instant a developer's audio usage is counted from.
 *
 * 'total' counts from the last admin reset (or account creation) forever; 'monthly' counts
 * from the start of this month, unless the admin reset more recently — a reset always wins,
 * so pressing it mid-month really does zero the figure.
 */
export function quotaWindowStart(period: string, resetAt: string): string {
  if (period === 'total') return resetAt;
  const m = monthStart();
  return resetAt > m ? resetAt : m;
}

export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

/** Best-effort operator/developer email. Never let a mail failure break a request. */
export async function sendEmail(env: Env, to: string, subject: string, text: string) {
  if (!env.EMAIL) return;
  try {
    // The Cloudflare Email Sending binding takes a raw-ish message object.
    await env.EMAIL.send({
      to: [{ email: to }],
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
      subject,
      text,
    });
  } catch (e) {
    console.error('email failed', (e as Error).message);
  }
}
