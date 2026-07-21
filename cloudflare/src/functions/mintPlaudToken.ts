// SATE — mint-plaud-token, Cloudflare Worker port.
//
// Mints a per-user Plaud "User Access Token" for the mobile app's "Connect with Plaud"
// flow, without ever shipping the Plaud partner secrets to the device.
//
// Two-step Plaud OAuth:
//   1. POST oauth/partner/access-token       (HTTP Basic CLIENT_ID:CLIENT_SECRET) -> partner token
//   2. POST open/partner/users/access-token  (Bearer partner token, {user_id})     -> user token
//
// ═══════════════════════════════════════════════════════════════════════════════════════
// ⚠️⚠️  DISABLED BY DEFAULT. READ THIS BEFORE SETTING PLAUD_ALLOW_MINT=1.  ⚠️⚠️
//
// A Plaud device can be PERMANENTLY LOCKED if its binding is mishandled. Unlike a SATE
// recorder (recoverable), a mis-bound / desynced Plaud is bricked for that account.
// CLAUDE.md RULE #1 exists because of this.
//
// Invariant #1 of RULE #1: the Plaud identity must be STABLE and ACCOUNT-DERIVED —
//
//     plaudUserId(uid) = "sate_<uid>"
//
// and it must be the SAME string in (a) this function, as the Plaud `user_id`, and (b) the
// app's connect(deviceId, ...) call, as the deviceToken. It survives reinstall precisely
// because it is derived from the account id and never changes.
//
// THIS STACK BREAKS THAT ASSUMPTION. The Cloudflare `users` table is a NEW user store with
// NEW uuids. The same human being has a different `uid` here than on Supabase, so:
//
//     sate_<cloudflare_uid>  ≠  sate_<supabase_uid>
//
// Pointing the phone app at this backend while a Plaud device is bound under the Supabase
// identity presents a DIFFERENT identity to a device that is already bound — which is the
// exact "re-bind under a new identity" that invariant #2's bind guard exists to refuse and
// that RULE #1 says can lock the device for good. CLAUDE.md is explicit that anything which
// "could change the identity or the binding lifecycle" is high-risk and must be confirmed
// with the user first. A second backend with its own uuid space is exactly that.
//
// The app's bind guard (`bindingOwner(sn)` set and ≠ this account => refuse to connect)
// should catch this and refuse rather than re-bind, and the Keychain record survives
// reinstall. But that guard is the LAST line of defence, not a licence to walk into it, and
// Plaud has never confirmed that a re-bind with a different user_id fails safe.
//
// Before enabling, one of these must be true:
//   (a) No Plaud device has ever been bound against the Supabase stack, so there is no
//       prior identity to contradict — a clean-slate test fleet only; or
//   (b) The Cloudflare `users.id` is seeded with the SAME uuids as Supabase's auth.users,
//       so `sate_<uid>` is identical on both stacks and the identity genuinely does not
//       change (see README, "Plaud identity"); or
//   (c) Plaud has confirmed the re-bind semantics in writing.
//
// Until then this returns 501 rather than risk a locked device to save a token round-trip.
// ═══════════════════════════════════════════════════════════════════════════════════════

import { verifyAccessToken } from '../auth';
import type { Env } from '../index';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const PLAUD_BASE = 'https://platform-us.plaud.ai/developer/api';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export async function handleMintPlaudToken(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // The guard. See the header — this is a device-lock safety gate, not a feature flag.
  if (env.PLAUD_ALLOW_MINT !== '1') {
    return json(
      {
        error:
          'Plaud token minting is disabled on the Cloudflare stack. This backend has its own ' +
          'user id space, so the Plaud identity sate_<uid> would differ from the one a device ' +
          'is already bound to under Supabase, and re-binding under a new identity can ' +
          'permanently lock the device (CLAUDE.md RULE #1). See cloudflare/README.md.',
      },
      501,
    );
  }

  if (!env.PLAUD_CLIENT_ID || !env.PLAUD_CLIENT_SECRET) {
    return json({ error: 'Plaud partner credentials not configured' }, 500);
  }

  // Identify the SATE user from their JWT.
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer /i, '');
  if (!token) return json({ error: 'Unauthorized' }, 401);
  const claims = await verifyAccessToken(env.JWT_SECRET, token);
  if (!claims) return json({ error: 'Unauthorized' }, 401);

  try {
    // Step 1: partner token (HTTP Basic CLIENT_ID:CLIENT_SECRET).
    const basic = btoa(`${env.PLAUD_CLIENT_ID}:${env.PLAUD_CLIENT_SECRET}`);
    const pRes = await fetch(`${PLAUD_BASE}/oauth/partner/access-token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!pRes.ok) return json({ error: `Plaud partner auth failed: ${pRes.status} ${await pRes.text()}` }, 502);
    const partnerToken = ((await pRes.json()) as { access_token?: string })?.access_token;
    if (!partnerToken) return json({ error: 'No partner access_token from Plaud' }, 502);

    // Step 2: per-user token, keyed on the stable SATE user id.
    //
    // ⚠️ `sate_${claims.sub}` MUST match the deviceToken the app passes to connect(). Do not
    // "improve" this string — not a raw uid, not a random value, not a per-device token.
    // See RULE #1 invariant #1.
    const uRes = await fetch(`${PLAUD_BASE}/open/partner/users/access-token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${partnerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: `sate_${claims.sub}`, expires_in: 86400 }),
    });
    if (!uRes.ok) return json({ error: `Plaud user token failed: ${uRes.status} ${await uRes.text()}` }, 502);

    const body = (await uRes.json()) as { access_token?: string; expires_in?: number };
    if (!body?.access_token) return json({ error: 'No user access_token from Plaud' }, 502);

    // expires_in is seconds; hand back an absolute expiry for client caching.
    const expiresIn = Number(body.expires_in || 86400);
    return json({ token: body.access_token, expiresAt: Date.now() + expiresIn * 1000 });
  } catch (e) {
    return json({ error: `mint-plaud-token error: ${(e as Error).message}` }, 500);
  }
}
