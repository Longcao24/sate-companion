// The processor container — a long-lived Python process with no wall-clock.
//
// This exists for exactly one reason: the AI transcription call cannot be held by a
// Worker. A Worker dies at the ~100 s origin timeout, mid-fetch, before any catch block
// runs, so a long job would strand in 'processing' with no error ever recorded. The
// container has no such limit and holds the call for as long as it takes.
//
// The container itself owns NO state and speaks NO SQL. It calls back into this Worker
// over /internal/* with a shared secret; the Worker owns D1 and R2. That keeps every
// query in one place and means the container is a dumb, restartable executor.

import { Container, getContainer } from '@cloudflare/containers';
import type { Env } from './util';

export class DevProcessor extends Container<Env> {
  defaultPort = 8080;
  // The cron ticks every minute, so this only matters if ticks stop: sleep to save cost,
  // reboot on the next tick, resume straight from the queue (state lives in D1).
  sleepAfter = '20m';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx as any, env);
    this.envVars = {
      // Where to call back for work. The container never touches D1 or R2 directly.
      API_BASE: `https://${env.API_HOST}`,
      INTERNAL_SECRET: env.INTERNAL_SECRET,
      AI_PROCESS_URL: env.AI_PROCESS_URL ?? '',
      MAX_ATTEMPTS: env.MAX_ATTEMPTS ?? '3',
      POLL_INTERVAL: '10',
      WORKER_ID: 'devapi-container-1',
      // Clinical-priority gate. Optional: with no probe URL configured the gate is off and
      // developer jobs run immediately. See processor.py.
      CLINICAL_PROBE_URL: env.CLINICAL_PROBE_URL ?? '',
      CLINICAL_PROBE_KEY: env.CLINICAL_PROBE_KEY ?? '',
      CLINICAL_DEFER_SEC: '15',
      MAX_DEFER_SEC: '600',
    };
  }
}

/** Boot / keep-warm the singleton container. Never throws — a boot in progress is normal. */
export async function wakeProcessor(env: Env): Promise<void> {
  try {
    await getContainer(env.PROCESSOR as any).fetch(new Request('http://container/health'));
  } catch {
    // Boot in progress or transient; the next cron tick picks the work up.
  }
}
