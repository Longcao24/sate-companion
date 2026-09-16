// Ingest from the clinical device-api.
//
// A recorder speaks to exactly ONE server, so "this recorder is a notes recorder" cannot be a
// property of the device — it has to be a routing decision on the server that receives the
// upload. device-api therefore keeps doing everything it already did (assemble the chunks,
// store the WAV, insert the session row so the firmware's /sessions/verify and SD reclaim keep
// working byte-for-byte) and only changes WHICH processor it wakes at the very end.
//
// This is that other processor. It is handed a short-lived signed URL rather than a service
// key: this Worker must never hold a credential that can read the clinical bucket at large.

import type { Env } from './index';
import { json, err, newId, parseFlags, wavSeconds, objectExists } from './util';
import { startPipeline } from './pipeline';

export interface IngestBody {
  session_id: string;        // the sate_device_sessions id, for idempotency across retries
  user_id?: string;          // Supabase auth uuid — machine route only; ignored for a user
  device_serial: string;
  folder_id?: string;
  session_number: number;
  sample_rate?: number;
  bytes: number;
  flags?: string | number[];
  /** Machine route only: a signed URL to the stored WAV. Never accepted from a browser. */
  audio_url?: string;
  /**
   * The `recordings` row the clinical pipeline already produced for this session, if it has
   * one. When present we reuse ITS transcript instead of paying for ASR again — see
   * fetchClinicalTranscript. Optional: a session that is still processing, failed, or came
   * back `no_text` simply has none, and the note falls back to transcribing the audio.
   */
  recording_id?: string;
}

/** A segment as the notes lane models it (mirrors `Seg` in pipeline.ts). */
interface NoteSeg { start: number; end: number; text: string; speaker?: number }

/**
 * Reuse the transcript SATE has ALREADY produced for this recording.
 *
 * The clinical pipeline transcribes every device session on a self-hosted GPU and stores the
 * result on `recordings.transcript` as `{ segments: [{ start, end, text, speaker? }] }` — the
 * same shape this lane builds from Workers AI. Transcribing it a second time is the single
 * most expensive thing the notes lane does (ASR is ~96% of its bill) and it buys nothing.
 *
 * It also buys something better than money: ONE transcript. A meeting note and the clinical
 * report are then quoting the same words. Two independent ASR runs over one recording
 * disagree in small ways, and "which of these two transcripts is the real one?" is not a
 * question anyone should have to ask about a clinical recording.
 *
 * Read with the CALLER'S own token through PostgREST, so row-level security decides what they
 * may see — the same trust model this Worker already uses to fetch the audio. A failure here
 * is never fatal: return null and the caller transcribes the audio as before.
 */
export async function fetchClinicalTranscript(
  env: Env, recordingId: string, userToken: string,
): Promise<{ text: string; segments: NoteSeg[] } | null> {
  try {
    const url =
      `${env.SUPABASE_URL}/rest/v1/recordings?id=eq.${encodeURIComponent(recordingId)}` +
      `&select=transcript&limit=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${userToken}`, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!res.ok) return null;
    const rows = await res.json<Array<{ transcript: { segments?: any[] } | null }>>();
    const raw = rows?.[0]?.transcript?.segments;
    if (!Array.isArray(raw) || raw.length === 0) return null;

    // SATE labels speakers with a STRING ("SPEAKER_00", "Child", …); this lane numbers them.
    // Map by first appearance so the numbering is stable and dense, and so promptTranscript()
    // renders "Speaker 1", "Speaker 2" rather than leaking the upstream label.
    const order: string[] = [];
    const segments: NoteSeg[] = [];
    for (const r of raw) {
      const text = typeof r?.text === 'string' ? r.text : '';
      if (!text.trim()) continue;
      const seg: NoteSeg = {
        start: Number(r.start) || 0,
        end: Number(r.end) || 0,
        text,
      };
      if (r.speaker !== undefined && r.speaker !== null) {
        const key = String(r.speaker);
        let idx = order.indexOf(key);
        if (idx < 0) { order.push(key); idx = order.length - 1; }
        seg.speaker = idx;
      }
      segments.push(seg);
    }
    if (!segments.length) return null;
    // `text` stays clean prose — it is what the note page renders. The time- and
    // speaker-stamped form is built for the model only, in promptTranscript().
    const text = segments.map((s) => s.text.trim()).filter(Boolean).join(' ');
    if (!text.trim()) return null;
    return { text, segments };
  } catch {
    // Network blip, shape change upstream, anything: fall back to transcribing.
    return null;
  }
}

