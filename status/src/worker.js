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
  { name: 'device-api (Supabase)', url: SUPA.replace('.supabase.co', '.functions.supabase.co') + '/device-api/firmware/latest', expect: [200, 401, 404], reachableIsUp: true },
  { name: 'Supabase API', url: SUPA + '/rest/v1/', expect: [200, 401, 404], reachableIsUp: true },
  { name: 'Storage (firmware)', url: SUPA + '/storage/v1/object/public/firmware/', expect: [200, 400, 404], reachableIsUp: true },
  { name: 'AI /process', url: 'https://sate-v1-5.ngrok.io/', expect: [200, 404, 502], reachableIsUp: true },
];

const WINDOW_DAYS = 90;
const DAY = 86400;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const results = await runChecks(env);
      await evaluateAndAlert(env, results);   // email on any NEW error
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
      return Response.json({ ok: true, checked: TARGETS.map((t) => t.name), alert: alerted });
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
</style></head><body><div class="wrap">
  <header><h1>🩺 SATE Status</h1></header>
  <div class="banner"><span class="d"></span><span class="t">${OVR.t}</span></div>
  ${rows || '<p style="color:#74838a">No components configured — edit <code>TARGETS</code> in the Worker.</p>'}
  <footer>Updated ${esc(h.generated_at)} · ${WINDOW_DAYS}-day history · probed by a Cloudflare Worker cron</footer>
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

async function evaluateAndAlert(env, checkResults) {
  const problems = [];

  // (a) any probed service that is DOWN (AI /process, Supabase, Storage, device-api).
  for (const r of (checkResults || [])) {
    if (r.status === 'down') problems.push({ k: `svc:${r.name}`, msg: `${r.name} is DOWN (HTTP ${r.code || 'no response'})` });
  }

  // (b) the pipeline error digest from device-api (AI/audio/processing errors, stuck
  //     jobs, offline devices). Best-effort: a fetch failure just means "device-api
  //     unreachable", already covered by (a).
  let digest = null;
  try {
    const key = env.HEALTH_ALERT_KEY;
    if (key) {
      const r = await fetch(`${SUPA}/functions/v1/device-api/api/health/alerts?key=${encodeURIComponent(key)}`,
        { headers: { apikey: env.SUPA_ANON || '' } });
      if (r.ok) digest = await r.json();
    }
  } catch (_e) { /* covered by the device-api probe */ }

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
