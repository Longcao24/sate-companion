// SATE Device API — Cloudflare Worker port of supabase/functions/device-api (v13).
//
// Same routes, same wire format, same auth model: a device key (`Bearer key-dev-<serial>`)
// or a user JWT. The recorder cannot tell this apart from the Supabase original except by
// the hostname, so its firmware needs no change beyond cfgServer.
//
// ⚠️ THIS FILE CARRIES SCAR TISSUE. Every comment marked "was" describes a bug that
// actually destroyed or stranded a real recording in July 2026. The Supabase original
// earned those fixes the hard way; this port keeps them. Before simplifying anything here,
// read doc/05-backend-supabase.md and CLAUDE.md.
//
// Preserved invariants, in order of how much they cost to learn:
//   1. storeSessionRecord THROWS on upload failure. It once logged and carried on, which
//      returned 2xx for a rejected upload — the recorder marked the take synced and
//      deleted its only copy. A 62-minute recording died this way.
//   2. Chunk upload is O(1) per slice. Rewriting one temp blob per slice was quadratic and
//      stalled long uploads forever ("8 recordings uploading, no progress").
//   3. The idempotency probe runs BEFORE touching parts, and verifies the OBJECT, not just
//      the row. A row is not proof the audio landed.
//   4. offset 0 purges the part dir. Stale higher-offset parts otherwise stitch onto new
//      audio, and session numbers get reused after a delete.
//   5. The part dir is scoped by patient. Session numbers restart per patient, so `s1`
//      alone collides and two patients' audio can end up in one WAV.
//   6. Parts are removed only AFTER the session is safely stored.

import { verifyAccessToken } from '../auth';
import { putObject, objectExists } from '../storage';
import type { Env } from '../index';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  // DELETE (unlink) and PATCH (rename) are not CORS-safelisted; the preflight needs them
  // named or the browser fails with "Failed to fetch".
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const err = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204, headers: cors });

const nowIso = () => new Date().toISOString();

/**
 * Patch a standard 44-byte WAV header in place: RIFF chunk size (offset 4) and data chunk
 * size (offset 40), so the stitched file is a valid WAV.
 */
/**
 * Patch a standard 44-byte WAV header in place so it describes a file of `totalSize` bytes:
 * RIFF chunk size (offset 4) and data chunk size (offset 40).
 *
 * `totalSize` is a parameter rather than `buf.length` because the streaming assembly only
 * ever holds the FIRST part in memory, and the size that belongs in the header is the whole
 * session's — which that part cannot know from its own length. Passing the wrong one yields
 * a WAV whose header claims ~1 MB: players show a 30-second file and the AI transcribes only
 * the opening minute of an hour-long session.
 */
function patchWavHeaderFor(buf: Uint8Array, totalSize: number) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 8 && totalSize >= 8) dv.setUint32(4, totalSize - 8, true);
  if (buf.length >= 44 && totalSize >= 44) dv.setUint32(40, totalSize - 44, true);
}

/** Parse the firmware's "&flags=12000,45000" CSV (ms offsets) into a number[]. */
function parseFlags(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
}

/**
 * Fire-and-forget: kick the AI/recordings processor for one session, so the device's POST
 * returns immediately. Deno used EdgeRuntime.waitUntil; the Worker equivalent is
 * ctx.waitUntil, which is why the ExecutionContext is threaded down here.
 */
