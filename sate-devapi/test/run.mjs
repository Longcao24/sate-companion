#!/usr/bin/env node
//
// SATE Developer API — end-to-end test suite.
//
// Black-box: it boots the real Worker under `wrangler dev --local` and drives it over HTTP,
// exactly as a developer's client and the processor container would. Nothing is stubbed
// inside the Worker.
//
// The one thing it stands in for is the container itself, by calling /internal/* directly.
// That is not a gap in coverage — /internal IS the container's entire contract, so driving
// it reproduces precisely what the container does, without needing Docker or a GPU, and
// deterministically enough to assert exact report numbers.
//
//   node test/run.mjs            # boot wrangler, run everything, tear down
//   node test/run.mjs --keep     # leave the server up afterwards for poking at
//   node test/run.mjs --base=…   # run against an already-running server
//
// Exit code is non-zero on any failure, so it works as a release gate.

import { spawn, execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8799;
const args = process.argv.slice(2);
const KEEP = args.includes('--keep');
const EXTERNAL = args.find((a) => a.startsWith('--base='))?.slice(7);
const BASE = EXTERNAL || `http://127.0.0.1:${PORT}`;
const INTERNAL_SECRET = 'test-internal-secret';

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
let group = '';

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m', b: '\x1b[1m' };

function section(name) {
  group = name;
  console.log(`\n${C.b}── ${name}${C.x}`);
}

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ${C.g}✓${C.x} ${label}`);
  } else {
    failures.push({ group, label, detail });
    console.log(`  ${C.r}✗ ${label}${C.x}`);
    if (detail !== undefined) console.log(`    ${C.d}${JSON.stringify(detail)}${C.x}`);
  }
}

const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/** Floating-point compare — MLU and rates are ratios, so exact equality is the wrong test. */
const near = (label, actual, expected, tol = 0.001) =>
  check(label, typeof actual === 'number' && Math.abs(actual - expected) < tol, { actual, expected });

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
let cookieJar = new Map();

async function http(method, url, { body, headers = {}, cookieAs, raw } = {}) {
  const h = { ...headers };
  if (cookieAs && cookieJar.has(cookieAs)) h.Cookie = cookieJar.get(cookieAs);
  if (body !== undefined && !(body instanceof FormData) && !(body instanceof Uint8Array) && !raw) {
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + url, {
    method,
    headers: h,
    body: body === undefined ? undefined
      : body instanceof FormData || body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const setCookie = res.headers.get('Set-Cookie');
  if (setCookie && cookieAs) cookieJar.set(cookieAs, setCookie.split(';')[0]);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 200) }; }
  return { status: res.status, body: json, headers: res.headers };
}

const asKey = (key) => ({ Authorization: `Bearer ${key}` });
const asInternal = { Authorization: `Bearer ${INTERNAL_SECRET}` };

/** A valid mono 16-bit 16 kHz WAV of the requested length — enough for the header parser. */
function makeWav(seconds, sampleRate = 16000) {
  const samples = Math.round(seconds * sampleRate);
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const ascii = (off, s) => [...s].forEach((c, i) => dv.setUint8(off + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ascii(36, 'data'); dv.setUint32(40, dataBytes, true);
  // A quiet sine so the bytes are not all identical — nothing reads them, but a real file
  // is a better test subject than a block of zeros.
  for (let i = 0; i < samples; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(i / 40) * 3000), true);
  return new Uint8Array(buf);
}

async function submitWav(key, { seconds = 2, view = 'full', rate = 16000, extra = {} } = {}) {
  const fd = new FormData();
  fd.append('audio', new Blob([makeWav(seconds, rate)], { type: 'audio/wav' }), 'sample.wav');
  fd.append('view', view);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return http('POST', '/v1/jobs', { body: fd, headers: asKey(key) });
}

// ---------------------------------------------------------------------------
// The canned AI transcript.
//
// Hand-built so every reported number can be derived on paper and asserted exactly. See
// the assertions in the "Report correctness" section for the derivation.
// ---------------------------------------------------------------------------
const w = (word, start, end) => ({ word, start, end });
const TRANSCRIPT = {
  segments: [
    {
      speaker: 'Child', start: 0, end: 4,
      words: [w('we', 0, .3), w('went', .3, .7), w('to', .7, .9), w('the', .9, 1.1), w('park.', 1.1, 1.6)],
      pauses: [{ index: 2, duration: 1.1 }],
    },
    {
      speaker: 'Examiner', start: 4, end: 6,
      words: [w('what', 4, 4.3), w('happened', 4.3, 4.8), w('next?', 4.8, 5.2)],
    },
    {
      speaker: 'Child', start: 6, end: 10,
      words: [w('um', 6, 6.3), w('the', 6.3, 6.5), w('dog', 6.5, 6.9), w('run', 6.9, 7.3), w('away.', 7.3, 7.9)],
      fillerwords: [{ index: 0, content: 'um', start: 6, end: 6.3 }],
      morphemes: [{ word: 'dog', lemma: 'dog', morpheme_form: 's' }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let server = null;

const TABLES = ['usage_events', 'jobs', 'api_keys', 'portal_sessions', 'audit_log', 'developers'];

function d1(args) {
  return execFileSync('npx', [
    'wrangler', 'd1', 'execute', 'sate-devapi-test',
    '--config', 'wrangler.test.toml', '--local', '--yes', ...args,
  ], { cwd: ROOT, stdio: 'pipe' });
}

async function bootServer() {
  // Rebuild from scratch every run: a schema change must not need a manual database wipe,
  // and a stale table from a previous version is exactly the kind of drift that makes a
  // suite pass locally and fail in CI.
  console.log(`${C.d}Rebuilding the local D1 from schema.sql…${C.x}`);
  d1(['--command', TABLES.map((t) => `DROP TABLE IF EXISTS ${t};`).join(' ')]);
  d1(['--file=./schema.sql']);

  console.log(`${C.d}Starting wrangler dev on :${PORT}…${C.x}`);
  server = spawn('npx', [
    'wrangler', 'dev', '--config', 'wrangler.test.toml',
    '--local', '--port', String(PORT), '--ip', '127.0.0.1',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error(`wrangler exited early:\n${log}`);
  }
  throw new Error(`server never became healthy:\n${log}`);
}

function stopServer() {
  if (server && !KEEP) server.kill('SIGTERM');
}

/** Empty every table, so --base= runs against a warm server also start from nothing. */
async function resetDb() {
  d1(['--command', TABLES.map((t) => `DELETE FROM ${t};`).join(' ')]);
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------
async function main() {
  if (!EXTERNAL) await bootServer();
  await resetDb();
  cookieJar = new Map();

  // =========================================================================
  section('Service basics');
  {
    const h = await http('GET', '/health');
    check('GET /health is 200', h.status === 200, h.body);
    eq('reports its own name', h.body.service, 'sate-devapi');

    const bad = await http('POST', '/tick');
    eq('POST /tick without the secret is 401', bad.status, 401);

    const nf = await http('GET', '/v1/nope', { headers: asKey('sate_live_x') });
    eq('an unknown /v1 route with a bad key is 401 before 404', nf.status, 401);
  }

  // =========================================================================
  section('Registration and approval');
  let adminEmail = 'admin@example.test';
  let devEmail = 'dev@example.test';
  let devId = null;
  {
    // The bootstrap address self-approves; everyone else lands pending. This is what stops
    // an open request form from ever spending GPU time.
    const a = await http('POST', '/portal/api/register',
      { body: { email: adminEmail, password: 'correct-horse-battery' } });
    eq('bootstrap admin registers active', a.body.status, 'active');

    const d = await http('POST', '/portal/api/register',
      { body: { email: devEmail, password: 'another-long-password', org: 'Acme', use_case: 'Testing' } });
    eq('a normal developer registers pending', d.body.status, 'pending');

    const dup = await http('POST', '/portal/api/register',
      { body: { email: devEmail, password: 'yet-another-password' } });
    check('re-registering an existing email does not confirm it exists', dup.status === 200 && dup.body.ok === true, dup.body);

    const weak = await http('POST', '/portal/api/register', { body: { email: 'x@y.test', password: 'short' } });
    eq('a short password is rejected', weak.body.error?.code, 'weak_password');

    const pendingLogin = await http('POST', '/portal/api/login', { body: { email: devEmail, password: 'another-long-password' } });
    eq('a pending developer cannot sign in', pendingLogin.body.error?.code, 'pending_approval');

    const wrongPw = await http('POST', '/portal/api/login', { body: { email: adminEmail, password: 'wrong' } });
    eq('a wrong password is rejected', wrongPw.body.error?.code, 'invalid_credentials');

    const login = await http('POST', '/portal/api/login',
      { body: { email: adminEmail, password: 'correct-horse-battery' }, cookieAs: 'admin' });
    eq('the admin signs in', login.status, 200);
    check('the session cookie is HttpOnly', /HttpOnly/i.test(login.headers.get('Set-Cookie') || ''));

    const list = await http('GET', '/portal/api/admin/developers', { cookieAs: 'admin' });
    const pending = list.body.data.find((x) => x.email === devEmail);
    devId = pending?.id;
    check('the admin sees the pending request', !!pending && pending.status === 'pending', pending);
    eq('a pending developer starts with no scopes', pending.scopes, []);

    // Approved with two of the three scopes: 'annotations:read' is deliberately withheld so
    // the scope-gating assertions below have something real to bite on.
    const approve = await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin',
      body: {
        status: 'active', scopes: ['transcript:read', 'report:read'],
        quota_minutes: 5, quota_period: 'monthly', rate_per_min: 600, max_keys: 3,
      },
    });
    eq('the admin approves the developer', approve.status, 200);

    const now = await http('POST', '/portal/api/login',
      { body: { email: devEmail, password: 'another-long-password' }, cookieAs: 'dev' });
    eq('the approved developer can now sign in', now.status, 200);
  }

  // =========================================================================
  section('Access control between the two credential types');
  let devKey = null;
  {
    const noScope = await http('POST', '/portal/api/keys', {
      cookieAs: 'dev', body: { name: 'annotations only', scopes: ['annotations:read'] },
    });
    eq('a key cannot be minted with a scope the developer was not granted', noScope.body.error?.code, 'invalid_scopes');

    const made = await http('POST', '/portal/api/keys', {
      cookieAs: 'dev', body: { name: 'Test key', scopes: ['transcript:read', 'report:read'] },
    });
    eq('the developer mints a key', made.status, 201);
    devKey = made.body.key;
    check('the key is returned in plaintext exactly once', typeof devKey === 'string' && devKey.startsWith('sate_live_'), made.body);

    const listed = await http('GET', '/portal/api/keys', { cookieAs: 'dev' });
    check('the plaintext is never listed back', !JSON.stringify(listed.body).includes(devKey.slice(10)), listed.body);

    const overRate = await http('POST', '/portal/api/keys', {
      cookieAs: 'dev', body: { name: 'greedy', scopes: ['report:read'], rate_per_min: 99999 },
    });
    check('a key cannot exceed the developer rate ceiling', overRate.body.rate_per_min === 600, overRate.body);

    // The two credential types must not be interchangeable in either direction.
    const cookieOnApi = await http('GET', '/v1/me', { cookieAs: 'dev' });
    eq('a portal cookie cannot call the machine API', cookieOnApi.status, 401);

    const keyOnPortal = await http('GET', '/portal/api/me', { headers: asKey(devKey) });
    eq('an API key cannot call the portal API', keyOnPortal.status, 401);

    const noAdmin = await http('GET', '/portal/api/admin/developers', { cookieAs: 'dev' });
    eq('a non-admin cannot read the admin console', noAdmin.body.error?.code, 'forbidden');
  }

  // =========================================================================
  section('Key authentication');
  {
    eq('no key is 401', (await http('GET', '/v1/me')).body.error?.code, 'unauthorized');
    eq('a malformed key is 401', (await http('GET', '/v1/me', { headers: asKey('nope') })).body.error?.code, 'unauthorized');
    eq('an unknown key is 401',
      (await http('GET', '/v1/me', { headers: asKey('sate_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') })).body.error?.code,
      'unauthorized');

    const me = await http('GET', '/v1/me', { headers: asKey(devKey) });
    eq('GET /v1/me succeeds', me.status, 200);
    eq('it reports the granted scopes', me.body.scopes.sort(), ['report:read', 'transcript:read']);
    eq('it reports which views are reachable', me.body.views_available.sort(), ['full', 'report', 'transcript']);
    eq('it reports the quota period', me.body.quota.period, 'monthly');
    eq('it reports the quota limit', me.body.quota.minutes_limit, 5);
  }

  // =========================================================================
  section('Submitting a job');
  let jobId = null;
  {
    const badView = await submitWav(devKey, { view: 'nonsense' });
    eq('an unknown view is rejected', badView.body.error?.code, 'invalid_view');

    const empty = await http('POST', '/v1/jobs', {
      body: new Uint8Array(0), headers: { ...asKey(devKey), 'Content-Type': 'audio/wav' }, raw: true,
    });
    eq('an empty body is rejected', empty.body.error?.code, 'empty_audio');

    const wrongType = await http('POST', '/v1/jobs', {
      body: { hello: 'world' }, headers: asKey(devKey),
    });
    eq('a JSON body is rejected', wrongType.body.error?.code, 'unsupported_content_type');

    // MAX_UPLOAD_MB is 1 in the test config, so this is a real 413 rather than a 50 MB push.
    const big = await http('POST', '/v1/jobs', {
      body: makeWav(40), headers: { ...asKey(devKey), 'Content-Type': 'audio/wav' }, raw: true,
    });
    eq('an oversize upload is rejected', big.body.error?.code, 'audio_too_large');

    const badHook = await submitWav(devKey, { extra: { webhook_url: 'http://insecure.test/hook' } });
    eq('a non-https webhook is rejected', badHook.body.error?.code, 'invalid_webhook');

    const sub = await submitWav(devKey, { seconds: 3, view: 'full', extra: { metadata: '{"ref":"abc123"}' } });
    eq('a valid submission is accepted with 202', sub.status, 202);
    eq('it comes back queued', sub.body.status, 'queued');
    check('it carries a poll URL', typeof sub.body.poll_url === 'string', sub.body);
    jobId = sub.body.id;

    const poll = await http('GET', `/v1/jobs/${jobId}`, { headers: asKey(devKey) });
    eq('polling an unfinished job is 200, not an error', poll.status, 200);
    eq('…and reports it as queued', poll.body.status, 'queued');
    eq('…and echoes the metadata', poll.body.metadata, { ref: 'abc123' });
    near('…and knows the audio duration from the WAV header', poll.body.duration_sec, 3);

    const raw = await http('POST', '/v1/jobs?view=transcript&file_name=raw.wav', {
      body: makeWav(1), headers: { ...asKey(devKey), 'Content-Type': 'audio/wav' }, raw: true,
    });
    eq('a raw-body upload is accepted too', raw.status, 202);
    // Keep the queue to one job for the claim-order assertions below.
    await http('DELETE', `/v1/jobs/${raw.body.id}`, { headers: asKey(devKey) });
  }

  // =========================================================================
  section('The container contract (/internal)');
  {
    const noAuth = await http('POST', '/internal/claim', { body: { worker_id: 'test' } });
    eq('claiming without the internal secret is 401', noAuth.status, 401);

    const devKeyOnInternal = await http('POST', '/internal/claim', { headers: asKey(devKey), body: {} });
    eq('an API key cannot reach the internal API', devKeyOnInternal.status, 401);

    const claim = await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'test-worker' } });
    eq('the oldest queued job is claimed', claim.body.job?.id, jobId);
    eq('the claim counts as an attempt', claim.body.job?.attempts, 1);

    const again = await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'test-worker' } });
    eq('a claimed job cannot be claimed twice', again.body.job, null);

    const state = await http('GET', `/v1/jobs/${jobId}`, { headers: asKey(devKey) });
    eq('the developer sees it as processing', state.body.status, 'processing');

    const audio = await fetch(BASE + `/internal/jobs/${jobId}/audio`, { headers: asInternal });
    const bytes = new Uint8Array(await audio.arrayBuffer());
    eq('the audio downloads', audio.status, 200);
    check('…byte-identical to what was uploaded', bytes.length === makeWav(3).length, { got: bytes.length });

    const hb = await http('POST', `/internal/jobs/${jobId}/heartbeat`, { headers: asInternal });
    eq('a long job can heartbeat to keep its claim', hb.status, 200);

    const done = await http('POST', `/internal/jobs/${jobId}/complete`, {
      headers: asInternal, body: { transcript: TRANSCRIPT, duration_sec: 10 },
    });
    eq('the result is accepted', done.status, 200);

    const purged = await fetch(BASE + `/internal/jobs/${jobId}/audio`, { headers: asInternal });
    eq('the uploaded audio is purged the moment the job finishes', purged.status, 404);
  }

  // =========================================================================
  section('Result views and scope gating');
  {
    const full = await http('GET', `/v1/jobs/${jobId}`, { headers: asKey(devKey) });
    eq('the job is done', full.body.status, 'done');
    check('the full view includes the transcript', !!full.body.transcript, Object.keys(full.body));
    check('…and the report', !!full.body.report, Object.keys(full.body));
    check('…but withholds annotations this key cannot see', full.body.annotations === undefined);
    eq('…and says exactly what was withheld', full.body.omitted, ['annotations']);

    eq('the transcript text is assembled in order', full.body.transcript.text,
      'we went to the park. what happened next? um the dog run away.');
    eq('every segment is present', full.body.transcript.segments.length, 3);
    eq('speaker attribution survives', full.body.transcript.segments[1].speaker, 'Examiner');
    eq('word timings survive', full.body.transcript.segments[0].words[0], { index: 0, word: 'we', start: 0, end: 0.3 });

    const tr = await http('GET', `/v1/jobs/${jobId}/transcript`, { headers: asKey(devKey) });
    eq('the transcript section endpoint works', tr.status, 200);
    check('…and returns only the transcript', tr.body.report === undefined && !!tr.body.transcript);

    const ann = await http('GET', `/v1/jobs/${jobId}/annotations`, { headers: asKey(devKey) });
    eq('the annotations endpoint is 403 without the scope', ann.status, 403);
    eq('…with a code a client can branch on', ann.body.error?.code, 'insufficient_scope');
    eq('…and names the scope required', ann.body.error?.required_scope, 'annotations:read');

    const asReport = await http('GET', `/v1/jobs/${jobId}?view=report`, { headers: asKey(devKey) });
    check('?view=report drops the transcript entirely', asReport.body.transcript === undefined && !!asReport.body.report);
  }

  // =========================================================================
  section('Report correctness');
  //
  // Derived by hand from TRANSCRIPT above:
  //   13 words over 10 s  -> 78 wpm
  //   annotations: 1 pause + 1 filler + 1 visible morpheme ('dog' + 's') = 3
  //   NTW/NDW/MLU exclude the Examiner and exclude mazes ('um' is a filler)
  //   NTW = 5 (seg0) + 4 (seg2 minus 'um') = 9
  //   NDW = we, went, to, the, park, dog, run, away = 8
  //   2 utterances (each segment ends in terminal punctuation): MLUw = 9/2 = 4.5
  //   morphemes: seg0 5x1, seg2 the/run/away 1 each + dog counts 2 -> 10; MLUm = 10/2 = 5
  {
    const r = (await http('GET', `/v1/jobs/${jobId}/report`, { headers: asKey(devKey) })).body.report;
    eq('pauses are counted', r.annotationCounts.pause, 1);
    eq('filler words are counted', r.annotationCounts.filler, 1);
    eq('visible morphemes are counted', r.annotationCounts.morpheme, 1);
    eq('nothing is invented for absent annotation types', r.annotationCounts.repetition, 0);
    eq('total annotations add up', r.totalAnnotations, 3);
    eq('annotation types present are listed', r.annotationTypes.sort(), ['filler', 'morpheme', 'pause']);
    eq('total words counts every speaker', r.totalWords, 13);
    eq('duration is the last segment end', r.totalDuration, 10);
    near('speaking rate is words per minute', r.speakingRate, 78);
    near('annotation rate is per 100 words', r.annotationRate, 3 / 13 * 100);
    eq('segments are counted', r.segmentCount, 3);
    eq('speakers are counted', r.speakerCount, 2);
    eq('NTW excludes the examiner and mazes', r.ntw, 9);
    eq('NDW counts distinct lemmas', r.ndw, 8);
    eq('utterances split on terminal punctuation', r.utteranceCount, 2);
    near('MLU in words', r.mluw, 4.5);
    near('MLU in morphemes counts a bound morpheme as two', r.mlum, 5);
    eq('pause count matches the annotation count', r.numberOfPauses, 1);
  }

  // =========================================================================
  section('Text-analysis endpoints');
  {
    // These proxy a separate CPU service, so the suite asserts the parts that run BEFORE any
    // upstream call — the scope gate and request validation — which is where the security is.
    const noScope = await http('POST', '/v1/cunit', {
      body: 'the dog ran', headers: { ...asKey(devKey), 'Content-Type': 'text/plain' }, raw: true,
    });
    eq('a text endpoint requires the text:read scope', noScope.body.error?.code, 'insufficient_scope');
    eq('…and names the scope a client must ask for', noScope.body.error?.required_scope, 'text:read');

    const wrongMethod = await http('GET', '/v1/cunit', { headers: asKey(devKey) });
    eq('a text endpoint is POST-only', wrongMethod.body.error?.code, 'method_not_allowed');

    // Grant text:read, mint a text-only key, and check body validation (no upstream needed).
    await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { scopes: ['transcript:read', 'report:read', 'text:read'] },
    });
    const mk = await http('POST', '/portal/api/keys', {
      cookieAs: 'dev', body: { name: 'text', scopes: ['text:read'] },
    });
    const textKey = mk.body.key;
    check('a key can be minted with text:read', typeof textKey === 'string' && mk.body.scopes.includes('text:read'), mk.body);

    const empty = await http('POST', '/v1/maze', {
      body: new Uint8Array(0), headers: { ...asKey(textKey), 'Content-Type': 'text/plain' }, raw: true,
    });
    eq('an empty text body is rejected before any upstream call', empty.body.error?.code, 'empty_body');

    // Give back the key slot and the original allowance so later sections are unaffected.
    await http('DELETE', `/portal/api/keys/${mk.body.id}`, { cookieAs: 'dev' });
    await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { scopes: ['transcript:read', 'report:read'] },
    });
  }

  // =========================================================================
  section('Tenant isolation');
  {
    const other = await http('POST', '/portal/api/register',
      { body: { email: 'other@example.test', password: 'a-third-long-password' } });
    check('a second developer registers', other.status === 200, other.body);

    const list = await http('GET', '/portal/api/admin/developers', { cookieAs: 'admin' });
    const otherId = list.body.data.find((x) => x.email === 'other@example.test').id;
    await http('PATCH', `/portal/api/admin/developers/${otherId}`, {
      cookieAs: 'admin', body: { status: 'active', scopes: ['transcript:read', 'report:read'] },
    });
    await http('POST', '/portal/api/login',
      { body: { email: 'other@example.test', password: 'a-third-long-password' }, cookieAs: 'other' });
    const otherKey = (await http('POST', '/portal/api/keys',
      { cookieAs: 'other', body: { name: 'other key', scopes: ['transcript:read'] } })).body.key;

    const peek = await http('GET', `/v1/jobs/${jobId}`, { headers: asKey(otherKey) });
    eq("another developer's job is invisible, not merely forbidden", peek.status, 404);

    const del = await http('DELETE', `/v1/jobs/${jobId}`, { headers: asKey(otherKey) });
    eq("…and cannot be deleted either", del.status, 404);

    const mine = await http('GET', '/v1/jobs', { headers: asKey(otherKey) });
    eq('a job list only ever contains your own jobs', mine.body.data.length, 0);
  }

  // =========================================================================
  section('Failure handling');
  {
    const sub = await submitWav(devKey, { seconds: 1 });
    const id = sub.body.id;

    await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'w' } });
    const t1 = await http('POST', `/internal/jobs/${id}/fail`, {
      headers: asInternal, body: { error: 'AI network error', kind: 'transient' },
    });
    eq('a transient failure with budget left is requeued', t1.body.requeued, true);
    eq('…and the job is queued again', (await http('GET', `/v1/jobs/${id}`, { headers: asKey(devKey) })).body.status, 'queued');

    // MAX_ATTEMPTS is 2 in the test config, so the second failure settles it.
    await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'w' } });
    const t2 = await http('POST', `/internal/jobs/${id}/fail`, {
      headers: asInternal, body: { error: 'AI network error', kind: 'transient' },
    });
    eq('past the attempt budget it stops retrying', t2.body.requeued, false);

    const errored = await http('GET', `/v1/jobs/${id}`, { headers: asKey(devKey) });
    eq('a failed job is still HTTP 200', errored.status, 200);
    eq('…with status error in the body', errored.body.status, 'error');
    eq('…and a structured error', errored.body.error?.code, 'transient');

    const perm = await submitWav(devKey, { seconds: 1 });
    await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'w' } });
    const p = await http('POST', `/internal/jobs/${perm.body.id}/fail`, {
      headers: asInternal, body: { error: 'AI returned no segments', kind: 'permanent' },
    });
    eq('a permanent failure never retries', p.body.requeued, false);

    // Silence is a legitimate result, not a failure.
    const quiet = await submitWav(devKey, { seconds: 1 });
    await http('POST', '/internal/claim', { headers: asInternal, body: { worker_id: 'w' } });
    await http('POST', `/internal/jobs/${quiet.body.id}/complete`, { headers: asInternal, body: { no_text: true } });
    const q = await http('GET', `/v1/jobs/${quiet.body.id}`, { headers: asKey(devKey) });
    eq('audio with no speech finishes done, not error', q.body.status, 'done');
    eq('…and says so explicitly', q.body.no_speech_detected, true);
  }

  // =========================================================================
  section('Quota, reset, and the API lock');
  {
    // Quota is 5 minutes; the submissions so far have spent well under that.
    const before = (await http('GET', '/v1/me', { headers: asKey(devKey) })).body.quota;
    check('used minutes are being tracked', before.minutes_used > 0, before);

    // 400 s at a 1 kHz sample rate: past the 5-minute quota, but only ~800 KB, so it clears
    // the 1 MB upload cap and the quota check is what refuses it.
    const over = await submitWav(devKey, { seconds: 400, rate: 1000 });
    eq('a submission past the quota is refused', over.body.error?.code, 'quota_exceeded');
    eq('…with 402, not 400', over.status, 402);

    // The admin reset moves the counting window; it must not delete usage history.
    const reset = await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { reset_usage: true },
    });
    eq('the admin resets the used-audio counter', reset.status, 200);
    const after = (await http('GET', '/v1/me', { headers: asKey(devKey) })).body.quota;
    eq('used minutes are back to zero', after.minutes_used, 0);
    const stillThere = await http('GET', '/portal/api/usage?days=30', { cookieAs: 'dev' });
    check('…but the usage history survives the reset', stillThere.body.totals.requests > 0, stillThere.body.totals);

    const ok = await submitWav(devKey, { seconds: 2 });
    eq('submissions work again after the reset', ok.status, 202);

    // A lifetime cap behaves like a monthly one, minus the rollover.
    await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { quota_period: 'total', quota_minutes: 1 },
    });
    const lifetime = (await http('GET', '/v1/me', { headers: asKey(devKey) })).body.quota;
    eq('a total cap reports as total', lifetime.period, 'total');
    eq('…and never resets on its own', lifetime.resets_at, null);
    const past = await submitWav(devKey, { seconds: 120, rate: 1000 });
    eq('a total cap blocks just like a monthly one', past.body.error?.code, 'quota_exceeded');

    await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { quota_period: 'monthly', quota_minutes: 0, reset_usage: true },
    });
    const unlimited = (await http('GET', '/v1/me', { headers: asKey(devKey) })).body.quota;
    eq('a zero limit means unlimited', unlimited.unlimited, true);

    // The lock stops API traffic without touching keys or the portal login.
    const lock = await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { api_locked: true, lock_reason: 'Payment overdue' },
    });
    eq('the admin locks API access', lock.status, 200);

    const locked = await http('GET', '/v1/me', { headers: asKey(devKey) });
    eq('a locked account cannot call the API', locked.status, 403);
    eq('…with a code a client can branch on', locked.body.error?.code, 'api_locked');
    check('…and the reason is passed through', locked.body.error?.message.includes('Payment overdue'), locked.body);

    const lockedSubmit = await submitWav(devKey, { seconds: 1 });
    eq('a locked account cannot submit either', lockedSubmit.body.error?.code, 'api_locked');

    const portalStillWorks = await http('GET', '/portal/api/me', { cookieAs: 'dev' });
    eq('…but the portal still works so they can see why', portalStillWorks.status, 200);
    eq('…and the portal says it is locked', portalStillWorks.body.developer.api_locked, true);

    await http('PATCH', `/portal/api/admin/developers/${devId}`, { cookieAs: 'admin', body: { api_locked: false } });
    eq('unlocking restores access', (await http('GET', '/v1/me', { headers: asKey(devKey) })).status, 200);
  }

  // =========================================================================
  section('Suspension and revocation');
  {
    const revocable = (await http('POST', '/portal/api/keys',
      { cookieAs: 'dev', body: { name: 'to revoke', scopes: ['report:read'] } })).body.key;
    eq('the new key works', (await http('GET', '/v1/me', { headers: asKey(revocable) })).status, 200);

    const keys = await http('GET', '/portal/api/keys', { cookieAs: 'dev' });
    const target = keys.body.data.find((k) => k.name === 'to revoke');
    await http('DELETE', `/portal/api/keys/${target.id}`, { cookieAs: 'dev' });
    const dead = await http('GET', '/v1/me', { headers: asKey(revocable) });
    eq('a revoked key stops working immediately', dead.body.error?.code, 'key_revoked');

    // Narrowing the allowance must bite on keys that already exist.
    await http('PATCH', `/portal/api/admin/developers/${devId}`,
      { cookieAs: 'admin', body: { scopes: ['report:read'] } });
    const narrowed = await http('GET', '/v1/me', { headers: asKey(devKey) });
    eq('narrowing the allowance narrows existing keys retroactively', narrowed.body.scopes, ['report:read']);
    const nowDenied = await http('GET', `/v1/jobs/${jobId}/transcript`, { headers: asKey(devKey) });
    eq('…so a section it used to reach is now refused', nowDenied.body.error?.code, 'insufficient_scope');

    await http('PATCH', `/portal/api/admin/developers/${devId}`,
      { cookieAs: 'admin', body: { status: 'suspended' } });
    const suspended = await http('GET', '/v1/me', { headers: asKey(devKey) });
    eq('a suspended account cannot call the API', suspended.body.error?.code, 'account_inactive');
    const kicked = await http('GET', '/portal/api/me', { cookieAs: 'dev' });
    eq('…and its portal sessions are killed at once', kicked.status, 401);

    await http('PATCH', `/portal/api/admin/developers/${devId}`, {
      cookieAs: 'admin', body: { status: 'active', scopes: ['transcript:read', 'report:read'] },
    });
    await http('POST', '/portal/api/login',
      { body: { email: devEmail, password: 'another-long-password' }, cookieAs: 'dev' });
  }

  // =========================================================================
  section('Rate limiting');
  {
    await http('PATCH', `/portal/api/admin/developers/${devId}`, { cookieAs: 'admin', body: { rate_per_min: 1 } });
    const limited = (await http('POST', '/portal/api/keys',
      { cookieAs: 'dev', body: { name: 'slow', scopes: ['report:read'], rate_per_min: 3 } })).body.key;

    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await http('GET', '/v1/me', { headers: asKey(limited) })).status);
    check('requests start succeeding', codes[0] === 200, codes);
    check('…then get 429 once over the limit', codes.includes(429), codes);

    const last = await http('GET', '/v1/me', { headers: asKey(limited) });
    eq('the 429 carries a retry hint', typeof last.body.error?.retry_after_seconds, 'number');

    await http('PATCH', `/portal/api/admin/developers/${devId}`, { cookieAs: 'admin', body: { rate_per_min: 600 } });
  }

  // =========================================================================
  section('Admin monitoring');
  {
    const usage = await http('GET', '/portal/api/admin/usage?days=30', { cookieAs: 'admin' });
    eq('the system-wide usage view loads', usage.status, 200);
    check('it counts requests across all developers', usage.body.totals.requests > 0, usage.body.totals);
    check('it counts distinct active developers', usage.body.totals.active_developers >= 2, usage.body.totals);
    check('it has a daily series to chart', Array.isArray(usage.body.daily) && usage.body.daily.length > 0);
    check('it lists every live key in the system', usage.body.active_keys.length >= 2, usage.body.active_keys.length);
    check('…with the traffic each one is pulling',
      usage.body.active_keys.every((k) => typeof k.requests === 'number' && typeof k.email === 'string'));
    check('…and never the key material itself', !JSON.stringify(usage.body).includes(devKey.slice(10)));
    check('it breaks usage down by developer', usage.body.by_developer.length >= 2, usage.body.by_developer.length);

    const overview = await http('GET', '/portal/api/admin/overview', { cookieAs: 'admin' });
    eq('the queue overview loads', overview.status, 200);
    check('it reports queue depth', typeof overview.body.queue?.queued === 'number', overview.body.queue);
    check('it surfaces recent job errors', Array.isArray(overview.body.recent_errors));

    const devs = await http('GET', '/portal/api/admin/developers', { cookieAs: 'admin' });
    const row = devs.body.data.find((d) => d.id === devId);
    check('each developer shows their used minutes', typeof row.used_minutes === 'number', row);
    check('…their live key count', typeof row.active_keys === 'number', row);
    check('…and no password material', !JSON.stringify(devs.body).includes('pbkdf2$'));

    const selfLock = await http('PATCH', '/portal/api/admin/developers/' +
      devs.body.data.find((d) => d.email === adminEmail).id,
      { cookieAs: 'admin', body: { status: 'suspended' } });
    eq('an admin cannot suspend their own account', selfLock.body.error?.code, 'self_lockout');
  }

  // =========================================================================
  section('Developer-facing portal views');
  {
    const me = await http('GET', '/portal/api/me', { cookieAs: 'dev' });
    eq('the developer sees their own account', me.body.developer.email, devEmail);
    check('…and the scope vocabulary for the UI', Array.isArray(me.body.all_scopes));

    const usage = await http('GET', '/portal/api/usage?days=30', { cookieAs: 'dev' });
    check('their usage is broken down by key', Array.isArray(usage.body.by_key));
    check('…and by endpoint', Array.isArray(usage.body.by_endpoint));
    check('…with a daily series', Array.isArray(usage.body.daily));

    const jobs = await http('GET', '/portal/api/jobs', { cookieAs: 'dev' });
    check('their jobs are listed', jobs.body.data.length > 0, jobs.body.data.length);
    check('…without the transcript payload in the list', !('transcript' in (jobs.body.data[0] || {})));

    const html = await fetch(BASE + '/');
    check('the portal page renders', html.ok);
    const body = await html.text();
    check('…as a self-contained document with no external fetches',
      !/src="https?:\/\//.test(body) && !/href="https?:\/\/[^"]*\.css/.test(body));

    // The portal is JS generated by a TypeScript template literal, so a stray escape can
    // emit source the browser refuses to parse — and the page still returns a healthy 200
    // while the app never boots. Parse what actually ships. This shipped broken once
    // ("\n" inside a single-quoted string became a real newline); it must never again.
    for (const [page, markup] of [['portal', body], ['docs', await (await fetch(BASE + '/docs')).text()]]) {
      const scripts = [...markup.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      check(`the ${page} ships at least one script block`, scripts.length > 0);
      scripts.forEach((src, i) => {
        let err = null;
        try { new vm.Script(src); } catch (e) { err = e.message; }
        check(`…${page} script ${i} parses in a browser`, err === null, err);
      });
    }

    // "Match the SATE app" is a requirement, so assert the shared tokens really shipped.
    const sate = { '--bg: #fafafa': 'page background', '--primary: #2563eb': 'primary blue',
                   "'Segoe UI'": 'app font stack', '0 1px 2px 0 rgba(0, 0, 0, .05)': 'card shadow' };
    for (const [token, what] of Object.entries(sate)) {
      check(`…using the SATE ${what}`, body.includes(token), token);
    }
    check('…with the SATE wordmark in the header', body.includes('class="wordmark"'));

    // Every tab in the row must resolve to a view or an explicit link.
    for (const tab of ['overview', 'keys', 'usage', 'jobs', 'playground', 'developers', 'system']) {
      check(`the ${tab} tab has a view behind it`, body.includes(`VIEWS.${tab} =`), tab);
    }
    check('Docs is a link, not a view', body.includes("href: '/docs'"));

    const docs = await fetch(BASE + '/docs');
    check('the API reference renders', docs.ok);
    const docsBody = await docs.text();
    check('…and documents the three views',
      ['transcript', 'report', 'full'].every((v) => docsBody.includes(v)));
    check('…and the text-analysis endpoints',
      ['/v1/cunit', '/v1/maze', '/v1/morpheme', 'text:read'].every((v) => docsBody.includes(v)));
    check('…and every documented error code exists in the code',
      ['quota_exceeded', 'api_locked', 'insufficient_scope', 'rate_limited', 'key_revoked']
        .every((c) => docsBody.includes(c)));

    const langs = ['curl', 'python', 'node', 'browser', 'go', 'php', 'java', 'csharp', 'ruby'];
    check('…with a runnable client in every advertised language',
      langs.every((l) => docsBody.includes(`data-lang="${l}"`)), langs);
    check('…each one actually calling this API host', (docsBody.match(/\/v1\/jobs/g) || []).length >= 9);
    check('…and none of them shipping a real key',
      !/sate_live_[a-z0-9]{20,}/.test(docsBody));
    check('the samples are HTML-escaped, not raw markup',
      !docsBody.includes('<?php\n') || docsBody.includes('&lt;?php'));
  }

  // =========================================================================
  section('Retention');
  {
    const sub = await submitWav(devKey, { seconds: 1 });
    const del = await http('DELETE', `/v1/jobs/${sub.body.id}`, { headers: asKey(devKey) });
    eq('a developer can delete their own job', del.body.deleted, true);
    eq('…and it is gone', (await http('GET', `/v1/jobs/${sub.body.id}`, { headers: asKey(devKey) })).status, 404);
  }

  // =========================================================================
  report();
}

function report() {
  const total = passed + failures.length;
  console.log(`\n${'─'.repeat(58)}`);
  if (failures.length === 0) {
    console.log(`${C.g}${C.b}All ${total} checks passed.${C.x}`);
  } else {
    console.log(`${C.r}${C.b}${failures.length} of ${total} checks failed:${C.x}`);
    for (const f of failures) {
      console.log(`  ${C.r}✗${C.x} [${f.group}] ${f.label}`);
      if (f.detail !== undefined) console.log(`    ${C.d}${JSON.stringify(f.detail)}${C.x}`);
    }
  }
  console.log('');
}

main()
  .then(() => { stopServer(); process.exit(failures.length ? 1 : 0); })
  .catch((e) => {
    console.error(`\n${C.r}Suite aborted:${C.x} ${e.stack || e.message}`);
    stopServer();
    process.exit(1);
  });
