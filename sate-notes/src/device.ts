// The device contract — byte-compatible with what the SATE recorder firmware already speaks.
//
// The recorder cannot tell this service apart from the clinical backend except by hostname.
// That is the whole point of the notes lane: same firmware, same image, different cfgServer.
//
// ⚠️ THIS FILE CARRIES INHERITED SCAR TISSUE. The chunk-assembly logic is ported from
// cloudflare/src/functions/deviceApi.ts, which in turn preserves fixes the Supabase original
// earned by destroying real recordings. Before simplifying anything here, read that file and
// CLAUDE.md. The invariants that matter, in order of what they cost to learn:
//
//   1. An upload failure must FAIL THE REQUEST. A 2xx not backed by real bytes tells the
//      recorder the take is safe; it then marks it synced and can free the only copy.
//   2. Chunk upload is O(1) per slice. Rewriting one temp blob per slice was quadratic and
//      stalled long uploads forever.
//   3. The idempotency probe verifies the OBJECT, not just the row. A row is not proof.
//   4. offset 0 purges the part dir, or stale higher-offset parts stitch onto new audio.
//   5. The part dir is scoped by folder. Session numbers are per-folder, so `s1` alone
//      collides and two folders' audio can end up in one WAV.
//   6. Parts are removed only AFTER the session is safely stored.
//   7. Never buffer the assembled WAV. A Worker has a hard 128 MB limit and a full-length
//      take is ~118 MB. Stream the parts straight through.

import type { Env } from './index';
import { startPipeline } from './pipeline';
import {
  json, err, nowIso, newId, patchWavHeaderFor, parseFlags,
  listParts, purgePrefix, objectExists, decodeBase64, wavSeconds, type PartRef,
} from './util';

interface DeviceRow { id: string; user_id: string; serial: string }

/** R2 key for a finished recording. */
const audioKey = (userId: string, serial: string, noteId: string) => `audio/${userId}/${serial}/${noteId}.wav`;

export async function handleDeviceApi(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  // The firmware builds every path as `<cfgServer><prefix>/api/...`. Accept the /api prefix
  // and the bare alias so a cfgServer with or without a trailing path both work.
  let p = url.pathname;
  if (p.startsWith('/api')) p = p.slice(4) || '/';
  const method = req.method;
  const auth = req.headers.get('Authorization') ?? '';

  // --- unauthenticated: first-time claim -------------------------------------------------
  if ((p === '/devices/register' || p === '/register') && method === 'POST') {
    return registerDevice(env, req);
  }

  // Everything below is device-key auth: `Bearer key-dev-<serial>`, issued by register.
  if (!auth.startsWith('Bearer key-')) return err('device key required', 401);
  const deviceId = auth.replace('Bearer key-', '');
  const device = await env.DB.prepare(`SELECT id, user_id, serial FROM devices WHERE id = ?`)
    .bind(deviceId).first<DeviceRow>();

  const cmdMatch = p.match(/^\/devices\/([^/]+)\/commands$/);
  if (cmdMatch && method === 'GET') return heartbeat(env, url, cmdMatch[1]);

  // A device whose row is gone must be told to reset to first-time setup — but only through
  // the heartbeat, which is handled above and answers {unclaimed:true} itself.
  if (!device) return err('device not found', 404);

  if (p === '/patients' && method === 'GET') return roster(env, device.user_id);

  if (p === '/sessions/verify' && method === 'GET') return verifySession(env, url, device);

  if (p === '/sessions/chunk' && method === 'POST') return uploadChunk(env, ctx, req, url, device);

  if (p === '/sessions/raw' && method === 'POST') {
    const bytes = new Uint8Array(await req.arrayBuffer());
    return storeTake(env, ctx, device, {
      folder_id: url.searchParams.get('patient_id') || 'notes',
      session_number: Number(url.searchParams.get('session_number') || 0),
      sample_rate: Number(url.searchParams.get('sample_rate') || 16000),
      serial: url.searchParams.get('device_serial') || device.serial,
      flags: parseFlags(url.searchParams.get('flags')),
    }, bytes);
  }

  if (p === '/sessions' && method === 'POST') {
    const body = await req.json<Record<string, any>>();
    return storeTake(env, ctx, device, {
      folder_id: body.patient_id || 'notes',
      session_number: body.session_number || 0,
      sample_rate: body.sample_rate || 16000,
      serial: body.device_serial || device.serial,
      flags: Array.isArray(body.flags) ? body.flags.filter((n: unknown) => Number.isFinite(n)) : [],
    }, decodeBase64(body.wav_base64 || ''));
  }

  if (p === '/firmware/latest' && method === 'GET') {
    const row = await env.DB.prepare(`SELECT version, url, notes, created_at FROM firmware ORDER BY created_at DESC LIMIT 1`)
      .first();
    return json(row || null);
  }

  return err(`no route for ${method} ${url.pathname}`, 404);
}

