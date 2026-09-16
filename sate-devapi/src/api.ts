// The public developer API — everything under /v1 on api-sate.long-cao.dev.
//
// Surface is deliberately small: submit audio, get a transcript and a report. There are no
// device, roster, or account-management routes here on purpose — an API key is a key to the
// AI, nothing more.
//
// ⚠️ Submission is ASYNCHRONOUS and cannot be made synchronous. The transcription runs on a
// GPU box and a long file takes many minutes; a Worker is killed at the ~100 s origin
// timeout, mid-fetch, BEFORE any catch block runs — so a "quick" synchronous version would
// silently strand jobs with no error recorded. POST returns 202 with a job id; poll or use a
// webhook. The clinical pipeline learned this the expensive way; do not relitigate it.

import {
  Env, json, apiError, uid, now, iso, parseJson, wavSeconds, quotaWindowStart, clampInt, CORS,
} from './util';
import { authenticateKey, touchKey, KeyIdentity, VIEW_SCOPE } from './auth';
import { projectResult, View } from './views';
import { wakeProcessor } from './container';

const VIEWS: View[] = ['full', 'transcript', 'report'];

// The three text-analysis routes and their path on the upstream service. Text in, annotations
// out — no audio, so these run synchronously (see proxyText).
const TEXT_ROUTES: Record<string, string> = {
  '/v1/cunit': '/cunit',
  '/v1/maze': '/maze',
  '/v1/morpheme': '/morpheme',
};
const MAX_TEXT_BYTES = 1_000_000;

/**
 * Forward a text-analysis request to the upstream service and pass its JSON straight back.
 *
 * Validation (empty / oversize body) runs BEFORE the upstream lookup so a bad request is a
 * clean 400 regardless of whether the service is configured or reachable. The upstream is an
 * ngrok tunnel; a network failure surfaces as 502, never a hang.
 */
