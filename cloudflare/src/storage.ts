// SATE — Supabase-Storage-compatible surface over R2.
//
// Layout: ONE R2 bucket, with the Supabase bucket name as the key prefix
// (`recordings/…`, `device-sessions/…`, `firmware/…`, `mobile/…`). R2 has no notion of
// nested buckets and per-bucket bindings would mean four bindings and four names to keep
// in step; a prefix keeps the mapping obvious and lets one binding serve all of them.
//
// Routes (mirroring Supabase Storage so the shim stays thin):
//   GET  /storage/v1/object/public/<bucket>/<path>      — no auth (firmware only)
//   POST /storage/v1/object/sign/<bucket>/<path>        — mint a signed URL
//   GET  /storage/v1/object/sign/<bucket>/<path>?token= — redeem one
//   DELETE /storage/v1/object/<bucket>/<path>           — remove
//
// ⚠️ Supabase Storage enforced access with its own policies. R2 has none: any key is
// readable by anyone who can reach the binding. Authorisation here is entirely this file's
// job, and `recordings/` holds patient audio.
//
// ⚠️ THE FILE SIZE LIMIT THAT BIT BEFORE: Supabase had a project-wide 50 MB cap that
// silently 413'd a 118 MB take and cost a 62-minute recording. R2 has no such cap (5 TB
// per object), so that particular failure cannot recur here — but the lesson does apply:
// an upload failure must never be swallowed. storeSessionRecord's equivalent must throw.

import { HttpError } from './rest';
import type { Ctx } from './policy';

export interface StorageEnv {
  BUCKET: R2Bucket;
  DB: D1Database;
  JWT_SECRET: string;
}

/** Buckets that exist on the Supabase side. An unknown bucket is refused. */
const BUCKETS = new Set(['recordings', 'device-sessions', 'firmware', 'mobile']);

/**
 * Only `firmware` is public on Supabase, and it must stay that way: the recorder fetches
 * its OTA image over plain HTTPS with no credentials, from a URL stored in sate_firmware.
 * Never add `recordings` here — that is patient audio.
 */
const PUBLIC_BUCKETS = new Set(['firmware']);

const enc = new TextEncoder();

