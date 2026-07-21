// SATE async processor — Worker + Container Durable Object.
//
// The Worker does NOT process anything and never waits on the AI. It only wakes the
// container (a single fetch boots it if asleep) and returns immediately. The container
// runs its own poll loop internally (see app/processor.py). pg_cron pings /tick every
// minute so the container stays warm and keeps draining the queue; if pings stop it
// sleeps after `sleepAfter` and reboots on the next tick, resuming from the queue.

import { Container, getContainer } from '@cloudflare/containers';

interface Env {
  PROCESSOR: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string; // secret
  AI_PROCESS_URL: string; // secret (ngrok /process)
  FINALIZE_URL: string;
  TICK_SECRET: string; // secret — shared with the pg_cron caller
  STUCK_MINUTES?: string;
  MAX_ATTEMPTS?: string;
  POLL_INTERVAL?: string;
  WORKER_ID?: string;
}

export class ProcessorContainer extends Container<Env> {
  defaultPort = 8080;
  // Stay alive between pg_cron ticks (1 min) so the internal poll loop never stops.
  // If ticks stop, sleep after this idle window to save cost; reboot resumes the queue.
  sleepAfter = '20m';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Injected into the Python process environment.
    this.envVars = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: env.SUPABASE_SERVICE_KEY,
      AI_PROCESS_URL: env.AI_PROCESS_URL,
      FINALIZE_URL: env.FINALIZE_URL,
      STUCK_MINUTES: env.STUCK_MINUTES ?? '45',
      MAX_ATTEMPTS: env.MAX_ATTEMPTS ?? '3',
      POLL_INTERVAL: env.POLL_INTERVAL ?? '10',
      WORKER_ID: env.WORKER_ID ?? 'cf-container-1',
    };
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // pg_cron (and optionally device-api) hits this to wake/keep-warm the container.
    if (url.pathname === '/tick') {
      const auth = (req.headers.get('Authorization') ?? '').replace(/^Bearer /i, '');
      if (!env.TICK_SECRET || auth !== env.TICK_SECRET) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      // Singleton container instance. A fetch boots it if asleep; its poll loop does the work.
      const container = getContainer(env.PROCESSOR);
      try {
        await container.fetch(new Request('http://container/health'));
      } catch (e) {
        // Boot in progress / transient — the loop will pick up on the next tick.
        return new Response(JSON.stringify({ ok: true, note: 'container waking' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response('not found', { status: 404 });
  },
};
