// SATE status page — a self-hosted, status.claude.com-style page with 90-day
// uptime history. A cron trigger probes each service and records the result to D1;
// the fetch handler renders the page from that history.
//
// Edit TARGETS for your environment. `reachableIsUp` treats any response (even
// 401/404) as "up" — useful for an API whose root needs auth but is clearly alive.
// `authSecret` names a Worker secret whose value is sent as `Authorization: Bearer`.

// EXTERNAL services only. A Cloudflare Worker CANNOT probe resources on the SAME
// Cloudflare account (Pages/Workers) — that returns error 1042 — so the CF-hosted
// docs site, service monitor, and cf-processor Worker are intentionally NOT here.
// Monitor those from an external prober (see status/README.md). Verify/adjust these
// URLs for your project (Supabase ref, ngrok host).
const SUPA = 'https://zlgdpivcbmaodgokkdvz.supabase.co';
const TARGETS = [
  { name: 'device-api (edge fn)', url: SUPA.replace('.supabase.co', '.functions.supabase.co') + '/device-api/firmware/latest', expect: [200, 401, 404], reachableIsUp: true },
  { name: 'Supabase API', url: SUPA + '/rest/v1/', expect: [200, 401, 404], reachableIsUp: true },
  { name: 'Storage (firmware)', url: SUPA + '/storage/v1/object/public/firmware/', expect: [200, 400, 404], reachableIsUp: true },
  { name: 'AI /process', url: 'https://sate-v1-5.ngrok.io/', expect: [200, 404, 502], reachableIsUp: true },
  { name: 'Norms API (edge fn)', url: SUPA + '/functions/v1/childes-norms', expect: [200, 400, 401, 405], reachableIsUp: true },
  { name: 'Norms data (CHILDES)', url: 'https://childes-metrics.ngrok.app/', expect: [200, 404, 405, 502], reachableIsUp: true },
  { name: 'Web app (clinician)', url: 'https://sate-hardwave.vercel.app/', expect: [200, 401, 404], reachableIsUp: true },
];
// NOTE: same-Cloudflare-account resources (the cf-processor Worker, the docs and
// test Pages sites) can't be probed from this Worker (error 1042) — they need an
// external prober. cf-processor health is covered indirectly via the pipeline digest.

const WINDOW_DAYS = 90;
const DAY = 86400;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const results = await runChecks(env);
      await evaluateAndAlert(env, results);   // email on any NEW error
      await maybeDailyReport(env, results);   // once/day: a full infrastructure report
    })());
  },
  async fetch(req, env, ctx) {
    try {
      return await handle(req, env);
    } catch (e) {
      return new Response('status worker error: ' + (e && e.message || e), { status: 500 });
    }
  },
};

async function handle(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/check') {
      // On-demand probe (seed/test). Gate with ?key=<CHECK_KEY secret> if set.
      if (env.CHECK_KEY && url.searchParams.get('key') !== env.CHECK_KEY) {
        return new Response('forbidden', { status: 403 });
      }
      const results = await runChecks(env);
      const alerted = await evaluateAndAlert(env, results);
      // ?daily=1 force-sends the daily infrastructure report now (test/on-demand),
      // bypassing the once-a-day hour/date gate.
      let report = null;
      if (url.searchParams.get('daily') === '1') {
        await sendDailyReport(env, results, await fetchDigest(env), new Date().toISOString().slice(0, 10));
        report = 'sent';
      }
      return Response.json({ ok: true, checked: TARGETS.map((t) => t.name), alert: alerted, report });
    }
    if (url.pathname === '/api/history') {
      return Response.json(await history(env));
    }
    return new Response(await renderPage(env), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
}

async function runChecks(env) {
  const now = Math.floor(Date.now() / 1000);
  const stmts = [];
  const results = [];
  for (const t of TARGETS) {
    let status = 'down', code = 0;
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 10000);
      const headers = {};
      if (t.authSecret && env[t.authSecret]) headers['Authorization'] = 'Bearer ' + env[t.authSecret];
      const r = await fetch(t.url, { method: t.method || 'GET', headers, signal: ctrl.signal, redirect: 'follow' });
      clearTimeout(to);
      code = r.status;
      const ok = (t.expect || [200]).includes(code);
      if (ok) status = 'up';
      else if (code >= 500 || code === 0) status = 'down';
      else status = t.reachableIsUp ? 'up' : 'degraded';
    } catch (_e) {
      status = 'down';
      code = 0;
    }
    const latency = Date.now() - start;
    results.push({ name: t.name, status, code, latency });
    stmts.push(env.DB.prepare(
      'INSERT INTO checks (component, ts, status, code, latency_ms) VALUES (?,?,?,?,?)'
    ).bind(t.name, now, status, code, latency));
  }
  stmts.push(env.DB.prepare('DELETE FROM checks WHERE ts < ?').bind(now - (WINDOW_DAYS + 10) * DAY));
  if (stmts.length) await env.DB.batch(stmts);
  return results;
}

