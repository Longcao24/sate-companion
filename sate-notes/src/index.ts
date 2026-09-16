// SATE Notes — Worker entry point.
//
// Two surfaces on one Worker:
//   /api/*      the DEVICE contract (device-key auth) — byte-compatible with what the
//               recorder firmware already speaks. src/device.ts.
//   /admin/*    control plane — mint a claim token, set the folder roster, queue a command,
//               grant the feature to an account. Two ways in: a SATE admin's own session
//               (the app's Admin page → Users, which is where access is decided), or the
//               ops ADMIN_KEY for bench scripts.
//
// This service shares no database, no storage and no AI capacity with the clinical stack.
// A recorder belongs to this lane because it was provisioned with cfgServer pointing here —
// nothing on the device says "notes".

import { handleDeviceApi } from './device';
import { TEMPLATES, DEFAULT_TEMPLATE, assertCloudflareModel } from './pipeline';
import { readerHtml } from './ui';
import { consoleHtml } from './console';
import { callerFrom } from './auth';
import { handleIngest, ingest, type IngestBody } from './ingest';
import { json, err, cors, newId, nowIso, signMedia, verifyMedia } from './util';

export { NotePipeline } from './pipeline';

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  PIPELINE: Workflow;
  /** Secret. Gates every /admin route, including claim-token minting. */
  ADMIN_KEY: string;
  /** Shared with the clinical device-api, for the /internal/ingest route only. */
  INGEST_SECRET: string;
  /** Identity provider. This service verifies tokens against it; it holds no user table. */
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** The clinical device-api, used to fetch a session's audio with the caller's own token. */
  DEVICE_API_URL: string;
  ASR_MODEL: string;
  /** BCP-47 hint for ASR. Was hardcoded 'en', which turned any other language into noise. */
  ASR_LANGUAGE: string;
  SUMMARY_MODEL: string;
  CHUNK_SECONDS: string;
  CHUNK_OVERLAP_SECONDS: string;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);

    try {
      if (url.pathname === '/health') return json({ ok: true, service: 'sate-notes' });
      // The reader. Served from the same Worker so a demo needs no second deploy and no CDN.
      if ((url.pathname === '/' || url.pathname === '/app') && req.method === 'GET') {
        return new Response(readerHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      // The operator console: devices, folders, notes.
      if (url.pathname === '/console' && req.method === 'GET') {
        return new Response(consoleHtml(), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      // Who am I, and may I use this feature? The web app calls this with the user's Supabase
      // access token and renders the Notes section only if `enabled` comes back true.
      if (url.pathname === '/me' && req.method === 'GET') {
        const who = await callerFrom(req, env);
        if (!who) return err('unauthorized', 401);
        return json({ user_id: who.caller.id, email: who.caller.email, ...who.access });
      }
      if (url.pathname === '/internal/ingest' && req.method === 'POST') return await handleIngest(req, env, ctx);
      if (url.pathname.startsWith('/admin/')) return await handleAdmin(req, url, env);
      // Everything else is the device contract. It also serves the read API used by the
      // reader page, which is why the note routes are checked first.
      if (url.pathname.startsWith('/api/notes')) return await handleNotes(req, url, env, ctx);
      return await handleDeviceApi(req, url, env, ctx);
    } catch (e) {
      // Log the detail, return a generic message: stack traces and SQL must not leave here.
      console.error('[sate-notes] unhandled', e);
      return err('internal error', 500);
    }
  },
};

// ---------------------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------------------

/**
 * ⚠️ ADMIN_KEY is a single shared secret with no per-user scoping — an OPS key for bench
 * scripts and provisioning, not an identity. The real gate is the one below it: a signed-in
 * SATE admin (`sate_admins`, asked of device-api). Prefer that path; do not put anything
 * private behind this key, and do not hand it to a person when an admin account will do.
 */
function adminOk(req: Request, env: Env): boolean {
  const key = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
  return Boolean(env.ADMIN_KEY) && key === env.ADMIN_KEY;
}

async function handleAdmin(req: Request, url: URL, env: Env): Promise<Response> {
  // Two ways in: the ops key (scripts, this repo's tooling) or a signed-in admin of this lane.
  // A normal user's token is not enough, and neither grants anything over clinical data — this
  // service cannot reach it.
  if (!adminOk(req, env)) {
    const who = await callerFrom(req, env);
    if (!who?.access.isAdmin) return err('unauthorized', 401);
  }
  const p = url.pathname.slice('/admin'.length);
  const method = req.method;

  // Who may use the notes feature. This is the admin switch the whole lane hangs off.
  if (p === '/accounts' && method === 'GET') {
    const res = await env.DB.prepare(
      `SELECT a.user_id, a.email, a.enabled, a.mode, a.updated_at,
              (SELECT count(*) FROM notes n WHERE n.user_id = a.user_id) AS notes
         FROM account_access a ORDER BY a.updated_at DESC`,
    ).all();
    return json((res.results ?? []).map((r: any) => ({ ...r, enabled: r.enabled === 1 })));
  }

  // Grant/revoke by email. Resolving the email to a Supabase uuid is the caller's job (the
  // admin UI passes the id it already has); an id-less grant would be unenforceable.
  if (p === '/accounts' && method === 'PUT') {
    const b = await req.json<{ user_id?: string; email?: string; enabled?: boolean; mode?: string }>();
    // Granting by email works once the account has signed into the app at least once, which is
    // what records it here. Before that there is no uuid to grant to and nothing to enforce.
    if (!b.user_id && b.email) {
      const hit = await env.DB.prepare(`SELECT user_id FROM account_access WHERE lower(email) = lower(?)`)
        .bind(b.email).first<{ user_id: string }>();
      if (!hit) return err(`no account for ${b.email} yet — have them sign into the app once, then grant`, 404);
      b.user_id = hit.user_id;
    }
    if (!b.user_id) return err('user_id (the Supabase auth uuid) or a known email is required');
    await env.DB.prepare(
      `INSERT INTO account_access (user_id, email, enabled, mode, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         email = excluded.email, enabled = excluded.enabled,
         mode = excluded.mode, updated_at = excluded.updated_at`,
    ).bind(b.user_id, (b.email || '').toLowerCase(), b.enabled ? 1 : 0, b.mode || 'notes', nowIso()).run();
    return json({ ok: true });
  }

  if (p === '/notes-admins' && method === 'POST') {
    const { email } = await req.json<{ email?: string }>();
    if (!email) return err('email is required');
    await env.DB.prepare(`INSERT INTO notes_admins (email) VALUES (?) ON CONFLICT(email) DO NOTHING`)
      .bind(email.toLowerCase()).run();
    return json({ ok: true });
  }

  // Mint a one-shot claim token. This is what gets typed into provisioning:
  //   sate provision --server https://<worker> --claim-token <token>
  if (p === '/claim-tokens' && method === 'POST') {
    // The uuid comes from Supabase, which is the only place accounts exist. This service
    // deliberately cannot look one up by email — that would mean keeping a user table.
    const { user_id, name } = await req.json<{ user_id?: string; name?: string }>();
    if (!user_id) return err('user_id (the Supabase auth uuid) is required');
    const token = 'claim-' + crypto.randomUUID().slice(0, 8);
    await env.DB.prepare(`INSERT INTO claim_tokens (token, user_id, user_name) VALUES (?, ?, ?)`)
      .bind(token, user_id, name || '').run();
    return json({ token, user_id });
  }

  // Replace the folder roster. The device picks it up on the next `reload_patients`.
  if (p === '/folders' && method === 'PUT') {
    const { user_id, folders } = await req.json<{ user_id?: string; folders?: Array<{ folder_id: string; name?: string }> }>();
    if (!user_id || !Array.isArray(folders)) return err('user_id and folders[] are required');
    const stmts = [env.DB.prepare(`DELETE FROM folders WHERE user_id = ?`).bind(user_id)];
    for (const f of folders) {
      // Sanitised: this string becomes an SD path on the device and an R2 key prefix here.
      const fid = String(f.folder_id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 19);
      if (!fid) continue;
      stmts.push(env.DB.prepare(`INSERT INTO folders (id, user_id, folder_id, name) VALUES (?, ?, ?, ?)`)
        .bind(newId('f'), user_id, fid, f.name || fid));
    }
    await env.DB.batch(stmts);
    return json({ ok: true, count: stmts.length - 1 });
  }

  // Queue a command for a device: record / stop / reboot / sync_now / reload_patients / ota.
  const cmd = p.match(/^\/devices\/([^/]+)\/commands$/);
  if (cmd && method === 'POST') {
    const { op, payload } = await req.json<{ op?: string; payload?: unknown }>();
    if (!op) return err('op is required');
    const device = await env.DB.prepare(`SELECT id FROM devices WHERE id = ?`).bind(cmd[1]).first();
    if (!device) return err('device not found', 404);
    await env.DB.prepare(`INSERT INTO device_commands (id, device_id, op, payload) VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), cmd[1], op, payload ? JSON.stringify(payload) : null).run();
    return json({ ok: true });
  }

  if (p === '/folders' && method === 'GET') {
    const userId = url.searchParams.get('user_id');
    if (!userId) return err('user_id is required');
    const res = await env.DB.prepare(`SELECT folder_id, name FROM folders WHERE user_id = ? ORDER BY created_at ASC`)
      .bind(userId).all();
    return json(res.results ?? []);
  }

  // Re-run the WHOLE pipeline for a note (re-transcribe + re-summarise). Expensive — use
  // /summarize below when the transcript is already good.
  const retry = p.match(/^\/notes\/([^/]+)\/retry$/);
  if (retry && method === 'POST') {
    const note = await env.DB.prepare(`SELECT id, storage_key FROM notes WHERE id = ?`).bind(retry[1]).first<any>();
    if (!note?.storage_key) return err('note not found', 404);
    await env.DB.prepare(`UPDATE notes SET status = 'queued', error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?`)
      .bind(nowIso(), note.id).run();
    // A Workflow instance id is unique forever, so a re-run needs a fresh one — reusing the
    // note id would be rejected as a duplicate and the retry would silently do nothing.
    await env.PIPELINE.create({ id: `${note.id}-retry-${Date.now()}`, params: { noteId: note.id } });
    return json({ ok: true, note: note.id });
  }

  // Re-summarise from the STORED transcript: a different template, or a different (still
  // Cloudflare-hosted) model. ~4% of the cost of a full run, and it never re-transcribes.
  const resum = p.match(/^\/notes\/([^/]+)\/summarize$/);
  if (resum && method === 'POST') {
    const body = await req.json<{ template?: string; model?: string }>().catch(() => ({} as any));
    const template = body.template || 'meeting';
    if (!TEMPLATES[template]) return err(`unknown template "${template}" (have: ${Object.keys(TEMPLATES).join(', ')})`);
    let model = env.SUMMARY_MODEL;
    if (body.model) {
      try { model = assertCloudflareModel(body.model, 'model'); }
      catch (e) { return err((e as Error).message); }
    }
    const tr = await env.DB.prepare(`SELECT note_id FROM transcripts WHERE note_id = ?`).bind(resum[1]).first();
    if (!tr) return err('note has no transcript yet', 409);
    await env.PIPELINE.create({
      id: `${resum[1]}-sum-${Date.now()}`,
      params: { noteId: resum[1], summaryOnly: true, template, model },
    });
    return json({ ok: true, template, model });
  }

  const del = p.match(/^\/notes\/([^/]+)$/);
  if (del && method === 'DELETE') {
    const note = await env.DB.prepare(`SELECT storage_key FROM notes WHERE id = ?`).bind(del[1]).first<any>();
    if (!note) return err('note not found', 404);
    if (note.storage_key) await env.BUCKET.delete(note.storage_key).catch(() => {});
    // transcripts/summaries cascade on the FK.
    await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(del[1]).run();
    return json({ ok: true });
  }

  if (p === '/models' && method === 'GET') {
    return json({
      asr: env.ASR_MODEL,
      summary: env.SUMMARY_MODEL,
      default_template: DEFAULT_TEMPLATE,
      templates: Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label })),
    });
  }

  if (p === '/devices' && method === 'GET') {
    // A device that stopped heartbeating is offline; the firmware never says goodbye.
    const cutoff = new Date(Date.now() - 45000).toISOString();
    await env.DB.prepare(`UPDATE devices SET online = 0, state = 'idle' WHERE last_seen < ? AND online = 1`)
      .bind(cutoff).run();
    const res = await env.DB.prepare(`SELECT * FROM devices ORDER BY created_at ASC`).all();
    return json(res.results ?? []);
  }

  return err(`no admin route for ${method} ${url.pathname}`, 404);
}

// ---------------------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------------------

async function handleNotes(req: Request, url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  const p = url.pathname.slice('/api/notes'.length);

  // Audio is gated by a signed, per-note, expiring token rather than the bearer key: the
  // <audio> element cannot set headers. Checked BEFORE the bearer gate below.
  const audio = p.match(/^\/([^/]+)\/audio$/);
  if (audio && req.method === 'GET') {
    if (!(await verifyMedia(env.ADMIN_KEY, audio[1], url.searchParams.get('t')))) {
      return err('unauthorized', 401);
    }
    return streamAudio(env, req, audio[1]);
  }

  // A signed-in user, or the ops key. ⚠️ For a user the scope comes from the TOKEN, never from
  // a query parameter — `?user_id=` is a request, not a claim, and honouring it would let any
  // enabled account read every other account's recordings. Only the ops key may name a user.
  const who = await callerFrom(req, env);
  const isOps = adminOk(req, env);
  if (!who && !isOps) return err('unauthorized', 401);
  if (who && !who.access.enabled) return err('the notes feature is not enabled for this account', 403);
  const scope = who ? who.caller.id : null;

  // Which of these device sessions already have a note? The Devices list asks this so its
  // button can read "View note" instead of offering to make a second one.
  if (p === '/by-source' && req.method === 'GET') {
    const ids = (url.searchParams.get('ids') || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 100);
    if (!ids.length) return json({});
    const owner = scope ?? url.searchParams.get('user_id');
    if (!owner) return err('user_id is required');
    const marks = ids.map(() => '?').join(',');
    const res = await env.DB.prepare(
      `SELECT id, source_id, status, title, chunks_done, chunks_total
         FROM notes WHERE user_id = ? AND source_id IN (${marks})`,
    ).bind(owner, ...ids).all<any>();
    const notes: Record<string, any> = {};
    for (const r of res.results ?? []) {
      notes[r.source_id] = { id: r.id, status: r.status, title: r.title, chunks_done: r.chunks_done, chunks_total: r.chunks_total };
    }
    // Sessions whose note was deleted on purpose. Returned separately from `notes` so the
    // caller cannot mistake an opt-out for an existing note: it must NOT auto-generate one,
    // but it must still offer the button.
    const opted = await env.DB.prepare(
      `SELECT source_id FROM note_optouts WHERE user_id = ? AND source_id IN (${marks})`,
    ).bind(owner, ...ids).all<{ source_id: string }>();
    return json({ notes, optedOut: (opted.results ?? []).map((r) => r.source_id) });
  }

  // "Generate meeting note" from a recording the clinical stack already stored. Nothing about
  // that recording changes — this only makes an additional artifact from a copy of the audio.
  if (p === '/from-session' && req.method === 'POST') {
    if (!scope) return err('a signed-in user is required', 401);
    const body = await req.json<IngestBody>().catch(() => null);
    if (!body) return err('body required');
    // Asking for it by name is a change of mind: drop any earlier "no thanks".
    await env.DB.prepare(`DELETE FROM note_optouts WHERE user_id = ? AND source_id = ?`)
      .bind(scope, body.session_id).run();
    const userToken = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
    return ingest(env, ctx, scope, body, userToken);
  }

  if ((p === '' || p === '/') && req.method === 'GET') {
    const userId = scope ?? url.searchParams.get('user_id');
    if (!userId) return err('user_id is required');
    const res = await env.DB.prepare(
      `SELECT id, device_serial, folder_id, session_number, bytes, duration_s, title, status,
              error, chunks_done, chunks_total, created_at
         FROM notes WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
    ).bind(userId).all();
    return json(res.results ?? []);
  }


  // Delete a note the user no longer wants. Scoped to the caller: a note that is not theirs
  // must be indistinguishable from one that does not exist.
  // Summarise this note a different way. Runs from the STORED transcript — one cheap LLM call,
  // never a re-transcription, which is the whole reason summaries live in their own table.
  const resum = p.match(/^\/([^/]+)\/summarize$/);
  if (resum && req.method === 'POST') {
    if (!scope) return err('a signed-in user is required', 401);
    const body = await req.json<{ template?: string }>().catch(() => ({} as any));
    const template = body.template || DEFAULT_TEMPLATE;
    if (!TEMPLATES[template]) {
      return err(`unknown template "${template}" (have: ${Object.keys(TEMPLATES).join(', ')})`);
    }
    const owned = await env.DB.prepare(`SELECT id FROM notes WHERE id = ? AND user_id = ?`)
      .bind(resum[1], scope).first();
    if (!owned) return err('note not found', 404);
    const tr = await env.DB.prepare(`SELECT note_id FROM transcripts WHERE note_id = ?`).bind(resum[1]).first();
    if (!tr) return err('this note has no transcript yet', 409);
    // Already made? Hand it back rather than paying for it twice.
    const have = await env.DB.prepare(
      `SELECT id FROM summaries WHERE note_id = ? AND template = ? AND model = ?`,
    ).bind(resum[1], template, env.SUMMARY_MODEL).first();
    if (have) return json({ ok: true, template, cached: true });
    await env.PIPELINE.create({
      id: `${resum[1]}-sum-${template}-${Date.now()}`,
      params: { noteId: resum[1], summaryOnly: true, template, model: env.SUMMARY_MODEL },
    });
    return json({ ok: true, template });
  }

  const del = p.match(/^\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    if (!scope) return err('a signed-in user is required', 401);
    const row = await env.DB.prepare(`SELECT storage_key, source_id FROM notes WHERE id = ? AND user_id = ?`)
      .bind(del[1], scope).first<{ storage_key: string | null; source_id: string | null }>();
    if (!row) return err('note not found', 404);
    if (row.storage_key) await env.BUCKET.delete(row.storage_key).catch(() => {});
    await env.DB.prepare(`DELETE FROM notes WHERE id = ? AND user_id = ?`).bind(del[1], scope).run();
    // Remember the intention, or the auto-generator recreates it within seconds.
    if (row.source_id) {
      await env.DB.prepare(
        `INSERT INTO note_optouts (user_id, source_id) VALUES (?, ?)
         ON CONFLICT(user_id, source_id) DO NOTHING`,
      ).bind(scope, row.source_id).run();
    }
    return json({ ok: true });
  }

  const one = p.match(/^\/([^/]+)$/);
  if (one && req.method === 'GET') {
    // Ownership is part of the lookup, not a check after it: a "not found" and a "not yours"
    // must be indistinguishable, or the endpoint enumerates other people's recordings.
    const note = scope
      ? await env.DB.prepare(`SELECT * FROM notes WHERE id = ? AND user_id = ?`).bind(one[1], scope).first<any>()
      : await env.DB.prepare(`SELECT * FROM notes WHERE id = ?`).bind(one[1]).first<any>();
    if (!note) return err('note not found', 404);
    const tr = await env.DB.prepare(`SELECT lang, text, segments FROM transcripts WHERE note_id = ?`)
      .bind(one[1]).first<any>();
    // Which summary to show: the one asked for, else the default, else whatever exists. A note
    // is never blank just because the requested template has not been generated yet.
    const wanted = url.searchParams.get('template');
    const all = await env.DB.prepare(
      `SELECT template, model, json, created_at FROM summaries WHERE note_id = ? ORDER BY created_at DESC`,
    ).bind(one[1]).all<any>();
    const rows = all.results ?? [];
    const sum = (wanted && rows.find((r) => r.template === wanted))
      || (!wanted && rows.find((r) => r.template === DEFAULT_TEMPLATE))
      || (wanted ? null : rows[0]);
    return json({
      ...note,
      // Every template, and whether this note already has one — so the picker can show what is
      // ready instantly versus what costs a (cheap) generation.
      templates: Object.entries(TEMPLATES).map(([key, t]) => ({
        key, label: t.label, ready: rows.some((r) => r.template === key),
      })),
      // The player follows this URL as-is; it carries its own one-hour credential.
      audio_url: `/api/notes/${note.id}/audio?t=${await signMedia(env.ADMIN_KEY, note.id)}`,
      flags: note.flags ? JSON.parse(note.flags) : [],
      transcript: tr ? { ...tr, segments: JSON.parse(tr.segments || '[]') } : null,
      summary: sum ? { ...sum, json: normaliseSummary(JSON.parse(sum.json || '{}')) } : null,
    });
  }

  return err(`no route for ${req.method} ${url.pathname}`, 404);
}

/**
 * Summaries written before templates had their own sections are stored as flat
 * `{bullets, actions, highlights}`. Convert on read rather than migrating the rows: the shape
 * is presentation, the rows are the expensive part, and a reader that understands one shape is
 * simpler than one that understands two.
 */
function normaliseSummary(j: any): any {
  if (!j || typeof j !== 'object') return j;
  if (Array.isArray(j.sections)) return j;
  const legacy: Array<[string, string]> = [
    ['bullets', 'Key points'], ['actions', 'Action items'], ['highlights', 'Highlights'],
  ];
  return {
    title: j.title ?? '',
    tldr: j.tldr ?? '',
    chapters: Array.isArray(j.chapters) ? j.chapters : [],
    sections: legacy
      .filter(([k]) => Array.isArray(j[k]) && j[k].length)
      // Legacy rows stored flat strings; the reader only understands the item shape.
      .map(([k, title]) => ({ key: k, title, items: j[k].map((x: any) => ({ text: String(x) })) })),
  };
}

/** Stream the WAV out of R2, honouring Range so the player can seek. */
async function streamAudio(env: Env, req: Request, noteId: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT storage_key, bytes FROM notes WHERE id = ?`)
    .bind(noteId).first<{ storage_key: string | null; bytes: number }>();
  if (!row?.storage_key) return err('note not found', 404);

  const range = req.headers.get('Range');
  const m = range?.match(/bytes=(\d+)-(\d*)/);
  if (m) {
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : row.bytes - 1, row.bytes - 1);
    // An unsatisfiable range must be refused, not clamped into a wrong body.
    if (!(start >= 0) || start > end) {
      return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${row.bytes}` } });
    }
    const length = end - start + 1;
    const obj = await env.BUCKET.get(row.storage_key, { range: { offset: start, length } });
    if (!obj) return err('audio not found', 404);
    return new Response(obj.body, {
      status: 206,
      headers: {
        ...cors,
        'Content-Type': 'audio/wav',
        'Content-Range': `bytes ${start}-${end}/${row.bytes}`,
        // ⚠️ Content-Length is REQUIRED here, not optional politeness. fetch() was perfectly
        // happy without it (206, 1024 bytes, 13 ms) but Chrome's MEDIA loader stalled: the
        // <audio> element sat at readyState 0 / networkState 2 forever, with no error event
        // and no failed request to point at. A player that never starts and never errors is
        // the hardest kind of bug to see — set the length.
        'Content-Length': String(length),
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const obj = await env.BUCKET.get(row.storage_key);
  if (!obj) return err('audio not found', 404);
  return new Response(obj.body, {
    headers: { ...cors, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(row.bytes) },
  });
}
