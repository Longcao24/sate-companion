// SATE — Cloudflare Worker entry point.
//
// Mirrors the Supabase URL surface so the client shim is a thin fetch wrapper:
//
//   /auth/v1/*            GoTrue-compatible auth          -> authRoutes.ts
//   /rest/v1/<table>      PostgREST-compatible CRUD       -> rest.ts
//   /rest/v1/rpc/<fn>     the two ported pg functions     -> rpc.ts
//   /storage/v1/object/*  Supabase-Storage-compatible R2  -> storage.ts
//   /functions/v1/<name>  the ported edge functions       -> functions/*
//
// This is a PARALLEL stack. It does not read from, write to, or depend on the live
// Supabase project, and nothing outside cloudflare/ was modified to make it work.

import { contextFrom } from './auth';
import { handleAuth, type AuthEnv } from './authRoutes';
import { handleRest, HttpError, type RestEnv } from './rest';
import { handleRpc } from './rpc';
import { handleStorage, type StorageEnv } from './storage';
import { handleDeviceApi } from './functions/deviceApi';
import { handleProcessDeviceSession } from './functions/processDeviceSession';
import { handleMintPlaudToken } from './functions/mintPlaudToken';
import { handleMobileLink } from './functions/mobileLink';

export interface Env extends AuthEnv, RestEnv, StorageEnv {
  DB: D1Database;
  BUCKET: R2Bucket;
  JWT_SECRET: string;
  SERVICE_KEY: string;
  SITE_URL: string;
  /** Cloudflare Email Service binding. Optional: absent if the domain was never onboarded. */
  EMAIL?: { send(msg: any): Promise<{ messageId: string }> };
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  /** The AI processor. Unchanged from Supabase: still the ngrok tunnel. */
  AI_PROCESS_URL: string;
  PROCESSOR_SECRET: string;
  PLAUD_CLIENT_ID: string;
  PLAUD_CLIENT_SECRET: string;
  /**
   * Device-lock safety gate, NOT a feature flag. Must be the string '1' to allow Plaud
   * token minting. Off by default because this stack's user ids differ from Supabase's,
   * which changes the Plaud identity and can permanently lock a device.
   * See src/functions/mintPlaudToken.ts and CLAUDE.md RULE #1.
   */
  PLAUD_ALLOW_MINT: string;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, prefer, accept, range',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'content-range, content-length',
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    try {
      const res = await route(req, url, env);
      // Route handlers build their own headers; fold CORS in without clobbering them.
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      if (e instanceof HttpError) {
        return new Response(JSON.stringify({ message: e.message, error: e.message }), {
          status: e.status,
          headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      // Unexpected: log the detail, return a generic message. Stack traces and SQL text
      // must not reach a browser.
      console.error('[worker] unhandled', e);
      return new Response(JSON.stringify({ message: 'internal error' }), {
        status: 500,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};

async function route(req: Request, url: URL, env: Env): Promise<Response> {
  const p = url.pathname;

  // Auth resolves its own tokens (it issues them), so it runs before contextFrom.
  if (p.startsWith('/auth/v1/')) return handleAuth(req, url, env);

  const ctx = await contextFrom(req, env);

  if (p.startsWith('/rest/v1/rpc/')) {
    const name = p.slice('/rest/v1/rpc/'.length);
    const body = await req.json<Record<string, unknown>>().catch(() => ({}));
    const data = await handleRpc(name, body, ctx, env.DB);
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }

  if (p.startsWith('/rest/v1/')) {
    const table = p.slice('/rest/v1/'.length);
    if (!table || table.includes('/')) throw new HttpError(400, 'bad table path');
    return handleRest(req, url, table, ctx, env);
  }

  if (p.startsWith('/storage/v1/object')) return handleStorage(req, url, ctx, env);

  // ---- edge functions ----
  // device-api and mint-plaud-token ran with verify_jwt:false on Supabase because they
  // validate their own credentials (a device key, not a user JWT). mobile-link's `consume`
  // is anonymous by definition — the phone has no session yet. Preserved here by routing
  // them before any auth gate. Do not "fix" this by requiring a JWT.
  if (p.startsWith('/functions/v1/device-api')) return handleDeviceApi(req, url, env);
  if (p.startsWith('/functions/v1/process-device-session')) return handleProcessDeviceSession(req, env);
  if (p.startsWith('/functions/v1/mint-plaud-token')) return handleMintPlaudToken(req, env);
  if (p.startsWith('/functions/v1/mobile-link')) return handleMobileLink(req, env);

  if (p === '/health') return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });

  throw new HttpError(404, `no route for ${req.method} ${p}`);
}
