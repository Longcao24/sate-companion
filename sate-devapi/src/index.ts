// SATE Developer API — Worker entry point.
//
// One Worker, two faces, decided by hostname:
//   api-sate…         -> /v1/*        the machine API (API key)
//   developers-sate…  -> the portal    (cookie session)
// plus /internal/* for the processor container (shared secret) and /tick for the cron.
//
// Anything not related to submitting audio and reading back a transcript or a report does
// not belong in this service. It holds no patient data, no clinical records, and no link to
// a SATE account — by design, not by omission.

import { Env, json, apiError, CORS, now } from './util';
import { handleApi } from './api';
import { handlePortalApi } from './portal';
import { handleInternal, requeueStale } from './internal';
import { portalHtml } from './ui';
import { docsHtml } from './docs';
import { wakeProcessor, DevProcessor } from './container';

export { DevProcessor };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      // ---- unauthenticated ---------------------------------------------------
      if (path === '/health') {
        return json({ ok: true, service: 'sate-devapi', time: now() });
      }

      // Cron and the API both nudge the container awake; the secret keeps it from being a
      // free way for anyone to spin up compute.
      if (path === '/tick' && req.method === 'POST') {
        const presented = (req.headers.get('Authorization') || '').replace(/^Bearer /i, '');
        if (!env.TICK_SECRET || presented !== env.TICK_SECRET) {
          return apiError('unauthorized', 'Bad tick secret.', 401);
        }
        ctx.waitUntil(wakeProcessor(env));
        return json({ ok: true });
      }

      // ---- container callbacks ----------------------------------------------
      if (path.startsWith('/internal/')) {
        return await handleInternal(req, env, ctx, path);
      }

      // ---- public API --------------------------------------------------------
      if (path.startsWith('/v1/')) {
        return await handleApi(req, env, ctx, path);
      }

      // ---- portal ------------------------------------------------------------
      if (path.startsWith('/portal/api/')) {
        return await handlePortalApi(req, env, ctx, path);
      }
      if (path === '/docs') {
        return html(docsHtml(env.API_HOST, env.PORTAL_HOST));
      }
      if (path === '/' || path === '/portal') {
        // The API host has no UI: hitting it in a browser should point you at the docs
        // rather than render a login form on the wrong domain.
        if (url.hostname === env.API_HOST) {
          return json({
            service: 'SATE Developer API',
            docs: `https://${env.PORTAL_HOST}/docs`,
            portal: `https://${env.PORTAL_HOST}`,
            version: 'v1',
          });
        }
        return html(portalHtml(env.API_HOST));
      }

      return apiError('not_found', `No route for ${req.method} ${path}.`, 404);
    } catch (e) {
      console.error('unhandled', (e as Error).stack || (e as Error).message);
      return apiError('internal_error', 'Something went wrong on our side.', 500);
    }
  },

  /**
   * Every minute: keep the container warm so a queued job never waits long, reclaim jobs a
   * dead container abandoned, and sweep expired data.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      await wakeProcessor(env);
      await requeueStale(env).catch((e) => console.error('requeueStale', e.message));
      await sweep(env).catch((e) => console.error('sweep', e.message));
    })());
  },
};

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // The portal is entirely self-contained, so it can afford a strict policy.
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; connect-src 'self' https:; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
    },
  });
}

/**
 * Retention sweep. Results and their audio are deleted once past `expires_at`, and dead
 * portal sessions go with them. Holding a developer's transcript forever is a liability
 * with no upside — if they need it kept, that is their storage, not ours.
 */
async function sweep(env: Env): Promise<void> {
  const stamp = now();

  const expired = await env.DB.prepare(
    `SELECT id, audio_key FROM jobs WHERE expires_at < ? LIMIT 200`,
  ).bind(stamp).all<{ id: string; audio_key: string | null }>();

  for (const row of expired.results || []) {
    if (row.audio_key) await env.AUDIO.delete(row.audio_key).catch(() => undefined);
  }
  if ((expired.results || []).length) {
    const ids = (expired.results || []).map((r) => r.id);
    const marks = ids.map(() => '?').join(',');
    await env.DB.prepare(`DELETE FROM jobs WHERE id IN (${marks})`).bind(...ids).run();
  }

  await env.DB.prepare(`DELETE FROM portal_sessions WHERE expires_at < ?`).bind(stamp).run();

  // Usage events outlive jobs on purpose — they are the billing record — but not forever.
  const usageCutoff = new Date(Date.now() - 400 * 86400_000).toISOString();
  await env.DB.prepare(`DELETE FROM usage_events WHERE created_at < ?`).bind(usageCutoff).run();
}
