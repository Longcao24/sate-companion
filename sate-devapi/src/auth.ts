// Authentication for both faces of the service.
//
//   Portal  — email + password, HttpOnly cookie session. Can manage keys; can NEVER call /v1.
//   API     — `Authorization: Bearer sate_live_…`. Can call /v1; can NEVER touch the portal.
//
// Keeping the two credential types strictly non-interchangeable is the point: a leaked API
// key cannot mint more keys or read the developer's account, and a stolen cookie cannot be
// replayed against the machine API from another origin.

import { Env, sha256Hex, randomToken, uid, now, iso, parseJson, timingSafeEqual } from './util';

// ---------------------------------------------------------------------------
// Passwords — PBKDF2-HMAC-SHA256.
//
// 100_000 iterations is the Workers platform maximum (it throws above that), not a chosen
// figure, and it is short of OWASP's 600_000 guidance for PBKDF2-SHA256. Do NOT try to buy
// the margin back by chaining two 100k rounds — composing PBKDF2 with itself is a homebrew
// construction with no proof, and 2x100k is not 200k. The real upgrade is argon2 as WASM.
//
// Stored format: pbkdf2$<iterations>$<salt_b64u>$<hash_b64u>. The count travels with the
// hash, so raising it later does not invalidate existing passwords.
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_HASH_BITS = 256;

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, PBKDF2_HASH_BITS);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64u(salt)}$${b64u(bits)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const bits = await deriveBits(password, unb64u(parts[2]), iterations);
  return timingSafeEqual(b64u(bits), parts[3]);
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------
export const ALL_SCOPES = ['transcript:read', 'annotations:read', 'report:read', 'text:read'] as const;
export type Scope = (typeof ALL_SCOPES)[number];

/** The scope a given result view requires. */
export const VIEW_SCOPE: Record<string, Scope> = {
  transcript: 'transcript:read',
  annotations: 'annotations:read',
  report: 'report:read',
};

export function sanitizeScopes(requested: unknown, allowed: string[]): string[] {
  const req = Array.isArray(requested) ? requested.map(String) : [];
  const set = new Set(allowed);
  const out = req.filter((s) => (ALL_SCOPES as readonly string[]).includes(s) && set.has(s));
  return Array.from(new Set(out));
}

// ---------------------------------------------------------------------------
// Portal sessions
// ---------------------------------------------------------------------------
const SESSION_DAYS = 14;
export const COOKIE = 'sate_dev_session';

export interface Developer {
  id: string;
  email: string;
  password_hash: string | null;
  name: string;
  org: string;
  status: string;
  is_admin: number;
  scopes: string;
  quota_minutes: number;
  quota_period: string;
  quota_reset_at: string;
  api_locked: number;
  lock_reason: string;
  rate_per_min: number;
  max_keys: number;
  created_at: string;
  approved_at?: string | null;
}

export async function createSession(env: Env, developerId: string, userAgent: string): Promise<string> {
  const raw = randomToken(40);
  await env.DB.prepare(
    `INSERT INTO portal_sessions (token, developer_id, expires_at, user_agent) VALUES (?, ?, ?, ?)`,
  )
    .bind(await sha256Hex(raw), developerId, iso(SESSION_DAYS * 86400_000), userAgent.slice(0, 200))
    .run();
  return raw;
}

export function sessionCookie(raw: string, secure = true): string {
  const attrs = [
    `${COOKIE}=${raw}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** Resolve the portal cookie to a developer, or null. Expired sessions are swept lazily. */
export async function currentDeveloper(env: Env, req: Request): Promise<Developer | null> {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const row = await env.DB.prepare(
    `SELECT d.* FROM portal_sessions s
       JOIN developers d ON d.id = s.developer_id
      WHERE s.token = ? AND s.expires_at > ?`,
  )
    .bind(await sha256Hex(raw), now())
    .first<Developer>();
  if (!row) return null;
  // A developer suspended mid-session loses portal access immediately, not at expiry.
  if (row.status !== 'active') return null;
  return row;
}

export async function destroySession(env: Env, req: Request): Promise<void> {
  const raw = readCookie(req, COOKIE);
  if (!raw) return;
  await env.DB.prepare(`DELETE FROM portal_sessions WHERE token = ?`).bind(await sha256Hex(raw)).run();
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------
export const KEY_PREFIX = 'sate_live_';

export interface KeyIdentity {
  keyId: string;
  developerId: string;
  scopes: string[];
  ratePerMin: number;
  quotaMinutes: number;
  quotaPeriod: string;
  quotaResetAt: string;
  email: string;
}

/**
 * Mint a key. The plaintext is returned ONCE and never stored — only its SHA-256 is,
 * so a dump of this database cannot be replayed against the API.
 */
export async function mintKey(
  env: Env,
  developerId: string,
  name: string,
  scopes: string[],
  ratePerMin: number,
): Promise<{ id: string; key: string; prefix: string }> {
  const secret = randomToken(32);
  const key = KEY_PREFIX + secret;
  const id = uid();
  const prefix = key.slice(0, KEY_PREFIX.length + 6);
  await env.DB.prepare(
    `INSERT INTO api_keys (id, developer_id, name, prefix, key_hash, scopes, rate_per_min)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, developerId, name.slice(0, 80), prefix, await sha256Hex(key), JSON.stringify(scopes), ratePerMin)
    .run();
  return { id, key, prefix };
}

/**
 * Resolve `Authorization: Bearer sate_live_…` to a key identity.
 *
 * Returns a discriminated failure rather than throwing, because each reason maps to a
 * different documented error code (`unauthorized` vs `account_inactive`).
 */
export async function authenticateKey(
  env: Env,
  req: Request,
): Promise<{ ok: true; identity: KeyIdentity } | { ok: false; code: string; message: string; status: number }> {
  const header = req.headers.get('Authorization') || '';
  const presented = header.startsWith('Bearer ')
    ? header.slice(7).trim()
    : (req.headers.get('x-sate-key') || '').trim();

  if (!presented) {
    return { ok: false, code: 'unauthorized', message: 'Missing API key. Send Authorization: Bearer sate_live_…', status: 401 };
  }
  if (!presented.startsWith(KEY_PREFIX)) {
    return { ok: false, code: 'unauthorized', message: 'Malformed API key.', status: 401 };
  }

  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.developer_id, k.scopes, k.rate_per_min, k.revoked_at,
            d.status, d.quota_minutes, d.quota_period, d.quota_reset_at,
            d.api_locked, d.lock_reason, d.email, d.scopes AS dev_scopes
       FROM api_keys k JOIN developers d ON d.id = k.developer_id
      WHERE k.key_hash = ?`,
  )
    .bind(await sha256Hex(presented))
    .first<any>();

  if (!row) return { ok: false, code: 'unauthorized', message: 'Invalid API key.', status: 401 };
  if (row.revoked_at) return { ok: false, code: 'key_revoked', message: 'This API key has been revoked.', status: 401 };
  if (row.status !== 'active') {
    return { ok: false, code: 'account_inactive', message: `Developer account is ${row.status}.`, status: 403 };
  }
  // An admin lock stops API traffic dead while leaving the portal reachable, so the
  // developer can read the reason instead of guessing at a wall of 401s.
  if (row.api_locked) {
    return {
      ok: false,
      code: 'api_locked',
      message: row.lock_reason
        ? `API access is locked: ${row.lock_reason}`
        : 'API access for this account has been locked by an administrator.',
      status: 403,
    };
  }

  // The key's scopes are re-intersected with the developer's current allowance on every
  // request, so narrowing a developer's scopes takes effect immediately without having to
  // hunt down and rewrite every key they already minted.
  const scopes = sanitizeScopes(parseJson<string[]>(row.scopes, []), parseJson<string[]>(row.dev_scopes, []));

  return {
    ok: true,
    identity: {
      keyId: row.key_id,
      developerId: row.developer_id,
      scopes,
      ratePerMin: row.rate_per_min,
      quotaMinutes: row.quota_minutes,
      quotaPeriod: row.quota_period,
      quotaResetAt: row.quota_reset_at,
      email: row.email,
    },
  };
}

/** Fire-and-forget last-used stamp; a failure here must never fail the request. */
export function touchKey(env: Env, keyId: string): Promise<unknown> {
  return env.DB.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(now(), keyId)
    .run()
    .catch(() => undefined);
}