async function history(env) {
  const since = Math.floor(Date.now() / 1000) - WINDOW_DAYS * DAY;
  // per component per day: how many down / degraded / total samples
  const agg = await env.DB.prepare(
    `SELECT component, ts/${DAY} AS day,
       SUM(CASE WHEN status='down' THEN 1 ELSE 0 END) AS down,
       SUM(CASE WHEN status='degraded' THEN 1 ELSE 0 END) AS deg,
       COUNT(*) AS n
     FROM checks WHERE ts > ? GROUP BY component, day`
  ).bind(since).all();
  // latest sample per component (current status)
  const latest = await env.DB.prepare(
    `SELECT c.component, c.status, c.code, c.latency_ms, c.ts
     FROM checks c
     JOIN (SELECT component, MAX(ts) mts FROM checks GROUP BY component) m
       ON m.component = c.component AND m.mts = c.ts`
  ).all();

  const today = Math.floor(Date.now() / 1000 / DAY);
  const byComp = {};
  for (const t of TARGETS) {
    byComp[t.name] = { name: t.name, days: {}, upSamples: 0, totalSamples: 0, current: 'nodata', ts: 0 };
  }
  for (const r of (agg.results || [])) {
    const c = byComp[r.component] || (byComp[r.component] = { name: r.component, days: {}, upSamples: 0, totalSamples: 0, current: 'nodata', ts: 0 });
    const up = r.n - r.down - r.deg;
    c.days[r.day] = r.down > 0 ? 'down' : (r.deg > 0 ? 'degraded' : 'up');
    c.upSamples += up;
    c.totalSamples += r.n;
  }
  for (const r of (latest.results || [])) {
    if (byComp[r.component]) { byComp[r.component].current = r.status; byComp[r.component].ts = r.ts; }
  }
  // build the ordered 90-day array (oldest → newest) per component
  const components = TARGETS.map((t) => {
    const c = byComp[t.name];
    const bars = [];
    for (let d = today - WINDOW_DAYS + 1; d <= today; d++) bars.push(c.days[d] || 'nodata');
    const uptime = c.totalSamples ? (c.upSamples / c.totalSamples) * 100 : null;
    return { name: c.name, current: c.current, uptime, bars, ts: c.ts };
  });
  return { generated_at: new Date().toISOString(), window_days: WINDOW_DAYS, components };
}

// Response-time / traffic stats per tier over the last 24h (from the check history).
async function latencyStats(env) {
  const since = Math.floor(Date.now() / 1000) - DAY;
  const agg = await env.DB.prepare(
    `SELECT component, AVG(latency_ms) avg_ms, MAX(latency_ms) max_ms, COUNT(*) n
     FROM checks WHERE ts > ? AND code != 0 GROUP BY component`
  ).bind(since).all();
  const latest = await env.DB.prepare(
    `SELECT c.component, c.latency_ms FROM checks c
     JOIN (SELECT component, MAX(ts) mts FROM checks GROUP BY component) m
       ON m.component = c.component AND m.mts = c.ts`
  ).all();
  const lat = {}; for (const r of (latest.results || [])) lat[r.component] = r.latency_ms;
  const map = {}; for (const r of (agg.results || [])) map[r.component] = r;
  return TARGETS.map((t) => {
    const a = map[t.name] || {};
    return { name: t.name, latest: lat[t.name] ?? null, avg: a.avg_ms != null ? Math.round(a.avg_ms) : null, n: a.n || 0 };
  });
}

const RANK = { up: 0, nodata: 1, degraded: 2, down: 3 };
function overall(components) {
  let worst = 'up', any = false;
  for (const c of components) {
    if (c.current === 'nodata') continue;
    any = true;
    if (RANK[c.current] > RANK[worst]) worst = c.current;
  }
  if (!any) return 'nodata';
  return worst;
}