function triggerProcessor(env: Env, ctx: ExecutionContext | undefined, sessionId: string, origin: string) {
  const p = fetch(`${origin}/functions/v1/process-device-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  }).catch(() => {});
  // Without waitUntil the Worker may be killed the moment it responds, dropping the kick.
  // The cron sweep is the fallback, but that delays the recording by minutes.
  try {
    ctx?.waitUntil(p);
  } catch {
    /* best effort */
  }
}

export async function handleDeviceApi(req: Request, url: URL, env: Env, ctx?: ExecutionContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer /i, '');

  const match = url.pathname.match(/\/device-api(\/.*)?$/);
  // Firmware posts to /api/sessions/chunk; accept both /api/* and /* aliases.
  let subPath = match?.[1] || '/';
  if (subPath.startsWith('/api')) subPath = subPath.slice(4) || '/';
  const method = req.method;

  try {
    // Firmware posts /api/devices/register (mock-server convention) -> /devices/register
    // after the strip; accept both it and /register.
    if ((subPath === '/register' || subPath === '/devices/register') && method === 'POST') {
      return await handleDeviceRegister(env, req);
    }

    const cmdMatch = subPath.match(/^\/devices\/([^/]+)\/commands$/);
    if (cmdMatch && method === 'GET' && authHeader.startsWith('Bearer key-')) {
      return await handleDeviceHeartbeat(env, url, cmdMatch[1]);
    }

    if ((subPath === '/sessions/raw' || subPath === '/sessions/chunk' || subPath === '/sessions') && method === 'POST') {
      if (authHeader.startsWith('Bearer key-')) {
        return await handleSessionUpload(env, ctx, req, url, subPath);
      }
    }

    // The recorder fetches its own patient roster with its device key. listPatients wants a
    // user id, which the recorder has no JWT for, so resolve the device's owner here.
    if (subPath === '/patients' && method === 'GET' && authHeader.startsWith('Bearer key-')) {
      const deviceId = authHeader.replace('Bearer key-', '');
      const device = await env.DB.prepare(`SELECT user_id FROM sate_devices WHERE id = ?`)
        .bind(deviceId)
        .first<{ user_id: string }>();
      if (!device) return err('Device not found', 404);
      return await listPatients(env, device.user_id, url.searchParams.get('slp'));
    }

    // ---- everything below needs a signed-in user ----
    const claims = await verifyAccessToken(env.JWT_SECRET, token);
    if (!claims) return err('Unauthorized', 401);
    const user = await env.DB.prepare(`SELECT id, email, user_metadata FROM users WHERE id = ?`)
      .bind(claims.sub)
      .first<{ id: string; email: string; user_metadata: string }>();
    if (!user) return err('Unauthorized', 401);

    if (subPath === '/devices' && method === 'GET') return await listDevices(env, user.id);
    if (subPath === '/devices/claim-token' && method === 'POST') return await createClaimToken(env, user);
    if (cmdMatch && method === 'POST') return await sendCommand(env, user.id, cmdMatch[1], req);
    if (cmdMatch && method === 'GET') return await handleDeviceHeartbeatUser(env, url, user.id, cmdMatch[1]);

    const devIdMatch = subPath.match(/^\/devices\/([^/]+)$/);
    if (devIdMatch && method === 'PATCH') return await renameDevice(env, user.id, devIdMatch[1], req);
    if (devIdMatch && method === 'DELETE') return await removeDevice(env, user.id, devIdMatch[1]);

    if (subPath === '/firmware/latest' && method === 'GET') return await getLatestFirmware(env);
    if (subPath === '/firmware' && method === 'POST') {
      // Publishes an OTA image to the WHOLE fleet. This route sits above the `/admin` block,
      // so without its own check any signed-in account could push firmware to every recorder
      // — the same defect that was fixed in the Supabase device-api (v22).
      if (!(await isAdmin(env, user.email))) return err('Forbidden', 403);
      return await publishFirmware(env, req, url);
    }

    // ---- Admin (system-wide) ----
    // Gated on the caller's email being in sate_admins. Everything here spans ALL users, so
    // it must never be reachable by a normal account.
    if (subPath.startsWith('/admin')) {
      const admin = await isAdmin(env, user.email);
      if (subPath === '/admin/me' && method === 'GET') return json({ isAdmin: admin });
      if (!admin) return err('Forbidden', 403);
      if (subPath === '/admin/devices' && method === 'GET') return await adminListDevices(env);
      if (subPath === '/admin/firmware' && method === 'GET') return await adminListFirmware(env);

      const fwMatch = subPath.match(/^\/admin\/firmware\/([^/]+)$/);
      if (fwMatch && method === 'DELETE') return await adminDeleteFirmware(env, fwMatch[1]);
      const devMatch = subPath.match(/^\/admin\/devices\/([^/]+)$/);
      if (devMatch && method === 'DELETE') return await adminDeleteDevice(env, devMatch[1]);
      return err('Not found', 404);
    }

    if (subPath === '/patients' && method === 'GET') return await listPatients(env, user.id, url.searchParams.get('slp'));
    if (subPath === '/patients' && method === 'PUT') return await replacePatients(env, user.id, req);

    // User-authenticated session upload. The SATE recorder posts with its device key
    // (handled above), but the phone uploads for a device with no device key of its own —
    // a Plaud recorder (never registered in sate_devices) or a BLE-bridged SATE session.
    if (subPath === '/sessions' && method === 'POST') {
      const body = await req.json<Record<string, any>>();
      const { wav_base64, ...meta } = body;
      const wavBytes = decodeBase64(wav_base64 || '');
      return await storeSessionRecord(
        env,
        ctx,
        url.origin,
        user.id,
        {
          device_serial: meta.device_serial || 'plaud',
          patient_id: meta.patient_id || 'PT',
          session_number: meta.session_number || 0,
          sample_rate: meta.sample_rate || 16000,
          flags: Array.isArray(meta.flags) ? meta.flags.filter((n: unknown) => Number.isFinite(n)) : undefined,
        },
        wavBytes,
      );
    }
    if (subPath === '/sessions' && method === 'GET') return await listSessions(env, user.id, url.searchParams.get('device'));

    const audioMatch = subPath.match(/^\/sessions\/([^/]+)\/audio$/);
    if (audioMatch && method === 'GET') return await getSessionAudio(env, user.id, audioMatch[1]);
    const sessDelMatch = subPath.match(/^\/sessions\/([^/]+)$/);
    if (sessDelMatch && method === 'DELETE') return await deleteSession(env, user.id, sessDelMatch[1]);

    return err('Not found', 404);
  } catch (e) {
    console.error('Device API error:', e);
    return err((e as Error).message || 'Internal error', 500);
  }
}

/** atob() on a 118 MB base64 string is fine, but the char-by-char map is not — do it in bulk. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ============================================================================
// Devices
// ============================================================================

async function listDevices(env: Env, userId: string): Promise<Response> {
  // Flip rows that stopped heartbeating to offline before reporting.
  const cutoff = new Date(Date.now() - 45000).toISOString();
  await env.DB.prepare(
    `UPDATE sate_devices SET online = 0, state = 'idle' WHERE user_id = ? AND last_seen < ? AND online = 1`,
  )
    .bind(userId, cutoff)
    .run();

  const res = await env.DB.prepare(`SELECT * FROM sate_devices WHERE user_id = ? ORDER BY created_at ASC`)
    .bind(userId)
    .all<Record<string, unknown>>();
  return json((res.results ?? []).map(decodeDevice));
}

/** sate_devices carries one boolean; the client checks `device.online === true`. */
function decodeDevice(d: Record<string, unknown>) {
  return { ...d, online: d.online === 1 };
}

async function createClaimToken(env: Env, user: { id: string; email: string; user_metadata: string }): Promise<Response> {
  const token = 'claim-' + crypto.randomUUID().slice(0, 8);
  let name = 'SLP';
  try {
    const meta = JSON.parse(user.user_metadata || '{}');
    name = meta.full_name || user.email || 'SLP';
  } catch {
    name = user.email || 'SLP';
  }
  await env.DB.prepare(`INSERT INTO sate_claim_tokens (token, user_id, user_name) VALUES (?, ?, ?)`)
    .bind(token, user.id, name)
    .run();
  return json({ token });
}

async function handleDeviceRegister(env: Env, req: Request): Promise<Response> {
  const { serial, claim_token, fw } = await req.json<{ serial?: string; claim_token?: string; fw?: string }>();
  if (!serial) return err('serial is required');
  if (!claim_token) return err('claim_token is required', 401);

  const claim = await env.DB.prepare(`SELECT * FROM sate_claim_tokens WHERE token = ? AND used = 0`)
    .bind(claim_token)
    .first<{ user_id: string; user_name: string }>();
  if (!claim) return err('Invalid or used claim token', 401);

  await env.DB.prepare(`UPDATE sate_claim_tokens SET used = 1 WHERE token = ?`).bind(claim_token).run();

  const id = 'dev-' + serial.toLowerCase();
  // upsert(onConflict:'id') — re-registering an existing recorder must refresh it, not fail.
  await env.DB.prepare(
    `INSERT INTO sate_devices (id, user_id, name, serial, fw, online, ip, last_seen, pending_sessions, state, slp, slp_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 'idle', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id, name = excluded.name, serial = excluded.serial,
       fw = excluded.fw, online = 1, ip = excluded.ip, last_seen = excluded.last_seen,
       pending_sessions = 0, state = 'idle', slp = excluded.slp, slp_id = excluded.slp_id`,
  )
    .bind(id, claim.user_id, serial, serial, fw || '', req.headers.get('x-forwarded-for') || '', nowIso(), claim.user_name, claim.user_id)
    .run();

  return json({ device_id: id, device_key: 'key-' + id, slp: claim.user_name, slp_id: claim.user_id });
}

async function sendCommand(env: Env, userId: string, deviceId: string, req: Request): Promise<Response> {
  const device = await env.DB.prepare(`SELECT id FROM sate_devices WHERE id = ? AND user_id = ?`)
    .bind(deviceId, userId)
    .first();
  if (!device) return err('Device not found', 404);

  const { op, patient } = await req.json<{ op?: string; patient?: any }>();
  if (!op) return err('op is required');

  await env.DB.prepare(`INSERT INTO sate_device_commands (id, device_id, op, patient) VALUES (?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), deviceId, op, patient ? JSON.stringify(patient) : null)
    .run();

  if (patient?.patient_id) {
    // upsert(onConflict:'user_id,patient_id') — backed by sate_device_patients_unique_idx.
    await env.DB.prepare(
      `INSERT INTO sate_device_patients (id, user_id, patient_id, name, age, session_type, clinician)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, patient_id) DO UPDATE SET
         name = excluded.name, age = excluded.age,
         session_type = excluded.session_type, clinician = excluded.clinician`,
    )
      .bind(
        crypto.randomUUID(),
        userId,
        patient.patient_id,
        patient.name || patient.patient_id,
        patient.age || '',
        patient.session_type || '',
        patient.clinician || '',
      )
      .run();
  }
  return noContent();
}

async function handleDeviceHeartbeat(env: Env, url: URL, deviceId: string): Promise<Response> {
  // If the SLP removed this recorder from their account the row is gone; tell the device to
  // reset to first-time setup. This is the ONLY path that unprovisions a recorder — holding
  // BOOT only changes Wi-Fi.
  const exists = await env.DB.prepare(`SELECT id FROM sate_devices WHERE id = ?`).bind(deviceId).first();
  if (!exists) return json({ unclaimed: true, commands: [] });

  const sets: string[] = ['online = 1', 'last_seen = ?'];
  const params: unknown[] = [nowIso()];
  const q = url.searchParams;
  if (q.has('pending')) {
    sets.push('pending_sessions = ?');
    params.push(Number(q.get('pending')));
  }
  if (q.has('state')) {
    sets.push('state = ?');
    params.push(q.get('state'));
  }
  // The firmware reports its running version + OTA phase each heartbeat, so the dashboard
  // can offer updates and show progress.
  if (q.has('fw')) {
    sets.push('fw = ?');
    params.push(q.get('fw'));
  }
  if (q.has('ota')) {
    sets.push('ota_state = ?');
    params.push(q.get('ota'));
  }
  params.push(deviceId);
  await env.DB.prepare(`UPDATE sate_devices SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  const res = await env.DB.prepare(
    `SELECT op, patient FROM sate_device_commands
      WHERE device_id = ? AND consumed = 0 ORDER BY created_at ASC`,
  )
    .bind(deviceId)
    .all<{ op: string; patient: string | null }>();
  const cmds = res.results ?? [];

  if (cmds.length) {
    await env.DB.prepare(`UPDATE sate_device_commands SET consumed = 1 WHERE device_id = ? AND consumed = 0`)
      .bind(deviceId)
      .run();
  }

  const parse = (p: string | null) => {
    if (!p) return null;
    try {
      return JSON.parse(p);
    } catch {
      return null;
    }
  };
  // OTA: an `ota` command stashes { url, version } in the `patient` column; the firmware
  // reads the sibling `ota` field, downloads the .bin and flashes.
  const otaCmd = cmds.find((c) => c.op === 'ota');
  return json({
    commands: cmds.map((c) => c.op),
    active_patient: parse(cmds.find((c) => c.op === 'record')?.patient ?? null),
    ota: parse(otaCmd?.patient ?? null),
  });
}

async function handleDeviceHeartbeatUser(env: Env, url: URL, userId: string, deviceId: string): Promise<Response> {
  const device = await env.DB.prepare(`SELECT id FROM sate_devices WHERE id = ? AND user_id = ?`)
    .bind(deviceId, userId)
    .first();
  if (!device) return err('Device not found', 404);
  return handleDeviceHeartbeat(env, url, deviceId);
}

async function renameDevice(env: Env, userId: string, deviceId: string, req: Request): Promise<Response> {
  const { name } = await req.json<{ name?: string }>();
  await env.DB.prepare(`UPDATE sate_devices SET name = ? WHERE id = ? AND user_id = ?`)
    .bind(name ?? '', deviceId, userId)
    .run();
  return noContent();
}

async function removeDevice(env: Env, userId: string, deviceId: string): Promise<Response> {
  await env.DB.prepare(`DELETE FROM sate_devices WHERE id = ? AND user_id = ?`).bind(deviceId, userId).run();
  return noContent();
}

// ============================================================================
// Firmware
// ============================================================================

async function getLatestFirmware(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT version, url, notes, created_at FROM sate_firmware ORDER BY created_at DESC LIMIT 1`,
  ).first();
  return json(row || null);
}

/**
 * Publish a firmware release: store the .bin in the public `firmware` prefix and record it
 * in sate_firmware. getLatestFirmware then serves it and the update banner appears.
 *
 * Publishing does NOT flash anything — a recorder only updates when an `ota` command is
 * queued for it specifically. Keep it that way: automatic fleet-wide flashing of a medical
 * device is not something a web button should do.
 */
async function publishFirmware(env: Env, req: Request, url: URL): Promise<Response> {
  const version = (url.searchParams.get('version') || '').trim();
  const notes = (url.searchParams.get('notes') || '').trim();
  if (!version) return err('A version is required (e.g. 1.1.0)');

  const bin = await req.arrayBuffer();
  if (bin.byteLength < 1024) return err('That firmware file looks empty or too small');

  // The name is what publishFirmware writes and what the web card's version regex expects.
  const path = `sate_${version}.bin`;
  try {
    await putObject(env, 'firmware', path, bin, 'application/octet-stream');
  } catch (e) {
    return err('Storage upload failed: ' + (e as Error).message, 500);
  }

  // Public URL served by src/storage.ts. SITE_URL is the web app; the firmware URL must be
  // this Worker's own origin, which is where the device will fetch it from.
  const fwUrl = `${url.origin}/storage/v1/object/public/firmware/${path}`;

  // A fresh row each time; getLatestFirmware orders by created_at so the newest wins.
  // Re-publishing a version overwrites its .bin and adds a row — `version` is not unique.
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO sate_firmware (id, version, url, notes) VALUES (?, ?, ?, ?)`)
    .bind(id, version, fwUrl, notes || null)
    .run();
  const row = await env.DB.prepare(`SELECT version, url, notes, created_at FROM sate_firmware WHERE id = ?`)
    .bind(id)
    .first();
  return json(row);
}

// ============================================================================
// Admin
// ============================================================================

async function isAdmin(env: Env, email?: string | null): Promise<boolean> {
  if (!email) return false;
  const row = await env.DB.prepare(`SELECT email FROM sate_admins WHERE email = ?`).bind(email.toLowerCase()).first();
  return !!row;
}

async function adminListDevices(env: Env): Promise<Response> {
  const cutoff = new Date(Date.now() - 45000).toISOString();
  await env.DB.prepare(`UPDATE sate_devices SET online = 0, state = 'idle' WHERE last_seen < ? AND online = 1`)
    .bind(cutoff)
    .run();

  // Supabase needed auth.admin.listUsers() to map owner -> email; here users is a normal
  // table, so one join replaces the paginated fetch.
  const res = await env.DB.prepare(
    `SELECT d.*, COALESCE(u.email, '') AS owner_email
       FROM sate_devices d LEFT JOIN users u ON u.id = d.user_id
      ORDER BY d.created_at ASC`,
  ).all<Record<string, unknown>>();
  return json((res.results ?? []).map(decodeDevice));
}

async function adminListFirmware(env: Env): Promise<Response> {
  const res = await env.DB.prepare(
    `SELECT id, version, url, notes, created_at FROM sate_firmware ORDER BY created_at DESC`,
  ).all();
  return json(res.results ?? []);
}

async function adminDeleteFirmware(env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT url FROM sate_firmware WHERE id = ?`).bind(id).first<{ url: string }>();
  if (row?.url) {
    // Best-effort: the object name is the trailing path segment.
    const file = row.url.split('/firmware/')[1];
    if (file) await env.BUCKET.delete(`firmware/${file}`).catch(() => {});
  }
  await env.DB.prepare(`DELETE FROM sate_firmware WHERE id = ?`).bind(id).run();
  return noContent();
}