// ---------------------------------------------------------------------------------------
// Claim + presence
// ---------------------------------------------------------------------------------------

async function registerDevice(env: Env, req: Request): Promise<Response> {
  const { serial, claim_token, fw } = await req.json<{ serial?: string; claim_token?: string; fw?: string }>();
  if (!serial) return err('serial is required');
  if (!claim_token) return err('claim_token is required', 401);

  const claim = await env.DB.prepare(`SELECT user_id, user_name FROM claim_tokens WHERE token = ? AND used = 0`)
    .bind(claim_token).first<{ user_id: string; user_name: string }>();
  if (!claim) return err('Invalid or used claim token', 401);
  await env.DB.prepare(`UPDATE claim_tokens SET used = 1 WHERE token = ?`).bind(claim_token).run();

  const id = 'dev-' + serial.toLowerCase();
  // Re-registering an existing recorder must refresh it, not fail.
  await env.DB.prepare(
    `INSERT INTO devices (id, user_id, name, serial, fw, online, ip, last_seen, pending_sessions, state)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 'idle')
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id, serial = excluded.serial, fw = excluded.fw,
       online = 1, ip = excluded.ip, last_seen = excluded.last_seen,
       pending_sessions = 0, state = 'idle'`,
  ).bind(id, claim.user_id, serial, serial, fw || '', req.headers.get('cf-connecting-ip') || '', nowIso()).run();

  // Seed a default folder so a fresh device has somewhere to record to. The firmware falls
  // back to its own synthetic "Standalone" bucket when the roster is empty, which works but
  // shows a clinical-sounding label on Home.
  await env.DB.prepare(
    `INSERT INTO folders (id, user_id, folder_id, name) VALUES (?, ?, 'notes', 'Voice Notes')
     ON CONFLICT(user_id, folder_id) DO NOTHING`,
  ).bind(newId('f'), claim.user_id).run();

  // `slp`/`slp_id` are the field names the firmware reads. Kept verbatim: renaming them is a
  // firmware change for zero user-visible gain.
  return json({ device_id: id, device_key: 'key-' + id, slp: claim.user_name, slp_id: claim.user_id });
}

/**
 * Heartbeat + command poll. The firmware calls this every few seconds with its telemetry in
 * the query string and expects { unclaimed?, commands[], active_patient, ota }.
 */
