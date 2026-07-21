// SATE — the two Postgres functions the app calls through supabase.rpc(), ported to D1.
//
//   generate_invite_code()                     -> src/services/inviteCodeService.ts:36
//   validate_and_use_invite_code(code, user)   -> src/services/inviteCodeService.ts:143
//
// Nothing else in the app uses .rpc(), so this is the whole set.

import { HttpError } from './rest';
import type { Ctx } from './policy';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * generate_invite_code — an 8-character code not already present in invite_codes.
 *
 * Postgres looped on upper(substring(md5(random()::text) from 1 for 8)), i.e. 8 hex chars
 * (16^8 ≈ 4.3e9). This uses the full 36-char alphabet (36^8 ≈ 2.8e12) via a CSPRNG rather
 * than md5(random()); the codes are the same length and shape, and the collision loop is
 * kept because the column is UNIQUE.
 *
 * SECURITY DEFINER in Postgres: the uniqueness probe reads rows the caller cannot see
 * (invite_codes SELECT is USING (is_active = true), so an inactive code is invisible yet
 * still occupies its code value). The probe below runs unfiltered for the same reason —
 * it returns only a yes/no, never row contents.
 */
export async function generateInviteCode(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    let code = '';
    for (const b of bytes) code += ALPHABET[b % ALPHABET.length];

    const clash = await db.prepare(`SELECT 1 FROM invite_codes WHERE code = ? LIMIT 1`).bind(code).first();
    if (!clash) return code;
  }
  // Postgres looped forever. Ten failures at this collision probability means something is
  // wrong with the RNG, and a Worker that spins is worse than one that reports.
  throw new HttpError(500, 'could not generate a unique invite code');
}

export interface RedeemResult {
  success: boolean;
  message?: string;
  error?: string;
}

/**
 * validate_and_use_invite_code — validate, then consume one use.
 *
 * ⚠️ CONCURRENCY: the Postgres original opened with `SELECT ... FOR UPDATE`, holding a row
 * lock across validate -> increment -> insert, so two redemptions of the last remaining use
 * could not both win. D1 has no row locks and no interactive transactions, so a literal
 * port would let both through and push current_uses past max_uses.
 *
 * Reconstructed with the same guarantees by different means:
 *   1. A single conditional UPDATE does the check and the increment atomically — SQLite
 *      executes one statement atomically, so `WHERE current_uses < max_uses` is evaluated
 *      against the same row version it increments. changes=0 means somebody else took the
 *      last use, or the code is inactive/expired.
 *   2. "already used by this user" is enforced by the UNIQUE index
 *      invite_code_usage(invite_code_id, used_by), not by the earlier read — the read is
 *      only there to produce the friendly message on the common path.
 *   3. If the insert loses that race, the increment is compensated back down, because the
 *      use was never actually handed out.
 *
 * Failure diagnosis is deliberately a second read: it runs only on the error path, so the
 * happy path stays one statement.
 */
export async function validateAndUseInviteCode(db: D1Database, code: string, userId: string): Promise<RedeemResult> {
  const now = new Date().toISOString();

  // Friendly-message path only; the authoritative check is the UNIQUE index below.
  const already = await db
    .prepare(
      `SELECT 1 FROM invite_code_usage u
        JOIN invite_codes c ON c.id = u.invite_code_id
       WHERE c.code = ? AND u.used_by = ? LIMIT 1`,
    )
    .bind(code, userId)
    .first();
  if (already) return { success: false, error: 'You have already used this invite code' };

  // Atomic claim: validate and consume in one statement.
  const claim = await db
    .prepare(
      `UPDATE invite_codes
          SET current_uses = current_uses + 1
        WHERE code = ?
          AND is_active = 1
          AND (expires_at IS NULL OR expires_at > ?)
          AND current_uses < max_uses`,
    )
    .bind(code, now)
    .run();

  if ((claim.meta?.changes ?? 0) === 0) return { success: false, error: await diagnose(db, code, now) };

  const row = await db.prepare(`SELECT id FROM invite_codes WHERE code = ?`).bind(code).first<{ id: string }>();
  if (!row) {
    // The code vanished between the UPDATE and now (deleted concurrently). Nothing to
    // compensate — the row it counted against is gone.
    return { success: false, error: 'Invalid invite code' };
  }

  try {
    await db
      .prepare(`INSERT INTO invite_code_usage (id, invite_code_id, used_by, used_at) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), row.id, userId, now)
      .run();
  } catch (e) {
    // Lost the race on the UNIQUE index: this user redeemed the code on another request.
    // Give the use back — it was counted but never granted.
    await db.prepare(`UPDATE invite_codes SET current_uses = current_uses - 1 WHERE id = ? AND current_uses > 0`).bind(row.id).run();
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE|constraint/i.test(msg)) return { success: false, error: 'You have already used this invite code' };
    throw e;
  }

  return { success: true, message: 'Invite code validated successfully' };
}

/** Why did the conditional UPDATE match nothing? Error path only. */
async function diagnose(db: D1Database, code: string, now: string): Promise<string> {
  const row = await db
    .prepare(`SELECT is_active, expires_at, current_uses, max_uses FROM invite_codes WHERE code = ?`)
    .bind(code)
    .first<{ is_active: number; expires_at: string | null; current_uses: number; max_uses: number }>();

  // Same wording and precedence as the Postgres original, so the UI reads identically.
  if (!row) return 'Invalid invite code';
  if (!row.is_active) return 'Invite code is inactive';
  if (row.expires_at !== null && row.expires_at <= now) return 'Invite code has expired';
  if (row.current_uses >= row.max_uses) return 'Invite code has reached maximum uses';
  return 'Invite code could not be redeemed';
}

/** Dispatch for POST /rest/v1/rpc/<name>. */
export async function handleRpc(name: string, body: Record<string, unknown>, ctx: Ctx, db: D1Database): Promise<unknown> {
  switch (name) {
    case 'generate_invite_code': {
      // Postgres exposed this to any caller; it only mints a candidate string and writes
      // nothing, so an anonymous call is harmless. Requiring a session anyway keeps it off
      // the public surface.
      if (!ctx.uid && !ctx.serviceRole) throw new HttpError(401, 'not authenticated');
      return generateInviteCode(db);
    }

    case 'validate_and_use_invite_code': {
      const code = String(body.p_code ?? '').trim();
      if (!code) return { success: false, error: 'Invalid invite code' };

      // The Postgres function was SECURITY DEFINER and took p_user_id as an argument,
      // which means it trusted the caller to say who they were: passing someone else's uid
      // would burn a use against that account. Bind it to the verified session instead.
      // Service-role callers may still pass one explicitly (no session to bind to).
      const userId = ctx.serviceRole ? String(body.p_user_id ?? '') : ctx.uid;
      if (!userId) throw new HttpError(401, 'not authenticated');

      return validateAndUseInviteCode(db, code, userId);
    }

    default:
      throw new HttpError(404, `unknown function "${name}"`);
  }
}
