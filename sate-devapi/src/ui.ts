// The developer portal — one self-contained HTML document.
//
// No CDN, no build step, no framework: the whole UI is this string. That is a deliberate
// trade. The portal is small, it must keep working when a CDN is blocked or an npm package
// is yanked, and a Worker can serve it with zero cold-start cost. If it ever grows past what
// one file can hold comfortably, move it to a real bundle then — not before.
//
// ── Visual language ────────────────────────────────────────────────────────────
// These tokens are NOT chosen here. They come from ../../design-system/tokens.json,
// the audited SATE palette, so the portal and the clinical app read as one product:
//   surface  white cards on #fafafa, 1px #e5e7eb borders, shadow-sm
//   primary  blue-600 (#2563eb), hover blue-700 — the app's active tab pill
//   type     the app's -apple-system / Segoe UI stack, gray-900 headings, gray-600 muted
//   shell    white header, SATE wordmark left, a row of pill tabs — the shape of
//            react_app_sate-ui_update/src/components/Layout/Header.tsx
//   accents  annotation colours are semantic: a pause is the same blue here as it is
//            on a clinical report
//
// Do not hand-pick a colour in this file. Change tokens.json, mirror it here, and run
//   node ../design-system/verify.mjs ./src
// which fails on any colour that is near a token without being it. The test suite pins
// the four load-bearing values too, so drift breaks the build rather than the brand.