async function adminDeleteDevice(env: Env, deviceId: string): Promise<Response> {
  // No user_id filter: an admin can unlink any device. The recorder learns it was removed on
  // its next heartbeat ({unclaimed:true}) and resets to setup.
  await env.DB.prepare(`DELETE FROM sate_devices WHERE id = ?`).bind(deviceId).run();
  return noContent();
}

// ============================================================================
// Patients (device roster)
// ============================================================================

async function listPatients(env: Env, userId: string, slp: string | null): Promise<Response> {
  const sql = slp
    ? `SELECT patient_id, name, age, session_type, clinician FROM sate_device_patients
        WHERE user_id = ? AND clinician = ? ORDER BY created_at ASC`
    : `SELECT patient_id, name, age, session_type, clinician FROM sate_device_patients
        WHERE user_id = ? ORDER BY created_at ASC`;
  const stmt = slp ? env.DB.prepare(sql).bind(userId, slp) : env.DB.prepare(sql).bind(userId);
  const res = await stmt.all();
  return json(res.results ?? []);
}

async function replacePatients(env: Env, userId: string, req: Request): Promise<Response> {
  const patients = await req.json<any[]>();
  if (!Array.isArray(patients)) return err('Expected an array');

  // delete-then-insert must not half-apply: a failure after the delete would wipe the
  // device's roster. batch() runs the statements in one transaction.
  const stmts = [env.DB.prepare(`DELETE FROM sate_device_patients WHERE user_id = ?`).bind(userId)];
  for (const p of patients) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sate_device_patients (id, user_id, patient_id, name, age, session_type, clinician, clinical_patient_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        userId,
        p.patient_id,
        p.name || '',
        p.age || '',
        p.session_type || '',
        p.clinician || '',
        p.clinical_patient_id || null,
      ),
    );
  }
  await env.DB.batch(stmts);
  return noContent();
}

