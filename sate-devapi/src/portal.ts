// Portal JSON API — everything the developer-facing web UI calls, plus the admin console.
//
// Cookie-authenticated. An API key can NEVER reach these routes and a portal cookie can
// never reach /v1, so neither credential can escalate into the other.
//
// Access model: registration creates a 'pending' developer who can do nothing. An admin
// approves them and assigns the scope allowance, quota, and rate limit. The developer then
// mints their own keys, but only ever with a subset of the scopes they were granted.

import {
  Env, json, apiError, uid, now, parseJson, isEmail, clampInt, sendEmail, quotaWindowStart,
} from './util';
import {
  hashPassword, verifyPassword, createSession, sessionCookie, clearCookie, destroySession,
  currentDeveloper, mintKey, sanitizeScopes, ALL_SCOPES, Developer,
} from './auth';

const MIN_PASSWORD = 10;

function publicDeveloper(d: Developer) {
  return {
    id: d.id,
    email: d.email,
    name: d.name,
    org: d.org,
    status: d.status,
    is_admin: !!d.is_admin,
    scopes: parseJson<string[]>(d.scopes, []),
    quota_minutes: d.quota_minutes,
    quota_period: d.quota_period,
    quota_reset_at: d.quota_reset_at,
    api_locked: !!d.api_locked,
    lock_reason: d.lock_reason,
    rate_per_min: d.rate_per_min,
    max_keys: d.max_keys,
    created_at: d.created_at,
  };
}

/** Audio seconds used inside a developer's own quota window. */
async function usedSeconds(env: Env, d: Developer): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(audio_seconds), 0) AS s FROM usage_events
      WHERE developer_id = ? AND created_at >= ?`,
  ).bind(d.id, quotaWindowStart(d.quota_period, d.quota_reset_at)).first<{ s: number }>();
  return row?.s ?? 0;
}

async function audit(env: Env, actorId: string, action: string, targetId: string, detail: unknown) {
  await env.DB.prepare(`INSERT INTO audit_log (id, actor_id, action, target_id, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(uid(), actorId, action, targetId, JSON.stringify(detail ?? {}))
    .run()
    .catch(() => undefined);
}

