// sate-test-form — serves the recorder user-test form (static asset), saves
// submitted runs to D1, and shows them at /result behind Basic Auth.

const TITLES = {
  1: 'Record a session',
  2: 'Read the transcript on the web app',
  3: 'Export a PDF',
  4: 'Turn off and on WHILE recording',
  5: 'Turn off and on WHILE uploading',
  6: 'Record with Wi-Fi off, then turn Wi-Fi on',
  7: 'Several recordings in a row',
  8: 'Long recording (over 30 minutes)',
};
const TOTAL = Object.keys(TITLES).length;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};
const json = (o, status = 200, extra = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...CORS, ...extra } });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function authed(request, env) {
  const pass = env.RESULT_PASSWORD;
  if (!pass) return null; // not configured → fail closed
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let dec = '';
  try { dec = atob(h.slice(6)); } catch { return false; }
  const i = dec.indexOf(':');
  return dec.slice(0, i) === (env.RESULT_USER || 'sate') && dec.slice(i + 1) === pass ? true : false;
}
const needLogin = () =>
  new Response('Sign in to view test results.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="SATE test results", charset="UTF-8"', 'content-type': 'text/plain' },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    // Save a submitted run.
    if (url.pathname === '/api/results' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
      const meta = body.meta || {}, tests = body.tests || {};
      let p = 0, f = 0, na = 0;
      for (const k in tests) { const s = tests[k].status; if (s === 'pass') p++; else if (s === 'fail') f++; else if (s === 'na') na++; }
      try {
        const r = await env.DB.prepare(
          'INSERT INTO results (created_at,tester,run_date,device,build,n_pass,n_fail,n_na,n_total,payload) VALUES (?,?,?,?,?,?,?,?,?,?)'
        ).bind(Date.now(), meta.tester || '', meta.date || '', meta.device || '', meta.build || '', p, f, na, TOTAL, JSON.stringify(body)).run();
        return json({ ok: true, id: r.meta?.last_row_id ?? null });
      } catch (e) {
        return json({ error: 'save failed: ' + (e?.message || e) }, 500);
      }
    }

    // Results JSON (auth).
    if (url.pathname === '/api/results' && request.method === 'GET') {
      const a = authed(request, env);
      if (a !== true) return a === null ? json({ error: 'not configured' }, 503) : needLogin();
      const { results } = await env.DB.prepare('SELECT * FROM results ORDER BY created_at DESC LIMIT 500').all();
      return json({ results });
    }

    // Results dashboard (auth).
    if (url.pathname === '/result') {
      const a = authed(request, env);
      if (a === null) return new Response('Results page not configured (missing password).', { status: 503 });
      if (a !== true) return needLogin();
      const { results } = await env.DB.prepare('SELECT * FROM results ORDER BY created_at DESC LIMIT 500').all();
      return new Response(renderResults(results || []), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }

    // Everything else → the static form.
    return env.ASSETS.fetch(request);
  },
};

function renderResults(rows) {
  const B = '#3a86ff', INK = '#101828', MUT = '#667085', HAIR = '#e4e7ec';
  const PASS = '#16a34a', FAIL = '#dc2626', NA = '#667085';
  const runs = rows.map((r) => {
    let payload = {}; try { payload = JSON.parse(r.payload); } catch {}
    const tests = payload.tests || {};
    const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const chip = (n, c, lbl) => `<span style="display:inline-flex;gap:5px;align-items:center;font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:${c}1a;color:${c};font-variant-numeric:tabular-nums;">${n} ${lbl}</span>`;
    const testRows = Object.keys(TITLES).map((id) => {
      const t = tests[id] || {};
      const s = t.status;
      const mk = s === 'pass' ? ['PASS', PASS] : s === 'fail' ? ['FAIL', FAIL] : s === 'na' ? ['N/A', NA] : ['—', '#98a2b3'];
      return `<tr>
        <td style="padding:5px 10px;border-top:1px solid ${HAIR};color:${MUT};font-variant-numeric:tabular-nums;">${id}</td>
        <td style="padding:5px 10px;border-top:1px solid ${HAIR};">${esc(TITLES[id])}</td>
        <td style="padding:5px 10px;border-top:1px solid ${HAIR};font-weight:700;color:${mk[1]};">${mk[0]}</td>
        <td style="padding:5px 10px;border-top:1px solid ${HAIR};color:${MUT};">${esc(t.note || '')}</td></tr>`;
    }).join('');
    return `<details style="background:#fff;border:1px solid ${HAIR};border-radius:12px;margin:0 0 12px;box-shadow:0 1px 2px rgba(20,32,58,.05);">
      <summary style="cursor:pointer;list-style:none;padding:14px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <span style="font-weight:700;">${esc(r.device || 'Unknown recorder')}</span>
        <span style="flex:1;"></span>
        ${chip(r.n_pass, PASS, 'pass')} ${chip(r.n_fail, FAIL, 'fail')} ${chip(r.n_na, NA, 'n/a')}
        <span style="color:${MUT};font-size:12px;font-family:ui-monospace,Menlo,monospace;">${when}</span>
      </summary>
      <div style="padding:0 16px 14px;overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
          <thead><tr style="text-align:left;color:${MUT};font-size:12px;">
            <th style="padding:4px 10px;">#</th><th style="padding:4px 10px;">Test</th><th style="padding:4px 10px;">Result</th><th style="padding:4px 10px;">Notes</th>
          </tr></thead><tbody>${testRows}</tbody></table>
      </div></details>`;
  }).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SATE Test Results</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📋</text></svg>">
  <style>
    body{margin:0;background:#f5f6f8;color:${INK};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;}
    .wrap{max-width:900px;margin:0 auto;padding:22px 18px 60px;}
    .top{border-bottom:2px solid ${B};padding-bottom:12px;margin-bottom:18px;}
    .eyebrow{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${B};font-weight:700;margin:0;}
    h1{font-size:21px;margin:2px 0 0;}
    .sub{color:${MUT};font-size:13px;margin:12px 0 18px;}
    a.btn{display:inline-block;text-decoration:none;font-size:13px;font-weight:600;color:${B};border:1px solid ${HAIR};background:#fff;padding:7px 13px;border-radius:9px;}
    .empty{color:${MUT};background:#fff;border:1px dashed ${HAIR};border-radius:12px;padding:28px;text-align:center;}
  </style></head><body><div class="wrap">
    <div class="top" style="display:flex;align-items:center;gap:12px;"><img src="/LOGO.png" alt="SATE" style="height:28px;width:auto;"><div><p class="eyebrow">Recorder test</p><h1>Test results</h1></div></div>
    <p class="sub">${rows.length} submitted run${rows.length === 1 ? '' : 's'}. <a class="btn" href="/">← Back to the test form</a></p>
    ${runs || '<div class="empty">No test runs submitted yet. Fill in the form and press <b>Submit results</b>.</div>'}
  </div></body></html>`;
}
