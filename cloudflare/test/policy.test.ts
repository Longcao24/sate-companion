// Policy tests — the ones that matter.
//
// D1 has no RLS, so src/policy.ts is the only thing standing between one SLP and another
// SLP's patients. On Supabase a bug here would have been caught by Postgres refusing the
// row; here it would just leak. These tests encode the pg_policies of project
// zlgdpivcbmaodgokkdvz as captured on 2026-07-16 — if a test fails, either the port drifted
// or production changed, and both need a human.
//
// Run: npm test

import { describe, it, expect } from 'vitest';
import { check, checkRow, CLIENT_TABLES, type Ctx } from '../src/policy';

const ALICE: Ctx = { uid: 'alice', serviceRole: false };
const BOB: Ctx = { uid: 'bob', serviceRole: false };
const ANON: Ctx = { uid: null, serviceRole: false };
const SERVICE: Ctx = { uid: null, serviceRole: true };

/** Minimal D1 stand-in: only sate_device_commands' async check touches the database. */
function fakeDb(ownedDeviceIds: string[]): D1Database {
  return {
    prepare: (_sql: string) => ({
      bind: (deviceId: string, userId: string) => ({
        first: async () => (ownedDeviceIds.includes(`${userId}:${deviceId}`) ? { 1: 1 } : null),
      }),
    }),
  } as unknown as D1Database;
}

const db = fakeDb(['alice:dev-1']);

describe('deny by default', () => {
  it('refuses anonymous callers on every client table', () => {
    for (const table of CLIENT_TABLES) {
      expect(check(table, 'select', ANON).allowed, table).toBe(false);
    }
  });

  it('refuses a table that has no policy entry', () => {
    // Not a typo: these three have RLS enabled and ZERO policies in production, so no client
    // may touch them at all. sate_admins gates /admin, which manages every device
    // system-wide; a policy here would be a privilege-escalation path.
    for (const table of ['mobile_link_codes', 'sate_admins', 'sate_firmware']) {
      expect(check(table, 'select', ALICE).allowed, table).toBe(false);
    }
  });

  it('refuses a table nobody has heard of', () => {
    expect(check('users', 'select', ALICE).allowed).toBe(false);
    expect(check('refresh_tokens', 'select', ALICE).allowed).toBe(false);
    expect(check('definitely_not_a_table', 'select', ALICE).allowed).toBe(false);
  });

  it('lets the service role through', () => {
    expect(check('sate_admins', 'select', SERVICE).allowed).toBe(true);
    expect(check('patients', 'delete', SERVICE).allowed).toBe(true);
  });
});

describe('patients — an SLP sees only their own', () => {
  it('scopes SELECT to slp_id', () => {
    const d = check('patients', 'select', ALICE);
    expect(d.allowed).toBe(true);
    expect(d.filter?.sql).toBe('slp_id = ?');
    expect(d.filter?.params).toEqual(['alice']);
  });

  it('refuses creating a patient owned by someone else', async () => {
    expect(await checkRow('patients', 'insert', ALICE, { slp_id: 'alice' }, db)).toBeNull();
    expect(await checkRow('patients', 'insert', ALICE, { slp_id: 'bob' }, db)).toBeTruthy();
  });

  it('refuses handing a patient to another SLP via UPDATE', async () => {
    // Production has no WITH CHECK on this policy, so Postgres reuses USING as the check.
    // Without that rule an SLP could reassign their own patient to another account.
    expect(await checkRow('patients', 'update', ALICE, { slp_id: 'bob' }, db)).toBeTruthy();
  });

  it('refuses DELETE outright', () => {
    // No DELETE policy exists in production; the app deactivates instead. A hard delete
    // would orphan the recordings that reference the patient.
    expect(check('patients', 'delete', ALICE).allowed).toBe(false);
  });
});

describe('recordings — two policies, OR-ed', () => {
  it('SELECT covers own recordings OR recordings of own patients', () => {
    const d = check('recordings', 'select', ALICE);
    expect(d.allowed).toBe(true);
    // Both arms must be present: "individual access" (user_id) OR'd with the SLP/patient
    // policy. Dropping either changes what a clinician can see.
    expect(d.filter?.sql).toContain('user_id = ?');
    expect(d.filter?.sql).toContain('p.slp_id = ?');
    expect(d.filter?.params).toEqual(['alice', 'alice']);
  });

  it('writes are scoped to the owner only', async () => {
    expect(check('recordings', 'update', ALICE).filter?.params).toEqual(['alice']);
    expect(check('recordings', 'delete', ALICE).filter?.params).toEqual(['alice']);
    expect(await checkRow('recordings', 'insert', ALICE, { user_id: 'bob' }, db)).toBeTruthy();
  });
});