// ============================================================================
// Sessions
// ============================================================================

async function handleSessionUpload(
  env: Env,
  ctx: ExecutionContext | undefined,
  req: Request,
  url: URL,
  subPath: string,
): Promise<Response> {
  const deviceId = (req.headers.get('Authorization') ?? '').replace('Bearer key-', '');
  const device = await env.DB.prepare(`SELECT user_id, serial FROM sate_devices WHERE id = ?`)
    .bind(deviceId)
    .first<{ user_id: string; serial: string }>();
  if (!device) return err('Device not found', 404);

  if (subPath === '/sessions') {
    const body = await req.json<Record<string, any>>();
    const { wav_base64, ...meta } = body;
    return await storeSessionRecord(
      env,
      ctx,
      url.origin,
      device.user_id,
      {
        device_serial: meta.device_serial || device.serial,
        patient_id: meta.patient_id || 'PT',
        session_number: meta.session_number || 0,
        sample_rate: meta.sample_rate || 16000,
        flags: Array.isArray(meta.flags) ? meta.flags.filter((n: unknown) => Number.isFinite(n)) : undefined,
      },
      decodeBase64(wav_base64 || ''),
    );
  }

  if (subPath === '/sessions/raw') {
    const wavBytes = new Uint8Array(await req.arrayBuffer());
    return await storeSessionRecord(
      env,
      ctx,
      url.origin,
      device.user_id,
      {
        device_serial: url.searchParams.get('device_serial') || device.serial,
        patient_id: url.searchParams.get('patient_id') || 'PT',
        session_number: Number(url.searchParams.get('session_number') || 0),
        sample_rate: Number(url.searchParams.get('sample_rate') || 16000),
      },
      wavBytes,
    );
  }

  if (subPath === '/sessions/chunk') return await handleChunk(env, ctx, req, url, deviceId, device);

  return err('Unknown session endpoint', 404);
}

