// SATE — process-device-session, Cloudflare Worker port.
//
// Bridges a hardware-recorded device session into the SAME pipeline a manual web upload
// uses: run the AI, compute error_counts + analysis, insert into `recordings` assigned to
// the SLP's existing patient.
//
// Invoked (a) fire-and-forget by device-api after a session's final chunk, (b) by a cron
// fallback. Idempotent via sate_device_sessions.processed.
//
// Auth: not a user JWT. The caller presents the service key or PROCESSOR_SECRET.
//
// The AI target is UNCHANGED from Supabase — still AI_PROCESS_URL, still the ngrok tunnel.

import { countErrors, calculateSpeechAnalysis } from './analysis';
import type { Env } from '../index';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BATCH_LIMIT = 5;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

interface SessionRow {
  id: string;
  user_id: string;
  device_serial: string;
  patient_id: string;
  session_number: number;
  sample_rate: number;
  bytes: number;
  storage_path: string;
  flags: string | null;
}

const COLS = `id, user_id, device_serial, patient_id, session_number, sample_rate, bytes, storage_path, flags`;

export async function handleProcessDeviceSession(req: Request, env: Env): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
  if (auth !== env.SERVICE_KEY && (!env.PROCESSOR_SECRET || auth !== env.PROCESSOR_SECRET)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  // Optional: one specific session (passed by device-api), else sweep.
  let onlyId: string | null = null;
  try {
    onlyId = (await req.json<{ session_id?: string }>())?.session_id ?? null;
  } catch {
    /* no body = sweep */
  }

  const stmt = onlyId
    ? env.DB.prepare(`SELECT ${COLS} FROM sate_device_sessions WHERE id = ? AND processed = 0`).bind(onlyId)
    : env.DB.prepare(
        `SELECT ${COLS} FROM sate_device_sessions WHERE processed = 0 ORDER BY created_at ASC LIMIT ${BATCH_LIMIT}`,
      );

  const res = await stmt.all<SessionRow>();
  const sessions = res.results ?? [];
  if (sessions.length === 0) return json({ processed: [], message: 'nothing to process' });

  const results: unknown[] = [];
  for (const s of sessions) {
    try {
      const rec = await processOne(env, s);
      results.push({ session: s.id, recording_id: rec, status: rec ? 'ok' : 'no_text' });
    } catch (e) {
      const msg = (e as Error).message || String(e);
      await env.DB.prepare(`UPDATE sate_device_sessions SET process_error = ? WHERE id = ?`).bind(msg, s.id).run();
      results.push({ session: s.id, status: 'error', error: msg });
    }
  }
  return json({ processed: results });
}