describe('devices — ownership by user_id', () => {
  for (const table of ['sate_devices', 'sate_device_sessions', 'sate_device_patients', 'sate_claim_tokens']) {
    it(`${table} scopes every command to user_id`, async () => {
      for (const cmd of ['select', 'update', 'delete'] as const) {
        const d = check(table, cmd, BOB);
        expect(d.allowed, `${table}.${cmd}`).toBe(true);
        expect(d.filter?.params, `${table}.${cmd}`).toEqual(['bob']);
      }
      expect(await checkRow(table, 'insert', BOB, { user_id: 'alice' }, db)).toBeTruthy();
      expect(await checkRow(table, 'insert', BOB, { user_id: 'bob' }, db)).toBeNull();
    });
  }
});

describe('sate_device_commands — keyed by device, not user', () => {
  it('scopes reads to devices the caller owns', () => {
    const d = check('sate_device_commands', 'select', ALICE);
    expect(d.allowed).toBe(true);
    expect(d.filter?.sql).toContain('SELECT id FROM sate_devices WHERE user_id = ?');
    expect(d.filter?.params).toEqual(['alice']);
  });

  it('refuses queuing a command onto a device you do not own', async () => {
    // This is the one that matters: `ota` is a command. Without the check, any signed-in
    // user could flash arbitrary firmware onto someone else's recorder.
    expect(await checkRow('sate_device_commands', 'insert', ALICE, { device_id: 'dev-1' }, db)).toBeNull();
    expect(await checkRow('sate_device_commands', 'insert', BOB, { device_id: 'dev-1' }, db)).toBeTruthy();
    expect(await checkRow('sate_device_commands', 'insert', ALICE, { device_id: 'dev-999' }, db)).toBeTruthy();
  });

  it('refuses moving a command onto another device via UPDATE', async () => {
    expect(await checkRow('sate_device_commands', 'update', BOB, { device_id: 'dev-1' }, db)).toBeTruthy();
    // No device_id in the patch: USING already proved the row is the caller's.
    expect(await checkRow('sate_device_commands', 'update', ALICE, { consumed: 1 }, db)).toBeNull();
  });
});

describe('invite codes', () => {
  it('SELECT is is_active only — NOT scoped to the creator', () => {
    // ⚠️ Transcribed verbatim from production: USING (is_active = true). Every signed-in
    // user can read every active invite code, including other people's. This test exists to
    // pin the real behaviour, not to endorse it — if this fails because someone scoped it,
    // that is a deliberate product change and Supabase needs the same fix.
    const d = check('invite_codes', 'select', ALICE);
    expect(d.filter?.sql).toBe('is_active = 1');
    expect(d.filter?.params).toEqual([]);
  });

  it('mutations are scoped to created_by', async () => {
    expect(check('invite_codes', 'update', ALICE).filter?.params).toEqual(['alice']);
    expect(check('invite_codes', 'delete', ALICE).filter?.params).toEqual(['alice']);
    expect(await checkRow('invite_codes', 'insert', ALICE, { created_by: 'bob' }, db)).toBeTruthy();
    expect(await checkRow('invite_codes', 'insert', ALICE, { created_by: 'alice' }, db)).toBeNull();
  });

  it('invite_code_usage: read only your own codes usage, insert is open', async () => {
    const d = check('invite_code_usage', 'select', ALICE);
    expect(d.filter?.sql).toContain('SELECT id FROM invite_codes WHERE created_by = ?');
    expect(d.filter?.params).toEqual(['alice']);

    // Production: WITH CHECK (true) — redeeming a code must write a usage row for a code you
    // do not own.
    expect(await checkRow('invite_code_usage', 'insert', ALICE, { used_by: 'alice' }, db)).toBeNull();

    // No UPDATE/DELETE policy in production => denied.
    expect(check('invite_code_usage', 'update', ALICE).allowed).toBe(false);
    expect(check('invite_code_usage', 'delete', ALICE).allowed).toBe(false);
  });
});

describe('cross-tenant sweep', () => {
  it('never returns a filter that omits the caller for an ownership-scoped table', () => {
    // A filter that forgot its parameter would read as "no restriction" and hand back the
    // whole table. Catch that shape directly.
    for (const table of ['patients', 'recordings', 'sate_devices', 'sate_device_sessions', 'sate_device_patients', 'sate_claim_tokens', 'sate_device_commands']) {
      const d = check(table, 'select', ALICE);
      expect(d.allowed, table).toBe(true);
      expect(d.filter, `${table} must have a row filter`).toBeDefined();
      expect(d.filter!.sql.length, table).toBeGreaterThan(0);
      expect(d.filter!.params, table).toContain('alice');
      expect(d.filter!.params, `${table} must not leak bob`).not.toContain('bob');
    }
  });
});
