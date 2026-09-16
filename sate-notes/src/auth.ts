// Identity bridge: Supabase issues the session, this Worker trusts it.
//
// The clinical stack stays the single source of identity — a user logs into the SATE web app
// exactly as before and nothing about that flow changes. This service never sees a password,
// never mints a session, and holds no copy of the user table. It only answers "who is this
// token?" and "may this account use the notes feature?".
//
// ⚠️ NO SHARED SECRET, deliberately. Verifying the JWT locally would mean copying Supabase's
// signing secret into a second system: two places to rotate, and a leak here would forge
// sessions for the clinical app too. Instead the token is presented to Supabase's own
// /auth/v1/user endpoint, which is the only party that can authoritatively answer. The cost is
// one fetch per token, so results are cached briefly per isolate.

import type { Env } from './index';

export interface Caller { id: string; email: string }

/** token -> {caller, expires}. Per-isolate, so it dies with the isolate; that is fine. */
const cache = new Map<string, { caller: Caller; exp: number }>();
const TTL_MS = 60_000;

/**
 * Resolve a Supabase access token to a user, or null. Never throws on a bad token — an
 * unauthenticated caller is a 401, not a 500.
 */
export async function resolveUser(env: Env, token: string): Promise<Caller | null> {
  if (!token) return null;
  const hit = cache.get(token);
  if (hit && hit.exp > Date.now()) return hit.caller;

  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
  } catch {
    return null;   // Supabase unreachable: refuse rather than guess.
  }
  if (!res.ok) return null;

  const body = await res.json<{ id?: string; email?: string }>().catch(() => ({} as any));
  if (!body?.id) return null;
  const caller: Caller = { id: body.id, email: (body.email || '').toLowerCase() };

  // Bound the cache: a Worker isolate can serve a lot of distinct tokens and this map has no
  // other eviction.
  if (cache.size > 500) cache.clear();
  cache.set(token, { caller, exp: Date.now() + TTL_MS });
  return caller;
}

export interface Access { enabled: boolean; mode: string; isAdmin: boolean }

/** token -> {isAdmin, expires}. Same isolate lifetime and TTL as the identity cache. */
const adminCache = new Map<string, { admin: boolean; exp: number }>();

/**
 * Is this caller a SATE admin? Asks the clinical stack, which owns `sate_admins` — the ONE
 * admin list. A second list here would mean an admin promoted in the SATE app silently has no
 * authority over this lane (and, worse, one demoted there keeps it). `notes_admins` stays as a
 * bench/ops fallback for a Worker deployed without device-api reachable.
 */
async function sateAdmin(env: Env, token: string): Promise<boolean> {
  if (!token || !env.DEVICE_API_URL) return false;
  const hit = adminCache.get(token);
  if (hit && hit.exp > Date.now()) return hit.admin;
  let admin = false;
  try {
    const res = await fetch(`${env.DEVICE_API_URL}/admin/me`, {
      headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (res.ok) admin = Boolean((await res.json<{ isAdmin?: boolean }>()).isAdmin);
  } catch { /* unreachable: fall back to notes_admins, never grant on an error */ }
  if (adminCache.size > 500) adminCache.clear();
  adminCache.set(token, { admin, exp: Date.now() + TTL_MS });
  return admin;
}

/**
 * What this account is allowed to do here. An account with no row has NO access: the notes
 * feature is off for everyone until an admin turns it on, so adding this service to the stack
 * cannot change what any existing user sees.
 */
export async function accessFor(env: Env, caller: Caller, token?: string): Promise<Access> {
  let row = await env.DB.prepare(`SELECT enabled, mode FROM account_access WHERE user_id = ?`)
    .bind(caller.id).first<{ enabled: number; mode: string }>();

  // First sight of an account records it, DISABLED. Without this the admin switch has nothing
  // to switch: an admin cannot grant access to a uuid they have no way to learn, and asking a
  // user to read their own uuid out of a JWT is not a workflow. Signing into the app once is.
  // The row grants nothing — enabled defaults to 0 — it only makes the account listable.
  if (!row) {
    await env.DB.prepare(
      `INSERT INTO account_access (user_id, email, enabled, mode, updated_at)
       VALUES (?, ?, 0, 'clinical', ?) ON CONFLICT(user_id) DO NOTHING`,
    ).bind(caller.id, caller.email, new Date().toISOString()).run();
    row = { enabled: 0, mode: 'clinical' };
  } else if (caller.email) {
    // Keep the email fresh so the admin list stays readable after a change of address.
    await env.DB.prepare(`UPDATE account_access SET email = ? WHERE user_id = ? AND email <> ?`)
      .bind(caller.email, caller.id, caller.email).run();
  }
  const local = caller.email
    ? await env.DB.prepare(`SELECT email FROM notes_admins WHERE email = ?`).bind(caller.email).first()
    : null;
  return {
    enabled: row?.enabled === 1,
    mode: row?.mode || 'clinical',
    isAdmin: Boolean(local) || (token ? await sateAdmin(env, token) : false),
  };
}

/** The caller for a user-facing request, or null. Also records the email for the admin list. */
export async function callerFrom(req: Request, env: Env): Promise<{ caller: Caller; access: Access } | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
  if (!token || token === env.ADMIN_KEY) return null;   // the ops key is not a user
  const caller = await resolveUser(env, token);
  if (!caller) return null;
  return { caller, access: await accessFor(env, caller, token) };
}
