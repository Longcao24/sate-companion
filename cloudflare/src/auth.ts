// SATE — authentication. The Cloudflare replacement for Supabase Auth (GoTrue).
//
// Cloudflare has no managed user/password service, so this owns the whole thing: password
// hashing, JWT minting/verification, refresh rotation. It implements exactly the surface
// the existing clients use (verified by grep against react_app_sate-ui_update/src):
//
//   supabase.auth.signUp                 -> POST /auth/v1/signup
//   supabase.auth.signInWithPassword     -> POST /auth/v1/token?grant_type=password
//   supabase.auth.getUser                -> GET  /auth/v1/user
//   supabase.auth.getSession             -> (client-side; refreshes via grant_type=refresh_token)
//   supabase.auth.signOut                -> POST /auth/v1/logout
//   supabase.auth.updateUser             -> PUT  /auth/v1/user
//   supabase.auth.resetPasswordForEmail  -> POST /auth/v1/recover
//   supabase.auth.onAuthStateChange      -> (client-side only; no server route)
//
// Claim shape mirrors a Supabase access token (sub/email/role/aud/iat/exp) so anything
// already reading those claims — including the edge functions being ported — keeps working.
//
// ⚠️ JWT_SECRET must be a real secret (`wrangler secret put JWT_SECRET`), never a var in
// wrangler.toml. Anyone holding it can mint a token for any user, which is every patient
// record in the system.

import type { Ctx } from './policy';

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------
function b64uEncode(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2-HMAC-SHA256.
//
// ⚠️ THIS IS WEAKER THAN SUPABASE. Read before assuming parity.
//
// Supabase Auth (GoTrue) hashes with bcrypt. bcrypt and argon2 are both memory-hard and
// both are the right answer here — but neither exists in the Workers runtime, and getting
// one means shipping a WASM build. PBKDF2 is what WebCrypto offers natively, and it is not
// memory-hard, so it is materially cheaper to attack on GPUs than bcrypt at equal wall time.
//
// It is then capped further by the platform:
//
//     NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported
//
// Workers refuses anything over 100_000. OWASP's 2023 guidance for PBKDF2-SHA256 is
// 600_000 (or 210_000 with a subsequent HMAC pepper). Neither is reachable here. 100_000 is
// the platform maximum, not a chosen figure — so this is the strongest PBKDF2 the runtime
// permits, and it is still short of current guidance.
//
// Do NOT try to buy back the margin by chaining two 100_000 rounds: composing PBKDF2 with
// itself is a homebrew construction with no security proof, and 2x100k is not 200k.
//
// If password strength matters more than the $20/mo this stack saves, the options are
// (a) ship argon2 as WASM, or (b) stay on Supabase. See README.
//
// Stored format: pbkdf2$<iterations>$<salt_b64u>$<hash_b64u>. The iteration count travels
// with the hash, so if Workers ever lifts the cap it can be raised without invalidating
// existing passwords — verification reads the count from the stored value.
// ---------------------------------------------------------------------------
const PBKDF2_ITERATIONS = 100_000; // platform maximum; see above before changing
const PBKDF2_HASH_BITS = 256;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await deriveBits(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64uEncode(salt)}$${b64uEncode(bits)}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;

  const salt = b64uDecode(parts[2]);
  const expected = b64uDecode(parts[3]);
  const actual = new Uint8Array(await deriveBits(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

async function deriveBits(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, PBKDF2_HASH_BITS);
}

/** Constant-time compare. A plain === leaks the match position through timing. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------
export interface Claims {
  sub: string;
  email: string;
  role: 'authenticated';
  aud: 'authenticated';
  iat: number;
  exp: number;
}

const ACCESS_TTL_SEC = 3600; // 1h, matching Supabase's default access-token lifetime.

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function mintAccessToken(secret: string, user: { id: string; email: string }): Promise<{ token: string; expiresIn: number; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = {
    sub: user.id,
    email: user.email,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + ACCESS_TTL_SEC,
  };
  const header = b64uEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64uEncode(enc.encode(JSON.stringify(claims)));
  const signing = `${header}.${payload}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signing));
  return { token: `${signing}.${b64uEncode(sig)}`, expiresIn: ACCESS_TTL_SEC, expiresAt: claims.exp };
}

/** Verify signature + expiry. Returns null on any failure — callers must not distinguish why. */
export async function verifyAccessToken(secret: string, token: string): Promise<Claims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64uDecode(sig), enc.encode(`${header}.${payload}`));
  } catch {
    return null;
  }
  if (!ok) return null;

  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(b64uDecode(payload)));
  } catch {
    return null;
  }

  // alg is not read back from the header on purpose: verify() above is pinned to HMAC, so
  // an attacker cannot swap in alg:none or an asymmetric alg and have it honoured.
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
  return claims;
}

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

/**
 * Resolve the caller from an incoming request.
 *
 * serviceRole is granted ONLY on an exact match against the service key, which lives in a
 * Worker secret and is never shipped to a browser. It bypasses every access policy, so the
 * comparison is constant-time and the key is never accepted from a query string.
 */
export async function contextFrom(req: Request, env: { JWT_SECRET: string; SERVICE_KEY: string }): Promise<Ctx> {
  const header = req.headers.get('Authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return { uid: null, serviceRole: false };

  if (constantTimeStringEqual(token, env.SERVICE_KEY)) return { uid: null, serviceRole: true };

  const claims = await verifyAccessToken(env.JWT_SECRET, token);
  return { uid: claims?.sub ?? null, serviceRole: false };
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Refresh tokens
// ---------------------------------------------------------------------------
const REFRESH_TTL_DAYS = 30;

export function newRefreshToken(): string {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

export function refreshExpiry(): string {
  return new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();
}

export const nowIso = (): string => new Date().toISOString();
