// SATE — mobile-link
// "Sign in on phone" via a one-time code / QR. Two actions on one function:
//
//   POST { action: 'create' }   Authorization: Bearer <web user JWT>
//     -> { code, expires_at, expires_in }   (web shows it as text + QR)
//
//   POST { action: 'consume', code }   (anon - the phone isn't signed in yet)
//     -> { access_token, refresh_token, expires_in, user }
//
// The code is validated (exists, unexpired, unused), atomically marked used,
// then a REAL Supabase session is minted for the owning user (admin magic-link
// -> verifyOtp) so the phone behaves exactly like a password login (its refresh
// token auto-refreshes). verify_jwt is disabled: 'consume' is anon and 'create'
// validates the supplied JWT itself.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY')!;
const TTL_MIN = 5;
// Unambiguous alphabet (no 0/O/1/I) so a hand-typed code is hard to get wrong.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

// 8 chars formatted XXXX-XXXX, e.g. 8K2P-L9QX.
function genCode(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  let c = '';
  for (const b of r) c += ALPHABET[b % ALPHABET.length];
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = body.action;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ---- create: web (already signed in) mints a code ----
  if (action === 'create') {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '').trim();
    if (!jwt) return json({ error: 'missing token' }, 401);
    const { data: { user }, error } = await admin.auth.getUser(jwt);
    if (error || !user) return json({ error: 'invalid session' }, 401);

    // QR sign-in mints the phone's session from this account's email (magic-link
    // under the hood). An account with no email can't use it - say so up front
    // so the web user isn't handed a code that will fail on the phone.
    if (!user.email) {
      return json({ error: 'This account has no email address, so phone sign-in is unavailable. Use email + password on the phone instead.' }, 400);
    }

    // Keep at most one live code per user: drop prior unconsumed ones.
    await admin.from('mobile_link_codes').delete().eq('user_id', user.id).is('consumed_at', null);

    const code = genCode();
    const expires_at = new Date(Date.now() + TTL_MIN * 60000).toISOString();
    const { error: insErr } = await admin.from('mobile_link_codes').insert({ code, user_id: user.id, expires_at });
    if (insErr) return json({ error: insErr.message }, 500);
    return json({ code, expires_at, expires_in: TTL_MIN * 60 });
  }

  // ---- consume: phone exchanges the code for a session ----
  if (action === 'consume') {
    const code = (body.code ?? '').toString().trim().toUpperCase();
    if (!code) return json({ error: 'missing code' }, 400);

    const { data: row } = await admin.from('mobile_link_codes').select('*').eq('code', code).maybeSingle();
    if (!row) return json({ error: 'invalid code' }, 400);
    if (row.consumed_at) return json({ error: 'code already used' }, 400);
    if (new Date(row.expires_at).getTime() < Date.now()) return json({ error: 'code expired' }, 400);

    // Atomically claim the code: only one consumer wins the race.
    const { data: claimed } = await admin
      .from('mobile_link_codes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('code', code)
      .is('consumed_at', null)
      .select('code');
    if (!claimed || claimed.length === 0) return json({ error: 'code already used' }, 400);

    // Mint a real session for the owning user. If anything below fails the code
    // is already spent (single-use by design); the user just generates a new one
    // on the web. We release the claim so a transient failure is retryable.
    const fail = async (msg: string, status = 500) => {
      await admin.from('mobile_link_codes').update({ consumed_at: null }).eq('code', code);
      return json({ error: msg }, status);
    };

    const { data: uRes, error: uErr } = await admin.auth.admin.getUserById(row.user_id);
    if (uErr || !uRes?.user) return await fail('Could not load the linked account. Generate a new code and try again.');
    const email = uRes.user.email;
    if (!email) {
      // No email on the account: magic-link sign-in is impossible. Spend the code
      // (don't release) and tell the phone to fall back to password.
      return json({ error: 'This account has no email address, so QR sign-in is unavailable. Sign in with email + password instead.' }, 400);
    }

    const { data: link, error: lErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (lErr || !link?.properties?.hashed_token) {
      return await fail('QR sign-in is not available for this account right now. Sign in with email + password instead.', 400);
    }

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: verify, error: vErr } = await anon.auth.verifyOtp({ token_hash: link.properties.hashed_token, type: 'magiclink' });
    if (vErr || !verify?.session) return await fail('Sign-in could not be completed. Generate a new code and try again.');

    const s = verify.session;
    const u = verify.user;
    return json({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      expires_in: s.expires_in,
      user: {
        id: u?.id,
        email: u?.email,
        name: u?.user_metadata?.full_name || u?.user_metadata?.name || u?.email,
      },
    });
  }

  return json({ error: 'unknown action' }, 400);
});