export async function handlePortalApi(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const url = new URL(req.url);
  const secure = url.protocol === 'https:';

  // ---- POST /portal/api/register -------------------------------------------
  // Anyone may ask; nobody is granted anything. The row lands 'pending' with no scopes
  // until an admin acts, so an open form cannot spend a single second of GPU time.
  if (path === '/portal/api/register' && req.method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!isEmail(email)) return apiError('invalid_email', 'Enter a valid email address.', 400);
    if (password.length < MIN_PASSWORD) {
      return apiError('weak_password', `Password must be at least ${MIN_PASSWORD} characters.`, 400);
    }

    const existing = await env.DB.prepare(`SELECT id FROM developers WHERE lower(email) = ?`).bind(email).first();
    if (existing) {
      // Do not confirm which addresses are registered — that is a free account-enumeration
      // oracle. The message is the same either way.
      return json({ ok: true, status: 'pending' });
    }

    const isBootstrap = email === (env.BOOTSTRAP_ADMIN_EMAIL || '').toLowerCase();
    const id = uid();
    await env.DB.prepare(
      `INSERT INTO developers (id, email, password_hash, name, org, use_case, status, is_admin, scopes, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, email, await hashPassword(password),
      String(body.name || '').slice(0, 120), String(body.org || '').slice(0, 120),
      String(body.use_case || '').slice(0, 1000),
      isBootstrap ? 'active' : 'pending',
      isBootstrap ? 1 : 0,
      JSON.stringify(isBootstrap ? [...ALL_SCOPES] : []),
      isBootstrap ? now() : null,
    ).run();

    if (!isBootstrap) {
      ctx.waitUntil(sendEmail(env, env.OPERATOR_EMAIL,
        'SATE Developer API — access request',
        `${email}${body.org ? ` (${body.org})` : ''} requested developer access.\n\n` +
        `Use case:\n${body.use_case || '(none given)'}\n\n` +
        `Approve at https://${env.PORTAL_HOST}/#admin`));
    }
    return json({ ok: true, status: isBootstrap ? 'active' : 'pending' });
  }

  // ---- POST /portal/api/login ----------------------------------------------
  if (path === '/portal/api/login' && req.method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const email = String(body.email || '').trim().toLowerCase();
    const row = await env.DB.prepare(`SELECT * FROM developers WHERE lower(email) = ?`).bind(email).first<Developer>();

    // Always run the hash comparison, even with no row, so a missing account and a wrong
    // password take the same time and cannot be told apart.
    const ok = await verifyPassword(String(body.password || ''), row?.password_hash ?? null);
    if (!row || !ok) return apiError('invalid_credentials', 'Email or password is incorrect.', 401);

    if (row.status === 'pending') {
      return apiError('pending_approval', 'Your access request is still awaiting approval.', 403);
    }
    if (row.status !== 'active') {
      return apiError('account_inactive', `This account is ${row.status}.`, 403);
    }

    const raw = await createSession(env, row.id, req.headers.get('User-Agent') || '');
    await env.DB.prepare(`UPDATE developers SET last_login_at = ? WHERE id = ?`).bind(now(), row.id).run();
    return json({ ok: true, developer: publicDeveloper(row) }, 200, { 'Set-Cookie': sessionCookie(raw, secure) });
  }

  // ---- POST /portal/api/logout ---------------------------------------------
  if (path === '/portal/api/logout' && req.method === 'POST') {
    await destroySession(env, req);
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  }

  // Everything past this point needs a live session.
  const me = await currentDeveloper(env, req);
  if (!me) return apiError('unauthorized', 'Sign in to continue.', 401);

  // ---- GET /portal/api/me --------------------------------------------------
  if (path === '/portal/api/me' && req.method === 'GET') {
    const used = await usedSeconds(env, me);
    return json({
      developer: publicDeveloper(me),
      quota_minutes_used: Math.round((used / 60) * 100) / 100,
      all_scopes: ALL_SCOPES,
    });
  }

  // ---- Keys ----------------------------------------------------------------
  if (path === '/portal/api/keys' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT id, name, prefix, scopes, rate_per_min, created_at, last_used_at, revoked_at
         FROM api_keys WHERE developer_id = ? ORDER BY created_at DESC`,
    ).bind(me.id).all();
    return json({
      data: (rows.results || []).map((k: any) => ({ ...k, scopes: parseJson<string[]>(k.scopes, []) })),
    });
  }

  if (path === '/portal/api/keys' && req.method === 'POST') {
    const body = await req.json<any>().catch(() => ({}));
    const allowance = parseJson<string[]>(me.scopes, []);
    if (allowance.length === 0) {
      return apiError('no_scopes', 'Your account has no API scopes yet. Contact an administrator.', 403);
    }

    const live = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_keys WHERE developer_id = ? AND revoked_at IS NULL`,
    ).bind(me.id).first<{ n: number }>();
    if ((live?.n ?? 0) >= me.max_keys) {
      return apiError('key_limit', `You already have ${me.max_keys} active keys. Revoke one first.`, 409);
    }

    // Requested scopes are intersected with the allowance — a developer can narrow a key
    // but can never widen one beyond what an admin granted them.
    const scopes = sanitizeScopes(body.scopes ?? allowance, allowance);
    if (scopes.length === 0) return apiError('invalid_scopes', 'Select at least one scope you have access to.', 400);

    const rate = clampInt(body.rate_per_min, 1, me.rate_per_min, me.rate_per_min);
    const minted = await mintKey(env, me.id, String(body.name || 'Untitled key'), scopes, rate);
    // The plaintext is returned exactly once. It is not stored and cannot be recovered.
    return json({ id: minted.id, key: minted.key, prefix: minted.prefix, scopes, rate_per_min: rate }, 201);
  }

  const keyMatch = path.match(/^\/portal\/api\/keys\/([A-Za-z0-9-]+)$/);
  if (keyMatch && req.method === 'DELETE') {
    const res = await env.DB.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND developer_id = ? AND revoked_at IS NULL`,
    ).bind(now(), keyMatch[1], me.id).run();
    if (!res.meta.changes) return apiError('not_found', 'No such active key.', 404);
    return json({ ok: true, revoked: keyMatch[1] });
  }

  // ---- Usage ---------------------------------------------------------------
  if (path === '/portal/api/usage' && req.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 1, 90, 30);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const [daily, byKey, byEndpoint, totals] = await Promise.all([
      env.DB.prepare(
        `SELECT substr(created_at,1,10) AS day, COUNT(*) AS requests,
                SUM(audio_seconds) AS audio_seconds,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
           FROM usage_events WHERE developer_id = ? AND created_at >= ?
          GROUP BY day ORDER BY day`,
      ).bind(me.id, since).all(),
      env.DB.prepare(
        `SELECT k.name, k.prefix, COUNT(u.id) AS requests, SUM(u.audio_seconds) AS audio_seconds
           FROM usage_events u JOIN api_keys k ON k.id = u.api_key_id
          WHERE u.developer_id = ? AND u.created_at >= ?
          GROUP BY u.api_key_id ORDER BY requests DESC`,
      ).bind(me.id, since).all(),
      env.DB.prepare(
        `SELECT endpoint, method, COUNT(*) AS requests,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
           FROM usage_events WHERE developer_id = ? AND created_at >= ?
          GROUP BY endpoint, method ORDER BY requests DESC LIMIT 20`,
      ).bind(me.id, since).all(),
      env.DB.prepare(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(audio_seconds),0) AS audio_seconds,
                SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
           FROM usage_events WHERE developer_id = ? AND created_at >= ?`,
      ).bind(me.id, since).first(),
    ]);
    return json({
      window_days: days,
      totals,
      daily: daily.results || [],
      by_key: byKey.results || [],
      by_endpoint: byEndpoint.results || [],
    });
  }

  // ---- Jobs (read-only mirror of what the developer submitted) -------------
  if (path === '/portal/api/jobs' && req.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 25);
    const rows = await env.DB.prepare(
      `SELECT id, status, view, file_name, bytes, duration_sec, created_at, finished_at,
              attempts, error, error_kind, no_text
         FROM jobs WHERE developer_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).bind(me.id, limit).all();
    return json({ data: rows.results || [] });
  }

  // ---- Admin ---------------------------------------------------------------
  if (path.startsWith('/portal/api/admin')) {
    if (!me.is_admin) return apiError('forbidden', 'Administrator access required.', 403);

    if (path === '/portal/api/admin/developers' && req.method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT d.*,
                (SELECT COUNT(*) FROM api_keys k WHERE k.developer_id = d.id AND k.revoked_at IS NULL) AS active_keys,
                (SELECT COUNT(*) FROM jobs j WHERE j.developer_id = d.id) AS total_jobs
           FROM developers d ORDER BY
             CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.created_at DESC`,
      ).all();
      // Each developer's used-minutes figure has to be computed against THEIR OWN window
      // (monthly vs total, and their own last reset), so it cannot be one grouped query.
      const data = await Promise.all((rows.results || []).map(async (d: any) => ({
        ...publicDeveloper(d),
        use_case: d.use_case,
        notes: d.notes,
        active_keys: d.active_keys,
        total_jobs: d.total_jobs,
        used_minutes: Math.round((await usedSeconds(env, d)) / 60 * 100) / 100,
        last_login_at: d.last_login_at,
      })));
      return json({ data });
    }

    // ---- System-wide usage: every developer, every active key, one chart -----
    if (path === '/portal/api/admin/usage' && req.method === 'GET') {
      const days = clampInt(url.searchParams.get('days'), 1, 90, 30);
      const since = new Date(Date.now() - days * 86400_000).toISOString();
      const [daily, byDev, keys, totals] = await Promise.all([
        env.DB.prepare(
          `SELECT substr(created_at,1,10) AS day, COUNT(*) AS requests,
                  COALESCE(SUM(audio_seconds),0) AS audio_seconds,
                  SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
             FROM usage_events WHERE created_at >= ? GROUP BY day ORDER BY day`,
        ).bind(since).all(),
        env.DB.prepare(
          `SELECT d.id, d.email, d.org, d.api_locked, COUNT(u.id) AS requests,
                  COALESCE(SUM(u.audio_seconds),0) AS audio_seconds,
                  SUM(CASE WHEN u.status_code >= 400 THEN 1 ELSE 0 END) AS errors
             FROM developers d LEFT JOIN usage_events u
               ON u.developer_id = d.id AND u.created_at >= ?
            GROUP BY d.id ORDER BY requests DESC`,
        ).bind(since).all(),
        // Every live key in the system, with the traffic it is actually pulling. This is
        // the "who is calling us right now" view.
        env.DB.prepare(
          `SELECT k.id, k.name, k.prefix, k.scopes, k.rate_per_min, k.created_at, k.last_used_at,
                  d.email, d.org, d.api_locked,
                  (SELECT COUNT(*) FROM usage_events u WHERE u.api_key_id = k.id AND u.created_at >= ?) AS requests,
                  (SELECT COALESCE(SUM(u.audio_seconds),0) FROM usage_events u
                    WHERE u.api_key_id = k.id AND u.created_at >= ?) AS audio_seconds
             FROM api_keys k JOIN developers d ON d.id = k.developer_id
            WHERE k.revoked_at IS NULL
            ORDER BY requests DESC, k.created_at DESC`,
        ).bind(since, since).all(),
        env.DB.prepare(
          `SELECT COUNT(*) AS requests, COALESCE(SUM(audio_seconds),0) AS audio_seconds,
                  SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors,
                  COUNT(DISTINCT developer_id) AS active_developers
             FROM usage_events WHERE created_at >= ?`,
        ).bind(since).first(),
      ]);
      return json({
        window_days: days,
        totals,
        daily: daily.results || [],
        by_developer: byDev.results || [],
        active_keys: (keys.results || []).map((k: any) => ({
          ...k, scopes: parseJson<string[]>(k.scopes, []), api_locked: !!k.api_locked,
        })),
      });
    }

    const devMatch = path.match(/^\/portal\/api\/admin\/developers\/([A-Za-z0-9-]+)$/);
    if (devMatch && req.method === 'PATCH') {
      const targetId = devMatch[1];
      const body = await req.json<any>().catch(() => ({}));
      const target = await env.DB.prepare(`SELECT * FROM developers WHERE id = ?`).bind(targetId).first<Developer>();
      if (!target) return apiError('not_found', 'No such developer.', 404);

      // Guard against locking yourself out of the only admin account.
      if (targetId === me.id && (body.status === 'suspended' || body.is_admin === false)) {
        return apiError('self_lockout', 'You cannot suspend or demote your own admin account.', 400);
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      const detail: Record<string, unknown> = {};

      if (typeof body.status === 'string' && ['pending', 'active', 'suspended', 'rejected'].includes(body.status)) {
        sets.push('status = ?'); vals.push(body.status); detail.status = body.status;
        if (body.status === 'active' && !target.approved_at) {
          sets.push('approved_at = ?', 'approved_by = ?'); vals.push(now(), me.id);
        }
      }
      if (Array.isArray(body.scopes)) {
        const scopes = sanitizeScopes(body.scopes, [...ALL_SCOPES]);
        sets.push('scopes = ?'); vals.push(JSON.stringify(scopes)); detail.scopes = scopes;
      }
      if (body.quota_minutes !== undefined) {
        const q = clampInt(body.quota_minutes, 0, 1_000_000, 120);
        sets.push('quota_minutes = ?'); vals.push(q); detail.quota_minutes = q;
      }
      if (body.quota_period === 'monthly' || body.quota_period === 'total') {
        sets.push('quota_period = ?'); vals.push(body.quota_period); detail.quota_period = body.quota_period;
      }
      // Reset the usage counter by moving the window floor, never by deleting usage rows —
      // the billing history has to survive a reset.
      if (body.reset_usage === true) {
        sets.push('quota_reset_at = ?'); vals.push(now()); detail.reset_usage = true;
      }
      if (typeof body.api_locked === 'boolean') {
        sets.push('api_locked = ?'); vals.push(body.api_locked ? 1 : 0); detail.api_locked = body.api_locked;
        sets.push('lock_reason = ?');
        vals.push(body.api_locked ? String(body.lock_reason || '').slice(0, 300) : '');
      }
      if (body.rate_per_min !== undefined) {
        const r = clampInt(body.rate_per_min, 1, 1000, 20);
        sets.push('rate_per_min = ?'); vals.push(r); detail.rate_per_min = r;
      }
      if (body.max_keys !== undefined) {
        const m = clampInt(body.max_keys, 1, 50, 5);
        sets.push('max_keys = ?'); vals.push(m); detail.max_keys = m;
      }
      if (typeof body.notes === 'string') {
        sets.push('notes = ?'); vals.push(body.notes.slice(0, 2000));
      }
      if (typeof body.is_admin === 'boolean') {
        sets.push('is_admin = ?'); vals.push(body.is_admin ? 1 : 0); detail.is_admin = body.is_admin;
      }
      if (sets.length === 0) return apiError('nothing_to_update', 'No recognised fields to update.', 400);

      vals.push(targetId);
      await env.DB.prepare(`UPDATE developers SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
      ctx.waitUntil(audit(env, me.id, 'developer.update', targetId, detail));

      // A suspension must take effect now, not when the browser session happens to expire.
      if (body.status && body.status !== 'active') {
        await env.DB.prepare(`DELETE FROM portal_sessions WHERE developer_id = ?`).bind(targetId).run();
      }
      if (body.status === 'active' && target.status === 'pending') {
        ctx.waitUntil(sendEmail(env, target.email,
          'Your SATE Developer API access is approved',
          `You're approved. Sign in at https://${env.PORTAL_HOST} to create your API key.\n\n` +
          `Docs: https://${env.PORTAL_HOST}/docs`));
      }
      return json({ ok: true });
    }

    if (path === '/portal/api/admin/overview' && req.method === 'GET') {
      const [devs, jobs, queue, recent] = await Promise.all([
        env.DB.prepare(
          `SELECT status, COUNT(*) AS n FROM developers GROUP BY status`).all(),
        env.DB.prepare(
          `SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all(),
        env.DB.prepare(
          `SELECT COUNT(*) AS queued,
                  (SELECT COUNT(*) FROM jobs WHERE status='processing') AS processing,
                  (SELECT MIN(created_at) FROM jobs WHERE status='queued') AS oldest_queued
             FROM jobs WHERE status='queued'`).first(),
        env.DB.prepare(
          `SELECT id, developer_id, status, error, created_at FROM jobs
            WHERE status = 'error' ORDER BY created_at DESC LIMIT 10`).all(),
      ]);
      return json({
        developers: devs.results || [],
        jobs: jobs.results || [],
        queue,
        recent_errors: recent.results || [],
      });
    }

    return apiError('not_found', 'No such admin route.', 404);
  }

  return apiError('not_found', 'No such portal route.', 404);
}
