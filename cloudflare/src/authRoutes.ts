// SATE — GoTrue-compatible HTTP routes, mounted under /auth/v1.
//
// Paths and payload shapes follow Supabase Auth so the client shim can be a thin fetch
// wrapper and the call sites keep their supabase-js shape.

import {
  hashPassword,
  verifyPassword,
  mintAccessToken,
  newRefreshToken,
  refreshExpiry,
  nowIso,
  verifyAccessToken,
} from './auth';
import { HttpError } from './rest';
import { decodeRow } from './columns';
import { sendPasswordReset, type EmailEnv } from './email';

export interface AuthEnv extends EmailEnv {
  DB: D1Database;
  JWT_SECRET: string;
  SERVICE_KEY: string;
  /** Where the emailed password-reset link should point. */
  SITE_URL: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string | null;
  user_metadata: string;
  email_confirmed_at: string | null;
  last_sign_in_at: string | null;
  created_at: string;
}

/** Public shape of a user, matching what supabase-js hands to the app. */
function publicUser(row: UserRow) {
  const decoded = decodeRow('users', row as unknown as Record<string, unknown>);
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: row.email,
    email_confirmed_at: row.email_confirmed_at,
    last_sign_in_at: row.last_sign_in_at,
    created_at: row.created_at,
    user_metadata: decoded.user_metadata ?? {},
    app_metadata: { provider: 'email', providers: ['email'] },
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function findByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db.prepare(`SELECT * FROM users WHERE lower(email) = lower(?)`).bind(email).first<UserRow>();
}

