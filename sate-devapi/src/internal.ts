// Container-facing routes. Bearer INTERNAL_SECRET, never reachable by a developer.
//
// The container is deliberately stateless: it claims a job here, streams the audio here,
// posts the result back here. All D1 and R2 access lives in this file, so there is exactly
// one place where a job's state machine can be advanced.
//
// State machine:  queued -> processing -> done | error
// with requeue (transient failure, under MAX_ATTEMPTS) sending it back to queued.

import { Env, json, apiError, now, uid, timingSafeEqual, parseJson } from './util';
import { calculateReport } from './analysis';

function authorized(req: Request, env: Env): boolean {
  const presented = (req.headers.get('Authorization') || '').replace(/^Bearer /i, '');
  return !!env.INTERNAL_SECRET && timingSafeEqual(presented, env.INTERNAL_SECRET);
}

export async function handleInternal(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (!authorized(req, env)) return apiError('unauthorized', 'Bad internal secret.', 401);

  // ---- POST /internal/claim ------------------------------------------------
  // Atomic claim of the next queued job. A single UPDATE ... RETURNING is one D1
  // statement and therefore atomic, so two container incarnations can never claim the
  // same row — the second one's subquery simply selects a different id (or none).
  if (path === '/internal/claim' && req.method === 'POST') {
    const body = await req.json<{ worker_id?: string }>().catch(() => ({} as { worker_id?: string }));
    const workerId = body.worker_id || 'unknown';

    // Reclaim anything a dead incarnation abandoned before claiming new work.
    await requeueStale(env);

    const claimed = await env.DB.prepare(
      `UPDATE jobs
          SET status = 'processing', started_at = ?, heartbeat_at = ?, worker_id = ?,
              attempts = attempts + 1
        WHERE id = (
          SELECT id FROM jobs WHERE status = 'queued'
           ORDER BY priority DESC, created_at ASC LIMIT 1
        )
        RETURNING id, developer_id, file_name, content_type, bytes, language, pause_threshold, attempts`,
    ).bind(now(), now(), workerId).first<any>();

    if (!claimed) return json({ job: null });
    return json({
      job: {
        id: claimed.id,
        file_name: claimed.file_name,
        content_type: claimed.content_type,
        bytes: claimed.bytes,
        language: claimed.language,
        pause_threshold: claimed.pause_threshold,
        attempts: claimed.attempts,
        audio_url: `https://${env.API_HOST}/internal/jobs/${claimed.id}/audio`,
      },
    });
  }

  const jobMatch = path.match(/^\/internal\/jobs\/([A-Za-z0-9-]+)\/(audio|complete|fail|heartbeat)$/);
  if (!jobMatch) return apiError('not_found', 'No such internal route.', 404);
  const jobId = jobMatch[1];
  const action = jobMatch[2];

  // ---- GET /internal/jobs/:id/audio ---------------------------------------
  if (action === 'audio' && req.method === 'GET') {
    const row = await env.DB.prepare(`SELECT audio_key, content_type FROM jobs WHERE id = ?`)
      .bind(jobId).first<any>();
    if (!row?.audio_key) return apiError('not_found', 'Job has no audio.', 404);
    const obj = await env.AUDIO.get(row.audio_key);
    if (!obj) return apiError('not_found', 'Audio object missing.', 404);
    return new Response(obj.body, {
      headers: { 'Content-Type': row.content_type || 'audio/wav', 'Content-Length': String(obj.size) },
    });
  }

  // ---- POST /internal/jobs/:id/heartbeat ----------------------------------
  // Lets a long job outlive STUCK_MINUTES without the watchdog stealing it.
  if (action === 'heartbeat' && req.method === 'POST') {
    await env.DB.prepare(`UPDATE jobs SET heartbeat_at = ? WHERE id = ? AND status = 'processing'`)
      .bind(now(), jobId).run();
    return json({ ok: true });
  }

  // ---- POST /internal/jobs/:id/complete -----------------------------------
  if (action === 'complete' && req.method === 'POST') {
    const body = await req.json<{ transcript?: any; no_text?: boolean; duration_sec?: number }>();
    const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<any>();
    if (!row) return apiError('not_found', 'No such job.', 404);

    const noText = !!body.no_text || !body.transcript;
    // The report is computed here, in the Worker, from the same code the clinical product
    // uses — the container never does analysis, only transcription.
    const report = noText ? null : calculateReport(body.transcript);
    const duration = body.duration_sec ?? row.duration_sec ?? report?.totalDuration ?? null;

    await env.DB.prepare(
      `UPDATE jobs SET status = 'done', transcript = ?, report = ?, no_text = ?,
                       duration_sec = ?, finished_at = ?, error = NULL, error_kind = NULL
        WHERE id = ?`,
    ).bind(
      noText ? null : JSON.stringify(body.transcript),
      report ? JSON.stringify(report) : null,
      noText ? 1 : 0, duration, now(), jobId,
    ).run();

    // Meter the true audio length now that it is known. The submit-time event recorded the
    // WAV-header duration (0 for formats we could not parse), so this only tops up the
    // difference — it must not double-count.
    // Method 'SYSTEM' marks a bookkeeping row rather than an inbound request, so the rate
    // limiter skips it — a developer must not be throttled by our own metering.
    const alreadyMetered = row.duration_sec ?? 0;
    const delta = (duration ?? 0) - alreadyMetered;
    if (delta > 0.01) {
      await env.DB.prepare(
        `INSERT INTO usage_events (id, developer_id, api_key_id, job_id, endpoint, method, status_code, audio_seconds)
         VALUES (?, ?, ?, ?, '/v1/jobs', 'SYSTEM', 200, ?)`,
      ).bind(uid(), row.developer_id, row.api_key_id, jobId, delta).run();
    }

    ctx.waitUntil(purgeAudio(env, row));
    ctx.waitUntil(fireWebhook(env, jobId, row, 'done'));
    return json({ ok: true, job_id: jobId });
  }

  // ---- POST /internal/jobs/:id/fail ---------------------------------------
  if (action === 'fail' && req.method === 'POST') {
    const body = await req.json<{ error?: string; kind?: string }>();
    const kind = body.kind === 'transient' ? 'transient' : 'permanent';
    const message = (body.error || 'processing failed').slice(0, 500);
    const maxAttempts = Number(env.MAX_ATTEMPTS || '3');

    const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first<any>();
    if (!row) return apiError('not_found', 'No such job.', 404);

    // A transient failure with budget left goes back on the queue; anything else settles.
    if (kind === 'transient' && row.attempts < maxAttempts) {
      await env.DB.prepare(
        `UPDATE jobs SET status = 'queued', worker_id = NULL, started_at = NULL, error = ?, error_kind = 'transient'
          WHERE id = ?`,
      ).bind(message, jobId).run();
      return json({ ok: true, requeued: true, attempts: row.attempts });
    }

    await env.DB.prepare(
      `UPDATE jobs SET status = 'error', error = ?, error_kind = ?, finished_at = ? WHERE id = ?`,
    ).bind(message, kind, now(), jobId).run();

    ctx.waitUntil(purgeAudio(env, row));
    ctx.waitUntil(fireWebhook(env, jobId, row, 'error'));
    return json({ ok: true, requeued: false });
  }

  return apiError('method_not_allowed', 'Method not allowed.', 405);
}