/**
 * /sessions/chunk — collect the firmware's ~1 MB offset slices, stitch on final.
 *
 * Each slice is its OWN object under _tmp/<patient>/s<n>/<offset>.part. The pre-v12 version
 * kept one temp blob and did download-whole + upload-whole on EVERY slice: quadratic, so a
 * 30-minute session moved ~1.5 GB through this function and the late slices blew past the
 * firmware's 12 s timeout. Every timeout was retried, the retry restarted at offset 0, and
 * offset 0 truncated the temp blob back to the first slice — a backlog that could never
 * drain. Writing parts makes each slice O(1); the file is materialised once, on the final.
 */
async function handleChunk(
  env: Env,
  ctx: ExecutionContext | undefined,
  req: Request,
  url: URL,
  deviceId: string,
  device: { user_id: string; serial: string },
): Promise<Response> {
  const q = url.searchParams;
  const offset = Number(q.get('offset') || 0);
  const isFinal = q.get('final') === '1';
  const sessionNumber = Number(q.get('session_number') || 0);
  // Firmware >=1.5.9 sends the session's full byte length so the assembled result can be
  // verified before it is accepted. 0 = older firmware: skip the check.
  const declaredTotal = Number(q.get('total') || 0);
  const serial = q.get('device_serial') || device.serial;

  // The part dir MUST be scoped by patient: session numbers restart at 1 for each patient,
  // so `s1` alone collides between two patients on the same device. With one shared dir,
  // patient A's stalled parts and patient B's parts land together and a resume can stitch a
  // WAV out of BOTH patients' audio. Sanitised because it becomes a storage path.
  const patientId = (q.get('patient_id') || 'PT').replace(/[^A-Za-z0-9_-]/g, '') || 'PT';
  const partDir = `${deviceId}/_tmp/${patientId}/s${sessionNumber}`;
  // Zero-padded so a plain lexical sort is also numeric order (R2 lists lexically).
  const partPath = `${partDir}/${String(offset).padStart(12, '0')}.part`;

  const slice = new Uint8Array(await req.arrayBuffer());

  // Already stored? Answer before touching the parts.
  //
  // Assembling a long session takes a while and the device gives up after 60 s. If it times
  // out on a final that actually SUCCEEDED, it retries the final — but the parts are gone
  // (removed on success), so the contiguity check would 409 and the device would re-upload
  // the whole session from byte 0. For a 118 MB take that is ~9 minutes of pointless
  // upload, on repeat, never converging. Confirming the existing row makes a lost ACK a
  // no-op: the device marks it synced and moves on.
  if (isFinal && declaredTotal > 0) {
    const already = await env.DB.prepare(
      `SELECT id, storage_path FROM sate_device_sessions
        WHERE user_id = ? AND device_serial = ? AND session_number = ? AND bytes = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(device.user_id, serial, sessionNumber, declaredTotal)
      .first<{ id: string; storage_path: string | null }>();

    // A row is NOT proof the audio is there. The 413 bug left rows whose object never
    // landed; trusting the row alone would answer "already stored" and strand that
    // recording on the device forever. Confirm the object, and bin the row if it is a ghost
    // so this upload can replace it.
    if (already) {
      const real = already.storage_path ? await objectExists(env, 'device-sessions', already.storage_path) : false;
      if (real) {
        await env.BUCKET.delete(`device-sessions/${partPath}`).catch(() => {});
        return json({ id: already.id, idempotent: true });
      }
      await env.DB.prepare(`DELETE FROM sate_device_sessions WHERE id = ?`).bind(already.id).run();
      console.warn(`dropped ghost session row ${already.id} (no object) - re-storing`);
    }
  }

  // offset 0 = the device is (re)starting this session, so whatever is in the part dir is
  // from an abandoned attempt and must go. Without this, stale parts with a HIGHER offset
  // survive and get stitched onto the new upload: sessions are renumbered when the SLP
  // deletes one, so `s3` today can be different audio than `s3` yesterday, and the leftover
  // tail would silently corrupt it.
  if (offset === 0) await purgePrefix(env, `device-sessions/${partDir}/`);

  // Re-sending a slice is normal (the firmware retries at the same offset); R2 put is an
  // overwrite, so this is idempotent without reading anything back.
  await putObject(env, 'device-sessions', partPath, slice.buffer as ArrayBuffer, 'application/octet-stream');

  if (!isFinal) return json({ ok: true, received: slice.length, offset });

  // Final slice: list every part and verify they form one gap-free stream. A gap means the
  // device and this function disagree about what landed, so 409 and let the device restart
  // from 0 rather than store a corrupt WAV.
  const parts = await listParts(env, `device-sessions/${partDir}/`);

  // Verify contiguity from the LISTED sizes first, so a bad set is rejected before a single
  // byte is downloaded.
  let assembledLen = 0;
  for (const p of parts) {
    if (p.offset !== assembledLen) return err(`offset gap: expected ${assembledLen}, have part at ${p.offset}`, 409);
    assembledLen += p.size;
  }
  if (declaredTotal > 0 && assembledLen !== declaredTotal) {
    return err(`size mismatch: assembled ${assembledLen}, device says ${declaredTotal}`, 409);
  }
  if (assembledLen === 0) return err('no audio received', 400);

  // ⚠️ DO NOT assemble this in a Uint8Array.
  //
  // The Deno original allocated `new Uint8Array(assembledLen)` and filled it. A Worker has a
  // hard 128 MB memory limit — far below Deno Deploy's — and a full-length take is ~118 MB
  // (RECORD_MAX_SECONDS 3700 s x 32 KB/s). Buffering one would OOM on exactly the long
  // recordings that already cost this project a 62-minute session once. The recorder would
  // retry forever and the backlog would never drain: the very bug the v12 rewrite fixed,
  // reintroduced by the platform's memory limit rather than by the algorithm.
  //
  // So the parts are streamed straight from R2 into the destination object instead. Peak
  // memory is one part (~1 MB) regardless of session length, which also means this scales
  // past the 128 MB take that the buffered version topped out at.
  //
  // The WAV header still needs patching, and that needs the total length — which is already
  // known from the contiguity check above, so the first part's 44 bytes can be fixed on the
  // way past without seeing the rest of the stream.
  const flags = parseFlags(q.get('flags'));
  const sessionId = 's-' + crypto.randomUUID().slice(0, 8);
  const storagePath = `${device.user_id}/${serial}/${sessionId}.wav`;

  // ⚠️ R2 REFUSES A STREAM OF UNKNOWN LENGTH. This used to build a plain ReadableStream and
  // hand it to put(), which fails outright with "Provided readable stream must have a known
  // length" — so the FINAL slice of every chunked upload failed, on every session, and the
  // recorder could never mark a take synced. It went unnoticed because this stack had not yet
  // been pointed at a real recorder; a simulated device session in sate-notes/ caught it.
  //
  // The length is known here (the contiguity check above computed it), so the bytes go
  // through a FixedLengthStream, which is the only stream shape R2 accepts.
  const fls = new FixedLengthStream(assembledLen);
  let failed: string | null = null;
  // Pump and put must run CONCURRENTLY: put() drains the readable half while the pump fills
  // the writable half. Awaiting the pump first would deadlock on the stream's buffer.
  const pump = pumpParts(env, parts, assembledLen, fls.writable).catch((e: Error) => {
    failed = e.message;   // recorded, not rethrown: the put below is what reports the failure
  });

  // THROW on failure — never log and carry on. See storeSessionRecord.
  try {
    await putObject(env, 'device-sessions', storagePath, fls.readable, 'audio/wav');
    await pump;
  } catch (e) {
    await env.BUCKET.delete(`device-sessions/${storagePath}`).catch(() => {});
    return err(`storage upload failed: ${failed ?? (e as Error).message}`, failed ? 409 : 500);
  }
  if (failed) {
    await env.BUCKET.delete(`device-sessions/${storagePath}`).catch(() => {});
    return err(`storage upload failed: ${failed}`, 409);
  }

  // Confirm the object really landed before telling the device it is safe. A 2xx that is not
  // backed by real bytes is what stranded a recording last time.
  if (!(await objectExists(env, 'device-sessions', storagePath))) {
    return err('storage upload reported success but the object is not there', 500);
  }

  await env.DB.prepare(
    `INSERT INTO sate_device_sessions
       (id, user_id, device_serial, patient_id, session_number, sample_rate, bytes, storage_path, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      device.user_id,
      // The SAME `serial` the idempotency probe used — if these disagreed, the probe could
      // never match and every timed-out final would duplicate the session.
      serial,
      q.get('patient_id') || 'PT',
      sessionNumber,
      Number(q.get('sample_rate') || 16000),
      assembledLen,
      storagePath,
      flags.length ? JSON.stringify(flags) : null,
    )
    .run();

  triggerProcessor(env, ctx, sessionId, url.origin);
  const res = json({ id: sessionId });

  // Only bin the parts once the session is safely stored.
  for (const p of parts) await env.BUCKET.delete(p.key).catch(() => {});
  return res;
}

interface PartRef {
  key: string;
  offset: number;
  size: number;
}

/**
 * Pump the R2 parts, in offset order, into `sink`. Part 0's WAV header is patched with the
 * real total on the way past — it is the only part carrying a header, and the length it must
 * declare is the whole session's, which that part cannot know from its own size.
 *
 * Sequential by necessity: a stream has one cursor. Each part is fetched, checked, written
 * and dropped, so peak memory is one part (~1 MB) regardless of session length — which is
 * what keeps a ~118 MB take under the Worker's hard 128 MB limit.
 */
async function pumpParts(
  env: Env,
  parts: PartRef[],
  totalLen: number,
  sink: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = sink.getWriter();
  try {
    for (const p of parts) {
      const obj = await env.BUCKET.get(p.key);
      if (!obj) throw new Error(`missing part at ${p.offset}`);
      let bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.length !== p.size) throw new Error(`part at ${p.offset} changed size`);
      if (p.offset === 0) {
        bytes = new Uint8Array(bytes);
        patchWavHeaderFor(bytes, totalLen);
      }
      await writer.write(bytes);
    }
    await writer.close();
  } catch (e) {
    // Abort so the concurrent put() rejects instead of hanging on a stream that will never
    // reach its declared length.
    await writer.abort(e).catch(() => {});
    throw e;
  }
}

/** List the .part objects under a prefix, in offset order, with their sizes. */
async function listParts(env: Env, prefix: string): Promise<PartRef[]> {
  const out: PartRef[] = [];
  let cursor: string | undefined;
  do {
    // R2 lists 1000 keys at a time; a 62-minute take is ~118 parts, but paginate anyway
    // rather than silently truncating a longer one.
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      if (!o.key.endsWith('.part')) continue;
      const name = o.key.slice(prefix.length);
      out.push({ key: o.key, offset: Number(name.replace('.part', '')), size: o.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.offset - b.offset);
}

async function purgePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function storeSessionRecord(
  env: Env,
  ctx: ExecutionContext | undefined,
  origin: string,
  userId: string,
  meta: { device_serial: string; patient_id: string; session_number: number; sample_rate: number; flags?: number[] },
  wavBytes: Uint8Array,
): Promise<Response> {
  const sessionId = 's-' + crypto.randomUUID().slice(0, 8);
  const storagePath = `${userId}/${meta.device_serial}/${sessionId}.wav`;

  // THROW — never just log.
  //
  // This once console.error'd and carried on inserting the row, so a rejected upload still
  // returned 2xx: the recorder marked the session synced and (pre-1.5.9) deleted its only
  // copy, while the server held a row pointing at nothing. A 118 MB session hit Supabase
  // Storage's global file-size limit (413) and a 62-minute recording was lost exactly this
  // way. A failed upload MUST fail the request so the device keeps the audio and retries.
  //
  // R2 has no 50 MB cap (5 TB per object), so that specific trigger is gone — but the rule
  // is about not lying to the device, not about one limit.
  try {
    await putObject(env, 'device-sessions', storagePath, wavBytes.buffer as ArrayBuffer, 'audio/wav');
  } catch (e) {
    throw new Error(`storage upload failed for ${wavBytes.length} bytes: ${(e as Error).message}`);
  }

  await env.DB.prepare(
    `INSERT INTO sate_device_sessions
       (id, user_id, device_serial, patient_id, session_number, sample_rate, bytes, storage_path, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      sessionId,
      userId,
      meta.device_serial,
      meta.patient_id,
      meta.session_number,
      meta.sample_rate,
      wavBytes.length,
      storagePath,
      meta.flags && meta.flags.length ? JSON.stringify(meta.flags) : null,
    )
    .run();

  // Kick the AI/recordings bridge so a device session appears exactly like a manual upload.
  // The cron sweep is the fallback if this is dropped.
  triggerProcessor(env, ctx, sessionId, origin);

  return json({ id: sessionId });
}

async function listSessions(env: Env, userId: string, deviceSerial: string | null): Promise<Response> {
  const cols = `id, device_serial, patient_id, session_number, sample_rate, bytes, created_at,
                processed, processed_at, recording_id, process_error, no_text`;
  const stmt = deviceSerial
    ? env.DB.prepare(
        `SELECT ${cols} FROM sate_device_sessions WHERE user_id = ? AND device_serial = ?
          ORDER BY created_at DESC LIMIT 20`,
      ).bind(userId, deviceSerial)
    : env.DB.prepare(`SELECT ${cols} FROM sate_device_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).bind(
        userId,
      );
  const res = await stmt.all<Record<string, unknown>>();
  // `at` is the alias the web list renders; `processed`/`no_text` are INTEGER here.
  return json(
    (res.results ?? []).map((s) => ({
      ...s,
      processed: s.processed === 1,
      no_text: s.no_text === 1,
      at: s.created_at,
    })),
  );
}

/**
 * Delete one uploaded session (row + stored WAV), scoped to the caller. A linked recording,
 * if any, is left intact — that is deleted from the report view.
 */
// Deleting a session must take the recording DERIVED from it as well. Removing only the
// session row left the `recordings` row and its copy of the audio in place: the take still
// showed in the web app and was still downloadable, so "delete" did not delete the clinical
// data. Same fix as the Supabase device-api (v22).
async function deleteSession(env: Env, userId: string, sessionId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT storage_path, recording_id FROM sate_device_sessions WHERE id = ? AND user_id = ?`)
    .bind(sessionId, userId)
    .first<{ storage_path: string | null; recording_id: string | null }>();
  if (!row) return err('Session not found', 404);
  if (row.storage_path) await env.BUCKET.delete(`device-sessions/${row.storage_path}`).catch(() => {});
  if (row.recording_id) {
    const rec = await env.DB.prepare(`SELECT file_path FROM recordings WHERE id = ? AND user_id = ?`)
      .bind(row.recording_id, userId)
      .first<{ file_path: string | null }>();
    if (rec?.file_path) await env.BUCKET.delete(`recordings/${rec.file_path}`).catch(() => {});
    await env.DB.prepare(`DELETE FROM recordings WHERE id = ? AND user_id = ?`)
      .bind(row.recording_id, userId).run();
  }
  await env.DB.prepare(`DELETE FROM sate_device_sessions WHERE id = ? AND user_id = ?`).bind(sessionId, userId).run();
  return noContent();
}

async function getSessionAudio(env: Env, userId: string, sessionId: string): Promise<Response> {
  const session = await env.DB.prepare(`SELECT storage_path FROM sate_device_sessions WHERE id = ? AND user_id = ?`)
    .bind(sessionId, userId)
    .first<{ storage_path: string | null }>();
  if (!session?.storage_path) return err('Session not found', 404);

  // Sign it the same way src/storage.ts does, then redirect — matching the Supabase original,
  // which 302'd to a Storage signed URL.
  const signReq = new Request(`https://internal/storage/v1/object/sign/device-sessions/${session.storage_path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SERVICE_KEY}` },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const signed = await (await import('../storage')).handleStorage(
    signReq,
    new URL(signReq.url),
    { uid: null, serviceRole: true },
    env,
  );
  const { signedURL } = await signed.json<{ signedURL: string }>();
  return new Response(null, { status: 302, headers: { ...cors, Location: signedURL } });
}