async function renderPage(env) {
  const h = await history(env);
  const ov = overall(h.components);
  const OVR = {
    up: { t: 'All systems operational', c: '#3ba55d' },
    degraded: { t: 'Degraded performance', c: '#e0a23c' },
    down: { t: 'Major outage', c: '#e8695b' },
    nodata: { t: 'Awaiting first checks…', c: '#74838a' },
  }[ov];
  const PILL = { up: ['Operational', '#3ba55d'], degraded: ['Degraded', '#e0a23c'], down: ['Outage', '#e8695b'], nodata: ['No data', '#74838a'] };
  const barColor = { up: '#3ba55d', degraded: '#e0a23c', down: '#e8695b', nodata: '#2a3340' };

  const rows = h.components.map((c) => {
    const [ptxt, pcol] = PILL[c.current] || PILL.nodata;
    const bars = c.bars.map((s) => `<i style="background:${barColor[s]}" title="${s}"></i>`).join('');
    const up = c.uptime == null ? '—' : c.uptime.toFixed(2) + '%';
    return `<div class="comp">
      <div class="chead"><span class="cname">${esc(c.name)}</span><span class="pill" style="color:${pcol};background:${pcol}22">${ptxt}</span></div>
      <div class="bars">${bars}</div>
      <div class="cfoot"><span>${WINDOW_DAYS} days ago</span><span class="up">${up} uptime</span><span>today</span></div>
    </div>`;
  }).join('');

  const lat = await latencyStats(env);
  const maxAvg = Math.max(1, ...lat.map((l) => l.avg || 0));
  const totalChecks = lat.reduce((s, l) => s + l.n, 0);
  const trafficRows = lat.map((l) => {
    const w = l.avg ? Math.max(4, Math.round((l.avg / maxAvg) * 100)) : 0;
    return `<div class="trow"><span class="tname">${esc(l.name)}</span>` +
      `<div class="tbar"><span style="width:${w}%"></span></div>` +
      `<span class="tnum">${l.latest != null ? l.latest + ' ms' : '—'}<small>${l.avg != null ? ' · avg ' + l.avg : ''}</small></span></div>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SATE Status</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0f1417;color:#e7eeea;font:15px/1.6 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:840px;margin:0 auto;padding:28px 20px 60px}
  header{display:flex;align-items:center;gap:12px;margin-bottom:22px}
  h1{font-size:18px;margin:0;font-weight:640}
  .banner{display:flex;align-items:center;gap:12px;background:#161d21;border:1px solid #26302f;border-left:4px solid ${OVR.c};border-radius:12px;padding:16px 18px;margin-bottom:26px}
  .banner .d{width:12px;height:12px;border-radius:50%;background:${OVR.c}}
  .banner .t{font-size:17px;font-weight:620}
  .comp{background:#161d21;border:1px solid #26302f;border-radius:12px;padding:16px 18px;margin-bottom:12px}
  .chead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
  .cname{font-weight:600}
  .pill{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px}
  .bars{display:flex;gap:2px;align-items:stretch;height:34px}
  .bars i{flex:1;border-radius:2px;min-width:2px}
  .cfoot{display:flex;justify-content:space-between;color:#74838a;font-size:12px;margin-top:8px}
  .cfoot .up{color:#a9b6bc}
  footer{color:#74838a;font-size:12px;text-align:center;margin-top:26px}
  a{color:#2fb39c}
  .traffic{background:#161d21;border:1px solid #26302f;border-radius:12px;padding:16px 18px;margin:24px 0 12px}
  .thead{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;font-weight:620}
  .thead .tsub{color:#74838a;font-size:12px;font-weight:400}
  .trow{display:flex;align-items:center;gap:12px;margin:0 0 9px}
  .tname{flex:0 0 175px;font-size:13px;color:#cdd8d6}
  .tbar{flex:1;height:8px;background:#0f1417;border-radius:999px;overflow:hidden}
  .tbar span{display:block;height:100%;background:#2fb39c;border-radius:999px}
  .tnum{flex:0 0 auto;font-size:12px;color:#a9b6bc;font-variant-numeric:tabular-nums;min-width:120px;text-align:right}
  .tnum small{color:#74838a}
  @media(max-width:560px){.tname{flex-basis:110px}.tnum{min-width:78px}}
</style></head><body><div class="wrap">
  <header><h1>🩺 SATE Status</h1></header>
  <div class="banner"><span class="d"></span><span class="t">${OVR.t}</span></div>
  ${rows || '<p style="color:#74838a">No components configured — edit <code>TARGETS</code> in the Worker.</p>'}
  <section class="traffic"><div class="thead"><span>Response time &amp; traffic</span><span class="tsub">last 24h · ${totalChecks} checks</span></div>${trafficRows}</section>
  <footer>Updated ${esc(h.generated_at)} · ${WINDOW_DAYS}-day history · probed every 5 min by a Cloudflare Worker cron</footer>
</div></body></html>`;
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}


// ---------------------------------------------------------------------------
// Error alerting: email the operator when anything goes wrong, and again when it
// clears. Fires ONLY on a change in the problem set (so a lingering issue does not
// mail every 5 minutes). A settled 'error' session is alerted once and then stays
// quiet (it can't auto-clear); only an ACTIVELY ongoing condition — a service DOWN or
// a job stuck in 'processing' — gets a re-notify, at most once per ALERT_REPEAT_MS.
// State (last problem signature + last-sent time) lives in D1.
// ---------------------------------------------------------------------------
const ALERT_TO = 'caothohoanglong2404@gmail.com';
const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;  // re-remind about an ACTIVE outage at most once a day
const DAILY_REPORT_TZ = 'America/New_York';   // the daily report is sent at 08:00 LOCAL time in
const DAILY_REPORT_HOUR = 8;                  // this zone — DST-aware (Intl handles EDT/EST). The
                                              // cron runs every 5 min; the first tick in this
                                              // local hour mails it (de-duped per local date).

// Pull the device-api health digest (pipeline errors, stuck jobs, offline devices).
// Best-effort: a failure just means the digest is unavailable (the device-api probe
// already covers "device-api unreachable").
async function fetchDigest(env) {
  try {
    const key = env.HEALTH_ALERT_KEY;
    if (!key) return null;
    const r = await fetch(`${SUPA}/functions/v1/device-api/api/health/alerts?key=${encodeURIComponent(key)}`,
      { headers: { apikey: env.SUPA_ANON || '' } });
    return r.ok ? await r.json() : null;
  } catch (_e) {
    return null;
  }
}

// Once per day (the first cron tick at/after DAILY_REPORT_HOUR_UTC), email a full
// infrastructure report — every probed tier + the pipeline health digest — whether or
// not anything is wrong. De-duped by date via alert_state id=2 so it sends exactly once.
// Current wall-clock hour and calendar date in DAILY_REPORT_TZ (DST-aware via Intl).
function reportLocalParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_REPORT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: parseInt(get('hour'), 10) % 24 };
}