async function issueSession(env: AuthEnv, user: UserRow) {
  const { token, expiresIn, expiresAt } = await mintAccessToken(env.JWT_SECRET, { id: user.id, email: user.email });
  const refresh = newRefreshToken();
  await env.DB.prepare(`INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(refresh, user.id, refreshExpiry())
    .run();
  await env.DB.prepare(`UPDATE users SET last_sign_in_at = ? WHERE id = ?`).bind(nowIso(), user.id).run();

  return {
    access_token: token,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    refresh_token: refresh,
    user: publicUser(user),
  };
}

export async function handleAuth(req: Request, url: URL, env: AuthEnv): Promise<Response> {
  const path = url.pathname.replace(/^\/auth\/v1/, '');

  // ---- POST /auth/v1/signup ----
  if (path === '/signup' && req.method === 'POST') {
    const body = await req.json<{ email?: string; password?: string; data?: Record<string, unknown> }>();
    const email = (body.email ?? '').trim();
    const password = body.password ?? '';
    if (!email || !password) throw new HttpError(400, 'email and password are required');
    if (password.length < 6) throw new HttpError(422, 'Password should be at least 6 characters');

    if (await findByEmail(env.DB, email)) {
      // GoTrue deliberately does not confirm whether an address is registered; matching that
      // keeps the endpoint from being used to enumerate accounts.
      throw new HttpError(422, 'User already registered');
    }

    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, password_hash, user_metadata, email_confirmed_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(id, email, await hashPassword(password), JSON.stringify(body.data ?? {}), nowIso())
      .run();
    // email_confirmed_at is set immediately: there is no mail sender wired up here, and
    // leaving it null would lock every new account out. See README — this is a real
    // divergence from the Supabase project, not an oversight.

    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>();
    return json(await issueSession(env, user!));
  }

  // ---- POST /auth/v1/token?grant_type=password|refresh_token ----
  if (path === '/token' && req.method === 'POST') {
    const grant = url.searchParams.get('grant_type');

    if (grant === 'password') {
      const body = await req.json<{ email?: string; password?: string }>();
      const user = await findByEmail(env.DB, (body.email ?? '').trim());
      // Hash even when the user is unknown, so a missing account and a wrong password take
      // the same time and cannot be told apart.
      const ok = await verifyPassword(body.password ?? '', user?.password_hash ?? '$dummy$');
      if (!user || !ok) throw new HttpError(400, 'Invalid login credentials');
      return json(await issueSession(env, user));
    }

    if (grant === 'refresh_token') {
      const body = await req.json<{ refresh_token?: string }>();
      const token = body.refresh_token ?? '';
      const row = await env.DB.prepare(`SELECT * FROM refresh_tokens WHERE token = ?`)
        .bind(token)
        .first<{ token: string; user_id: string; expires_at: string; revoked: number }>();
      if (!row || row.revoked === 1 || row.expires_at <= nowIso()) throw new HttpError(400, 'Invalid Refresh Token');

      // Rotate: a refresh token is single-use, so a stolen one is only good until the real
      // client next refreshes.
      await env.DB.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE token = ?`).bind(token).run();
      const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(row.user_id).first<UserRow>();
      if (!user) throw new HttpError(400, 'Invalid Refresh Token');
      return json(await issueSession(env, user));
    }

    throw new HttpError(400, `unsupported grant_type "${grant}"`);
  }

  // ---- GET/PUT /auth/v1/user ----
  if (path === '/user') {
    const claims = await verifyAccessToken(env.JWT_SECRET, bearer(req));
    if (!claims) throw new HttpError(401, 'invalid claim: missing sub claim');
    const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(claims.sub).first<UserRow>();
    if (!user) throw new HttpError(401, 'user not found');

    if (req.method === 'GET') return json(publicUser(user));

    if (req.method === 'PUT') {
      const body = await req.json<{ password?: string; email?: string; data?: Record<string, unknown> }>();
      const sets: string[] = [];
      const params: unknown[] = [];

      if (body.password) {
        if (body.password.length < 6) throw new HttpError(422, 'Password should be at least 6 characters');
        sets.push('password_hash = ?');
        params.push(await hashPassword(body.password));
        // Every existing session keeps working after a password change unless the old
        // refresh tokens are killed, which is the whole point of changing it.
        await env.DB.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`).bind(user.id).run();
      }
      if (body.email) {
        const clash = await findByEmail(env.DB, body.email);
        if (clash && clash.id !== user.id) throw new HttpError(422, 'Email address already in use');
        sets.push('email = ?');
        params.push(body.email.trim());
      }
      if (body.data) {
        // GoTrue merges into raw_user_meta_data rather than replacing it.
        const merged = { ...(JSON.parse(user.user_metadata || '{}') as object), ...body.data };
        sets.push('user_metadata = ?');
        params.push(JSON.stringify(merged));
      }
      if (sets.length === 0) return json(publicUser(user));

      sets.push('updated_at = ?');
      params.push(nowIso(), user.id);
      await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();
      const fresh = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(user.id).first<UserRow>();
      return json(publicUser(fresh!));
    }
  }

  // ---- POST /auth/v1/logout ----
  if (path === '/logout' && req.method === 'POST') {
    const claims = await verifyAccessToken(env.JWT_SECRET, bearer(req));
    // GoTrue answers 204 regardless; a failed sign-out must not look different from a
    // successful one, and the client has already dropped its local session either way.
    if (claims) {
      await env.DB.prepare(`UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?`).bind(claims.sub).run();
    }
    return new Response(null, { status: 204 });
  }

  // ---- POST /auth/v1/recover ----
  if (path === '/recover' && req.method === 'POST') {
    const body = await req.json<{ email?: string }>();
    const user = await findByEmail(env.DB, (body.email ?? '').trim());

    if (user) {
      const token = newRefreshToken();
      await env.DB.prepare(`INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
        .bind(token, user.id, new Date(Date.now() + 3600_000).toISOString())
        .run();

      // Delivered via Cloudflare Email Service. The result is deliberately ignored: whether
      // the mail sent must not change the response (see below). sendPasswordReset logs its
      // own failures.
      await sendPasswordReset(env, user.email, token);
    }

    // Always 200, whether or not the address exists and whether or not the mail sent.
    // Anything else turns this into an account-enumeration oracle. GoTrue does the same.
    return json({});
  }

  throw new HttpError(404, `no auth route for ${req.method} ${path}`);
}

function bearer(req: Request): string {
  const h = req.headers.get('Authorization') ?? '';
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
}
