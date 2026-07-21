// SATE — mobile-link, Cloudflare Worker port.
//
// "Sign in on phone" via a one-time code / QR. Two actions on one function:
//
//   POST { action: 'create' }        Authorization: Bearer <web user JWT>
//     -> { code, expires_at, expires_in }        (web shows it as text + QR)
//
//   POST { action: 'consume', code } (anon — the phone isn't signed in yet)
//     -> { access_token, refresh_token, expires_in, user }
//
// No JWT gate on the route: 'consume' is anonymous by definition and 'create' validates the
// supplied token itself. That mirrors verify_jwt:false on the Supabase original.
//
// SIMPLER THAN THE ORIGINAL, DELIBERATELY. Supabase had no way to mint a session directly,
// so it went admin.generateLink({type:'magiclink'}) -> anon.verifyOtp() to trick GoTrue into
// issuing one. That detour is why the original had to reject accounts with no email address
// and why several of its failure paths exist at all. Here auth.ts is ours, so the session is
// signed directly — no email needed, no OTP round-trip, fewer ways to fail.

import { mintAccessToken, newRefreshToken, refreshExpiry, verifyAccessToken, nowIso } from '../auth';
import type { Env } from '../index';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TTL_MIN = 5;
// Unambiguous alphabet (no 0/O/1/I) so a hand-typed code is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

/** 8 chars formatted XXXX-XXXX, e.g. 8K2P-L9QX. */
function genCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  let c = '';
  for (const b of r) c += ALPHABET[b % ALPHABET.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export async function handleMobileLink(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const body = await req.json<{ action?: string; code?: string }>().catch(() => ({}) as { action?: string; code?: string });

  // ---- create: web (already signed in) mints a code ----
  if (body.action === 'create') {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '').trim();
    if (!token) return json({ error: 'missing token' }, 401);
    const claims = await verifyAccessToken(env.JWT_SECRET, token);
    if (!claims) return json({ error: 'invalid session' }, 401);

    // Keep at most one live code per user: drop prior unconsumed ones.
    await env.DB.prepare(`DELETE FROM mobile_link_codes WHERE user_id = ? AND consumed_at IS NULL`)
      .bind(claims.sub)
      .run();

    const code = genCode();
    const expires_at = new Date(Date.now() + TTL_MIN * 60000).toISOString();
    await env.DB.prepare(`INSERT INTO mobile_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)`)
      .bind(code, claims.sub, expires_at)
      .run();
    return json({ code, expires_at, expires_in: TTL_MIN * 60 });
  }

  // ---- consume: phone exchanges the code for a session ----
  if (body.action === 'consume') {
    const code = (body.code ?? '').toString().trim().toUpperCase();
    if (!code) return json({ error: 'missing code' }, 400);

    // Atomically claim the code: exactly one consumer wins.
    //
    // The Supabase original read the row, checked it, then updated — two statements with a
    // gap. It papered over the race with `.is('consumed_at', null)` on the update and
    // re-checked the row count. One conditional UPDATE does the whole thing here: SQLite
    // evaluates the WHERE against the same row version it writes, so a second request
    // cannot also match.
    const claim = await env.DB.prepare(
      `UPDATE mobile_link_codes SET consumed_at = ?
        WHERE code = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
      .bind(nowIso(), code, nowIso())
      .run();

    if ((claim.meta?.changes ?? 0) === 0) {
      // Diagnose only on the error path, and keep the original's wording.
      const row = await env.DB.prepare(`SELECT consumed_at, expires_at FROM mobile_link_codes WHERE code = ?`)
        .bind(code)
        .first<{ consumed_at: string | null; expires_at: string }>();
      if (!row) return json({ error: 'invalid code' }, 400);
      if (row.consumed_at) return json({ error: 'code already used' }, 400);
      return json({ error: 'code expired' }, 400);
    }

    const row = await env.DB.prepare(`SELECT user_id FROM mobile_link_codes WHERE code = ?`)
      .bind(code)
      .first<{ user_id: string }>();

    // Release the claim on a transient failure so the code stays usable; the user would
    // otherwise have to go back to the web to mint another one for no reason.
    const release = async (msg: string, status = 500) => {
      await env.DB.prepare(`UPDATE mobile_link_codes SET consumed_at = NULL WHERE code = ?`).bind(code).run();
      return json({ error: msg }, status);
    };

    if (!row) return release('Could not load the linked account. Generate a new code and try again.');

    const user = await env.DB.prepare(`SELECT id, email, user_metadata FROM users WHERE id = ?`)
      .bind(row.user_id)
      .first<{ id: string; email: string; user_metadata: string }>();
    if (!user) return release('Could not load the linked account. Generate a new code and try again.');

    // Mint the session directly. No email address required — unlike the Supabase original,
    // which could only mint via a magic link and therefore refused email-less accounts.
    const { token, expiresIn } = await mintAccessToken(env.JWT_SECRET, { id: user.id, email: user.email });
    const refresh = newRefreshToken();
    await env.DB.prepare(`INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
      .bind(refresh, user.id, refreshExpiry())
      .run();
    await env.DB.prepare(`UPDATE users SET last_sign_in_at = ? WHERE id = ?`).bind(nowIso(), user.id).run();

    let name = user.email;
    try {
      const meta = JSON.parse(user.user_metadata || '{}');
      name = meta.full_name || meta.name || user.email;
    } catch {
      /* keep the email */
    }

    return json({
      access_token: token,
      refresh_token: refresh,
      expires_in: expiresIn,
      user: { id: user.id, email: user.email, name },
    });
  }

  return json({ error: 'unknown action' }, 400);
}