async function heartbeat(env: Env, url: URL, deviceId: string): Promise<Response> {
  const exists = await env.DB.prepare(`SELECT id FROM devices WHERE id = ?`).bind(deviceId).first();
  // The ONLY path back to first-time setup: the account removed this recorder, so the row is
  // gone. Holding BOOT is a full factory reset, not this.
  if (!exists) return json({ unclaimed: true, commands: [] });

  const q = url.searchParams;
  const sets = ['online = 1', 'last_seen = ?'];
  const params: unknown[] = [nowIso()];
  const num = (k: string, col: string) => { if (q.has(k)) { sets.push(`${col} = ?`); params.push(Number(q.get(k))); } };
  const str = (k: string, col: string) => { if (q.has(k)) { sets.push(`${col} = ?`); params.push(q.get(k)); } };
  num('pending', 'pending_sessions');
  str('state', 'state');
  str('fw', 'fw');
  str('ota', 'ota_state');
  num('bat', 'battery_pct');
  num('mv', 'battery_mv');
  num('recs', 'total_recordings');
  params.push(deviceId);
  await env.DB.prepare(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`).bind(...params).run();

  const res = await env.DB.prepare(
    `SELECT op, payload FROM device_commands WHERE device_id = ? AND consumed = 0 ORDER BY created_at ASC`,
  ).bind(deviceId).all<{ op: string; payload: string | null }>();
  const cmds = res.results ?? [];
  if (cmds.length) {
    await env.DB.prepare(`UPDATE device_commands SET consumed = 1 WHERE device_id = ? AND consumed = 0`)
      .bind(deviceId).run();
  }

  const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
  return json({
    commands: cmds.map((c) => c.op),
    // The firmware reads the record command's folder assignment from this field.
    active_patient: parse(cmds.find((c) => c.op === 'record')?.payload ?? null),
    ota: parse(cmds.find((c) => c.op === 'ota')?.payload ?? null),
  });
}

/**
 * The roster, in the exact shape the firmware parses into /sate/patients.json:
 * [{patient_id, name, age, session_type, clinician}]. Only `patient_id` and `name` carry
 * meaning here; the rest are filled so the firmware's parser and Home screen stay happy.
 */
async function roster(env: Env, userId: string): Promise<Response> {
  const res = await env.DB.prepare(`SELECT folder_id, name FROM folders WHERE user_id = ? ORDER BY created_at ASC`)
    .bind(userId).all<{ folder_id: string; name: string }>();
  return json((res.results ?? []).map((f) => ({
    patient_id: f.folder_id,
    name: f.name || f.folder_id,
    age: '-',
    session_type: 'Note',
    clinician: '-',
  })));
}

// ---------------------------------------------------------------------------------------
// Server-verified reclaim
// ---------------------------------------------------------------------------------------

/**
 * "Is this exact take durably stored?" — asked by the firmware before it frees the SD audio
 * of an already-synced take (fw >= 1.5.13, trimPatientSyncedAudio -> verifySessionStored).
 *
 * ⚠️ THIS ROUTE IS LOAD-BEARING AND MUST NEVER MUTATE. The device is the only copy of a
 * recording until this answers stored:true. Answer true ONLY when the row exists AND the
 * storage object really exists — a row alone is what the 413-ghost class of bugs produced.
 * Any doubt (missing row, missing object, byte mismatch) answers false, and the firmware
 * simply keeps the audio and retries next cycle.
 *
 * Note the clinical Cloudflare port (cloudflare/src/functions/deviceApi.ts) never implemented
 * this; a recorder pointed at it keeps every take's audio forever and eventually fills its
 * card. Implemented here from the start.
 */
async function verifySession(env: Env, url: URL, device: DeviceRow): Promise<Response> {
  const q = url.searchParams;
  const folderId = q.get('patient_id') || 'notes';
  const sessionNumber = Number(q.get('session_number') || 0);
  const bytes = Number(q.get('bytes') || 0);
  // device_serial is intentionally omitted by the firmware so it defaults to this device's
  // own serial — the same identity the take was uploaded under.
  const serial = q.get('device_serial') || device.serial;
  if (!bytes) return json({ stored: false, reason: 'no byte count' });

  const row = await env.DB.prepare(
    `SELECT id, storage_key FROM notes
      WHERE user_id = ? AND device_serial = ? AND folder_id = ? AND session_number = ? AND bytes = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(device.user_id, serial, folderId, sessionNumber, bytes).first<{ id: string; storage_key: string | null }>();

  if (!row?.storage_key) return json({ stored: false });
  const real = await objectExists(env, row.storage_key);
  return json({ stored: real, id: row.id });
}

// ---------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------

/**
 * /sessions/chunk — collect the firmware's ~1 MB offset slices, stitch on final.
 *
 * Each slice is its OWN object under _tmp/<device>/<folder>/s<n>/<offset>.part. Keeping one
 * temp blob and rewriting it per slice is quadratic: a 30-minute session moved ~1.5 GB
 * through the function and the late slices blew past the firmware's timeout, every timeout
 * retried from offset 0, and the backlog could never drain.
 */
async function uploadChunk(
  env: Env, ctx: ExecutionContext, req: Request, url: URL, device: DeviceRow,
): Promise<Response> {
  const q = url.searchParams;
  const offset = Number(q.get('offset') || 0);
  const isFinal = q.get('final') === '1';
  const sessionNumber = Number(q.get('session_number') || 0);
  // Firmware >= 1.5.9 sends the session's full byte length so the assembled result can be
  // verified before it is accepted. 0 = older firmware: skip the check.
  const declaredTotal = Number(q.get('total') || 0);
  const serial = q.get('device_serial') || device.serial;
  const sampleRate = Number(q.get('sample_rate') || 16000);

  // Sanitised because it becomes a storage path. Scoped by folder because session numbers
  // are per-folder: `s1` alone collides between two folders on the same device, and a resume
  // could stitch a WAV out of BOTH.
  const folderId = (q.get('patient_id') || 'notes').replace(/[^A-Za-z0-9_-]/g, '') || 'notes';
  const partDir = `_tmp/${device.id}/${folderId}/s${sessionNumber}`;
  // Zero-padded so a plain lexical sort is also numeric order (R2 lists lexically).
  const partKey = `${partDir}/${String(offset).padStart(12, '0')}.part`;

  const slice = new Uint8Array(await req.arrayBuffer());

  // Already stored? Answer before touching the parts.
  //
  // Assembling a long session takes a while and the device gives up after 60 s. If it times
  // out on a final that actually SUCCEEDED, it retries the final — but the parts are gone
  // (removed on success), so the contiguity check would 409 and the device would re-upload
  // the whole session from byte 0. Confirming the existing row makes a lost ACK a no-op.
  if (isFinal && declaredTotal > 0) {
    const hit = await findTake(env, device.user_id, serial, folderId, sessionNumber, declaredTotal);
    if (hit) {
      await env.BUCKET.delete(partKey).catch(() => {});
      return json({ id: hit, idempotent: true });
    }
  }

  // offset 0 = the device is (re)starting this session, so whatever is in the part dir is
  // from an abandoned attempt and must go. Stale parts with a HIGHER offset otherwise
  // survive and get stitched onto the new upload.
  if (offset === 0) await purgePrefix(env, `${partDir}/`);

  // Re-sending a slice is normal (the firmware retries at the same offset); an R2 put is an
  // overwrite, so this is idempotent without reading anything back.
  await env.BUCKET.put(partKey, slice.buffer as ArrayBuffer, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });

  if (!isFinal) return json({ ok: true, received: slice.length, offset });

  // Final slice: list every part and verify they form one gap-free stream. A gap means the
  // device and this function disagree about what landed, so 409 and let the device restart
  // from 0 rather than store a corrupt WAV.
  const parts = await listParts(env, `${partDir}/`);
  let assembledLen = 0;
  for (const p of parts) {
    if (p.offset !== assembledLen) return err(`offset gap: expected ${assembledLen}, have part at ${p.offset}`, 409);
    assembledLen += p.size;
  }
  if (declaredTotal > 0 && assembledLen !== declaredTotal) {
    return err(`size mismatch: assembled ${assembledLen}, device says ${declaredTotal}`, 409);
  }
  if (assembledLen === 0) return err('no audio received', 400);

  const noteId = newId('n');
  const key = audioKey(device.user_id, serial, noteId);

  // ⚠️ DO NOT assemble this in a Uint8Array. A Worker has a hard 128 MB memory limit and a
  // full-length take is ~118 MB (RECORD_MAX_SECONDS 3700 s x 32 KB/s). Buffering one would
  // OOM on exactly the long recordings that matter most. Stream the parts through instead:
  // peak memory is one part (~1 MB) regardless of length.
  // ⚠️ R2 REFUSES A STREAM OF UNKNOWN LENGTH: passing a bare ReadableStream to put() fails
  // with "Provided readable stream must have a known length". The length IS known here — the
  // contiguity check above computed it — so the bytes go through a FixedLengthStream, which
  // is the only stream shape R2 accepts. (The clinical Cloudflare port at
  // cloudflare/src/functions/deviceApi.ts had the same bug — a bare stream, so the final slice
  // of every chunked upload would have failed there. Fixed 2026-09-01.)
  const fls = new FixedLengthStream(assembledLen);
  let failed: string | null = null;
  // Pump and put must run CONCURRENTLY: put() consumes the readable half while the pump
  // fills the writable half. Awaiting the pump first would deadlock on the stream's buffer.
  const pump = pumpParts(env, parts, assembledLen, fls.writable).catch((e: Error) => {
    failed = e.message;   // recorded, not rethrown: the put below is what reports the failure
  });

  try {
    await env.BUCKET.put(key, fls.readable, { httpMetadata: { contentType: 'audio/wav' } });
    await pump;
  } catch (e) {
    // FAIL THE REQUEST — never log and carry on. A 2xx not backed by real bytes is what lets
    // a recorder free its only copy of a recording.
    await env.BUCKET.delete(key).catch(() => {});
    return err(`storage upload failed: ${failed ?? (e as Error).message}`, failed ? 409 : 500);
  }
  if (failed) {
    await env.BUCKET.delete(key).catch(() => {});
    return err(`storage upload failed: ${failed}`, 409);
  }
  if (!(await objectExists(env, key))) {
    return err('storage upload reported success but the object is not there', 500);
  }

  const inserted = await insertNote(env, {
    id: noteId, user_id: device.user_id, device_serial: serial, folder_id: folderId,
    session_number: sessionNumber, sample_rate: sampleRate, bytes: assembledLen,
    duration_s: wavSeconds(assembledLen, sampleRate), storage_key: key,
    flags: parseFlags(q.get('flags')),
  });

  // A concurrent final won the race and stored the same take: drop ours and answer theirs.
  if (inserted !== noteId) {
    await env.BUCKET.delete(key).catch(() => {});
    for (const p of parts) await env.BUCKET.delete(p.key).catch(() => {});
    return json({ id: inserted, idempotent: true });
  }

  startPipeline(env, ctx, noteId);
  const res = json({ id: noteId });
  // Only bin the parts once the note is safely stored.
  for (const p of parts) await env.BUCKET.delete(p.key).catch(() => {});
  return res;
}

