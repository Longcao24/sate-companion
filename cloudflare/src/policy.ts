// SATE — access policy. The Cloudflare replacement for Postgres Row Level Security.
//
// ⚠️ READ THIS BEFORE CHANGING ANYTHING IN THIS FILE.
//
// On Supabase, tenant isolation lives in the DATABASE: every table has RLS enabled, and
// Postgres refuses to return another SLP's rows even if the application asks for them. A
// bug in the app could not leak a patient.
//
// D1/SQLite has no RLS. That safety net does not exist here. The database returns whatever
// it is asked for. This file is the ONLY thing separating one SLP from another SLP's
// patients, recordings and devices. A missing entry here is a PHI leak, not a 500.
//
// Therefore:
//   * DENY BY DEFAULT. A table with no entry in POLICIES is refused outright (see check()).
//     Adding a table to the schema does NOT make it reachable; you must add it here too.
//   * Every rule below is transcribed from the live pg_policies of project
//     zlgdpivcbmaodgokkdvz, captured 2026-07-16. The transcription is 1:1 on purpose —
//     including quirks (see invite_codes SELECT). Do not "improve" a rule here; if the
//     policy should change, change it on both stacks deliberately.
//
// Postgres RLS semantics reproduced here (they are subtle, and getting them wrong opens
// exactly the hole this file exists to close):
//   1. Multiple PERMISSIVE policies for the same command are OR'd together.
//   2. RLS enabled + no matching policy for a command = DENY. Three tables rely on this:
//      mobile_link_codes, sate_admins and sate_firmware have RLS on and ZERO policies, so
//      no client may touch them at all — they are service-role-only by design.
//   3. USING (qual) filters which existing rows a SELECT/UPDATE/DELETE may see or act on.
//      WITH CHECK validates the NEW row on INSERT/UPDATE.
//   4. For a FOR ALL policy (and for UPDATE) with WITH CHECK omitted, Postgres reuses the
//      USING expression as the check. Several policies below depend on that.
//   5. service_role bypasses RLS entirely. Here that is Ctx.serviceRole — used only by
//      trusted server-side paths (device-api, process-device-session, mobile-link), never
//      reachable from a browser token.

export type Cmd = 'select' | 'insert' | 'update' | 'delete';

export interface Ctx {
  /** Authenticated user id, or null for an anonymous request. */
  uid: string | null;
  /** True only for internal server-side callers holding the service key. Bypasses everything. */
  serviceRole: boolean;
}

/** A SQL fragment plus its bound parameters, AND-ed into the query's WHERE clause. */
export interface Filter {
  sql: string;
  params: unknown[];
}

export interface Decision {
  allowed: boolean;
  /** Why it was refused. Server-side detail; never surfaced verbatim to the client. */
  reason?: string;
  /** Row-visibility filter to AND into WHERE. Absent = no additional restriction. */
  filter?: Filter;
}

/**
 * Marker for a WITH CHECK that cannot be decided from the row alone and needs a database
 * lookup. The validator lives in ASYNC_INSERT_CHECKS; checkRow() refuses the write if the
 * marker is present but no validator is registered, so deleting one without the other
 * fails closed rather than silently allowing the write.
 */
const ASYNC_CHECK = Symbol('async-check');

interface Policy {
  /** Row filter for select/update/delete (Postgres USING). */
  using?: (ctx: Ctx) => Filter;
  /** New-row validation for insert/update (Postgres WITH CHECK). Returns an error string, or null if OK. */
  check?: ((ctx: Ctx, row: Record<string, unknown>) => string | null) | typeof ASYNC_CHECK;
}

type TablePolicy = Partial<Record<Cmd, Policy>>;

const ownedBy = (col: string) => (ctx: Ctx): Filter => ({ sql: `${col} = ?`, params: [ctx.uid] });

const mustEqualUid =
  (col: string) =>
  (ctx: Ctx, row: Record<string, unknown>): string | null =>
    row[col] === ctx.uid ? null : `${col} must equal the authenticated user`;

/**
 * The transcribed policy set. Table absent => denied entirely.
 * Command absent on a present table => that command is denied (Postgres rule 2).
 */