async function signKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64u(buf: ArrayBuffer): string {
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A signed URL is `<key>:<exp>:<hmac>`. The HMAC covers the key AND the expiry, so neither
 * can be edited: bumping `exp` or pointing the token at another patient's audio invalidates
 * the signature.
 */
async function mintToken(secret: string, key: string, expiresAt: number): Promise<string> {
  const payload = `${key}:${expiresAt}`;
  const sig = await crypto.subtle.sign('HMAC', await signKey(secret), enc.encode(payload));
  return `${expiresAt}.${b64u(sig)}`;
}

async function verifyToken(secret: string, key: string, token: string): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;

  const expected = await mintToken(secret, key, expiresAt);
  // Compare the whole token; both halves are derived from the same secret.
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function splitKey(rest: string): { bucket: string; path: string; key: string } {
  const slash = rest.indexOf('/');
  if (slash < 0) throw new HttpError(400, 'path must be <bucket>/<object>');
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (!BUCKETS.has(bucket)) throw new HttpError(404, `unknown bucket "${bucket}"`);
  if (!path) throw new HttpError(400, 'empty object path');
  // `..` cannot escape an R2 keyspace the way it escapes a filesystem, but a key containing
  // it will not match what was written either — reject rather than 404 confusingly.
  if (path.includes('..')) throw new HttpError(400, 'invalid object path');
  return { bucket, path, key: `${bucket}/${path}` };
}

/**
 * May `ctx` touch this object?
 *
 * Supabase Storage keyed its policies off the object path. The paths here are:
 *   recordings/<user_id>/<file>           — written by the web app and process-device-session
 *   device-sessions/<device_id>/<...>     — written by device-api
 * so ownership is the first path segment for `recordings`. That is the only bucket a
 * browser session may reach; the rest are service-role territory.
 */
function authorize(ctx: Ctx, bucket: string, path: string): void {
  if (ctx.serviceRole) return;
  if (!ctx.uid) throw new HttpError(401, 'not authenticated');

  if (bucket === 'recordings') {
    const owner = path.split('/')[0];
    if (owner !== ctx.uid) throw new HttpError(403, 'not permitted');
    return;
  }

  // device-sessions holds raw device audio and is only ever read by the processor;
  // mobile/firmware are managed server-side. No client path needs them.
  throw new HttpError(403, 'not permitted');
}

export async function handleStorage(req: Request, url: URL, ctx: Ctx, env: StorageEnv): Promise<Response> {
  const path = url.pathname.replace(/^\/storage\/v1\/object/, '');

  // ---- public read (firmware) ----
  if (path.startsWith('/public/')) {
    const { bucket, key } = splitKey(path.slice('/public/'.length));
    if (!PUBLIC_BUCKETS.has(bucket)) throw new HttpError(404, 'not found');
    const obj = await env.BUCKET.get(key);
    if (!obj) throw new HttpError(404, 'not found');
    return new Response(obj.body, {
      headers: {
        'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(obj.size),
        // The recorder streams the image straight into flash; caching it is fine and saves
        // repeat pulls when several devices update at once.
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // ---- signed URLs ----
  if (path.startsWith('/sign/')) {
    const { bucket, path: objPath, key } = splitKey(path.slice('/sign/'.length));

    // Mint. Matches supabase-js: .createSignedUrl(path, expiresIn) -> { signedURL }.
    if (req.method === 'POST') {
      authorize(ctx, bucket, objPath);
      const body = await req.json<{ expiresIn?: number }>().catch(() => ({ expiresIn: 3600 }));
      const ttl = Math.min(Math.max(Number(body.expiresIn ?? 3600), 1), 604800); // cap at 7d, as Supabase does
      const token = await mintToken(env.JWT_SECRET, key, Math.floor(Date.now() / 1000) + ttl);
      return new Response(JSON.stringify({ signedURL: `/storage/v1/object/sign/${key}?token=${token}` }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Redeem. The token IS the authorisation — the URL is handed to an <audio> element,
    // which will not send the Authorization header.
    if (req.method === 'GET') {
      const token = url.searchParams.get('token') ?? '';
      if (!(await verifyToken(env.JWT_SECRET, key, token))) throw new HttpError(401, 'invalid or expired token');

      // Range matters: the report page seeks within an hour-long WAV, and without this the
      // browser refetches the whole file on every scrub.
      const range = req.headers.get('Range');
      const obj = await env.BUCKET.get(key, range ? { range: req.headers } : undefined);
      if (!obj) throw new HttpError(404, 'not found');

      const headers = new Headers({
        'Content-Type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
        'Accept-Ranges': 'bytes',
      });
      obj.writeHttpMetadata(headers);
      if (obj.range && 'offset' in obj.range) {
        const start = obj.range.offset ?? 0;
        const length = obj.range.length ?? obj.size - start;
        headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { headers });
    }
  }

  // ---- delete ----
  if (req.method === 'DELETE') {
    const { bucket, path: objPath, key } = splitKey(path.replace(/^\//, ''));
    authorize(ctx, bucket, objPath);
    await env.BUCKET.delete(key);
    return new Response(JSON.stringify({ message: 'Successfully deleted' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  throw new HttpError(404, `no storage route for ${req.method} ${path}`);
}

/** Server-side helper: write an object. Throws on failure — never swallow (see header). */
export async function putObject(
  env: StorageEnv,
  bucket: string,
  path: string,
  body: ArrayBuffer | ReadableStream,
  contentType: string,
): Promise<string> {
  if (!BUCKETS.has(bucket)) throw new HttpError(400, `unknown bucket "${bucket}"`);
  const key = `${bucket}/${path}`;
  const res = await env.BUCKET.put(key, body, { httpMetadata: { contentType } });
  if (!res) throw new Error(`R2 put failed for ${key}`);
  return key;
}

/** Server-side helper: does this object actually exist? Used by the upload idempotency probe. */
export async function objectExists(env: StorageEnv, bucket: string, path: string): Promise<boolean> {
  const head = await env.BUCKET.head(`${bucket}/${path}`);
  return head !== null;
}