async function maybeDailyReport(env, results) {
  const { date, hour } = reportLocalParts(new Date());
  if (hour !== DAILY_REPORT_HOUR) return;
  const row = await env.DB.prepare('SELECT sig FROM alert_state WHERE id = 2').first();
  if (row?.sig === date) return;                   // already sent for this local date
  const digest = await fetchDigest(env);
  await sendDailyReport(env, results, digest, date);
  await env.DB.prepare('INSERT INTO alert_state (id, sig, sent_ms) VALUES (2, ?, ?) ON CONFLICT(id) DO UPDATE SET sig=excluded.sig, sent_ms=excluded.sent_ms')
    .bind(date, Date.now()).run();
}

async function sendDailyReport(env, results, digest, dateStr) {
  if (!env.EMAIL) { console.warn('[daily] EMAIL binding not configured'); return; }
  const tiers = results || [];
  const allUp = tiers.length > 0 && tiers.every((r) => r.status === 'up');
  const errorCount = digest?.error_count ?? 0;
  const stuckCount = digest?.stuck_count ?? 0;
  const offline = digest?.offline_devices || [];
  const healthy = allUp && errorCount === 0 && stuckCount === 0;
  const when = new Date().toISOString();
  const word = (s) => s === 'up' ? 'OK' : s === 'degraded' ? 'DEGRADED' : 'DOWN';

  const tierText = tiers.map((r) => `  ${word(r.status).padEnd(9)}${r.name}  (HTTP ${r.code || '—'}, ${r.latency} ms)`).join('\n');
  const errList = (digest?.recent_errors || []).slice(0, 10)
    .map((e) => `    - ${e.device_serial} session ${e.session_number} (attempts ${e.attempts}): ${String(e.process_error || '').slice(0, 120)}`).join('\n');
  const subject = `[SATE] Daily infrastructure report ${dateStr} — ${healthy ? 'all systems healthy' : 'attention needed'}`;
  const text = [
    `SATE daily infrastructure report — ${when}`, '',
    'Tiers:', tierText, '',
    digest ? `Pipeline: errors=${errorCount}  stuck=${stuckCount}  offline_devices=${offline.length}` : 'Pipeline: (digest unavailable)',
    errList ? '\nRecent errors:\n' + errList : '',
    '', 'Status page: https://sate-status.longcao.workers.dev',
    'You receive this once a day; alerts still fire immediately on any new problem.',
  ].join('\n');

  const rows = tiers.map((r) => {
    const c = r.status === 'up' ? '#15803d' : r.status === 'degraded' ? '#b45309' : '#b91c1c';
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;color:${c};font-weight:600;">${word(r.status)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(r.name)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee;color:#666;">HTTP ${r.code || '—'} · ${r.latency} ms</td></tr>`;
  }).join('');
  const headColor = healthy ? '#15803d' : '#b45309';
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
      <div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;">
        <h1 style="margin:0 0 4px;font-size:19px;color:${headColor};">SATE — daily infrastructure report</h1>
        <p style="margin:0 0 16px;font-size:13px;color:#666;">${dateStr} · generated ${when}</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 16px;">${rows}</table>
        <p style="margin:0 0 6px;font-size:14px;color:#111;"><b>Pipeline:</b> errors=${errorCount} · stuck=${stuckCount} · offline devices=${offline.length}</p>
        ${errList ? `<pre style="font-size:12px;color:#b91c1c;white-space:pre-wrap;margin:0 0 12px;">${escapeHtml(errList)}</pre>` : ''}
        <p style="margin:16px 0 0;font-size:12px;color:#888;">You receive this once a day. Real-time alerts still fire immediately on any new problem. <a href="https://sate-status.longcao.workers.dev" style="color:#0c6b74;">Status page</a></p>
      </div></body></html>`;

  try {
    await env.EMAIL.send({ to: ALERT_TO, from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || 'SATE' }, subject, text, html });
  } catch (e) {
    console.error('[daily] send failed:', e && e.message || e);
  }
}

async function evaluateAndAlert(env, checkResults) {
  const problems = [];

  // (a) any probed service that is DOWN (AI /process, Supabase, Storage, device-api).
  for (const r of (checkResults || [])) {
    if (r.status === 'down') problems.push({ k: `svc:${r.name}`, msg: `${r.name} is DOWN (HTTP ${r.code || 'no response'})` });
  }

  // (b) the pipeline error digest from device-api (AI/audio/processing errors, stuck
  //     jobs, offline devices). Best-effort: a fetch failure just means "device-api
  //     unreachable", already covered by (a).
  const digest = await fetchDigest(env);

  if (digest) {
    for (const e of (digest.recent_errors || [])) {
      problems.push({ k: `err:${e.device_serial}#${e.session_number}`,
        msg: `Recording error — ${e.device_serial} session ${e.session_number} (attempts ${e.attempts}): ${String(e.process_error || '').slice(0, 200)}` });
    }
    for (const s of (digest.stuck_list || [])) {
      problems.push({ k: `stuck:${s.id}`, msg: `Stuck in processing — ${s.device_serial} session ${s.session_number} since ${s.processing_started_at}` });
    }
  }

  const signature = problems.map((p) => p.k).sort().join('|');
  const nowMs = Date.now();

  const row = await env.DB.prepare('SELECT sig, sent_ms FROM alert_state WHERE id = 1').first();
  const prevSig = row?.sig ?? '';
  const prevSentMs = row?.sent_ms ?? 0;

  const changed = signature !== prevSig;
  // Re-remind ONLY for conditions that are actively ongoing and could still change on
  // their own — a service that is DOWN, or a job wedged in 'processing' (the watchdog
  // is still working it). A settled 'error' session has already exhausted its retries
  // and will NEVER auto-clear, so re-reminding it is pure noise: it is alerted ONCE
  // when it first appears, then stays quiet until it is retried (→ "all clear") or a
  // NEW problem joins the set. This is the fix for the repeated same-session emails.
  const hasOngoing = problems.some((p) => p.k.startsWith('svc:') || p.k.startsWith('stuck:'));
  const stale = signature && hasOngoing && (nowMs - prevSentMs) > ALERT_REPEAT_MS;

  let action = 'none';
  if (problems.length > 0 && (changed || stale)) {
    action = 'alert-sent';
    await sendAlertEmail(env, problems, digest);
    await env.DB.prepare('INSERT INTO alert_state (id, sig, sent_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sig=excluded.sig, sent_ms=excluded.sent_ms')
      .bind(signature, nowMs).run();
  } else if (problems.length === 0 && prevSig) {
    action = 'recovered-sent';
    await sendRecoveredEmail(env);
    await env.DB.prepare('INSERT INTO alert_state (id, sig, sent_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sig=excluded.sig, sent_ms=excluded.sent_ms')
      .bind('', nowMs).run();
  } else if (changed) {
    action = 'recorded-no-mail';
    // problem set shrank but is not empty, or first clean run: record without mailing.
    await env.DB.prepare('INSERT INTO alert_state (id, sig, sent_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET sig=excluded.sig, sent_ms=excluded.sent_ms')
      .bind(signature, prevSentMs).run();
  }
  return { action, problems: problems.length, keys: problems.map((p) => p.k) };
}

async function sendAlertEmail(env, problems, digest) {
  if (!env.EMAIL) { console.warn('[alert] EMAIL binding not configured; problems:', problems.map((p) => p.msg)); return; }
  const when = new Date().toISOString();
  const lines = problems.map((p) => `• ${p.msg}`).join('\n');
  const counts = digest ? `errors=${digest.error_count} stuck=${digest.stuck_count} offline=${(digest.offline_devices || []).length}` : '';
  const subject = `[SATE] ${problems.length} issue${problems.length > 1 ? 's' : ''} detected` + (problems.some((p) => p.k.startsWith('svc:')) ? ' — a service is DOWN' : '');
  const text = [`SATE detected ${problems.length} issue(s) at ${when}.`, '', lines, '', counts, '', 'Status page: https://sate-status.pages.dev', 'This is an automated alert; you will get one more email when it clears.'].join('\n');
  const htmlList = problems.map((p) => `<li style="margin:0 0 6px;color:#b91c1c;">${escapeHtml(p.msg)}</li>`).join('');
  try {
    await env.EMAIL.send({
      to: ALERT_TO,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || 'SATE' },
      subject,
      text,
      html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
        <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;">
          <h1 style="margin:0 0 6px;font-size:19px;color:#111;">SATE — ${problems.length} issue${problems.length > 1 ? 's' : ''} detected</h1>
          <p style="margin:0 0 16px;font-size:13px;color:#666;">${when}${counts ? ' · ' + escapeHtml(counts) : ''}</p>
          <ul style="margin:0 0 20px;padding-left:20px;font-size:14px;line-height:1.5;">${htmlList}</ul>
          <p style="margin:0;font-size:13px;color:#666;"><a href="https://sate-status.pages.dev" style="color:#0c6b74;">Open the status page</a> · you'll get one more email when this clears.</p>
        </div></body></html>`,
    });
  } catch (e) { console.error('[alert] send failed:', e && e.message || e); }
}

async function sendRecoveredEmail(env) {
  if (!env.EMAIL) return;
  const when = new Date().toISOString();
  try {
    await env.EMAIL.send({
      to: ALERT_TO,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME || 'SATE' },
      subject: '[SATE] All clear — issues resolved',
      text: `All previously reported SATE issues have cleared as of ${when}.\n\nStatus page: https://sate-status.pages.dev`,
      html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;"><div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:28px;"><h1 style="margin:0 0 8px;font-size:19px;color:#15803d;">SATE — all clear</h1><p style="margin:0 0 16px;font-size:14px;color:#444;">All previously reported issues have cleared as of ${when}.</p><p style="margin:0;font-size:13px;color:#666;"><a href="https://sate-status.pages.dev" style="color:#0c6b74;">Status page</a></p></div></body></html>`,
    });
  } catch (e) { console.error('[alert] recovered send failed:', e && e.message || e); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