const POLICIES: Record<string, TablePolicy> = {
  // -- patients -------------------------------------------------------------
  // "SLPs can view/create/update their own patients". There is deliberately NO DELETE
  // policy in production, so DELETE is denied; the app deactivates instead
  // (patientService.deactivatePatient does UPDATE is_active=false). Keep it that way:
  // a hard delete would orphan recordings that reference the patient.
  patients: {
    select: { using: ownedBy('slp_id') },
    insert: { check: mustEqualUid('slp_id') },
    // UPDATE has no WITH CHECK in production => USING is reused as the check (rule 4).
    // Without the check an SLP could reassign their own patient to another SLP's id.
    update: { using: ownedBy('slp_id'), check: mustEqualUid('slp_id') },
  },

  // -- recordings -----------------------------------------------------------
  // Two policies in production:
  //   "individual access"                        FOR ALL    USING (auth.uid() = user_id)
  //   "SLPs can view recordings of their patients" FOR SELECT USING (user_id = uid OR patient is mine)
  // Rule 1 (OR) makes the effective SELECT: user_id = uid OR the recording's patient
  // belongs to me. INSERT/UPDATE/DELETE are governed by "individual access" alone.
  recordings: {
    select: {
      using: (ctx) => ({
        sql: `(user_id = ? OR EXISTS (SELECT 1 FROM patients p WHERE p.id = recordings.patient_id AND p.slp_id = ?))`,
        params: [ctx.uid, ctx.uid],
      }),
    },
    // "individual access" is FOR ALL with no WITH CHECK => USING doubles as the check (rule 4).
    insert: { check: mustEqualUid('user_id') },
    update: { using: ownedBy('user_id'), check: mustEqualUid('user_id') },
    delete: { using: ownedBy('user_id') },
  },

  // -- devices --------------------------------------------------------------
  sate_devices: {
    select: { using: ownedBy('user_id') },
    insert: { check: mustEqualUid('user_id') },
    update: { using: ownedBy('user_id'), check: mustEqualUid('user_id') },
    delete: { using: ownedBy('user_id') },
  },

  sate_device_sessions: {
    select: { using: ownedBy('user_id') },
    insert: { check: mustEqualUid('user_id') },
    update: { using: ownedBy('user_id'), check: mustEqualUid('user_id') },
    delete: { using: ownedBy('user_id') },
  },

  sate_device_patients: {
    select: { using: ownedBy('user_id') },
    insert: { check: mustEqualUid('user_id') },
    update: { using: ownedBy('user_id'), check: mustEqualUid('user_id') },
    delete: { using: ownedBy('user_id') },
  },

  sate_claim_tokens: {
    select: { using: ownedBy('user_id') },
    insert: { check: mustEqualUid('user_id') },
    update: { using: ownedBy('user_id'), check: mustEqualUid('user_id') },
    delete: { using: ownedBy('user_id') },
  },

  // Keyed by device, not by user: "Users can manage commands for their devices".
  // The check must re-run the same subquery, otherwise a user could queue a command
  // (e.g. an OTA flash) onto someone else's recorder.
  sate_device_commands: {
    select: { using: deviceIsMine },
    insert: { check: ASYNC_CHECK },
    update: { using: deviceIsMine, check: ASYNC_CHECK },
    delete: { using: deviceIsMine },
  },

  // -- invite codes ---------------------------------------------------------
  invite_codes: {
    // ⚠️ Transcribed verbatim: production is USING (is_active = true) — NOT scoped to the
    // creator. Every signed-in user can read every active invite code, including codes
    // other users made. That is the live behaviour and this port reproduces it rather
    // than silently diverging. It is worth a look on the Supabase side.
    select: { using: () => ({ sql: `is_active = 1`, params: [] }) },
    insert: {
      check: (ctx, row) => {
        if (!ctx.uid) return 'must be signed in to create an invite code';
        return row.created_by === ctx.uid ? null : 'created_by must equal the authenticated user';
      },
    },
    update: { using: ownedBy('created_by'), check: mustEqualUid('created_by') },
    delete: { using: ownedBy('created_by') },
  },

  invite_code_usage: {
    select: {
      using: (ctx) => ({
        sql: `invite_code_id IN (SELECT id FROM invite_codes WHERE created_by = ?)`,
        params: [ctx.uid],
      }),
    },
    // Production: "System can insert usage records" WITH CHECK (true). Wide open by design —
    // redeeming a code must write a usage row for a code you do not own.
    insert: { check: () => null },
    // No UPDATE/DELETE policy in production => denied (rule 2).
  },

  // -- service-role only ----------------------------------------------------
  // mobile_link_codes, sate_admins and sate_firmware have RLS enabled and NO policies in
  // production, so clients cannot reach them at all. They are intentionally omitted from
  // this map: absence = denial. Server-side code touches them through Ctx.serviceRole.
  //
  // sate_admins in particular gates /admin, which manages ALL devices and firmware
  // system-wide. Never add a client-reachable policy for it.
};