/** Whole-file upload (the app/pendant path). Same rules, no assembly. */
async function storeTake(
  env: Env, ctx: ExecutionContext, device: DeviceRow,
  meta: { folder_id: string; session_number: number; sample_rate: number; serial: string; flags: number[] },
  bytes: Uint8Array,
): Promise<Response> {
  if (!bytes.length) return err('no audio received', 400);

  const hit = await findTake(env, device.user_id, meta.serial, meta.folder_id, meta.session_number, bytes.length);
  if (hit) return json({ id: hit, idempotent: true });

  const noteId = newId('n');
  const key = audioKey(device.user_id, meta.serial, noteId);
  try {
    await env.BUCKET.put(key, bytes.buffer as ArrayBuffer, { httpMetadata: { contentType: 'audio/wav' } });
  } catch (e) {
    return err(`storage upload failed for ${bytes.length} bytes: ${(e as Error).message}`, 500);
  }
  if (!(await objectExists(env, key))) return err('upload reported success but the object is not there', 500);

  const inserted = await insertNote(env, {
    id: noteId, user_id: device.user_id, device_serial: meta.serial, folder_id: meta.folder_id,
    session_number: meta.session_number, sample_rate: meta.sample_rate, bytes: bytes.length,
    duration_s: wavSeconds(bytes.length, meta.sample_rate), storage_key: key, flags: meta.flags,
  });
  if (inserted !== noteId) {
    await env.BUCKET.delete(key).catch(() => {});
    return json({ id: inserted, idempotent: true });
  }

  startPipeline(env, ctx, noteId);
  return json({ id: noteId });
}

