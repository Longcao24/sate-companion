// Shared helpers: responses, WAV header maths, R2 part handling.

import type { Env } from './index';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const err = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: message }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const noContent = () => new Response(null, { status: 204, headers: cors });

export const nowIso = () => new Date().toISOString();

export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Patch a 44-byte WAV header in place so it describes a file of `totalSize` bytes:
 * RIFF chunk size (offset 4) and data chunk size (offset 40).
 *
 * `totalSize` is a parameter rather than `buf.length` because the assembly only ever holds
 * the FIRST part in memory, and the size that belongs in the header is the whole session's.
 * Passing the wrong one yields a WAV whose header claims ~1 MB: players show a 30-second
 * file and the ASR transcribes only the opening minute of an hour-long recording.
 */
export function patchWavHeaderFor(buf: Uint8Array, totalSize: number) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 8 && totalSize >= 8) dv.setUint32(4, totalSize - 8, true);
  if (buf.length >= 44 && totalSize >= 44) dv.setUint32(40, totalSize - 44, true);
}

/** Build a 44-byte PCM WAV header for `dataLen` bytes of 16-bit mono audio. */
export function wavHeader(dataLen: number, sampleRate = 16000, channels = 1, bits = 16): Uint8Array {
  const h = new Uint8Array(44);
  const dv = new DataView(h.buffer);
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const ascii = (off: number, s: string) => { for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');  dv.setUint32(4, 36 + dataLen, true);
  ascii(8, 'WAVE');  ascii(12, 'fmt ');
  dv.setUint32(16, 16, true);            // PCM fmt chunk size
  dv.setUint16(20, 1, true);             // PCM
  dv.setUint16(22, channels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bits, true);
  ascii(36, 'data'); dv.setUint32(40, dataLen, true);
  return h;
}

/** Duration in seconds of a 16-bit mono PCM WAV of `bytes` total length. */
export function wavSeconds(bytes: number, sampleRate = 16000, channels = 1, bits = 16): number {
  const bytesPerSec = (sampleRate * channels * bits) / 8;
  return bytesPerSec > 0 ? Math.max(0, bytes - 44) / bytesPerSec : 0;
}

/** Parse the firmware's "&flags=12000,45000" CSV (ms offsets) into a number[]. */
export function parseFlags(raw: string | null): number[] {
  if (!raw) return [];
  return raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
}

export interface PartRef { key: string; offset: number; size: number }

/** List the .part objects under a prefix, in offset order, with their sizes. */
export async function listParts(env: Env, prefix: string): Promise<PartRef[]> {
  const out: PartRef[] = [];
  let cursor: string | undefined;
  do {
    // R2 lists 1000 keys at a time; a 62-minute take is ~118 parts, but paginate anyway
    // rather than silently truncating a longer one.
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const o of page.objects) {
      if (!o.key.endsWith('.part')) continue;
      const name = o.key.slice(prefix.length);
      out.push({ key: o.key, offset: Number(name.replace('.part', '')), size: o.size });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.offset - b.offset);
}

export async function purgePrefix(env: Env, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** True when the key really exists. A DB row is not proof the audio landed. */
export async function objectExists(env: Env, key: string): Promise<boolean> {
  return (await env.BUCKET.head(key)) !== null;
}

export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------------------
// Signed media URLs
// ---------------------------------------------------------------------------------------
//
// An <audio> element cannot send an Authorization header — it is the browser that issues the
// request, not our fetch. So the audio route cannot sit behind the same bearer gate as the
// JSON API, and putting the admin key in the query string instead would leak a credential
// into history, logs and referrers.
//
// Instead the JSON response hands the player a short-lived token that grants access to ONE
// note. The HMAC covers the note id AND the expiry, so neither can be edited: bumping `exp`
// or pointing the token at another recording invalidates the signature. Same shape as the
// signed URLs in cloudflare/src/storage.ts.

const enc = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64u(buf: ArrayBuffer): string {
  let s = '';
  for (const x of new Uint8Array(buf)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `<exp>.<sig>` — valid for `ttlSec` seconds, for this note only. */
export async function signMedia(secret: string, noteId: string, ttlSec = 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${noteId}:${exp}`));
  return `${exp}.${b64u(sig)}`;
}

export async function verifyMedia(secret: string, noteId: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  // Check the clock before the signature: an expired token is invalid however well it is signed.
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`${noteId}:${exp}`));
  return b64u(expected) === token.slice(dot + 1);
}