async function processOne(env: Env, s: SessionRow): Promise<string | null> {
  const fileName = `device_${s.device_serial}_s${s.session_number}.wav`;
  const key = `device-sessions/${s.storage_path}`;

  // 1. Resolve the SLP's EXISTING patient from the device patient_id.
  //    (device = SLP's device; the patient already exists — never fabricate.)
  const patientUuid = await resolvePatient(env, s.user_id, s.patient_id);

  // 2. Run the SAME AI the web app uses (multipart audio_file).
  //
  // ⚠️ The Deno original did `new Uint8Array(await blob.arrayBuffer())` and handed that to
  // FormData. A Worker has a hard 128 MB memory limit and a full-length take is ~118 MB, so
  // buffering the WAV would OOM on exactly the long sessions this exists to rescue. The
  // multipart body is therefore built as a stream: the file bytes flow R2 -> fetch without
  // ever being fully resident. Peak memory is one R2 chunk.
  const head = await env.BUCKET.head(key);
  if (!head) throw new Error(`download failed: object not found at ${s.storage_path}`);

  const transcript = await runAi(env, key, fileName);
  if (!transcript || !Array.isArray(transcript.segments)) throw new Error('AI returned no segments');

  // No usable speech (silence / noise): the AI returns a valid response with no words. Do
  // NOT create a recording/report. Mark the session no_text so the device tab shows
  // "No text in audio" + a delete option, and stop reprocessing.
  const hasText = transcript.segments.some(
    (seg: any) =>
      (Array.isArray(seg.words) && seg.words.some((w: any) => (w?.word || '').trim().length > 0)) ||
      (typeof seg.text === 'string' && seg.text.trim().length > 0),
  );
  if (!hasText) {
    await env.DB.prepare(
      `UPDATE sate_device_sessions
          SET processed = 1, processed_at = ?, recording_id = NULL, no_text = 1, process_error = NULL
        WHERE id = ?`,
    )
      .bind(new Date().toISOString(), s.id)
      .run();
    return null;
  }

  // 3. Same derived metrics as a manual upload.
  const errorCounts = countErrors(transcript.segments);
  const analysis = calculateSpeechAnalysis(transcript);

  // 4. Copy the audio into `recordings` so app playback works identically. Streamed for the
  //    same reason as above — never materialise the WAV.
  const recPath = `${s.user_id}/${Date.now()}_${fileName}`;
  const src = await env.BUCKET.get(key);
  if (!src) throw new Error(`download failed: object vanished at ${s.storage_path}`);
  await env.BUCKET.put(`recordings/${recPath}`, src.body, {
    httpMetadata: { contentType: 'audio/wav', cacheControl: '3600' },
  });

  // 5. Insert into `recordings` — identical shape to a manual save.
  const recId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO recordings
         (id, user_id, file_path, transcript, error_counts, analysis, file_name, file_size,
          duration, patient_id, recording_name, protocol, notes, needs_review, flags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, 0, ?)`,
    )
      .bind(
        recId,
        s.user_id,
        recPath,
        JSON.stringify(transcript),
        JSON.stringify(errorCounts),
        JSON.stringify(analysis),
        fileName,
        head.size,
        analysis.totalDuration || 0,
        patientUuid,
        // The exact name the device sent (its WAV file name), not a reformatted label — the
        // recording shows up named as the device made it.
        fileName,
        'Auto-imported from SATE hardware device',
        // Flag markers (ms offsets) the clinician hit on the device during the take.
        s.flags && s.flags !== 'null' ? s.flags : null,
      )
      .run();
  } catch (e) {
    // Don't leave an orphan object behind if the row could not be written.
    await env.BUCKET.delete(`recordings/${recPath}`).catch(() => {});
    throw new Error(`recordings insert: ${(e as Error).message}`);
  }

  // 6. Mark the device session done + link back (idempotent).
  await env.DB.prepare(
    `UPDATE sate_device_sessions
        SET processed = 1, processed_at = ?, recording_id = ?, process_error = NULL
      WHERE id = ?`,
  )
    .bind(new Date().toISOString(), recId, s.id)
    .run();

  return recId;
}

/**
 * POST the WAV to the AI as multipart/form-data, streaming the file straight out of R2.
 *
 * FormData would need the whole file as a Blob in memory, so the multipart envelope is
 * written by hand around the R2 body stream. Field order and names match the original
 * exactly — the processor reads `audio_file`, `device` and `pause_threshold`.
 */
async function runAi(env: Env, key: string, fileName: string): Promise<any> {
  const boundary = `----sate${crypto.randomUUID().replace(/-/g, '')}`;
  const enc = new TextEncoder();

  const field = (name: string, value: string) =>
    enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);

  const fileHeader = enc.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="audio_file"; filename="${fileName}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);

  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error(`download failed: no object at ${key}`);

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(field('device', 'cuda'));
      controller.enqueue(field('pause_threshold', '0.25'));
      controller.enqueue(fileHeader);
      const reader = obj.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      controller.enqueue(tail);
      controller.close();
    },
  });

  const aiRes = await fetch(env.AI_PROCESS_URL, {
    method: 'POST',
    body,
    headers: { Accept: 'application/json', 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  });
  if (!aiRes.ok) throw new Error(`AI ${aiRes.status}: ${(await aiRes.text()).slice(0, 200)}`);
  return aiRes.json();
}

/**
 * Resolve a device patient_id (text, e.g. "PT-2001") to an existing clinical patients.id
 * owned by this SLP. Two paths, NO creation:
 *   1. the device roster row's explicit clinical_patient_id link
 *   2. a patients row tagged with device_patient_id for this slp
 * Returns null (unassigned) if nothing matches — a device recording is Standalone by
 * default and the SLP assigns it later on the web report. Never fabricate a patient.
 */
async function resolvePatient(env: Env, userId: string, devicePatientId: string): Promise<string | null> {
  if (!devicePatientId) return null;

  const roster = await env.DB.prepare(
    `SELECT clinical_patient_id FROM sate_device_patients WHERE user_id = ? AND patient_id = ?`,
  )
    .bind(userId, devicePatientId)
    .first<{ clinical_patient_id: string | null }>();
  if (roster?.clinical_patient_id) return roster.clinical_patient_id;

  const tagged = await env.DB.prepare(`SELECT id FROM patients WHERE slp_id = ? AND device_patient_id = ?`)
    .bind(userId, devicePatientId)
    .first<{ id: string }>();
  return tagged?.id ?? null;
}