export async function handleIngest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Machine-to-machine. Unlike the user path there is no session to verify, so this is the one
  // place a shared secret is unavoidable; keep it to this route.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
  if (!env.INGEST_SECRET || token !== env.INGEST_SECRET) return err('unauthorized', 401);
  const b = await req.json<IngestBody>().catch(() => null);
  if (!b?.user_id) return err('user_id is required');
  return ingest(env, ctx, b.user_id, b);
}

/**
 * Take one already-stored recording and make a note of it.
 *
 * `userId` is ALWAYS supplied by the caller's authenticated context, never read from the body:
 * on the user-facing route the body is written by a browser, and honouring a `user_id` from
 * there would let any enabled account file notes into someone else's account.
 */
export async function ingest(
  env: Env, ctx: ExecutionContext, userId: string, b: IngestBody, userToken?: string,
): Promise<Response> {
  if (!b?.session_id) return err('session_id is required');

  // Idempotent on the upstream session id, and checked FIRST — before a byte is moved. A
  // second "Generate meeting note" click, or a retry, must not re-copy a 118 MB take or start
  // a second AI run; it must hand back the note that already exists.
  const existing = await env.DB.prepare(`SELECT id, storage_key FROM notes WHERE source_id = ? AND user_id = ?`)
    .bind(b.session_id, userId).first<{ id: string; storage_key: string | null }>();
  if (existing) {
    // A row is not proof the audio is there; a ghost row is dropped so this call can replace it.
    const real = existing.storage_key ? await objectExists(env, existing.storage_key) : false;
    if (real) return json({ id: existing.id, idempotent: true });
    await env.DB.prepare(`DELETE FROM notes WHERE id = ?`).bind(existing.id).run();
  }

  const src = await fetchSource(env, b, userToken);
  if ('error' in src) return src.error;
  const folderId = (b.folder_id || 'notes').replace(/[^A-Za-z0-9_-]/g, '') || 'notes';
  const noteId = newId('n');
  const key = `audio/${userId}/${b.device_serial}/${noteId}.wav`;

  // ⚠️ Stream it. A full-length take is ~118 MB and a Worker dies at 128 MB, so the WAV is
  // piped straight into R2 rather than buffered. R2 needs a known length, and the length comes
  // from the RESPONSE, not from the request body: on the user route the body is written by a
  // browser, and a wrong length there would truncate or stall the copy.
  const bytes = src.bytes;
  const fls = new FixedLengthStream(bytes);
  let pumpFailed: string | null = null;
  const pump = src.body.pipeTo(fls.writable).catch((e: Error) => { pumpFailed = e.message; });

  try {
    await env.BUCKET.put(key, fls.readable, { httpMetadata: { contentType: 'audio/wav' } });
    await pump;
  } catch (e) {
    await env.BUCKET.delete(key).catch(() => {});
    return err(`copy failed: ${pumpFailed ?? (e as Error).message}`, 502);
  }
  if (pumpFailed) {
    await env.BUCKET.delete(key).catch(() => {});
    return err(`copy failed: ${pumpFailed}`, 502);
  }
  if (!(await objectExists(env, key))) return err('copy reported success but the object is not there', 500);

  const sampleRate = b.sample_rate || 16000;
  const seconds = wavSeconds(bytes, sampleRate);
  // Clamp to the recording: a mark past the end would draw a tick off the end of the scrubber.
  // The offsets arrive from a browser on the user route, so they are checked rather than
  // trusted — even though forging a mark on your own note buys nothing.
  const flags = (Array.isArray(b.flags) ? b.flags : parseFlags(b.flags ?? null))
    .filter((n) => Number.isFinite(n) && n >= 0 && n / 1000 <= seconds);

  try {
    await env.DB.prepare(
      `INSERT INTO notes (id, user_id, device_serial, folder_id, session_number, sample_rate,
                          bytes, duration_s, storage_key, flags, status, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).bind(
      noteId, userId, b.device_serial, folderId, b.session_number, sampleRate,
      bytes, seconds, key, flags.length ? JSON.stringify(flags) : null,
      b.session_id,
    ).run();
  } catch (e) {
    // The unique index on source_id is the backstop for two clicks racing past the probe
    // above. Whoever lost still has an object in R2 — bin it rather than leave an orphan.
    await env.BUCKET.delete(key).catch(() => {});
    const won = await env.DB.prepare(`SELECT id FROM notes WHERE source_id = ? AND user_id = ?`)
      .bind(b.session_id, userId).first<{ id: string }>();
    if (won) return json({ id: won.id, idempotent: true });
    throw e;
  }

  // Seed the transcript from the clinical pipeline if it already has one. The Workflow sees
  // a transcript row and skips transcription entirely — no chunking, no per-chunk AI call,
  // and the note quotes the same words as the SATE report.
  //
  // Best-effort and deliberately AFTER the note row exists: if this fails for any reason the
  // note is already valid and the Workflow just transcribes the audio as before. Reusing must
  // never be able to cost someone their note.
  if (b.recording_id && userToken) {
    const clinical = await fetchClinicalTranscript(env, b.recording_id, userToken);
    if (clinical) {
      try {
        await env.DB.prepare(
          `INSERT INTO transcripts (note_id, lang, text, segments) VALUES (?, ?, ?, ?)
           ON CONFLICT(note_id) DO UPDATE SET lang = excluded.lang, text = excluded.text,
                                              segments = excluded.segments`,
        ).bind(noteId, env.ASR_LANGUAGE || 'en', clinical.text, JSON.stringify(clinical.segments)).run();
        // chunks_total = 0 so the progress bar shows no chunk counter: there are no chunks to
        // count. A bar that reports "part 1 of 1" for work that never happened is a lie about
        // what the pipeline is doing.
        await env.DB.prepare(
          `UPDATE notes SET chunks_total = 0, chunks_done = 0 WHERE id = ?`,
        ).bind(noteId).run();
      } catch {
        /* fall through: the Workflow will transcribe the audio */
      }
    }
  }

  startPipeline(env, ctx, noteId);
  return json({ id: noteId });
}


/**
 * Get the audio for a session, and its exact length.
 *
 * The user route deliberately takes NO url from the client. Instead this asks the clinical
 * device-api for the session's audio using the CALLER'S OWN access token, so ownership is
 * enforced by the system that owns the recording — a user cannot reach a session that is not
 * theirs, and this Worker never holds a credential that could. The machine route still accepts
 * a pre-signed URL, because there is no user token in that direction.
 */
async function fetchSource(
  env: Env, b: IngestBody, userToken?: string,
): Promise<{ body: ReadableStream<Uint8Array>; bytes: number } | { error: Response }> {
  let res: Response;
  if (userToken) {
    res = await fetch(`${env.DEVICE_API_URL}/api/sessions/${encodeURIComponent(b.session_id)}/audio`, {
      headers: { Authorization: `Bearer ${userToken}`, apikey: env.SUPABASE_ANON_KEY },
      // device-api 302s to a signed storage URL; a Worker follows that itself.
      redirect: 'follow',
    });
  } else {
    if (!b.audio_url) return { error: err('audio_url is required on the machine route') };
    const allowed = `${env.SUPABASE_URL}/storage/v1/object/sign/`;
    if (!b.audio_url.startsWith(allowed)) {
      return { error: err("audio_url must be a signed URL from this project's storage", 400) };
    }
    res = await fetch(b.audio_url);
  }

  if (!res.ok || !res.body) {
    return { error: err(`could not fetch the source audio (${res.status})`, res.status === 404 ? 404 : 502) };
  }
  const len = Number(res.headers.get('content-length') || 0);
  if (!len) return { error: err('the source audio has no content-length; cannot copy it safely', 502) };
  return { body: res.body, bytes: len };
}