function deviceIsMine(ctx: Ctx): Filter {
  return {
    sql: `device_id IN (SELECT id FROM sate_devices WHERE user_id = ?)`,
    params: [ctx.uid],
  };
}

/**
 * Validators for policies marked ASYNC_CHECK. Keyed by table; every table whose policy
 * carries the marker MUST appear here or the write is refused (see checkRow).
 */
const ASYNC_CHECKS: Record<
  string,
  (ctx: Ctx, row: Record<string, unknown>, db: D1Database) => Promise<string | null>
> = {
  // WITH CHECK (device_id IN (SELECT id FROM sate_devices WHERE user_id = auth.uid())).
  // Without this, any signed-in user could queue a command — including an OTA flash —
  // onto someone else's recorder.
  sate_device_commands: async (ctx, row, db) => {
    // On UPDATE the column may be absent; the row then keeps a device_id that USING
    // already proved belongs to this user, so there is nothing new to validate.
    if (!('device_id' in row)) return null;
    const deviceId = row.device_id;
    if (typeof deviceId !== 'string' || !deviceId) return 'device_id is required';
    const hit = await db
      .prepare(`SELECT 1 FROM sate_devices WHERE id = ? AND user_id = ? LIMIT 1`)
      .bind(deviceId, ctx.uid)
      .first();
    return hit ? null : 'device does not belong to the authenticated user';
  },
};

/**
 * Decide whether `ctx` may run `cmd` on `table`.
 *
 * Returns a row filter to AND into the WHERE clause for select/update/delete. The caller
 * MUST apply it — a Decision with allowed:true and an unapplied filter is a leak.
 */
export function check(table: string, cmd: Cmd, ctx: Ctx): Decision {
  // Rule 5: the service role bypasses RLS. Only ever set by trusted server-side paths.
  if (ctx.serviceRole) return { allowed: true };

  // Everything below requires an authenticated user. Supabase's anon role could satisfy a
  // USING (true) policy, but no policy we ported is reachable anonymously, so this is a
  // faithful simplification — and a safe one.
  if (!ctx.uid) return { allowed: false, reason: 'not authenticated' };

  const table_ = POLICIES[table];
  // Deny by default: unknown table, or a table intentionally left out (service-role-only).
  if (!table_) return { allowed: false, reason: `no policy for table "${table}"` };

  const policy = table_[cmd];
  // Rule 2: RLS on, no policy for this command => denied (e.g. patients DELETE).
  if (!policy) return { allowed: false, reason: `no policy for ${cmd} on "${table}"` };

  return { allowed: true, filter: policy.using?.(ctx) };
}

/**
 * Validate a new/updated row against the table's WITH CHECK, after check() allowed the
 * command. Returns an error string, or null when the row is acceptable.
 */
export async function checkRow(
  table: string,
  cmd: 'insert' | 'update',
  ctx: Ctx,
  row: Record<string, unknown>,
  db: D1Database,
): Promise<string | null> {
  if (ctx.serviceRole) return null;

  const policy = POLICIES[table]?.[cmd];
  if (!policy) return `no policy for ${cmd} on "${table}"`;

  // No WITH CHECK on this command in production (e.g. DELETE-shaped policies, or an
  // UPDATE whose USING already constrained the row) => nothing further to validate.
  if (!policy.check) return null;

  if (policy.check === ASYNC_CHECK) {
    const validator = ASYNC_CHECKS[table];
    // Fail closed: the marker says this row cannot be judged without a lookup, so a
    // missing validator must refuse the write, never wave it through.
    if (!validator) return `no async validator registered for ${cmd} on "${table}"`;
    return validator(ctx, row, db);
  }

  return policy.check(ctx, row);
}

/** Tables a client may reach at all. Exported for the policy tests. */
export const CLIENT_TABLES = Object.keys(POLICIES);