/**
 * Find an already-stored take by its natural identity — and confirm the OBJECT, not just the
 * row. A row is not proof the audio landed; trusting one would answer "already stored" and
 * strand that recording on the device forever. A ghost row is deleted so this upload can
 * replace it. Returns the note id, or null.
 */
async function findTake(
  env: Env, userId: string, serial: string, folderId: string, sessionNumber: number, bytes: number,
): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT id, storage_key FROM notes
      WHERE user_id = ? AND device_serial = ? AND folder_id = ? AND session_number = ? AND bytes = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(userId, serial, folderId, sessionNumber, bytes).first<{ id: string; storage_key: string | null }>();
  if (!row) return null;
  if (row.storage_key && await objectExists(env, row.storage_key)) return row.id;
  await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(row.id).run();
  console.warn(`dropped ghost note row ${row.id} (no object) - re-storing`);
  return null;
}

/**
 * Insert the note row. Returns the id actually stored — which differs from the one passed in
 * when a concurrent upload of the same take won the unique index (notes_take_idx), in which
 * case the caller must bin its own object rather than leave an orphan.
 */
async function insertNote(env: Env, n: {
  id: string; user_id: string; device_serial: string; folder_id: string; session_number: number;
  sample_rate: number; bytes: number; duration_s: number; storage_key: string; flags: number[];
}): Promise<string> {
  try {
    await env.DB.prepare(
      `INSERT INTO notes (id, user_id, device_serial, folder_id, session_number, sample_rate,
                          bytes, duration_s, storage_key, flags, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')`,
    ).bind(
      n.id, n.user_id, n.device_serial, n.folder_id, n.session_number, n.sample_rate,
      n.bytes, n.duration_s, n.storage_key, n.flags.length ? JSON.stringify(n.flags) : null,
    ).run();
    return n.id;
  } catch (e) {
    const dup = await env.DB.prepare(
      `SELECT id FROM notes WHERE device_serial = ? AND folder_id = ? AND session_number = ? AND bytes = ?`,
    ).bind(n.device_serial, n.folder_id, n.session_number, n.bytes).first<{ id: string }>();
    if (dup) return dup.id;
    throw e;
  }
}

/**
 * Pump the R2 parts, in offset order, into `sink`. Part 0's WAV header is patched with the
 * real total on the way past — it is the only part that carries a header, and the length it
 * must declare is the whole session's, which that part cannot know from its own size.
 */
async function pumpParts(
  env: Env, parts: PartRef[], totalLen: number, sink: WritableStream<Uint8Array>,
): Promise<void> {
  const writer = sink.getWriter();
  try {
    // Sequential by necessity: a stream has one cursor. Each part is fetched, checked,
    // written and dropped, so peak memory is one part (~1 MB) whatever the length.
    for (const p of parts) {
      const obj = await env.BUCKET.get(p.key);
      if (!obj) throw new Error(`missing part at ${p.offset}`);
      let bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.length !== p.size) throw new Error(`part at ${p.offset} changed size`);
      if (p.offset === 0) { bytes = new Uint8Array(bytes); patchWavHeaderFor(bytes, totalLen); }
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