async function proxyText(env: Env, req: Request, upstreamPath: string): Promise<Response> {
  const body = await req.arrayBuffer();
  if (body.byteLength === 0) {
    return apiError('empty_body', 'Send the text to analyse in the request body.', 400);
  }
  if (body.byteLength > MAX_TEXT_BYTES) {
    return apiError('text_too_large', 'Text body exceeds the 1 MB limit.', 413, {
      max_bytes: MAX_TEXT_BYTES, your_bytes: body.byteLength,
    });
  }
  if (!env.SATE_TEXT_API_URL) {
    return apiError('text_unavailable', 'The text-analysis service is not configured.', 503);
  }

  const upstream = env.SATE_TEXT_API_URL.replace(/\/+$/, '') + upstreamPath;
  const contentType = req.headers.get('Content-Type') || 'text/plain';
  let res: Response;
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'ngrok-skip-browser-warning': '1' },
      body,
    });
  } catch {
    return apiError('text_upstream_error', 'The text-analysis service could not be reached.', 502);
  }

  const payload = await res.text();
  if (!res.ok) {
    return apiError('text_upstream_error', `The text-analysis service returned ${res.status}.`, 502, {
      upstream_status: res.status,
    });
  }
  // Pass the upstream JSON through untouched.
  return new Response(payload, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------------------------------------------------------------------------
// Metering: every /v1 call lands in usage_events. That single table is both the
// developer-facing usage monitor and the rate limiter's counter.
// ---------------------------------------------------------------------------
async function meter(
  env: Env,
  id: KeyIdentity | null,
  req: Request,
  endpoint: string,
  status: number,
  extra: { jobId?: string; view?: string; audioSeconds?: number; ms?: number } = {},
) {
  if (!id) return;
  try {
    await env.DB.prepare(
      `INSERT INTO usage_events (id, developer_id, api_key_id, job_id, endpoint, method, view, status_code, audio_seconds, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uid(), id.developerId, id.keyId, extra.jobId ?? null, endpoint, req.method,
        extra.view ?? null, status, extra.audioSeconds ?? 0, extra.ms ?? 0,
      )
      .run();
  } catch (e) {
    console.error('meter failed', (e as Error).message);
  }
}

/**
 * Fixed-window-ish limiter: count this key's calls in the trailing 60 s.
 *
 * Counting real events rather than keeping a separate counter means the limit and the usage
 * page can never disagree, and there is no state to lose. At this traffic level an indexed
 * range scan is cheaper than a Durable Object round trip.
 */
async function rateLimited(env: Env, id: KeyIdentity): Promise<{ limited: boolean; used: number; retryAfter: number }> {
  const since = new Date(Date.now() - 60_000).toISOString();
  // Only real inbound requests count. The pipeline also writes SYSTEM rows to meter audio
  // the caller could not have known the length of at submit time; charging those against
  // the rate limit would throttle a developer for our own bookkeeping.
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM usage_events
      WHERE api_key_id = ? AND created_at > ? AND method != 'SYSTEM'`,
  ).bind(id.keyId, since).first<{ n: number }>();
  const used = row?.n ?? 0;
  return { limited: used >= id.ratePerMin, used, retryAfter: 60 };
}

/**
 * Audio seconds this developer has submitted inside their current quota window.
 *
 * The window is whatever the admin configured — this calendar month, or everything since
 * the last reset for a lifetime cap. Summing usage_events rather than keeping a running
 * counter means an admin "reset usage" only has to move a timestamp: no numbers to
 * recompute, and no history destroyed.
 */
async function quotaUsedSeconds(env: Env, id: KeyIdentity): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(audio_seconds), 0) AS s FROM usage_events
      WHERE developer_id = ? AND created_at >= ?`,
  ).bind(id.developerId, quotaWindowStart(id.quotaPeriod, id.quotaResetAt)).first<{ s: number }>();
  return row?.s ?? 0;
}

/** When the quota figure next returns to zero on its own. A lifetime cap never does. */
function quotaResetsAt(id: KeyIdentity): string | null {
  if (id.quotaPeriod === 'total') return null;
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

function quotaBlock(id: KeyIdentity, usedSec: number) {
  return {
    period: id.quotaPeriod,
    minutes_limit: id.quotaMinutes || null,
    minutes_used: Math.round((usedSec / 60) * 100) / 100,
    minutes_remaining: id.quotaMinutes ? Math.max(0, Math.round((id.quotaMinutes - usedSec / 60) * 100) / 100) : null,
    unlimited: id.quotaMinutes === 0,
    resets_at: quotaResetsAt(id),
  };
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
function jobEnvelope(row: any) {
  return {
    id: row.id,
    object: 'job',
    status: row.status,
    view: row.view,
    file_name: row.file_name,
    bytes: row.bytes,
    duration_sec: row.duration_sec,
    metadata: parseJson(row.metadata, {}),
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    expires_at: row.expires_at,
    attempts: row.attempts,
    error: row.error ? { code: row.error_kind || 'processing_failed', message: row.error } : null,
  };
}

function finishedBody(row: any, id: KeyIdentity, view: View) {
  const { result, omitted } = projectResult({
    view,
    scopes: id.scopes,
    transcript: parseJson<any>(row.transcript, null),
    report: parseJson<any>(row.report, null),
    noText: !!row.no_text,
  });
  const body: Record<string, unknown> = { ...jobEnvelope(row), ...result };
  if (omitted.length) {
    body.omitted = omitted;
    body.omitted_reason = 'Your API key lacks the scope for these sections. Ask an administrator to widen it.';
  }
  return body;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export async function handleApi(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const started = Date.now();
  const url = new URL(req.url);

  const auth = await authenticateKey(env, req);
  if (!auth.ok) return apiError(auth.code, auth.message, auth.status);
  const id = auth.identity;
  ctx.waitUntil(touchKey(env, id.keyId));

  if (id.scopes.length === 0) {
    return apiError('no_scopes', 'This key has no scopes. Ask an administrator to grant at least one.', 403);
  }

  const rl = await rateLimited(env, id);
  if (rl.limited) {
    ctx.waitUntil(meter(env, id, req, path, 429));
    return apiError('rate_limited', `Rate limit of ${id.ratePerMin} requests/minute exceeded.`, 429, {
      retry_after_seconds: rl.retryAfter,
    });
  }

  const respond = async (res: Response, extra: Parameters<typeof meter>[5] = {}) => {
    ctx.waitUntil(meter(env, id, req, path, res.status, { ...extra, ms: Date.now() - started }));
    return res;
  };

  // ---- GET /v1/me — what this key can do -----------------------------------
  if (path === '/v1/me' && req.method === 'GET') {
    const usedSec = await quotaUsedSeconds(env, id);
    return respond(json({
      object: 'key',
      key_id: id.keyId,
      scopes: id.scopes,
      views_available: VIEWS.filter((v) => viewSatisfiable(v, id.scopes)),
      rate_limit_per_minute: id.ratePerMin,
      quota: quotaBlock(id, usedSec),
    }));
  }

  // ---- POST /v1/jobs — submit audio ----------------------------------------
  if (path === '/v1/jobs' && req.method === 'POST') {
    return respondSubmit();
  }

  // ---- GET /v1/jobs — list -------------------------------------------------
  if (path === '/v1/jobs' && req.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    const status = url.searchParams.get('status');
    const rows = status
      ? await env.DB.prepare(
          `SELECT * FROM jobs WHERE developer_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?`,
        ).bind(id.developerId, status, limit).all()
      : await env.DB.prepare(
          `SELECT * FROM jobs WHERE developer_id = ? ORDER BY created_at DESC LIMIT ?`,
        ).bind(id.developerId, limit).all();
    return respond(json({ object: 'list', data: (rows.results || []).map(jobEnvelope) }));
  }

  // ---- /v1/jobs/:id[/transcript|/annotations|/report] ----------------------
  const jobMatch = path.match(/^\/v1\/jobs\/([A-Za-z0-9-]+)(\/(transcript|annotations|report))?$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    const section = jobMatch[3] as 'transcript' | 'annotations' | 'report' | undefined;

    const row = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ? AND developer_id = ?`)
      .bind(jobId, id.developerId).first<any>();
    if (!row) return respond(apiError('not_found', 'No such job.', 404));

    if (req.method === 'DELETE') {
      if (row.audio_key) ctx.waitUntil(env.AUDIO.delete(row.audio_key).catch(() => undefined));
      await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return respond(json({ id: jobId, deleted: true }), { jobId });
    }

    if (req.method !== 'GET') return respond(apiError('method_not_allowed', 'Method not allowed.', 405));

    if (row.status !== 'done') {
      // 200, not 4xx: "not finished yet" is the expected state while polling, not an error.
      return respond(json(jobEnvelope(row)), { jobId });
    }

    if (section) {
      const needed = VIEW_SCOPE[section];
      if (!id.scopes.includes(needed)) {
        return respond(apiError('insufficient_scope', `This endpoint requires the '${needed}' scope.`, 403, {
          required_scope: needed, your_scopes: id.scopes,
        }), { jobId });
      }
      const view: View = section === 'annotations' ? 'full' : (section as View);
      const { result } = projectResult({
        view,
        scopes: [needed],
        transcript: parseJson<any>(row.transcript, null),
        report: parseJson<any>(row.report, null),
        noText: !!row.no_text,
      });
      return respond(json({ job_id: jobId, ...result }), { jobId, view: section });
    }

    const view = pickView(url.searchParams.get('view'), row.view, id.scopes);
    return respond(json(finishedBody(row, id, view)), { jobId, view });
  }

  // ---- GET /v1/usage -------------------------------------------------------
  if (path === '/v1/usage' && req.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 1, 90, 30);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const daily = await env.DB.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              COUNT(*) AS requests,
              SUM(audio_seconds) AS audio_seconds,
              SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS errors
         FROM usage_events
        WHERE developer_id = ? AND created_at >= ?
        GROUP BY day ORDER BY day`,
    ).bind(id.developerId, since).all();
    const usedSec = await quotaUsedSeconds(env, id);
    return respond(json({
      object: 'usage',
      window_days: days,
      quota: quotaBlock(id, usedSec),
      daily: daily.results || [],
    }));
  }

  // ---- Text-analysis endpoints (synchronous proxy) -------------------------
  // Unlike audio transcription (async, GPU, minutes long), these are fast text ops on a CPU
  // service, so they answer inline. They carry no audio, so they never touch the audio quota;
  // they are metered and rate-limited like every other call, and gated by the text:read scope.
  const upstreamPath = TEXT_ROUTES[path];
  if (upstreamPath !== undefined) {
    if (req.method !== 'POST') {
      return respond(apiError('method_not_allowed', `Use POST for ${path}.`, 405));
    }
    if (!id.scopes.includes('text:read')) {
      return respond(apiError('insufficient_scope', `This endpoint requires the 'text:read' scope.`, 403, {
        required_scope: 'text:read', your_scopes: id.scopes,
      }));
    }
    return respond(await proxyText(env, req, upstreamPath));
  }

  return respond(apiError('not_found', `No route for ${req.method} ${path}. See https://${env.PORTAL_HOST}/docs`, 404));

  // -------------------------------------------------------------------------
  async function respondSubmit(): Promise<Response> {
    const maxBytes = Number(env.MAX_UPLOAD_MB || '50') * 1024 * 1024;

    const contentType = req.headers.get('Content-Type') || '';
    let audio: ArrayBuffer;
    let fileName = 'audio.wav';
    let fileType = 'audio/wav';
    let requestedView = url.searchParams.get('view') || 'full';
    let webhook = url.searchParams.get('webhook_url') || null;
    let metadata: unknown = {};
    let pauseThreshold = 0.25;
    let language = '';

    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('audio');
      if (!(file instanceof File)) {
        return respond(apiError('missing_audio', "Send the audio as a multipart field named 'audio'.", 400));
      }
      audio = await file.arrayBuffer();
      fileName = file.name || fileName;
      fileType = file.type || fileType;
      requestedView = String(form.get('view') || requestedView);
      webhook = (form.get('webhook_url') as string) || webhook;
      metadata = parseJson<unknown>(form.get('metadata') as string, {});
      pauseThreshold = Number(form.get('pause_threshold')) || pauseThreshold;
      language = String(form.get('language') || '');
    } else if (contentType.startsWith('audio/') || contentType === 'application/octet-stream') {
      // Raw-body upload: simplest possible curl, and the only shape some embedded
      // clients can produce.
      audio = await req.arrayBuffer();
      fileName = url.searchParams.get('file_name') || fileName;
      fileType = contentType;
      pauseThreshold = Number(url.searchParams.get('pause_threshold')) || pauseThreshold;
      language = url.searchParams.get('language') || '';
    } else {
      return respond(apiError('unsupported_content_type',
        "Send multipart/form-data with an 'audio' field, or the raw bytes with an audio/* Content-Type.", 415));
    }

    if (audio.byteLength === 0) return respond(apiError('empty_audio', 'The audio body was empty.', 400));
    if (audio.byteLength > maxBytes) {
      return respond(apiError('audio_too_large', `Audio exceeds the ${env.MAX_UPLOAD_MB} MB limit.`, 413, {
        max_bytes: maxBytes, your_bytes: audio.byteLength,
      }));
    }

    if (!VIEWS.includes(requestedView as View)) {
      return respond(apiError('invalid_view', `view must be one of: ${VIEWS.join(', ')}.`, 400));
    }
    const view = requestedView as View;
    if (!viewSatisfiable(view, id.scopes)) {
      return respond(apiError('insufficient_scope',
        `Your key cannot produce the '${view}' view.`, 403, {
          your_scopes: id.scopes,
          views_available: VIEWS.filter((v) => viewSatisfiable(v, id.scopes)),
        }));
    }

    if (webhook && !/^https:\/\//i.test(webhook)) {
      return respond(apiError('invalid_webhook', 'webhook_url must be an https:// URL.', 400));
    }

    // Quota. Duration is known up front only for WAV; anything else is metered at its true
    // length once the AI reports back, so a non-WAV submission can overshoot the cap by at
    // most one file. That is deliberate — rejecting unmeasurable audio outright would be
    // worse for the developer than a small overshoot.
    const durationSec = wavSeconds(audio);
    if (id.quotaMinutes > 0) {
      const usedSec = await quotaUsedSeconds(env, id);
      const projected = usedSec + (durationSec ?? 0);
      if (projected > id.quotaMinutes * 60) {
        const label = id.quotaPeriod === 'total' ? 'Total' : 'Monthly';
        return respond(apiError('quota_exceeded',
          `${label} quota of ${id.quotaMinutes} audio minutes reached.`, 402, quotaBlock(id, usedSec)));
      }
    }

    const jobId = uid();
    const audioKey = `jobs/${id.developerId}/${jobId}`;
    await env.AUDIO.put(audioKey, audio, { httpMetadata: { contentType: fileType } });

    const retentionDays = Number(env.JOB_RETENTION_DAYS || '30');
    await env.DB.prepare(
      `INSERT INTO jobs (id, developer_id, api_key_id, status, view, audio_key, file_name, content_type,
                         bytes, duration_sec, language, pause_threshold, metadata, webhook_url, expires_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      jobId, id.developerId, id.keyId, view, audioKey, fileName.slice(0, 200), fileType,
      audio.byteLength, durationSec, language.slice(0, 16), pauseThreshold,
      JSON.stringify(metadata ?? {}), webhook, iso(retentionDays * 86400_000),
    ).run();

    // Nudge the container awake so a lone job does not wait for the next cron minute.
    ctx.waitUntil(wakeProcessor(env));

    return respond(
      json({
        id: jobId,
        object: 'job',
        status: 'queued',
        view,
        poll_url: `https://${env.API_HOST}/v1/jobs/${jobId}`,
        created_at: now(),
      }, 202),
      { jobId, view, audioSeconds: durationSec ?? 0 },
    );
  }
}

function viewSatisfiable(view: View, scopes: string[]): boolean {
  if (view === 'transcript') return scopes.includes('transcript:read');
  if (view === 'report') return scopes.includes('report:read');
  // 'full' is satisfiable with any one scope — the caller gets everything they are entitled
  // to and an explicit `omitted` list for the rest.
  return scopes.length > 0;
}

/** Honour ?view= when the key allows it, else fall back to what was asked at submit time. */
function pickView(requested: string | null, stored: string, scopes: string[]): View {
  if (requested && VIEWS.includes(requested as View) && viewSatisfiable(requested as View, scopes)) {
    return requested as View;
  }
  return (VIEWS.includes(stored as View) ? stored : 'full') as View;
}