export function portalHtml(apiHost: string): string {
  // The SATE wordmark, inlined as a data URI so the page stays self-contained (the CSP allows
  // data: images but blocks any external host). Sized small; CSS controls the display height.
  const LOGO = 'data:image/png;base64,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';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SATE Developer Platform</title>
<style>
  :root {
    --bg: #fafafa; --surface: #ffffff; --surface-2: #f9fafb;
    --line: #e5e7eb; --line-strong: #d1d5db;
    --text: #111827; --text-2: #374151; --muted: #4b5563; --subtle: #6b7280;
    --primary: #2563eb; --primary-hover: #1d4ed8; --primary-soft: #eff6ff;
    --ok: #16a34a; --ok-soft: #f0fdf4;
    --warn: #d97706; --warn-soft: #fffbeb;
    --bad: #dc2626; --bad-soft: #fef2f2;
    --radius: 8px;
    --shadow-card: 0 1px 2px 0 rgba(0, 0, 0, .05);
    --shadow-pop: 0 10px 15px -3px rgba(0, 0, 0, .1), 0 4px 6px -4px rgba(0, 0, 0, .1);

    /* The app's annotation palette (index.css) — same colour, same meaning. */
    --c-pause: #3b82f6; --c-filler: #f59e0b; --c-repetition: #eab308;
    --c-mispronunciation: #8b5cf6; --c-morpheme: #10b981; --c-revision: #f97316;
    --c-utterance-error: #ef4444; --c-morpheme-omission: #dc2626;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
    font-size: 14px; line-height: 1.55;
    -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  }
  code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  a { color: var(--primary); text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* ---- header + tabs (mirrors the app's Layout/Header) ---- */
  header {
    background: var(--surface); border-bottom: 1px solid var(--line);
    padding: 14px 24px; position: sticky; top: 0; z-index: 20;
  }
  .hrow { display: flex; align-items: center; gap: 24px; flex-wrap: wrap;
          max-width: 1240px; margin: 0 auto; }
  .wordmark { display: inline-flex; align-items: center; gap: 10px; }
  .wordmark .logo { height: 26px; width: auto; display: block; }
  .wordmark span { font-size: 11px; font-weight: 500; color: var(--subtle);
                   letter-spacing: .02em; padding-left: 10px; border-left: 1px solid var(--line); }
  .tabs { display: flex; align-items: center; gap: 4px; flex: 1; flex-wrap: wrap; }
  .tabs button {
    background: transparent; border: 0; color: var(--muted); cursor: pointer;
    font: inherit; font-size: 14px; padding: 7px 14px; border-radius: var(--radius);
    transition: background-color .12s, color .12s;
  }
  .tabs button:hover { color: var(--text); background: var(--surface-2); }
  .tabs button[aria-current="true"] { background: var(--primary); color: #fff; font-weight: 500; }
  .tabs .sep { width: 1px; height: 22px; background: var(--line); margin: 0 6px; }
  .huser { display: flex; align-items: center; gap: 12px; color: var(--muted); font-size: 13px; }

  main { max-width: 1240px; margin: 0 auto; padding: 26px 24px 72px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -.015em; }
  h2 { font-size: 15px; font-weight: 600; margin: 26px 0 10px; color: var(--text-2); }
  .sub { color: var(--muted); margin: 4px 0 20px; }

  /* ---- primitives ---- */
  .card {
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius); box-shadow: var(--shadow-card); padding: 18px;
  }
  .grid { display: grid; gap: 14px; }
  .cols { grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
  .stat .n { font-size: 25px; font-weight: 600; letter-spacing: -.02em; line-height: 1.25; }
  .stat .l { color: var(--subtle); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }

  .btn {
    background: var(--primary); color: #fff; border: 1px solid var(--primary);
    padding: 8px 15px; border-radius: var(--radius); font: inherit; font-size: 14px;
    font-weight: 500; cursor: pointer; transition: background-color .12s;
  }
  .btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
  .btn.ghost { background: var(--surface); color: var(--text-2); border-color: var(--line-strong); }
  .btn.ghost:hover { background: var(--surface-2); }
  .btn.danger { background: var(--surface); color: var(--bad); border-color: #fecaca; }
  .btn.danger:hover { background: var(--bad-soft); }
  .btn.sm { padding: 5px 11px; font-size: 13px; }
  .btn:disabled { opacity: .55; cursor: not-allowed; }

  input, select, textarea {
    background: var(--surface); border: 1px solid var(--line-strong); color: var(--text);
    border-radius: var(--radius); padding: 8px 11px; font: inherit; font-size: 14px; width: 100%;
  }
  input:focus, select:focus, textarea:focus {
    outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
  }
  label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 5px; }

  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; color: var(--subtle); font-weight: 500; font-size: 11px;
    text-transform: uppercase; letter-spacing: .06em; padding: 9px 10px;
    border-bottom: 1px solid var(--line); white-space: nowrap;
  }
  td { padding: 11px 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tr:last-child td { border-bottom: 0; }
  .tablewrap { overflow-x: auto; }

  .pill {
    display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 12px;
    border: 1px solid var(--line); background: var(--surface-2); color: var(--text-2);
  }
  .pill.ok { color: #15803d; border-color: #bbf7d0; background: var(--ok-soft); }
  .pill.warn { color: #b45309; border-color: #fde68a; background: var(--warn-soft); }
  .pill.bad { color: #b91c1c; border-color: #fecaca; background: var(--bad-soft); }
  .pill.info { color: #1d4ed8; border-color: #bfdbfe; background: var(--primary-soft); }
  .muted { color: var(--muted); }
  .small { font-size: 13px; }

  pre {
    background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 14px; overflow-x: auto; font-size: 13px; margin: 10px 0; color: var(--text-2);
  }

  .toast {
    position: fixed; right: 20px; bottom: 20px; background: var(--surface);
    border: 1px solid var(--line); border-left: 3px solid var(--primary);
    box-shadow: var(--shadow-pop); padding: 12px 16px; border-radius: var(--radius);
    max-width: 380px; z-index: 50;
  }
  .toast.bad { border-left-color: var(--bad); }
  .hidden { display: none !important; }

  /* ---- auth ---- */
  .auth { display: grid; place-items: center; min-height: 100vh; padding: 24px; }
  .auth .card { width: 100%; max-width: 420px; padding: 26px; }
  .authhead { text-align: center; margin-bottom: 20px; }
  .authhead { display: grid; place-items: center; }
  .authhead .wordmark .logo { height: 34px; }
  .segmented { display: flex; gap: 4px; background: var(--surface-2);
               border: 1px solid var(--line); border-radius: var(--radius); padding: 4px; margin-bottom: 18px; }
  .segmented button {
    flex: 1; background: transparent; border: 0; color: var(--muted); padding: 7px;
    border-radius: 6px; cursor: pointer; font: inherit; font-size: 14px;
  }
  .segmented button[aria-selected="true"] { background: var(--surface); color: var(--text);
                                            font-weight: 500; box-shadow: var(--shadow-card); }

  /* ---- chart (inline SVG, no library) ---- */
  .chart { width: 100%; height: 150px; display: block; }
  .chart rect { fill: var(--primary); }
  .chart rect.err { fill: var(--bad); }
  .chart line { stroke: var(--line); stroke-width: 1; }
  .chartx { display: flex; justify-content: space-between; color: var(--subtle);
            font-size: 12px; margin-top: 6px; }
  .legend { display: flex; gap: 16px; margin-top: 10px; font-size: 12px; color: var(--muted); }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  .legend .sw-a { background: var(--primary); }
  .legend .sw-b { background: var(--bad); }

  .scopes { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .scopes label {
    display: flex; align-items: center; gap: 7px; margin: 0; color: var(--text-2);
    border: 1px solid var(--line-strong); padding: 7px 12px; border-radius: var(--radius);
    cursor: pointer; font-size: 13px; background: var(--surface);
  }
  .scopes label:hover { background: var(--surface-2); }
  .scopes input { width: auto; }

  .keyreveal { background: var(--ok-soft); border: 1px solid #bbf7d0;
               border-radius: var(--radius); padding: 14px; margin-top: 14px; }
  .keyreveal .mono { word-break: break-all; font-size: 13px; display: block; margin: 8px 0;
                     background: var(--surface); border: 1px solid #bbf7d0;
                     border-radius: 6px; padding: 9px 11px; }
  .banner { border-radius: var(--radius); padding: 14px 16px; margin-bottom: 16px;
            border: 1px solid; box-shadow: var(--shadow-card); }
  .banner.bad { background: var(--bad-soft); border-color: #fecaca; }
  .banner.warn { background: var(--warn-soft); border-color: #fde68a; }
  .devrow { border-bottom: 1px solid var(--line); padding: 16px 0; }
  .devrow:first-of-type { padding-top: 0; }
  .devrow:last-of-type { border-bottom: 0; padding-bottom: 0; }
  .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }

  /* ---- onboarding stepper (Overview) ---- */
  .stepper { display: grid; }
  .step { position: relative; display: grid; grid-template-columns: 30px 1fr; gap: 14px; }
  .step:not(:last-child) .rail::after {
    content: ""; position: absolute; left: 14px; top: 30px; bottom: -4px; width: 2px; background: var(--line-strong);
  }
  .step.done .rail::after { background: var(--ok); opacity: .5; }
  .bullet {
    width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center;
    font-weight: 600; font-size: 12px; border: 2px solid var(--line-strong);
    background: var(--surface); color: var(--subtle); position: relative; z-index: 1;
  }
  .step.done .bullet { background: var(--ok); border-color: var(--ok); color: #fff; }
  .step.active .bullet { background: var(--primary); border-color: var(--primary); color: #fff; box-shadow: 0 0 0 4px var(--primary-soft); }
  .step-body { padding-bottom: 18px; }
  .step-body h3 { font-size: 14px; font-weight: 600; margin: 3px 0 2px; }
  .step.future h3, .step.future .st-desc { opacity: .5; }
  .st-desc { color: var(--muted); font-size: 13px; }
  .st-label { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; font-weight: 600; color: var(--subtle); }
  .step-panel { margin-top: 11px; }
  .inset { background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; padding: 13px; }

  /* ---- stat sparkline + status dot ---- */
  .spark { margin-top: 8px; display: block; }
  .pill .led { width: 6px; height: 6px; border-radius: 50%; background: currentColor; display: inline-block; }

  /* ---- admin approval presets ---- */
  .tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .tier {
    text-align: left; background: var(--surface); border: 1px solid var(--line-strong);
    border-radius: 6px; padding: 12px; cursor: pointer; font: inherit; display: grid; gap: 3px;
    transition: border-color .12s, background-color .12s;
  }
  .tier:hover { border-color: var(--primary); background: var(--primary-soft); }
  .tier .tname { font-weight: 600; font-size: 13px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tier .tspec { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .tier .tgo { color: var(--primary); font-size: 12px; font-weight: 600; margin-top: 3px; }
  .quote { margin-top: 8px; padding: 9px 12px; border-left: 3px solid var(--line-strong); background: var(--surface-2); border-radius: 0 6px 6px 0; color: var(--text-2); font-size: 13px; }

  @media (max-width: 900px) {
    .hrow { gap: 12px; }
    .tabs { order: 3; width: 100%; overflow-x: auto; }
    main { padding: 20px 16px 56px; }
    .tiers { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<!-- ===================== AUTH ===================== -->
<div id="auth" class="auth hidden">
  <div class="card">
    <div class="authhead">
      <div class="wordmark"><img src="${LOGO}" class="logo" alt="SATE"><span>Developer Platform</span></div>
    </div>
    <div class="segmented">
      <button id="tab-login" aria-selected="true" onclick="setAuthTab('login')">Sign in</button>
      <button id="tab-register" aria-selected="false" onclick="setAuthTab('register')">Request access</button>
    </div>

    <form id="form-login" onsubmit="doLogin(event)">
      <label for="li-email">Email</label>
      <input id="li-email" type="email" autocomplete="username" required>
      <label for="li-pass">Password</label>
      <input id="li-pass" type="password" autocomplete="current-password" required>
      <div style="margin-top:18px"><button class="btn" style="width:100%">Sign in</button></div>
    </form>

    <form id="form-register" class="hidden" onsubmit="doRegister(event)">
      <p class="sub small" style="margin:0 0 4px">Access is granted manually. Tell us what
        you're building and we'll enable your account.</p>
      <label for="rg-email">Email</label>
      <input id="rg-email" type="email" autocomplete="username" required>
      <label for="rg-name">Your name</label>
      <input id="rg-name" type="text">
      <label for="rg-org">Organisation</label>
      <input id="rg-org" type="text">
      <label for="rg-use">What are you building?</label>
      <textarea id="rg-use" rows="3"></textarea>
      <label for="rg-pass">Password (10+ characters)</label>
      <input id="rg-pass" type="password" autocomplete="new-password" minlength="10" required>
      <div style="margin-top:18px"><button class="btn" style="width:100%">Request access</button></div>
    </form>
  </div>
</div>

<!-- ===================== APP ===================== -->
<div id="app" class="hidden">
  <header>
    <div class="hrow">
      <div class="wordmark"><img src="${LOGO}" class="logo" alt="SATE"><span>Developer Platform</span></div>
      <nav class="tabs" id="tabs"></nav>
      <div class="huser">
        <span id="who"></span>
        <button class="btn ghost sm" onclick="doLogout()">Sign out</button>
      </div>
    </div>
  </header>
  <main id="main"></main>
</div>

<script>
const API_HOST = ${JSON.stringify(apiHost)};
let ME = null;
// The plaintext of the most recently minted key, held in memory only (never stored) so the
// onboarding step and the playground can offer a one-click "test it" right after creation.
let lastSecret = null;

// The tab row. Admin-only tabs are appended for an admin and simply absent otherwise —
// the server enforces the same boundary, so hiding them is convenience, not security.
const TABS = [
  { id: 'overview',    label: 'Get started' },
  { id: 'keys',        label: 'API Keys' },
  { id: 'usage',       label: 'Usage' },
  { id: 'jobs',        label: 'Jobs' },
  { id: 'playground',  label: 'Playground' },
  { id: 'docs',        label: 'Docs', href: '/docs' },
  { id: 'developers',  label: 'Developers', admin: true, sep: true },
  { id: 'system',      label: 'System', admin: true },
];

// ---- helpers --------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || 'Request failed');
  return data;
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const fmtDur = (s) => (s == null ? '—' : Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's');
const mins = (sec) => Math.round((sec || 0) / 60);

/**
 * Stacked daily bar chart as raw SVG. Errors sit on top of successful requests, so the bar
 * height is total volume and the red portion is how much of it failed.
 *
 * A charting library would be by far the largest dependency in this portal, for this.
 */
function chartSvg(days, unit) {
  if (!days || !days.length) return '<p class="muted small">No data in this window yet.</p>';
  const max = Math.max(1, ...days.map((d) => d.requests || 0));
  const W = 100, H = 130, FLOOR = H - 10, TOP = 8;
  const slot = W / days.length;
  const bw = Math.max(slot * 0.62, 0.4);
  const bars = days.map((d, i) => {
    const total = d.requests || 0;
    const errs = Math.min(d.errors || 0, total);
    const h = (total / max) * (FLOOR - TOP);
    const eh = (errs / max) * (FLOOR - TOP);
    const x = i * slot + (slot - bw) / 2;
    const title = '<title>' + d.day + ': ' + total + ' ' + unit + (errs ? ', ' + errs + ' errors' : '') + '</title>';
    return '<rect x="' + x.toFixed(2) + '" y="' + (FLOOR - h).toFixed(2) + '" width="' + bw.toFixed(2) +
           '" height="' + Math.max(h - eh, 0).toFixed(2) + '" rx="0.4">' + title + '</rect>' +
           (errs ? '<rect class="err" x="' + x.toFixed(2) + '" y="' + (FLOOR - eh).toFixed(2) +
                   '" width="' + bw.toFixed(2) + '" height="' + eh.toFixed(2) + '">' + title + '</rect>' : '');
  }).join('');
  return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
         '<line x1="0" y1="' + FLOOR + '" x2="' + W + '" y2="' + FLOOR + '"></line>' + bars + '</svg>' +
         '<div class="chartx"><span>' + esc(days[0].day) + '</span><span>peak ' + max + ' ' + esc(unit) +
         '</span><span>' + esc(days[days.length - 1].day) + '</span></div>';
}

/** A tiny trend line for a stat card — last N points, endpoint dot. Inline SVG, no library. */
function sparkline(days, key) {
  const pts = (days || []).slice(-14).map((d) => (key === 'audio' ? mins(d.audio_seconds) : (d[key] ?? d.requests ?? 0)));
  if (pts.length < 2) return '';
  const max = Math.max(1, ...pts);
  const step = 100 / (pts.length - 1);
  const coords = pts.map((v, i) => (i * step).toFixed(1) + ',' + (22 - (v / max) * 20).toFixed(1));
  const lastY = (22 - (pts[pts.length - 1] / max) * 20).toFixed(1);
  return '<svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" width="100%" height="24">' +
    '<polyline points="' + coords.join(' ') + '" fill="none" stroke="var(--primary)" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline>' +
    '<circle cx="100" cy="' + lastY + '" r="1.8" fill="var(--primary)"></circle></svg>';
}

// ---- auth -----------------------------------------------------------------
function setAuthTab(which) {
  $('#tab-login').setAttribute('aria-selected', which === 'login');
  $('#tab-register').setAttribute('aria-selected', which === 'register');
  $('#form-login').classList.toggle('hidden', which !== 'login');
  $('#form-register').classList.toggle('hidden', which !== 'register');
}

async function doLogin(e) {
  e.preventDefault();
  try {
    await api('/portal/api/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#li-email').value, password: $('#li-pass').value }),
    });
    await boot();
  } catch (err) { toast(err.message, true); }
}

async function doRegister(e) {
  e.preventDefault();
  try {
    await api('/portal/api/register', {
      method: 'POST',
      body: JSON.stringify({
        email: $('#rg-email').value, password: $('#rg-pass').value,
        name: $('#rg-name').value, org: $('#rg-org').value, use_case: $('#rg-use').value,
      }),
    });
    toast('Request submitted. You will get an email once it is approved.');
    setAuthTab('login');
  } catch (err) { toast(err.message, true); }
}

async function doLogout() {
  await api('/portal/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

// ---- routing --------------------------------------------------------------
const VIEWS = {};

function renderTabs(current) {
  $('#tabs').innerHTML = TABS
    .filter((t) => !t.admin || ME.developer.is_admin)
    .map((t) => (t.sep ? '<span class="sep"></span>' : '') +
      '<button data-view="' + t.id + '" aria-current="' + (t.id === current) + '" onclick="' +
      (t.href ? "location.href='" + t.href + "'" : "go('" + t.id + "')") + '">' + t.label + '</button>')
    .join('');
}

function go(view) {
  if (!VIEWS[view]) view = 'overview';
  location.hash = view;
  renderTabs(view);
  $('#main').innerHTML = '<p class="muted">Loading…</p>';
  VIEWS[view]().catch((e) => {
    $('#main').innerHTML = '<div class="banner bad"><strong>Could not load this view.</strong> ' +
      esc(e.message) + '</div>';
  });
}

// ---- overview / get started -----------------------------------------------
// While a developer is still getting set up, this is a guided checklist that carries them all
// the way to a working call. Once they are approved, have a key, and have made a call, it
// collapses into the usual dashboard — no nagging a set-up developer with an onboarding wizard.
VIEWS.overview = async () => {
  const d = ME.developer;
  const [usage, keysRes, jobsRes] = await Promise.all([
    api('/portal/api/usage?days=30').catch(() => ({ totals: {}, daily: [] })),
    api('/portal/api/keys').catch(() => ({ data: [] })),
    api('/portal/api/jobs?limit=1').catch(() => ({ data: [] })),
  ]);
  const t = usage.totals || {};
  const liveKeys = (keysRes.data || []).filter((k) => !k.revoked_at);
  const approved = d.scopes.length > 0;
  const hasKey = liveKeys.length > 0;
  const hasCall = (jobsRes.data || []).length > 0;
  const complete = approved && hasKey && hasCall;

  const lockBanner = d.api_locked
    ? '<div class="banner bad"><strong>API access is locked.</strong><div class="small" style="margin-top:4px">' +
      esc(d.lock_reason || 'An administrator has locked API access for this account.') +
      ' Your keys return <span class="mono">403 api_locked</span> until it is lifted.</div></div>'
    : '';

  if (complete) { $('#main').innerHTML = lockBanner + dashboard(); return; }

  // ---- the checklist ----
  const doneCount = 1 + (approved ? 1 : 0) + (hasKey ? 1 : 0) + (hasCall ? 1 : 0);
  const stepClass = (i, cur) => (i < cur ? 'done' : i === cur ? 'active' : 'future');
  // current active index: first incomplete step
  const cur = !approved ? 1 : !hasKey ? 2 : 3;

  const approvedPanel = approved
    ? '<div class="inset"><span class="pill ok"><span class="led"></span>Approved</span> ' +
        '<span class="small muted">' + d.scopes.map((s) => esc(s.replace(':read', ''))).join(' + ') + ' · ' +
        (d.quota_minutes ? d.quota_minutes + ' min ' + (d.quota_period === 'total' ? 'total' : '/ month') : 'unlimited') +
        ' · ' + d.rate_per_min + ' req/min</span></div>'
    : '<div class="inset small muted">An admin reviews new requests, usually within a day. We’ll email you the ' +
        'moment it’s approved — you can close this tab.</div>';

  let keyPanel = '';
  if (approved && !hasKey) {
    keyPanel = '<div class="inset"><div class="small muted" style="margin-bottom:10px">One click mints a key with ' +
      'your granted scopes. It’s shown once — copy it somewhere safe.</div>' +
      '<button class="btn" onclick="createFirstKey()">Create my first key</button></div>';
  } else if (hasKey) {
    keyPanel = (lastSecret
      ? '<div class="keyreveal"><strong>Copy this key now — it will not be shown again.</strong>' +
          '<code class="mono">' + esc(lastSecret) + '</code>' +
          '<button class="btn ghost sm" onclick="copyKey(this)" data-key="' + esc(lastSecret) + '">Copy</button></div>'
      : '<div class="inset small muted">You have an active key. Manage or revoke keys under ' +
          '<strong>API Keys</strong>.</div>');
  }

  let callPanel = '';
  if (hasKey) {
    callPanel = '<div class="inset">' +
      '<div class="small muted" style="margin-bottom:10px">Submit audio for a transcript + report, or try a text ' +
      'endpoint — no audio needed. Run it in the Playground, or from your terminal:</div>' +
      '<pre>' + [
        'curl -X POST https://' + esc(API_HOST) + '/v1/jobs \\\\',
        '  -H "Authorization: Bearer sate_live_..." \\\\',
        '  -F audio=@sample.wav -F view=full',
      ].join('\\n') + '</pre>' +
      '<div class="actions">' +
        '<button class="btn" onclick="go(\\'playground\\')">Open the Playground</button>' +
        (lastSecret ? '<button class="btn ghost" onclick="verifyKey()">Verify my key</button>' : '') +
      '</div><div id="ob-verify" style="margin-top:12px"></div></div>';
  }

  const steps = [
    ['Step 1', 'Request access', 'You told us what you’re building. Done at sign-up.', ''],
    ['Step 2', 'Get approved', 'An admin enables your account and sets your allowance.', approvedPanel],
    ['Step 3', 'Create an API key', 'Your key authenticates every request to the API.', keyPanel],
    ['Step 4', 'Make your first call', 'Submit audio, get a transcript and speech report back.', callPanel],
  ];

  $('#main').innerHTML =
    '<h1>Welcome' + (d.name ? ', ' + esc(d.name.split(' ')[0]) : '') + ' — let’s get you a transcript</h1>' +
    '<p class="sub">' + doneCount + ' of 4 done. Everything you need is on this screen; the other tabs are there ' +
      'when you outgrow it.</p>' +
    lockBanner +
    '<div class="stepper">' + steps.map((st, i) =>
      '<div class="step ' + stepClass(i, cur) + '">' +
        '<div class="rail"><div class="bullet">' + (i < cur ? '✓' : (i + 1)) + '</div></div>' +
        '<div class="step-body"><div class="st-label">' + st[0] + '</div><h3>' + st[1] + '</h3>' +
          '<div class="st-desc">' + st[2] + '</div>' +
          (st[3] && i <= cur ? '<div class="step-panel">' + st[3] + '</div>' : '') +
        '</div></div>').join('') +
    '</div>' +
    '<p class="muted small" style="margin-top:14px">Full reference, with clients in nine languages: ' +
      '<a href="/docs">documentation</a>.</p>';

  // The signed-in dashboard, shown once onboarding is complete.
  function dashboard() {
    const periodLabel = d.quota_period === 'total' ? 'total' : 'this month';
    const quota = d.quota_minutes ? ME.quota_minutes_used + ' / ' + d.quota_minutes + ' min'
                                  : ME.quota_minutes_used + ' min';
    const views = [
      d.scopes.includes('transcript:read') ? 'transcript' : null,
      d.scopes.includes('report:read') ? 'report' : null,
      d.scopes.includes('text:read') ? 'text' : null,
      d.scopes.length ? 'full' : null,
    ].filter(Boolean);
    return '<h1>Overview</h1>' +
      '<p class="sub">Signed in as ' + esc(d.email) + (d.org ? ' · ' + esc(d.org) : '') + '</p>' +
      '<div class="grid cols">' +
        '<div class="card stat"><div class="l">Requests (30d)</div><div class="n">' + (t.requests || 0) + '</div>' +
          sparkline(usage.daily, 'requests') + '</div>' +
        '<div class="card stat"><div class="l">Audio ' + periodLabel + '</div><div class="n">' + quota + '</div>' +
          sparkline(usage.daily, 'audio') + '</div>' +
        '<div class="card stat"><div class="l">Errors (30d)</div><div class="n">' + (t.errors || 0) + '</div></div>' +
      '</div>' +
      '<h2>Requests per day</h2><div class="card">' + chartSvg(usage.daily, 'requests') + '</div>' +
      '<h2>Your access</h2><div class="card"><div class="tablewrap"><table>' +
        '<tr><td class="muted" style="width:210px">Scopes granted</td><td>' +
          d.scopes.map((s) => '<span class="pill info">' + esc(s) + '</span>').join(' ') + '</td></tr>' +
        '<tr><td class="muted">Views available</td><td>' +
          (views.map((v) => '<span class="pill">' + v + '</span>').join(' ') || '<span class="muted">—</span>') + '</td></tr>' +
        '<tr><td class="muted">Rate limit</td><td>' + d.rate_per_min + ' requests / minute</td></tr>' +
        '<tr><td class="muted">Audio quota</td><td>' + (d.quota_minutes
          ? d.quota_minutes + ' minutes ' + (d.quota_period === 'total' ? 'in total (does not reset)' : 'per month')
          : 'Unlimited') + '</td></tr>' +
        '<tr><td class="muted">API status</td><td>' + (d.api_locked
          ? '<span class="pill bad">locked</span>' : '<span class="pill ok"><span class="led"></span>active</span>') + '</td></tr>' +
        '<tr><td class="muted">API base URL</td><td class="mono">https://' + esc(API_HOST) + '</td></tr>' +
      '</table></div></div>' +
      '<h2>Quick start</h2>' +
      '<pre>' + [
        'curl -X POST https://' + esc(API_HOST) + '/v1/jobs \\\\',
        '  -H "Authorization: Bearer sate_live_..." \\\\',
        '  -F audio=@sample.wav \\\\',
        '  -F view=full',
        '',
        '# -&gt; 202 { "id": "...", "status": "queued", "poll_url": "..." }',
        '',
        'curl https://' + esc(API_HOST) + '/v1/jobs/JOB_ID \\\\',
        '  -H "Authorization: Bearer sate_live_..."',
      ].join('\\n') + '</pre>' +
      '<p class="muted small">Full reference, with clients in nine languages: <a href="/docs">documentation</a>.</p>';
  }
};

/** Onboarding step 3: mint a first key with the full granted allowance, held in memory to test. */
async function createFirstKey() {
  try {
    const r = await api('/portal/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Default key', scopes: ME.developer.scopes }),
    });
    lastSecret = r.key;
    toast('Key created');
    go('overview');
  } catch (err) { toast(err.message, true); }
}

/** Onboarding step 4: prove the just-minted key authenticates, inline. */
async function verifyKey() {
  if (!lastSecret) return;
  const out = $('#ob-verify');
  out.innerHTML = '<p class="muted small">Calling GET /v1/me…</p>';
  try {
    const res = await fetch('https://' + API_HOST + '/v1/me', { headers: { Authorization: 'Bearer ' + lastSecret } });
    const body = await res.json();
    out.innerHTML = '<pre>' + esc(JSON.stringify(body, null, 2)) + '</pre>';
  } catch (err) { out.innerHTML = '<div class="banner bad">' + esc(err.message) + '</div>'; }
}

// ---- keys -----------------------------------------------------------------
VIEWS.keys = async () => {
  const { data } = await api('/portal/api/keys');
  const allowed = ME.developer.scopes;

  $('#main').innerHTML =
    '<h1>API Keys</h1>' +
    '<p class="sub">A key is shown once, at creation. Store it somewhere safe — we only keep its hash.</p>' +

    '<div class="card"><h2 style="margin-top:0">Create a key</h2>' +
      (allowed.length === 0
        ? '<p class="muted">Your account has no scopes yet. An administrator has to grant them first.</p>'
        : '<form onsubmit="createKey(event)">' +
            '<label for="k-name">Name</label>' +
            '<input id="k-name" placeholder="Production backend" required>' +
            '<label>Scopes</label><div class="scopes">' +
              allowed.map((s) => '<label><input type="checkbox" value="' + esc(s) + '" checked> ' +
                esc(s) + '</label>').join('') +
            '</div>' +
            '<label for="k-rate">Rate limit (max ' + ME.developer.rate_per_min + '/min)</label>' +
            '<input id="k-rate" type="number" min="1" max="' + ME.developer.rate_per_min +
              '" value="' + ME.developer.rate_per_min + '">' +
            '<div style="margin-top:18px"><button class="btn">Create key</button></div>' +
          '</form><div id="reveal"></div>') +
    '</div>' +

    '<h2>Existing keys</h2><div class="card">' +
      (data.length === 0 ? '<p class="muted">No keys yet.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Name</th><th>Key</th><th>Scopes</th><th>Last used</th><th></th></tr>' +
        data.map((k) => '<tr>' +
          '<td>' + esc(k.name) + '</td>' +
          '<td class="mono muted">' + esc(k.prefix) + '…</td>' +
          '<td>' + k.scopes.map((s) => '<span class="pill info">' + esc(s.replace(':read', '')) + '</span>').join(' ') + '</td>' +
          '<td class="muted small">' + (k.revoked_at ? '<span class="pill bad">revoked</span>' : fmtDate(k.last_used_at)) + '</td>' +
          '<td>' + (k.revoked_at ? '' : '<button class="btn danger sm" onclick="revokeKey(\\'' + k.id + '\\')">Revoke</button>') + '</td>' +
        '</tr>').join('') +
      '</table></div>') +
    '</div>';
};

async function createKey(e) {
  e.preventDefault();
  const scopes = Array.from(document.querySelectorAll('.scopes input:checked')).map((i) => i.value);
  try {
    const r = await api('/portal/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: $('#k-name').value, scopes, rate_per_min: Number($('#k-rate').value) }),
    });
    lastSecret = r.key;
    // Rendered inline rather than in an alert so it can be selected and copied.
    $('#reveal').innerHTML = '<div class="keyreveal"><strong>Copy this key now — it will not be ' +
      'shown again.</strong><code class="mono">' + esc(r.key) + '</code>' +
      '<button class="btn ghost sm" onclick="copyKey(this)" data-key="' + esc(r.key) + '">Copy</button></div>';
    toast('Key created');
  } catch (err) { toast(err.message, true); }
}

function copyKey(btn) {
  navigator.clipboard.writeText(btn.dataset.key).then(() => toast('Copied to clipboard'));
}

async function revokeKey(id) {
  if (!confirm('Revoke this key? Applications using it start getting 401s immediately.')) return;
  try { await api('/portal/api/keys/' + id, { method: 'DELETE' }); toast('Key revoked'); go('keys'); }
  catch (err) { toast(err.message, true); }
}

// ---- usage ----------------------------------------------------------------
VIEWS.usage = async () => {
  const u = await api('/portal/api/usage?days=30');
  const days = u.daily || [];
  const audioDays = days.map((d) => ({ day: d.day, requests: mins(d.audio_seconds), errors: 0 }));

  $('#main').innerHTML =
    '<h1>Usage</h1>' +
    '<p class="sub">Last 30 days. Every API call is metered here, including failures.</p>' +

    '<div class="grid cols">' +
      '<div class="card stat"><div class="l">Requests</div><div class="n">' + (u.totals?.requests || 0) + '</div></div>' +
      '<div class="card stat"><div class="l">Audio processed</div><div class="n">' + mins(u.totals?.audio_seconds) + ' min</div></div>' +
      '<div class="card stat"><div class="l">Errors</div><div class="n">' + (u.totals?.errors || 0) + '</div></div>' +
    '</div>' +

    '<h2>Requests per day</h2><div class="card">' + chartSvg(days, 'requests') +
      '<div class="legend"><span><i class="sw sw-a"></i>Successful</span>' +
      '<span><i class="sw sw-b"></i>Errors</span></div></div>' +

    '<h2>Audio processed per day</h2><div class="card">' + chartSvg(audioDays, 'minutes') + '</div>' +

    '<h2>By key</h2><div class="card">' +
      ((u.by_key || []).length === 0 ? '<p class="muted">No usage yet.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Key</th><th>Requests</th><th>Audio</th></tr>' +
        u.by_key.map((k) => '<tr><td>' + esc(k.name) + ' <span class="mono muted">' + esc(k.prefix) +
          '…</span></td><td>' + k.requests + '</td><td>' + mins(k.audio_seconds) + ' min</td></tr>').join('') +
      '</table></div>') + '</div>' +

    '<h2>By endpoint</h2><div class="card">' +
      ((u.by_endpoint || []).length === 0 ? '<p class="muted">No usage yet.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Endpoint</th><th>Requests</th><th>Errors</th></tr>' +
        u.by_endpoint.map((e) => '<tr><td class="mono small">' + esc(e.method) + ' ' + esc(e.endpoint) +
          '</td><td>' + e.requests + '</td><td>' + e.errors + '</td></tr>').join('') +
      '</table></div>') + '</div>';
};

// ---- jobs -----------------------------------------------------------------
const statusPill = (s) =>
  '<span class="pill ' + (s === 'done' ? 'ok' : s === 'error' ? 'bad' : 'warn') + '"><span class="led"></span>' + esc(s) + '</span>';

VIEWS.jobs = async () => {
  const { data } = await api('/portal/api/jobs?limit=50');
  $('#main').innerHTML =
    '<h1>Jobs</h1>' +
    '<p class="sub">Your last 50 submissions. Results are deleted automatically after the retention window.</p>' +
    '<div class="card">' +
      (data.length === 0 ? '<p class="muted">Nothing submitted yet.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Job</th><th>Status</th><th>View</th><th>File</th><th>Duration</th><th>Submitted</th></tr>' +
        data.map((j) => '<tr>' +
          '<td class="mono muted">' + esc(j.id.slice(0, 8)) + '</td>' +
          '<td>' + statusPill(j.status) + (j.no_text ? ' <span class="pill">no speech</span>' : '') + '</td>' +
          '<td>' + esc(j.view) + '</td>' +
          '<td>' + esc(j.file_name) + ' <span class="muted small">' + fmtBytes(j.bytes) + '</span></td>' +
          '<td>' + fmtDur(j.duration_sec) + '</td>' +
          '<td class="muted small">' + fmtDate(j.created_at) + '</td></tr>' +
          (j.error ? '<tr><td colspan="6" class="muted small" style="padding-top:0">↳ ' + esc(j.error) + '</td></tr>' : '')
        ).join('') +
      '</table></div>') +
    '</div>';
};

// ---- playground -----------------------------------------------------------
VIEWS.playground = async () => {
  const { data } = await api('/portal/api/keys');
  const live = data.filter((k) => !k.revoked_at);
  $('#main').innerHTML =
    '<h1>Playground</h1>' +
    '<p class="sub">Submit a file against the real API with one of your own keys, and watch it complete.</p>' +
    (live.length === 0 ? '<div class="card"><p class="muted">Create an API key first.</p></div>' :
    '<div class="card">' +
      '<label for="pg-key">Key</label><select id="pg-key">' +
        live.map((k) => '<option value="' + k.id + '">' + esc(k.name) + ' (' + esc(k.prefix) + '…)</option>').join('') +
      '</select>' +
      '<p class="muted small" style="margin:8px 0 0">The playground needs the key\\'s secret, which we ' +
        'do not store. Paste it below.</p>' +
      '<label for="pg-secret">Key secret</label>' +
      '<input id="pg-secret" type="password" placeholder="sate_live_…" autocomplete="off">' +
      '<label for="pg-view">View</label><select id="pg-view">' +
        '<option value="full">full</option><option value="transcript">transcript</option>' +
        '<option value="report">report</option></select>' +
      '<label for="pg-file">Audio file (WAV)</label><input id="pg-file" type="file" accept="audio/*">' +
      '<div style="margin-top:18px"><button class="btn" id="pg-go" onclick="runPlayground()">Submit</button></div>' +
    '</div><div id="pg-out"></div>');
};

async function runPlayground() {
  const secret = $('#pg-secret').value.trim();
  const file = $('#pg-file').files[0];
  if (!secret || !file) return toast('Pick a file and paste your key secret.', true);
  const btn = $('#pg-go');
  btn.disabled = true;
  const out = $('#pg-out');
  const status = (msg) => { out.innerHTML = '<div class="card" style="margin-top:14px"><p class="muted">' + esc(msg) + '</p></div>'; };
  status('Uploading…');
  try {
    const fd = new FormData();
    fd.append('audio', file);
    fd.append('view', $('#pg-view').value);
    // Straight at the public API — the playground is a real client, not a special path.
    const res = await fetch('https://' + API_HOST + '/v1/jobs', {
      method: 'POST', headers: { Authorization: 'Bearer ' + secret }, body: fd,
    });
    const job = await res.json();
    if (!res.ok) throw new Error(job?.error?.message || 'Submit failed');
    status('Queued as ' + job.id + '. Polling…');

    // Back off while polling: hammering the endpoint just burns the caller's own rate limit.
    let delay = 2000;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.25, 10000);
      const r = await fetch('https://' + API_HOST + '/v1/jobs/' + job.id, {
        headers: { Authorization: 'Bearer ' + secret },
      });
      const body = await r.json();
      if (body.status === 'done' || body.status === 'error') {
        out.innerHTML = '<h2>Result</h2><pre>' + esc(JSON.stringify(body, null, 2)) + '</pre>';
        btn.disabled = false;
        return;
      }
      status('Status: ' + body.status + '…');
    }
    status('Still running — check the Jobs tab.');
  } catch (err) {
    out.innerHTML = '<div class="banner bad" style="margin-top:14px">' + esc(err.message) + '</div>';
  }
  btn.disabled = false;
}

// ===========================================================================
// ADMIN — split into two tabs so the two jobs stay separate: "Developers" is
// per-account administration, "System" is platform-wide monitoring.
// ===========================================================================

// ---- Developers -----------------------------------------------------------
VIEWS.developers = async () => {
  const { data } = await api('/portal/api/admin/developers');
  const pending = data.filter((d) => d.status === 'pending');
  const active = data.filter((d) => d.status === 'active');
  const other = data.filter((d) => d.status !== 'pending' && d.status !== 'active');
  const locked = data.filter((d) => d.api_locked).length;

  $('#main').innerHTML =
    '<h1>Developers</h1>' +
    '<p class="sub">Approve accounts and set what each one may call.</p>' +

    '<div class="grid cols">' +
      '<div class="card stat"><div class="l">Active</div><div class="n">' + active.length + '</div></div>' +
      '<div class="card stat"><div class="l">Awaiting approval</div><div class="n">' + pending.length + '</div></div>' +
      '<div class="card stat"><div class="l">API locked</div><div class="n">' + locked + '</div></div>' +
      '<div class="card stat"><div class="l">Suspended / rejected</div><div class="n">' + other.length + '</div></div>' +
    '</div>' +

    (pending.length
      ? '<h2>Access requests</h2><div class="card">' + pending.map(devRow).join('') + '</div>'
      : '') +
    '<h2>Active</h2><div class="card">' +
      (active.length ? active.map(devRow).join('') : '<p class="muted">None.</p>') + '</div>' +
    (other.length ? '<h2>Suspended and rejected</h2><div class="card">' + other.map(devRow).join('') + '</div>' : '');
};

function devRow(d) {
  const all = ME.all_scopes;
  const usedLabel = d.quota_minutes ? d.used_minutes + ' / ' + d.quota_minutes + ' min'
                                    : d.used_minutes + ' min (unlimited)';
  const overQuota = d.quota_minutes && d.used_minutes >= d.quota_minutes;
  const statusClass = d.status === 'active' ? 'ok' : d.status === 'pending' ? 'warn' : 'bad';

  return '<div class="devrow">' +
    '<div><strong>' + esc(d.email) + '</strong> ' +
      '<span class="pill ' + statusClass + '">' + esc(d.status) + '</span> ' +
      (d.is_admin ? '<span class="pill info">admin</span> ' : '') +
      (d.api_locked ? '<span class="pill bad">API locked</span> ' : '') +
      '<span class="pill' + (overQuota ? ' bad' : '') + '">' + usedLabel + ' · ' + esc(d.quota_period) + '</span>' +
      '<div class="muted small">' + esc(d.name || '') + (d.org ? ' · ' + esc(d.org) : '') +
        ' · ' + d.active_keys + ' keys · ' + d.total_jobs + ' jobs' +
        (d.last_login_at ? ' · last seen ' + fmtDate(d.last_login_at) : '') + '</div>' +
      (d.use_case ? '<div class="muted small" style="margin-top:6px">“' + esc(d.use_case) + '”</div>' : '') +
      (d.api_locked && d.lock_reason
        ? '<div class="small" style="color:var(--bad);margin-top:6px">Lock reason: ' + esc(d.lock_reason) + '</div>' : '') +
    '</div>' +

    // For a pending request: one-click presets that set scopes + quota + rate together. The
    // full manual form stays right below for anything the presets don't cover.
    (d.status === 'pending'
      ? '<div style="margin:14px 0"><div class="muted small" style="margin-bottom:8px">Approve with a preset — ' +
          'one click sets scopes, audio limit and rate:</div><div class="tiers">' +
          Object.keys(TIERS).map((k) => {
            const tr = TIERS[k];
            const scopeLabel = tr.scopes ? tr.scopes.map((s) => s.replace(':read', '')).join(' + ') : 'all scopes';
            const quotaLabel = tr.quota_minutes
              ? tr.quota_minutes + ' min / ' + (tr.quota_period === 'total' ? 'total' : 'month')
              : 'unlimited';
            return '<button class="tier" onclick="approveTier(\\'' + d.id + '\\', \\'' + k + '\\')">' +
              '<div class="tname">' + tr.label +
                (k === 'standard' ? '<span class="pill info">suggested</span>' : '') + '</div>' +
              '<div class="tspec">' + scopeLabel + '<br>' + quotaLabel + ' · ' + tr.rate_per_min + ' req/min</div>' +
              '<div class="tgo">Approve &rarr;</div></button>';
          }).join('') +
        '</div><div class="muted small" style="margin-top:10px">…or set an exact allowance below.</div></div>'
      : '') +

    '<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:14px">' +
      '<div><label>Status</label><select id="st-' + d.id + '">' +
        ['pending', 'active', 'suspended', 'rejected'].map((s) =>
          '<option value="' + s + '"' + (s === d.status ? ' selected' : '') + '>' + s + '</option>').join('') +
      '</select></div>' +
      '<div><label>Audio limit (min, 0 = ∞)</label>' +
        '<input id="q-' + d.id + '" type="number" min="0" value="' + d.quota_minutes + '"></div>' +
      '<div><label>Limit applies</label><select id="qp-' + d.id + '">' +
        '<option value="monthly"' + (d.quota_period === 'monthly' ? ' selected' : '') + '>per month</option>' +
        '<option value="total"' + (d.quota_period === 'total' ? ' selected' : '') + '>in total (lifetime)</option>' +
      '</select></div>' +
      '<div><label>Rate (req/min)</label>' +
        '<input id="r-' + d.id + '" type="number" min="1" value="' + d.rate_per_min + '"></div>' +
      '<div><label>Max keys</label>' +
        '<input id="mk-' + d.id + '" type="number" min="1" value="' + d.max_keys + '"></div>' +
    '</div>' +

    '<label>Scope allowance</label><div class="scopes" id="sc-' + d.id + '">' +
      all.map((s) => '<label><input type="checkbox" value="' + esc(s) + '"' +
        (d.scopes.includes(s) ? ' checked' : '') + '> ' + esc(s) + '</label>').join('') +
    '</div>' +

    '<div class="actions">' +
      '<button class="btn" onclick="saveDev(\\'' + d.id + '\\')">Save</button>' +
      '<button class="btn ghost" onclick="resetUsage(\\'' + d.id + '\\', \\'' + esc(d.email) + '\\')">Reset used audio</button>' +
      (d.api_locked
        ? '<button class="btn ghost" onclick="setLock(\\'' + d.id + '\\', false)">Unlock API</button>'
        : '<button class="btn danger" onclick="setLock(\\'' + d.id + '\\', true)">Lock API</button>') +
    '</div></div>';
}

// Approval presets. Each is just a bundle of the same fields the manual form sets, so a
// preset approval is one PATCH with no new backend surface. A null scopes list means "all".
const TIERS = {
  trial:    { label: 'Trial',    scopes: ['report:read'],                    quota_minutes: 60,  quota_period: 'monthly', rate_per_min: 30,  max_keys: 2 },
  standard: { label: 'Standard', scopes: ['transcript:read', 'report:read'], quota_minutes: 500, quota_period: 'monthly', rate_per_min: 60,  max_keys: 5 },
  full:     { label: 'Full',     scopes: null,                               quota_minutes: 0,   quota_period: 'monthly', rate_per_min: 120, max_keys: 10 },
};

function approveTier(id, key) {
  const tr = TIERS[key];
  patchDev(id, {
    status: 'active',
    scopes: tr.scopes || ME.all_scopes,
    quota_minutes: tr.quota_minutes,
    quota_period: tr.quota_period,
    rate_per_min: tr.rate_per_min,
    max_keys: tr.max_keys,
  }, 'Approved on the ' + tr.label + ' tier · developer emailed');
}

async function patchDev(id, body, okMsg) {
  try {
    await api('/portal/api/admin/developers/' + id, { method: 'PATCH', body: JSON.stringify(body) });
    toast(okMsg);
    go('developers');
  } catch (err) { toast(err.message, true); }
}

async function saveDev(id) {
  const scopes = Array.from(document.querySelectorAll('#sc-' + id + ' input:checked')).map((i) => i.value);
  patchDev(id, {
    status: $('#st-' + id).value,
    scopes,
    quota_minutes: Number($('#q-' + id).value),
    quota_period: $('#qp-' + id).value,
    rate_per_min: Number($('#r-' + id).value),
    max_keys: Number($('#mk-' + id).value),
  }, 'Saved');
}

async function resetUsage(id, email) {
  if (!confirm('Reset the used-audio counter for ' + email + '?\\n\\nTheir quota starts from zero now. ' +
               'Billing history is kept.')) return;
  patchDev(id, { reset_usage: true }, 'Usage counter reset');
}

async function setLock(id, lock) {
  let reason = '';
  if (lock) {
    reason = prompt('Lock API access. Reason (shown to the developer in every API error):',
                    'Suspended pending review');
    if (reason === null) return;
  }
  patchDev(id, { api_locked: lock, lock_reason: reason }, lock ? 'API locked' : 'API unlocked');
}

// ---- System ---------------------------------------------------------------
VIEWS.system = async () => {
  const [usage, ov] = await Promise.all([
    api('/portal/api/admin/usage?days=30'),
    api('/portal/api/admin/overview'),
  ]);
  const t = usage.totals || {};
  const audioDays = (usage.daily || []).map((d) => ({ day: d.day, requests: mins(d.audio_seconds), errors: 0 }));

  $('#main').innerHTML =
    '<h1>System</h1>' +
    '<p class="sub">Platform-wide traffic across every developer, and the state of the processing queue.</p>' +

    '<div class="grid cols">' +
      '<div class="card stat"><div class="l">Requests (30d)</div><div class="n">' + (t.requests || 0) + '</div></div>' +
      '<div class="card stat"><div class="l">Audio processed (30d)</div><div class="n">' + mins(t.audio_seconds) + ' min</div></div>' +
      '<div class="card stat"><div class="l">Active developers</div><div class="n">' + (t.active_developers || 0) + '</div></div>' +
      '<div class="card stat"><div class="l">Queued</div><div class="n">' + (ov.queue?.queued || 0) + '</div></div>' +
      '<div class="card stat"><div class="l">Processing</div><div class="n">' + (ov.queue?.processing || 0) + '</div></div>' +
      '<div class="card stat"><div class="l">Errors (30d)</div><div class="n">' + (t.errors || 0) + '</div></div>' +
    '</div>' +

    '<h2>Traffic — all developers</h2><div class="card">' + chartSvg(usage.daily, 'requests') +
      '<div class="legend"><span><i class="sw sw-a"></i>Successful</span>' +
      '<span><i class="sw sw-b"></i>Errors</span></div></div>' +

    '<h2>Audio processed per day</h2><div class="card">' + chartSvg(audioDays, 'minutes') + '</div>' +

    '<h2>Active API keys <span class="muted small" style="font-weight:400">— every live key in the system</span></h2>' +
    '<div class="card">' +
      ((usage.active_keys || []).length === 0 ? '<p class="muted">No active keys.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Developer</th><th>Key</th><th>Scopes</th><th>Requests 30d</th><th>Audio</th><th>Last used</th></tr>' +
        usage.active_keys.map((k) => '<tr>' +
          '<td>' + esc(k.email) + (k.api_locked ? ' <span class="pill bad">locked</span>' : '') +
            (k.org ? '<div class="muted small">' + esc(k.org) + '</div>' : '') + '</td>' +
          '<td>' + esc(k.name) + ' <span class="mono muted">' + esc(k.prefix) + '…</span></td>' +
          '<td>' + k.scopes.map((s) => '<span class="pill info">' + esc(s.replace(':read', '')) + '</span>').join(' ') + '</td>' +
          '<td>' + k.requests + '</td><td>' + mins(k.audio_seconds) + ' min</td>' +
          '<td class="muted small">' + fmtDate(k.last_used_at) + '</td></tr>').join('') +
      '</table></div>') + '</div>' +

    '<h2>Usage by developer</h2><div class="card">' +
      ((usage.by_developer || []).length === 0 ? '<p class="muted">No developers.</p>' : '<div class="tablewrap"><table>' +
        '<tr><th>Developer</th><th>Requests</th><th>Audio</th><th>Errors</th></tr>' +
        usage.by_developer.map((d) => '<tr>' +
          '<td>' + esc(d.email) + (d.api_locked ? ' <span class="pill bad">locked</span>' : '') + '</td>' +
          '<td>' + d.requests + '</td><td>' + mins(d.audio_seconds) + ' min</td>' +
          '<td>' + (d.errors || 0) + '</td></tr>').join('') +
      '</table></div>') + '</div>' +

    ((ov.recent_errors || []).length
      ? '<h2>Recent job errors</h2><div class="card"><div class="tablewrap"><table>' +
        '<tr><th>Job</th><th>Error</th><th>When</th></tr>' +
        ov.recent_errors.map((e) => '<tr><td class="mono muted">' + esc(e.id.slice(0, 8)) + '</td>' +
          '<td class="small">' + esc(e.error) + '</td>' +
          '<td class="muted small">' + fmtDate(e.created_at) + '</td></tr>').join('') +
        '</table></div></div>'
      : '');
};

// ---- boot -----------------------------------------------------------------
async function boot() {
  try {
    ME = await api('/portal/api/me');
  } catch {
    $('#auth').classList.remove('hidden');
    $('#app').classList.add('hidden');
    return;
  }
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who').textContent = ME.developer.email;
  go((location.hash || '#overview').slice(1));
}
window.addEventListener('hashchange', () => {
  if (ME) go(location.hash.slice(1));
});
boot();
</script>
</body>
</html>`;
}