/**
 * Reclaim jobs a crashed or recycled container left in 'processing'.
 *
 * A live job heartbeats, so only genuinely abandoned rows go stale. Past MAX_ATTEMPTS they
 * settle as errors instead of looping forever.
 */
export async function requeueStale(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - Number(env.STUCK_MINUTES || '45') * 60_000).toISOString();
  const maxAttempts = Number(env.MAX_ATTEMPTS || '3');
  await env.DB.prepare(
    `UPDATE jobs SET status = 'queued', worker_id = NULL, started_at = NULL
      WHERE status = 'processing'
        AND COALESCE(heartbeat_at, started_at, created_at) < ?
        AND attempts < ?`,
  ).bind(cutoff, maxAttempts).run();
  await env.DB.prepare(
    `UPDATE jobs SET status = 'error', error = 'processing timed out', error_kind = 'timeout', finished_at = ?
      WHERE status = 'processing'
        AND COALESCE(heartbeat_at, started_at, created_at) < ?
        AND attempts >= ?`,
  ).bind(now(), cutoff, maxAttempts).run();
}

/**
 * Drop the uploaded audio the moment it is no longer needed.
 *
 * Default retention is 0 hours: a developer's audio exists only while the job is in flight.
 * The less of it we hold, the smaller the liability — and nothing in the API ever reads it
 * back.
 */
async function purgeAudio(env: Env, row: any): Promise<void> {
  if (Number(env.AUDIO_RETENTION_HOURS || '0') > 0) return;
  if (!row.audio_key) return;
  try {
    await env.AUDIO.delete(row.audio_key);
    await env.DB.prepare(`UPDATE jobs SET audio_purged = 1, audio_key = NULL WHERE id = ?`).bind(row.id).run();
  } catch (e) {
    console.error('audio purge failed', (e as Error).message);
  }
}

/**
 * Notify the developer's webhook that a job settled.
 *
 * Payload is intentionally minimal — an id and a status. The result itself is fetched over
 * the authenticated API, so a webhook URL that leaks or is guessed reveals nothing.
 */
async function fireWebhook(env: Env, jobId: string, row: any, status: string): Promise<void> {
  if (!row.webhook_url) return;
  try {
    const res = await fetch(row.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'sate-devapi/1' },
      body: JSON.stringify({
        event: `job.${status}`,
        job_id: jobId,
        status,
        view: row.view,
        metadata: parseJson(row.metadata, {}),
        result_url: `https://${env.API_HOST}/v1/jobs/${jobId}`,
        occurred_at: now(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    await env.DB.prepare(`UPDATE jobs SET webhook_status = ? WHERE id = ?`)
      .bind(res.ok ? 'sent' : `failed: HTTP ${res.status}`, jobId).run();
  } catch (e) {
    await env.DB.prepare(`UPDATE jobs SET webhook_status = ? WHERE id = ?`)
      .bind(`failed: ${(e as Error).message}`.slice(0, 120), jobId).run()
      .catch(() => undefined);
  }
}
